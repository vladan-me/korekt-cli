#!/usr/bin/env bash
# Requires bash 4.0+ for associative arrays
set -euo pipefail

# Azure DevOps PR Comment Script for korekt-cli
# Posts AI code review results to Azure DevOps Pull Request with inline comments

# Usage: ./azure.sh results.json
# Required environment variables:
#   SYSTEM_ACCESSTOKEN - Azure DevOps access token
#   SYSTEM_TEAMFOUNDATIONCOLLECTIONURI - Collection URI
#   SYSTEM_TEAMPROJECT - Team project name (URL-encoded if needed)
#   BUILD_REPOSITORY_ID - Repository ID
#   SYSTEM_PULLREQUEST_PULLREQUESTID - Pull request ID
#   BUILD_BUILDID - Build ID (optional, for linking to build results)

# Optional configuration
INCLUDE_AI_ASSIST_INLINE="${INCLUDE_AI_ASSIST_INLINE:-false}"  # Include AI-assist YAML in inline comments
INCLUDE_AI_ASSIST_SUMMARY="${INCLUDE_AI_ASSIST_SUMMARY:-false}"  # Include AI-assist YAML in summary
MAX_LINE_WIDTH="${MAX_LINE_WIDTH:-100}"  # Max width for code blocks
POST_INLINE_COMMENTS="${POST_INLINE_COMMENTS:-true}"  # Post inline comments (only for non-low severity)

RESULTS_FILE="${1:-results.json}"

# Validate inputs
if [ ! -f "$RESULTS_FILE" ]; then
  echo "Error: Results file not found: $RESULTS_FILE"
  exit 1
fi

if [ -z "$SYSTEM_ACCESSTOKEN" ]; then
  echo "Error: SYSTEM_ACCESSTOKEN environment variable not set"
  exit 1
fi

if [ -z "$SYSTEM_TEAMFOUNDATIONCOLLECTIONURI" ]; then
  echo "Error: SYSTEM_TEAMFOUNDATIONCOLLECTIONURI environment variable not set"
  exit 1
fi

if [ -z "$SYSTEM_TEAMPROJECT" ]; then
  echo "Error: SYSTEM_TEAMPROJECT environment variable not set"
  exit 1
fi

if [ -z "$BUILD_REPOSITORY_ID" ]; then
  echo "Error: BUILD_REPOSITORY_ID environment variable not set"
  exit 1
fi

if [ -z "$SYSTEM_PULLREQUEST_PULLREQUESTID" ]; then
  echo "Error: SYSTEM_PULLREQUEST_PULLREQUESTID environment variable not set"
  exit 1
fi

# Validate JSON
if ! jq empty "$RESULTS_FILE" 2>/dev/null; then
  echo "Error: Invalid JSON in $RESULTS_FILE"
  exit 1
fi

# Use an associative array to store locations of existing comments
declare -A existing_comment_locations

# Base API URL
BASE_API_URL="${SYSTEM_TEAMFOUNDATIONCOLLECTIONURI}${SYSTEM_TEAMPROJECT}/_apis/git/repositories/${BUILD_REPOSITORY_ID}/pullRequests/${SYSTEM_PULLREQUEST_PULLREQUESTID}"

# Function to wrap long lines in code blocks
wrap_code_block() {
  local content="$1"
  local max_width="$2"
  printf "%s\n" "$content" | fold -s -w "$max_width"
}

# Function to fetch all pages of threads using pagination
fetch_all_threads() {
  local url="$1"
  local all_threads="[]"
  local skip=0
  local top=100
  local has_more=true

  while [ "$has_more" = true ]; do
    local response
    response=$(curl -s -X GET "${url}?\$top=${top}&\$skip=${skip}&api-version=6.0" \
      -H "Authorization: Bearer $SYSTEM_ACCESSTOKEN" \
      -H "Content-Type: application/json")

    if ! echo "$response" | jq -e '.value' > /dev/null 2>&1; then
      echo "[]"
      return
    fi

    local page_threads
    page_threads=$(echo "$response" | jq '.value')

    local count
    count=$(echo "$page_threads" | jq 'length')

    if [ "$count" -eq 0 ]; then
      has_more=false
    else
      all_threads=$(jq -s '.[0] + .[1]' <(echo "$all_threads") <(echo "$page_threads"))
      skip=$((skip + top))
    fi
  done

  echo "$all_threads"
}

