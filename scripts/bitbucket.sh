#!/usr/bin/env bash
# Requires bash 4.0+ for associative arrays
set -euo pipefail

# Bitbucket PR Comment Script for korekt-cli
# Posts AI code review results to Bitbucket Pull Request with inline comments

# Usage: ./bitbucket.sh results.json
# Required environment variables:
#   BITBUCKET_ACCESS_TOKEN - Bitbucket access token (App password or OAuth token)
#   BITBUCKET_REPO_FULL_NAME - Repository full name (owner/repo)
#   BITBUCKET_PR_ID - Pull request ID
#   BITBUCKET_COMMIT - Commit hash
#   BITBUCKET_BUILD_NUMBER - Build number (optional, for linking)

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

if [ -z "$BITBUCKET_ACCESS_TOKEN" ]; then
  echo "Error: BITBUCKET_ACCESS_TOKEN environment variable not set"
  exit 1
fi

if [ -z "$BITBUCKET_REPO_FULL_NAME" ]; then
  echo "Error: BITBUCKET_REPO_FULL_NAME environment variable not set"
  exit 1
fi

if [ -z "$BITBUCKET_PR_ID" ]; then
  echo "Error: BITBUCKET_PR_ID environment variable not set"
  exit 1
fi

if [ -z "$BITBUCKET_COMMIT" ]; then
  echo "Error: BITBUCKET_COMMIT environment variable not set"
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
BASE_API_URL="https://api.bitbucket.org/2.0/repositories/${BITBUCKET_REPO_FULL_NAME}/pullrequests/${BITBUCKET_PR_ID}"

# Function to wrap long lines in code blocks
wrap_code_block() {
  local content="$1"
  local max_width="$2"
  printf "%s\n" "$content" | fold -s -w "$max_width"
}

# Function to fetch all pages using pagination
fetch_all_pages() {
  local url="$1"
  local all_items="[]"
  local next_url="$url"

  while [ -n "$next_url" ] && [ "$next_url" != "null" ]; do
    local response
    response=$(curl -s -X GET "$next_url" \
      -H "Authorization: Bearer $BITBUCKET_ACCESS_TOKEN" \
      -H "Content-Type: application/json")

    if ! echo "$response" | jq -e '.values' > /dev/null 2>&1; then
      echo "[]"
      return
    fi

    local page_items
    page_items=$(echo "$response" | jq '.values')
    all_items=$(jq -s '.[0] + .[1]' <(echo "$all_items") <(echo "$page_items"))

    # Get next page URL
    next_url=$(echo "$response" | jq -r '.next // empty')
  done

  echo "$all_items"
}

# Function to delete old bot summary comments
delete_old_summary_comments() {
  echo "Deleting old bot summary comments..."
  local comments_url="${BASE_API_URL}/comments"
  local existing_comments

  existing_comments=$(fetch_all_pages "$comments_url")

  if ! echo "$existing_comments" | jq -e . > /dev/null 2>&1; then
    echo "Warning: Could not fetch existing comments to delete old summaries."
    return
  fi

  # Find comments that contain the bot marker and have no inline info
  echo "$existing_comments" | jq -r '.[] | select(.content.raw | contains("🤖 **Automated Code Review Results**")) | select(.inline == null) | .id' | while IFS= read -r comment_id; do
    if [ -z "$comment_id" ] || [ "$comment_id" = "null" ]; then
      continue
    fi

    echo "Deleting old summary comment (ID: $comment_id)..."

    local delete_response
    delete_response=$(curl -s -X DELETE "${BASE_API_URL}/comments/${comment_id}" \
      -H "Authorization: Bearer $BITBUCKET_ACCESS_TOKEN" \
      -w "\n%{http_code}")

    local http_status
    http_status=$(echo "$delete_response" | tail -n1)

    if [ "$http_status" -ge 200 ] && [ "$http_status" -lt 300 ]; then
      echo "Successfully deleted comment $comment_id"
    else
      echo "Warning: Could not delete comment $comment_id (HTTP $http_status)"
    fi
  done
}

