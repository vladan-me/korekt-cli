#!/usr/bin/env bash
# Requires bash 4.0+ for associative arrays
set -euo pipefail

# GitHub PR Comment Script for korekt-cli
# Posts AI code review results to GitHub Pull Request with inline comments

# Usage: ./github.sh results.json
# Required environment variables:
#   GITHUB_TOKEN - GitHub token with repo access
#   GITHUB_REPOSITORY - Repository in format "owner/repo"
#   GITHUB_SERVER_URL - GitHub server URL (default: https://github.com)
#   PR_NUMBER - Pull request number
#   COMMIT_HASH - Commit hash to comment on

# Optional configuration
INCLUDE_AI_ASSIST_INLINE="${INCLUDE_AI_ASSIST_INLINE:-false}"  # Include AI-assist YAML in inline comments
INCLUDE_AI_ASSIST_SUMMARY="${INCLUDE_AI_ASSIST_SUMMARY:-false}"  # Include AI-assist YAML in summary
MAX_LINE_WIDTH="${MAX_LINE_WIDTH:-100}"  # Max width for code blocks

RESULTS_FILE="${1:-results.json}"
GITHUB_SERVER_URL="${GITHUB_SERVER_URL:-https://github.com}"

# Validate inputs
if [ ! -f "$RESULTS_FILE" ]; then
  echo "Error: Results file not found: $RESULTS_FILE"
  exit 1
fi

if [ -z "$GITHUB_TOKEN" ]; then
  echo "Error: GITHUB_TOKEN environment variable not set"
  exit 1
fi

if [ -z "$GITHUB_REPOSITORY" ]; then
  echo "Error: GITHUB_REPOSITORY environment variable not set"
  exit 1
fi

if [ -z "$PR_NUMBER" ]; then
  echo "Error: PR_NUMBER environment variable not set"
  exit 1
fi

if [ -z "$COMMIT_HASH" ]; then
  echo "Error: COMMIT_HASH environment variable not set"
  exit 1
fi

# Validate JSON
if ! jq empty "$RESULTS_FILE" 2>/dev/null; then
  echo "Error: Invalid JSON in $RESULTS_FILE"
  exit 1
fi

GITHUB_API_URL="https://api.github.com/repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}"

# Use an associative array to store locations of existing comments
declare -A existing_comment_locations

# Function to wrap long lines in code blocks
wrap_code_block() {
  local content="$1"
  local max_width="$2"
  printf "%s\n" "$content" | fold -s -w "$max_width"
}

# Function to fetch all pages of comments using pagination
fetch_all_comments() {
  local url="$1"
  local all_comments="[]"
  local page_url="$url?per_page=100"

  while [ -n "$page_url" ]; do
    local response
    local headers_file
    headers_file=$(mktemp)

    response=$(curl -s -X GET "$page_url" \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -D "$headers_file")

    if ! echo "$response" | jq -e . > /dev/null 2>&1; then
      rm -f "$headers_file"
      echo "[]"
      return
    fi

    all_comments=$(jq -s '.[0] + .[1]' <(echo "$all_comments") <(echo "$response"))

    # Extract next page URL from Link header
    page_url=$(grep -i "^link:" "$headers_file" | sed -n 's/.*<\([^>]*\)>; rel="next".*/\1/p')

    rm -f "$headers_file"
  done

  echo "$all_comments"
}