# Function to delete old bot summary comments
delete_old_summary_comments() {
  echo "Deleting old bot summary comments..."
  local threads_url="${BASE_API_URL}/threads"
  local existing_threads

  existing_threads=$(fetch_all_threads "$threads_url")

  if ! echo "$existing_threads" | jq -e . > /dev/null 2>&1; then
    echo "Warning: Could not fetch existing threads to delete old summaries."
    return
  fi

  # Find threads that contain the bot marker and have no threadContext (summary comments)
  echo "$existing_threads" | jq -r '.[] | select(.comments[0].content | contains("🤖 **Automated Code Review Results**")) | select(.threadContext == null) | .id' | while IFS= read -r thread_id; do
    if [ -z "$thread_id" ] || [ "$thread_id" = "null" ]; then
      continue
    fi

    echo "Deleting old summary thread (ID: $thread_id)..."

    local delete_response
    delete_response=$(curl -s -X PATCH "${BASE_API_URL}/threads/${thread_id}?api-version=6.0" \
      -H "Authorization: Bearer $SYSTEM_ACCESSTOKEN" \
      -H "Content-Type: application/json" \
      --data '{"status": "closed"}' \
      -w "\n%{http_code}")

    local http_status
    http_status=$(echo "$delete_response" | tail -n1)

    if [ "$http_status" -ge 200 ] && [ "$http_status" -lt 300 ]; then
      echo "Successfully closed thread $thread_id"
    else
      echo "Warning: Could not close thread $thread_id (HTTP $http_status)"
    fi
  done
}

# Function to populate existing comments map
populate_existing_comments_map() {
  echo "Fetching existing review threads to prevent duplicates..."
  local threads_url="${BASE_API_URL}/threads"
  local existing_threads

  existing_threads=$(fetch_all_threads "$threads_url")

  if ! echo "$existing_threads" | jq -e . > /dev/null 2>&1; then
    echo "Warning: Could not fetch existing threads. Duplicate checking will be skipped."
    return
  fi

  local comment_count=0

  # Process threads with file context and active comments
  while IFS= read -r thread_json; do
    local file_path
    local line_number
    local has_active_comment

    file_path=$(echo "$thread_json" | jq -r '.threadContext.filePath // empty') || true
    line_number=$(echo "$thread_json" | jq -r '.threadContext.rightFileEnd.line // empty') || true

    # Check if thread has any active (non-deleted) comments
    has_active_comment=$(echo "$thread_json" | jq -r '[.comments[] | select(.isDeleted != true)] | length > 0') || true

    if [ "$has_active_comment" != "true" ]; then
      continue
    fi

    # Normalize file path (remove leading slash if present)
    file_path=$(echo "$file_path" | sed 's|^/||')

    if [ -n "$file_path" ] && [ "$file_path" != "null" ] && [ "$file_path" != "" ] && [ -n "$line_number" ] && [ "$line_number" != "null" ] && [ "$line_number" != "" ]; then
      location_key="${file_path}:${line_number}"
      existing_comment_locations["$location_key"]=1
      ((comment_count++)) || true
    fi
  done < <(echo "$existing_threads" | jq -c '.[] | select(.threadContext != null)' || true)

  echo "Found active comments at ${comment_count} unique locations."
}