# Function to populate existing comments map
populate_existing_comments_map() {
  echo "Fetching existing inline comments to prevent duplicates..."
  local comments_url="${BASE_API_URL}/comments"
  local existing_comments

  existing_comments=$(fetch_all_pages "$comments_url")

  if ! echo "$existing_comments" | jq -e . > /dev/null 2>&1; then
    echo "Warning: Could not fetch existing comments. Duplicate checking will be skipped."
    return
  fi

  local comment_count=0

  # Process inline comments only
  while IFS= read -r comment_json; do
    local file_path
    local line_to

    file_path=$(echo "$comment_json" | jq -r '.inline.path // empty') || true
    line_to=$(echo "$comment_json" | jq -r '.inline.to // empty') || true

    if [ -n "$file_path" ] && [ "$file_path" != "null" ] && [ "$file_path" != "" ] && [ -n "$line_to" ] && [ "$line_to" != "null" ] && [ "$line_to" != "" ]; then
      location_key="${file_path}:${line_to}"
      existing_comment_locations["$location_key"]=1
      ((comment_count++)) || true
    fi
  done < <(echo "$existing_comments" | jq -c '.[] | select(.inline != null)' || true)

  echo "Found inline comments at ${comment_count} unique locations."
}

# Function to post an inline comment
post_inline_comment() {
  local file_path="$1"
  local line_number="$2"
  local comment_body="$3"

  local comment_payload
  comment_payload=$(jq -n \
    --arg raw "$comment_body" \
    --arg path "$file_path" \
    --argjson line "$line_number" \
    '{
      content: {
        raw: $raw
      },
      inline: {
        path: $path,
        to: $line
      }
    }')

  local post_response
  post_response=$(curl -s -X POST "${BASE_API_URL}/comments" \
    -H "Authorization: Bearer $BITBUCKET_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$comment_payload" -w "\n%{http_code}")

  local http_status
  http_status=$(echo "$post_response" | tail -n1)

  if [ "$http_status" -ge 200 ] && [ "$http_status" -lt 300 ]; then
    echo "Successfully posted inline comment on ${file_path}:${line_number}"
  else
    echo "Warning: Could not post inline comment on ${file_path}:${line_number} (HTTP $http_status)"
  fi
}

# Parse results
TOTAL_ISSUES=$(jq -r '.summary.total_issues // 0' "$RESULTS_FILE")
TOTAL_PRAISES=$(jq -r '.summary.total_praises // 0' "$RESULTS_FILE")
CRITICAL_ISSUES=$(jq -r '.summary.critical // 0' "$RESULTS_FILE")

# Post inline comments for issues (excluding low severity)
if [ "$TOTAL_ISSUES" -gt 0 ] && [ "$POST_INLINE_COMMENTS" = "true" ]; then
  populate_existing_comments_map

  echo "Posting inline comments for non-low severity issues..."
  jq -r '.review.issues[] | select(.severity != "low") | @json' "$RESULTS_FILE" | while IFS= read -r issue_json; do
    file_path=$(echo "$issue_json" | jq -r '.file_path')
    line_number=$(echo "$issue_json" | jq -r '.line_number')
    message=$(echo "$issue_json" | jq -r '.message')
    severity=$(echo "$issue_json" | jq -r '.severity')
    category=$(echo "$issue_json" | jq -r '.category')
    suggested_fix=$(echo "$issue_json" | jq -r '.suggested_fix // ""')

    if [ -z "$file_path" ] || [ "$file_path" = "null" ] || [ -z "$line_number" ] || [ "$line_number" = "null" ]; then
      continue
    fi

    # Check for duplicate
    location_key="${file_path}:${line_number}"
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

    post_inline_comment "$file_path" "$line_number" "$inline_comment_content"
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
    jq -r '.review.praises[] | @json' "$RESULTS_FILE" | while IFS= read -r praise_json; do
      file_path=$(echo "$praise_json" | jq -r '.file_path')
      line_number=$(echo "$praise_json" | jq -r '.line_number')
      message=$(echo "$praise_json" | jq -r '.message')
      category=$(echo "$praise_json" | jq -r '.category')

      # Bitbucket doesn't support line anchors in the same way
      file_link="$file_path:$line_number"
      formatted_category=$(echo "$category" | sed -e 's/_/ /g' -e 's/\b\(.\)/\u\1/g')

      echo "- ✅ **$formatted_category** in \`$file_link\`" >> "$COMMENT_FILE"
      echo "  - $message" >> "$COMMENT_FILE"
      echo "" >> "$COMMENT_FILE"
    done
  fi

  # Issues section
  if [ "$TOTAL_ISSUES" -gt 0 ]; then
    HIGH_ISSUES=$(jq -r '.summary.high // 0' "$RESULTS_FILE")
    MEDIUM_ISSUES=$(jq -r '.summary.medium // 0' "$RESULTS_FILE")
    LOW_ISSUES=$(jq -r '.summary.low // 0' "$RESULTS_FILE")

    echo "### ⚠️ Issues Found ($TOTAL_ISSUES)" >> "$COMMENT_FILE"
    echo "" >> "$COMMENT_FILE"
    echo "| Severity | Count |" >> "$COMMENT_FILE"
    echo "| :--- | :---: |" >> "$COMMENT_FILE"
    [ "$CRITICAL_ISSUES" -gt 0 ] && echo "| 🟣 Critical | $CRITICAL_ISSUES |" >> "$COMMENT_FILE"
    [ "$HIGH_ISSUES" -gt 0 ] && echo "| 🔴 High | $HIGH_ISSUES |" >> "$COMMENT_FILE"
    [ "$MEDIUM_ISSUES" -gt 0 ] && echo "| 🟠 Medium | $MEDIUM_ISSUES |" >> "$COMMENT_FILE"
    [ "$LOW_ISSUES" -gt 0 ] && echo "| 🟡 Low | $LOW_ISSUES |" >> "$COMMENT_FILE"
    echo "" >> "$COMMENT_FILE"

    jq -r '.review.issues[] | @json' "$RESULTS_FILE" | while IFS= read -r issue_json; do
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