# Function to delete old bot summary comments
delete_old_summary_comments() {
  echo "Deleting old bot summary comments..."
  local existing_comments_response
  local issue_comments_url="https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments"

  existing_comments_response=$(fetch_all_comments "$issue_comments_url")

  if ! echo "$existing_comments_response" | jq -e . > /dev/null 2>&1; then
    echo "Warning: Could not fetch existing comments to delete old summaries."
    return
  fi

  echo "$existing_comments_response" | jq -r '.[] | select(.body | contains("🤖 **Automated Code Review Results**")) | .id' | while IFS= read -r comment_id; do
    echo "Deleting old summary comment (ID: $comment_id)..."

    local delete_response
    delete_response=$(curl -s -X DELETE "https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/comments/${comment_id}" \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
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
  echo "Fetching existing review comments to prevent duplicates..."
  local existing_comments_response
  existing_comments_response=$(fetch_all_comments "${GITHUB_API_URL}/comments")

  if ! echo "$existing_comments_response" | jq -e . > /dev/null 2>&1; then
    echo "Warning: Could not fetch existing comments. Duplicate checking will be skipped."
    return
  fi

  local comment_count=0
  while IFS= read -r comment_json; do
    local file_path
    local line_number
    local location_key

    file_path=$(echo "$comment_json" | jq -r '.path // empty') || true
    line_number=$(echo "$comment_json" | jq -r '.line // empty') || true

    if [ -n "$file_path" ] && [ "$file_path" != "null" ] && [ "$file_path" != "" ] && [ -n "$line_number" ] && [ "$line_number" != "null" ] && [ "$line_number" != "" ]; then
      location_key="${file_path}:${line_number}"
      existing_comment_locations["$location_key"]=1
      ((comment_count++)) || true
    fi
  done < <(echo "$existing_comments_response" | jq -c '.[]' || true)

  echo "Found comments at ${comment_count} unique locations."
}

# Function to post a review comment
post_review_comment() {
  local file_path="$1"
  local line_number="$2"
  local comment_body="$3"

  local comment_payload
  comment_payload=$(jq -n \
    --arg body "$comment_body" \
    --arg commit_id "$COMMIT_HASH" \
    --arg path "$file_path" \
    --argjson line "$line_number" \
    '{
      body: $body,
      commit_id: $commit_id,
      path: $path,
      line: $line
    }')

  local post_response
  post_response=$(curl -s -X POST "${GITHUB_API_URL}/comments" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
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
TOTAL_ISSUES=$(jq -r '.data.summary.total_issues // 0' "$RESULTS_FILE")
TOTAL_PRAISES=$(jq -r '.data.summary.total_praises // 0' "$RESULTS_FILE")
CRITICAL_ISSUES=$(jq -r '.data.summary.critical // 0' "$RESULTS_FILE")

# Post inline comments for issues
if [ "$TOTAL_ISSUES" -gt 0 ]; then
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

    post_review_comment "$file_path" "$line_number" "$inline_comment_content"
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

      file_link="[$file_path:$line_number](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/blob/${COMMIT_HASH}/${file_path}#L${line_number})"
      formatted_category=$(echo "$category" | sed -e 's/_/ /g' -e 's/\b\(.\)/\u\1/g')

      echo "- ✅ **$formatted_category** in $file_link" >> "$COMMENT_FILE"
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

      file_link="[$file_path:$line_number](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/blob/${COMMIT_HASH}/${file_path}#L${line_number})"
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

echo "---" >> "$COMMENT_FILE"
echo "*Powered by [korekt-cli](https://github.com/korekt-ai/korekt-cli)*" >> "$COMMENT_FILE"

# Delete old summaries
delete_old_summary_comments

# Post summary comment
echo "Posting summary comment..."
COMMENT_BODY=$(cat "$COMMENT_FILE")
JSON_PAYLOAD=$(jq -n --arg body "$COMMENT_BODY" '{body: $body}')

ISSUE_COMMENTS_URL="https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments"
POST_RESPONSE=$(curl -s -X POST "$ISSUE_COMMENTS_URL" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "Content-Type: application/json" \
  --data "$JSON_PAYLOAD" -w "\n%{http_code}")

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
  COMMIT_STATUS="failure"
  STATUS_DESCRIPTION="Found $CRITICAL_ISSUES critical severity issues that must be addressed"
else
  COMMIT_STATUS="success"
  STATUS_DESCRIPTION="No critical severity issues found"
fi

COMMIT_STATUS_URL="https://api.github.com/repos/${GITHUB_REPOSITORY}/statuses/${COMMIT_HASH}"

STATUS_PAYLOAD=$(jq -n \
  --arg state "$COMMIT_STATUS" \
  --arg description "$STATUS_DESCRIPTION" \
  --arg context "Code Review" \
  '{
    state: $state,
    description: $description,
    context: $context
  }')

STATUS_RESPONSE=$(curl -s -X POST "$COMMIT_STATUS_URL" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
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