# Function to post a review thread (inline comment)
post_review_thread() {
  local file_path="$1"
  local line_number="$2"
  local comment_body="$3"

  # Azure DevOps expects paths to start with /
  local normalized_path="/${file_path}"
  normalized_path=$(echo "$normalized_path" | sed 's|^//|/|')

  local thread_payload
  thread_payload=$(jq -n \
    --arg content "$comment_body" \
    --arg path "$normalized_path" \
    --argjson line "$line_number" \
    '{
      comments: [
        {
          content: $content,
          commentType: 1
        }
      ],
      status: 1,
      threadContext: {
        filePath: $path,
        rightFileStart: {
          line: $line,
          offset: 1
        },
        rightFileEnd: {
          line: $line,
          offset: 999
        }
      }
    }')

  local post_response
  post_response=$(curl -s -X POST "${BASE_API_URL}/threads?api-version=6.0" \
    -H "Authorization: Bearer $SYSTEM_ACCESSTOKEN" \
    -H "Content-Type: application/json" \
    --data "$thread_payload" -w "\n%{http_code}")

  local http_status
  http_status=$(echo "$post_response" | tail -n1)

  if [ "$http_status" -ge 200 ] && [ "$http_status" -lt 300 ]; then
    echo "Successfully posted inline comment on ${file_path}:${line_number}"
  else
    echo "Warning: Could not post inline comment on ${file_path}:${line_number} (HTTP $http_status)"
  fi
}

# Parse results
TOTAL_ISSUES=$(jq -r '.data.summary.total_issues // 0' "$RESULTS_FILE")
TOTAL_PRAISES=$(jq -r '.data.summary.total_praises // 0' "$RESULTS_FILE")
CRITICAL_ISSUES=$(jq -r '.data.summary.critical // 0' "$RESULTS_FILE")

# Post inline comments for issues (excluding low severity)
if [ "$TOTAL_ISSUES" -gt 0 ] && [ "$POST_INLINE_COMMENTS" = "true" ]; then
  populate_existing_comments_map

  echo "Posting inline comments for non-low severity issues..."
  jq -r '.data.review.issues[] | select(.severity != "low") | @json' "$RESULTS_FILE" | while IFS= read -r issue_json; do
    file_path=$(echo "$issue_json" | jq -r '.file_path')
    line_number=$(echo "$issue_json" | jq -r '.line_number')
    message=$(echo "$issue_json" | jq -r '.message')
    severity=$(echo "$issue_json" | jq -r '.severity')
    category=$(echo "$issue_json" | jq -r '.category')
    suggested_fix=$(echo "$issue_json" | jq -r '.suggested_fix // ""')

    if [ -z "$file_path" ] || [ "$file_path" = "null" ] || [ -z "$line_number" ] || [ "$line_number" = "null" ]; then
      continue
    fi

    # Normalize file path for comparison
    normalized_file_path=$(echo "$file_path" | sed 's|^/||')

    # Check for duplicate
    location_key="${normalized_file_path}:${line_number}"
    if [[ -v existing_comment_locations["$location_key"] ]]; then
      echo "Skipping comment on ${file_path}:${line_number} (already exists)"
      continue
    fi

    # Severity emoji
    emoji="⚪️"
    case "$severity" in
      "critical") emoji="🟣" ;;
      "high") emoji="🔴" ;;
      "medium") emoji="🟠" ;;
      "low") emoji="🟡" ;;
    esac

    # Category emoji
    category_emoji="📝"
    case "$category" in
      "bug") category_emoji="🐞" ;;
      "security") category_emoji="🛡️" ;;
      "best_practice") category_emoji="✨" ;;
      "dependency") category_emoji="📦" ;;
      "performance") category_emoji="🚀" ;;
      "rbac") category_emoji="🔑" ;;
      "syntax") category_emoji="📝" ;;
    esac

    formatted_category=$(echo "$category" | sed -e 's/_/ /g' -e 's/\b\(.\)/\u\1/g')

    inline_comment_content=$(printf "%s **%s (%s %s):**\n\n%s" "$emoji" "$severity" "$category_emoji" "$formatted_category" "$message")

    # Add suggested fix
    if [ -n "$suggested_fix" ] && [ "$suggested_fix" != "null" ] && [ "$suggested_fix" != "" ]; then
      sanitized_fix=$(echo "$suggested_fix" | sed -E 's/^```[a-zA-Z]*//' | sed 's/```$//g')
      wrapped_fix=$(wrap_code_block "$sanitized_fix" "$MAX_LINE_WIDTH")
      inline_comment_content+=$(printf "\n\n---\n\n**💡 Suggested Fix:**\n\n\`\`\`\n%s\n\`\`\`" "$wrapped_fix")
    fi

    # Add AI-assist block if enabled
    if [ "$INCLUDE_AI_ASSIST_INLINE" = "true" ]; then
      ai_assist_block=$(printf "\n\n---\n\n**🤖 AI-Assisted Fix:**\n\`\`\`yaml\n- file: %s\n  line: %s\n  severity: %s\n  category: %s\n  message: |\n%s" "$file_path" "$line_number" "$severity" "$category" "$(printf "%s\n" "$message" | sed 's/^/    /')")
      if [ -n "$suggested_fix" ] && [ "$suggested_fix" != "null" ] && [ "$suggested_fix" != "" ]; then
        sanitized_fix=$(echo "$suggested_fix" | sed -E 's/^```[a-zA-Z]*//' | sed 's/```$//g')
        ai_assist_block+=$(printf "\n  suggested_fix: |\n%s" "$(printf "%s\n" "$sanitized_fix" | sed 's/^/    /')")
      fi
      ai_assist_block+=$(printf "\n\`\`\`")
      inline_comment_content+="$ai_assist_block"
    fi

    post_review_thread "$file_path" "$line_number" "$inline_comment_content"
  done