# Add link to build if BITBUCKET_BUILD_NUMBER is available
if [ -n "${BITBUCKET_BUILD_NUMBER:-}" ]; then
  echo "---" >> "$COMMENT_FILE"
  echo "[View full pipeline results](https://bitbucket.org/${BITBUCKET_REPO_FULL_NAME}/pipelines/results/${BITBUCKET_BUILD_NUMBER})" >> "$COMMENT_FILE"
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
  --arg raw "$COMMENT_BODY" \
  '{
    content: {
      raw: $raw
    }
  }')

POST_RESPONSE=$(curl -s -X POST "${BASE_API_URL}/comments" \
  -H "Authorization: Bearer $BITBUCKET_ACCESS_TOKEN" \
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

# Post commit status to block/unblock merge
echo "Posting commit status..."

if [ "$CRITICAL_ISSUES" -gt 0 ]; then
  COMMIT_STATUS="FAILED"
  STATUS_DESCRIPTION="Found $CRITICAL_ISSUES critical severity issues that must be addressed"
else
  COMMIT_STATUS="SUCCESSFUL"
  STATUS_DESCRIPTION="No critical severity issues found"
fi

STATUS_PAYLOAD=$(jq -n \
  --arg state "$COMMIT_STATUS" \
  --arg description "$STATUS_DESCRIPTION" \
  '{
    state: $state,
    key: "korekt-cli-review",
    name: "Code Review",
    description: $description,
    url: ("https://bitbucket.org/" + env.BITBUCKET_REPO_FULL_NAME + "/pullrequests/" + env.BITBUCKET_PR_ID)
  }')

STATUS_URL="https://api.bitbucket.org/2.0/repositories/${BITBUCKET_REPO_FULL_NAME}/commit/${BITBUCKET_COMMIT}/statuses/build"

STATUS_RESPONSE=$(curl -s -X POST "$STATUS_URL" \
  -H "Authorization: Bearer $BITBUCKET_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data "$STATUS_PAYLOAD" -w "\n%{http_code}")

STATUS_HTTP_CODE=$(echo "$STATUS_RESPONSE" | tail -n1)

if [ "$STATUS_HTTP_CODE" -ge 200 ] && [ "$STATUS_HTTP_CODE" -lt 300 ]; then
  echo "✅ Successfully posted commit status: $COMMIT_STATUS"
else
  echo "⚠️  Warning: Could not post commit status (HTTP $STATUS_HTTP_CODE)"
fi

rm -f "$COMMENT_FILE"
exit 0