fi

# Build summary comment
COMMENT_FILE=$(mktemp)

if [ "$TOTAL_ISSUES" -eq 0 ] && [ "$TOTAL_PRAISES" -eq 0 ]; then
  echo "✅ **Automated Code Review Complete** ✅" > "$COMMENT_FILE"
  echo "" >> "$COMMENT_FILE"
  echo "No issues or praises were found." >> "$COMMENT_FILE"
else
  echo "🤖 **Automated Code Review Results**" >> "$COMMENT_FILE"
  echo "" >> "$COMMENT_FILE"

  # Praises section
  if [ "$TOTAL_PRAISES" -gt 0 ]; then
    echo "### ✨ Praises ($TOTAL_PRAISES)" >> "$COMMENT_FILE"
    echo "" >> "$COMMENT_FILE"
    jq -r '.data.review.praises[] | @json' "$RESULTS_FILE" | while IFS= read -r praise_json; do
      file_path=$(echo "$praise_json" | jq -r '.file_path')
      line_number=$(echo "$praise_json" | jq -r '.line_number')
      message=$(echo "$praise_json" | jq -r '.message')
      category=$(echo "$praise_json" | jq -r '.category')

      # Azure DevOps doesn't support line anchors in file URLs like GitHub
      file_link="$file_path:$line_number"
      formatted_category=$(echo "$category" | sed -e 's/_/ /g' -e 's/\b\(.\)/\u\1/g')

      echo "- ✅ **$formatted_category** in \`$file_link\`" >> "$COMMENT_FILE"
      echo "  - $message" >> "$COMMENT_FILE"
      echo "" >> "$COMMENT_FILE"
    done
  fi

  # Issues section
  if [ "$TOTAL_ISSUES" -gt 0 ]; then
    HIGH_ISSUES=$(jq -r '.data.summary.high // 0' "$RESULTS_FILE")
    MEDIUM_ISSUES=$(jq -r '.data.summary.medium // 0' "$RESULTS_FILE")
    LOW_ISSUES=$(jq -r '.data.summary.low // 0' "$RESULTS_FILE")

    echo "### ⚠️ Issues Found ($TOTAL_ISSUES)" >> "$COMMENT_FILE"
    echo "" >> "$COMMENT_FILE"
    echo "| Severity | Count |" >> "$COMMENT_FILE"
    echo "| :--- | :---: |" >> "$COMMENT_FILE"
    [ "$CRITICAL_ISSUES" -gt 0 ] && echo "| 🟣 Critical | $CRITICAL_ISSUES |" >> "$COMMENT_FILE"
    [ "$HIGH_ISSUES" -gt 0 ] && echo "| 🔴 High | $HIGH_ISSUES |" >> "$COMMENT_FILE"
    [ "$MEDIUM_ISSUES" -gt 0 ] && echo "| 🟠 Medium | $MEDIUM_ISSUES |" >> "$COMMENT_FILE"
    [ "$LOW_ISSUES" -gt 0 ] && echo "| 🟡 Low | $LOW_ISSUES |" >> "$COMMENT_FILE"
    echo "" >> "$COMMENT_FILE"

    jq -r '.data.review.issues[] | @json' "$RESULTS_FILE" | while IFS= read -r issue_json; do
      file_path=$(echo "$issue_json" | jq -r '.file_path')
      line_number=$(echo "$issue_json" | jq -r '.line_number')
      message=$(echo "$issue_json" | jq -r '.message')
      severity=$(echo "$issue_json" | jq -r '.severity')
      category=$(echo "$issue_json" | jq -r '.category')
      suggested_fix=$(echo "$issue_json" | jq -r '.suggested_fix // ""')

      emoji="⚪️"
      case "$severity" in
        "critical") emoji="🟣" ;;
        "high") emoji="🔴" ;;
        "medium") emoji="🟠" ;;
        "low") emoji="🟡" ;;
      esac

      category_emoji="📝"
      case "$category" in
        "bug") category_emoji="🐞" ;;
        "security") category_emoji="🛡️" ;;
        "best_practice") category_emoji="✨" ;;
        "dependency") category_emoji="📦" ;;
        "performance") category_emoji="🚀" ;;
        "rbac") category_emoji="🔑" ;;
        "syntax") category_emoji="📝" ;;
      esac

      file_link="\`${file_path}:${line_number}\`"
      formatted_category=$(echo "$category" | sed -e 's/_/ /g' -e 's/\b\(.\)/\u\1/g')

      echo "- $emoji **$severity** in $file_link ($category_emoji $formatted_category)" >> "$COMMENT_FILE"
      echo "" >> "$COMMENT_FILE"
      printf "%s\n" "$message" >> "$COMMENT_FILE"
      echo "" >> "$COMMENT_FILE"

      if [ -n "$suggested_fix" ] && [ "$suggested_fix" != "null" ] && [ "$suggested_fix" != "" ]; then
        sanitized_fix=$(echo "$suggested_fix" | sed -E 's/^```[a-zA-Z]*//' | sed 's/```$//g')
        wrapped_fix=$(wrap_code_block "$sanitized_fix" "$MAX_LINE_WIDTH")
        echo "**💡 Suggested Fix:**" >> "$COMMENT_FILE"
        echo '```' >> "$COMMENT_FILE"
        printf "%s\n" "$wrapped_fix" >> "$COMMENT_FILE"
        echo '```' >> "$COMMENT_FILE"
      fi

      if [ "$INCLUDE_AI_ASSIST_SUMMARY" = "true" ]; then
        echo "" >> "$COMMENT_FILE"
        echo "**🤖 AI-Assisted Fix:**" >> "$COMMENT_FILE"
        echo '```yaml' >> "$COMMENT_FILE"
        echo "- file: $file_path" >> "$COMMENT_FILE"
        echo "  line: $line_number" >> "$COMMENT_FILE"
        echo "  severity: $severity" >> "$COMMENT_FILE"
        echo "  category: $category" >> "$COMMENT_FILE"
        echo "  message: |" >> "$COMMENT_FILE"
        printf "%s\n" "$message" | sed 's/^/    /' >> "$COMMENT_FILE"
        if [ -n "$suggested_fix" ] && [ "$suggested_fix" != "null" ] && [ "$suggested_fix" != "" ]; then
          sanitized_fix=$(echo "$suggested_fix" | sed -E 's/^```[a-zA-Z]*//' | sed 's/```$//g')
          echo "  suggested_fix: |" >> "$COMMENT_FILE"
          printf "%s\n" "$sanitized_fix" | sed 's/^/    /' >> "$COMMENT_FILE"
        fi
        echo '```' >> "$COMMENT_FILE"
      fi

      echo "" >> "$COMMENT_FILE"
    done
  fi
fi

# Add link to build if BUILD_BUILDID is available
if [ -n "$BUILD_BUILDID" ]; then
  echo "---" >> "$COMMENT_FILE"
  echo "[View full pipeline results](${SYSTEM_TEAMFOUNDATIONCOLLECTIONURI}${SYSTEM_TEAMPROJECT}/_build/results?buildId=${BUILD_BUILDID})" >> "$COMMENT_FILE"
  echo "" >> "$COMMENT_FILE"
fi

echo "---" >> "$COMMENT_FILE"
echo "*Powered by [korekt-cli](https://github.com/korekt-ai/korekt-cli)*" >> "$COMMENT_FILE"

# Delete old summaries
delete_old_summary_comments

# Post summary comment
echo "Posting summary comment..."
COMMENT_BODY=$(cat "$COMMENT_FILE")

SUMMARY_PAYLOAD=$(jq -n \
  --arg content "$COMMENT_BODY" \
  '{
    comments: [
      {
        content: $content,
        commentType: 1
      }
    ],
    status: 1
  }')

POST_RESPONSE=$(curl -s -X POST "${BASE_API_URL}/threads?api-version=6.0" \
  -H "Authorization: Bearer $SYSTEM_ACCESSTOKEN" \
  -H "Content-Type: application/json" \
  --data "$SUMMARY_PAYLOAD" -w "\n%{http_code}")

HTTP_STATUS=$(echo "$POST_RESPONSE" | tail -n1)

if [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 300 ]; then
  echo "✅ Successfully posted summary comment"
else
  echo "❌ Failed to post summary comment (HTTP $HTTP_STATUS)"
  rm -f "$COMMENT_FILE"
  exit 1
fi

# Post PR status to block/unblock merge
echo "Posting PR status..."

if [ "$CRITICAL_ISSUES" -gt 0 ]; then
  PR_STATUS="failed"
  STATUS_DESCRIPTION="Found $CRITICAL_ISSUES critical severity issues that must be addressed"
else
  PR_STATUS="succeeded"
  STATUS_DESCRIPTION="No critical severity issues found"
fi

STATUS_PAYLOAD=$(jq -n \
  --arg state "$PR_STATUS" \
  --arg description "$STATUS_DESCRIPTION" \
  '{
    state: $state,
    description: $description,
    context: {
      name: "Code Review",
      genre: "korekt-cli"
    }
  }')

STATUS_RESPONSE=$(curl -s -X POST "${BASE_API_URL}/statuses?api-version=6.0" \
  -H "Authorization: Bearer $SYSTEM_ACCESSTOKEN" \
  -H "Content-Type: application/json" \
  --data "$STATUS_PAYLOAD" -w "\n%{http_code}")

STATUS_HTTP_CODE=$(echo "$STATUS_RESPONSE" | tail -n1)

if [ "$STATUS_HTTP_CODE" -ge 200 ] && [ "$STATUS_HTTP_CODE" -lt 300 ]; then
  echo "✅ Successfully posted PR status: $PR_STATUS"
else
  echo "⚠️  Warning: Could not post PR status (HTTP $STATUS_HTTP_CODE)"
fi

rm -f "$COMMENT_FILE"
exit 0
