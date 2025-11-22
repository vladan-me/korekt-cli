# korekt-cli Integration Flow

This document explains how korekt-cli works in local development and CI/CD environments, focusing on data flow, JSON output mode, and PR integration.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Data Flow](#data-flow)
- [Local Development Flow](#local-development-flow)
- [CI/CD Integration Flow](#cicd-integration-flow)
- [JSON Output Mode](#json-output-mode)
- [Posting Results to PRs](#posting-results-to-prs)
- [Best Practices](#best-practices)

## Architecture Overview

```
┌─────────────────┐
│  Local Git Repo │
│  (checked out)  │
└────────┬────────┘
         │
         │ git commands
         │ (diff, log, show)
         ▼
    ┌────────┐
    │   kk   │ ◄── korekt-cli
    └────┬───┘
         │
         │ HTTP POST
         │ (payload with diffs)
         ▼
┌──────────────────┐
│  Korekt API      │
│  (AI Analysis)   │
└────────┬─────────┘
         │
         │ JSON response
         │ (issues, praises)
         ▼
    ┌────────┐
    │   kk   │
    └────┬───┘
         │
         ├─► Terminal output (formatted)
         │   or
         └─► JSON to stdout (CI/CD)
```

### Key Principles

1. **Local Execution**: kk runs git commands locally - no repository cloning needed on backend
2. **Stateless API**: API receives all data in request, returns analysis results
3. **Separation of Concerns**: kk handles git operations, CI scripts handle PR posting

## Data Flow

### What kk Collects and Sends

```javascript
{
  repo_url: "https://github.com/user/repo",
  source_branch: "feature-branch",
  commit_messages: ["feat: add feature", "fix: bug"],
  changed_files: [
    {
      path: "src/file.js",
      status: "M",  // M, A, D, R, C
      old_path: "src/old.js",  // Only for R (renamed)
      diff: "diff content...",
      content: "full file content..."
    }
  ]
}
```

### What API Returns

```javascript
{
  review: {
    issues: [
      {
        file_path: "src/file.js",
        line_number: 42,
        message: "Potential security vulnerability",
        severity: "high",  // critical, high, medium, low
        category: "security",
        suggested_fix: "Use parameterized queries"
      }
    ],
    praises: [
      {
        file_path: "src/utils.js",
        line_number: 15,
        message: "Excellent error handling"
      }
    ]
  },
  summary: {
    total_issues: 5,
    total_praises: 2,
    critical: 1,
    high: 2,
    medium: 1,
    low: 1
  }
}
```

## Local Development Flow

### Interactive Mode (Default)

```bash
$ kk review main

🚀 Starting AI Code Review against 'main'...

📋 Ready to submit for review:

  Branch: feature-auth
  Commits: 3
  Files: 5

  Files to review:
    M src/auth.js
    A src/utils.js
    D docs/old.md

Proceed with AI review? (Y/n): y

⠹ Submitting review to the AI... 3s
✓ Review completed in 3s!

[Formatted output with colors, emojis, severity indicators]
```

### Dry Run Mode

```bash
$ kk review main --dry-run

📋 Dry Run - Payload that would be sent:

{
  "repo_url": "https://github.com/user/repo",
  "source_branch": "feature-auth",
  "commit_messages": [...],
  "changed_files": [...]  // Truncated for readability
}

💡 Run without --dry-run to send to API
💡 Diffs and content are truncated in dry-run for readability
```

## CI/CD Integration Flow

### Without JSON Mode (Basic)

**Problem:** Output mixed with progress messages, ANSI colors, interactive prompts

```bash
$ kk review origin/main

🚀 Starting AI Code Review...  # ← Progress to stderr
Proceed with AI review? (Y/n):  # ← Blocks in CI
[Formatted output]              # ← Hard to parse
```

### With JSON Mode (Recommended for CI)

**Solution:** Clean JSON to stdout, progress to stderr, auto-confirm

```bash
$ kk review origin/main --json > results.json

# stderr: Progress messages (can be suppressed with 2>/dev/null)
# stdout: Pure JSON → results.json
```

**Benefits:**
- No interactive prompts (auto-confirms)
- No ANSI colors or formatting
- Pure JSON output
- Progress separated to stderr
- Easy to parse in scripts

### Complete CI/CD Flow

```
┌─────────────────────────────────────────────────┐
│  1. CI Checkout (fetch-depth: 0)               │
└─────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  2. Install kk: npm install -g korekt-cli       │
└─────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  3. Configure: kk config --key "$API_KEY"       │
└─────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  4. Review: kk review origin/main --json        │
│     Output: results.json                        │
└─────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  5. Run Integration Script                      │
│     kk get-script <provider> | bash -s          │
└─────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  6. Post Comments & Status                      │
│     • Fetch existing comments (paginated)       │
│     • Delete old bot summary comments           │
│     • Post inline comments (with dup check)     │
│     • Post new summary comment                  │
│     • Post PR/commit status (block on critical) │
└─────────────────────────────────────────────────┘
```

## JSON Output Mode

### Usage

```bash
# Review with JSON output
kk review origin/main --json > results.json

# Works with all review commands
kk stg --json          # Staged changes
kk diff --json         # Unstaged changes


# Suppress progress messages
kk review origin/main --json 2>/dev/null > results.json
```

### stdout/stderr Separation

```bash
# Progress goes to stderr
process.stderr.write("Starting review...\n")

# Data goes to stdout
process.stdout.write(JSON.stringify(results))
```

**In practice:**

```bash
# Both visible
$ kk review origin/main --json > results.json
Starting review...         # stderr (visible on screen)
Submitting to AI...        # stderr (visible on screen)
Review completed!          # stderr (visible on screen)
# results.json contains clean JSON

# Suppress progress
$ kk review origin/main --json 2>/dev/null > results.json
# Only JSON in file, nothing on screen
```

### Error Handling in JSON Mode

**Success:**
```json
{
  "review": { ... },
  "summary": { ... }
}
```

**Error:**
```json
{
  "success": false,
  "error": "API request failed",
  "status": 401,
  "data": {
    "error": "Unauthorized"
  }
}
```

### Parsing JSON

**Using jq:**
```bash
# Extract total issues
cat results.json | jq '.summary.total_issues'

# Check for critical issues
cat results.json | jq '.summary.critical'

# Get all high severity issues
cat results.json | jq '.review.issues[] | select(.severity == "high")'
```

**Using Python:**
```python
import json

with open('results.json') as f:
    results = json.load(f)

total_issues = results['summary']['total_issues']
critical = results['summary']['critical']

if critical > 0:
    print(f"FAILED: {critical} critical issues found")
    exit(1)
```

**Using PowerShell:**
```powershell
$results = Get-Content results.json | ConvertFrom-Json
$critical = $results.summary.critical

if ($critical -gt 0) {
    Write-Error "FAILED: $critical critical issues found"
    exit 1
}
```

## Posting Results to PRs

### Script-Based Approach (Recommended)

korekt-cli provides sophisticated shell scripts that handle PR commenting with advanced features. These scripts are fetched from the repository and executed in your CI/CD pipeline.

**Features:**
- **Inline comments** on specific file:line locations (non-low severity issues)
- **Duplicate detection** - prevents re-posting the same comment
- **Old comment cleanup** - deletes previous bot summary comments
- **Summary comment** with full issue breakdown
- **PR/Commit status** - blocks merges when critical issues found
- **Pagination** - fetches all existing comments across multiple pages
- **Rich formatting** - category/severity emojis, code wrapping
- **Optional AI-assist YAML blocks** - machine-readable fix suggestions

**Available Scripts:**
- `scripts/github.sh` - GitHub Actions
- `scripts/azure.sh` - Azure DevOps
- `scripts/bitbucket.sh` - Bitbucket Pipelines

### GitHub Actions Example

```yaml
- name: Run AI Code Review
  run: kk review origin/${{ github.base_ref }} --json > results.json
  continue-on-error: true

- name: Post PR Comment
  if: always()
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    GITHUB_REPOSITORY: ${{ github.repository }}
    PR_NUMBER: ${{ github.event.pull_request.number }}
    COMMIT_HASH: ${{ github.event.pull_request.head.sha }}
  run: |
    kk get-script github | bash -s results.json
```

**What it does:**
1. Posts inline comments on file:line for each non-low severity issue
2. Checks for duplicates - skips if comment already exists at that location
3. Deletes old summary comments from previous runs
4. Posts new summary comment with all issues/praises
5. Posts commit status (success/failure) that can block PR merges

**Optional Configuration:**
```bash
# Include AI-assist YAML in inline comments
export INCLUDE_AI_ASSIST_INLINE=true

# Include AI-assist YAML in summary
export INCLUDE_AI_ASSIST_SUMMARY=true

# Disable inline comments (summary only)
export POST_INLINE_COMMENTS=false

# Adjust code block width
export MAX_LINE_WIDTH=120
```

### Azure DevOps Example

```yaml
- script: |
    kk review origin/$TARGET_BRANCH --json > results.json
  displayName: 'Run AI Code Review'
  continueOnError: true

- script: |
    kk get-script azure | bash -s results.json
  displayName: 'Post PR Comment'
  condition: and(succeeded(), eq(variables['Build.Reason'], 'PullRequest'))
  env:
    SYSTEM_ACCESSTOKEN: $(System.AccessToken)
    SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: $(System.TeamFoundationCollectionUri)
    SYSTEM_TEAMPROJECT: $(System.TeamProject)
    BUILD_REPOSITORY_ID: $(Build.Repository.ID)
    SYSTEM_PULLREQUEST_PULLREQUESTID: $(System.PullRequest.PullRequestId)
    BUILD_BUILDID: $(Build.BuildId)
```

**What it does:**
1. Posts inline threads on file:line for non-low severity issues
2. Checks for active (non-deleted) comments to prevent duplicates
3. Closes (soft-deletes) old summary threads
4. Posts new summary thread
5. Posts PR status (succeeded/rejected) to block merges

**Azure-specific features:**
- Uses threads API for inline comments
- Handles file path normalization (leading slash)
- Only checks active comments (isDeleted != true)
- Uses proper status states (succeeded/rejected)

### Bitbucket Example

```yaml
- step:
    name: AI Code Review
    script:
      - npm install -g korekt-cli
      - kk config --key "$KOREKT_API_KEY"
      - kk review origin/$BITBUCKET_PR_DESTINATION_BRANCH --json > results.json || true
      - kk get-script bitbucket | bash -s results.json
```

**What it does:**
1. Posts inline comments with file path and line number
2. Deletes old summary comments from previous runs
3. Posts new summary comment
4. Posts commit status (SUCCESSFUL/FAILED) to Bitbucket

**Bitbucket-specific features:**
- Uses `inline.path` and `inline.to` for inline comments
- Uses `content.raw` for markdown content
- Proper pagination with `next` URL extraction

### How the Scripts Work

All three scripts follow the same architecture:

**1. Validation**
```bash
# Verify results.json exists and is valid JSON
if ! jq empty "$RESULTS_FILE" 2>/dev/null; then
  echo "Error: Invalid JSON"
  exit 1
fi
```

**2. Fetch Existing Comments (with Pagination)**
```bash
# GitHub uses Link headers for pagination
fetch_all_comments() {
  while [ -n "$page_url" ]; do
    # Fetch page
    # Merge results
    # Extract next page URL from Link header
  done
}
```

**3. Populate Duplicate Detection Map**
```bash
# Bash associative array tracks file:line locations
declare -A existing_comment_locations
existing_comment_locations["src/file.js:42"]=1
```

**4. Delete Old Summary Comments**
```bash
# Find bot comments (contains marker text)
# Delete via API
delete_old_summary_comments()
```

**5. Post Inline Comments**
```bash
# For each non-low severity issue:
#   - Check if location already has comment (skip if duplicate)
#   - Format with emojis and severity/category
#   - Post to file:line location
#   - Add suggested fix if available
```

**6. Build and Post Summary Comment**
```bash
# Create markdown with:
#   - Praises section
#   - Issues table by severity
#   - Full issue details
#   - Link to pipeline/build
```

**7. Post PR/Commit Status**
```bash
# If critical issues > 0:
#   status = failure/rejected/FAILED
# Else:
#   status = success/succeeded/SUCCESSFUL
```

### Script Distribution

**Bundled with korekt-cli:**
Integration scripts are now bundled with the korekt-cli npm package and can be accessed via the `kk get-script` command:

```bash
# Output script directly to bash
kk get-script github | bash -s results.json

# Or save for inspection/customization
kk get-script bitbucket > bitbucket.sh
chmod +x bitbucket.sh
./bitbucket.sh results.json
```

**Benefits:**
- **Single installation** - Everything needed is in one npm package
- **Version alignment** - Scripts match the kk CLI version
- **Works offline** - No external downloads required
- **No checksum maintenance** - Scripts are versioned with the package

**Security Best Practices:**
1. Review scripts before first use (they're in `node_modules/korekt-cli/scripts/`)
2. Pin korekt-cli version in production for stability:
   ```bash
   npm install -g korekt-cli@0.4.1
   ```
3. Scripts are open source and reviewable at [github.com/korekt-ai/korekt-cli](https://github.com/korekt-ai/korekt-cli)

### Ticket Context Enrichment

Ticket IDs are automatically extracted server-side from branch names and commit messages. The API server handles this based on project configuration.

**Supported branch name patterns:**
- Jira: `feature/PROJ-123-description` → extracts `PROJ-123`
- Azure DevOps: `feature/AB#12345-description` → extracts `AB#12345`

The CLI sends `source_branch` and `commit_messages` to the API, which extracts ticket IDs and fetches context from your configured ticketing system.

## Best Practices

### 1. Always Use --json in CI/CD

```yaml
# ✅ Good
- run: kk review origin/main --json > results.json

# ❌ Bad (hard to parse)
- run: kk review origin/main
```

### 2. Handle Errors Gracefully

```yaml
# Continue on error, check results later
- run: kk review origin/main --json > results.json
  continue-on-error: true

- run: |
    if [ -f results.json ]; then
      CRITICAL=$(jq '.summary.critical // 0' results.json)
      if [ "$CRITICAL" -gt "0" ]; then
        echo "Critical issues found!"
        exit 1
      fi
    fi
```

### 3. Use Full Git History

```yaml
# ✅ Always use fetch-depth: 0
- uses: actions/checkout@v4
  with:
    fetch-depth: 0

# ❌ Shallow clone may fail
- uses: actions/checkout@v4
  with:
    fetch-depth: 1
```

### 4. Cache Dependencies

```yaml
# GitHub Actions (automatic with setup-node@v4)
- uses: actions/setup-node@v4
  with:
    node-version: '20'
    cache: 'npm'

# Azure DevOps / Bitbucket
# npm global install is fast, usually doesn't need caching
```

### 5. Separate Progress from Data

```bash
# View progress while saving JSON
kk review origin/main --json > results.json

# Suppress progress for cleaner logs
kk review origin/main --json 2>/dev/null > results.json

# Debug mode (see both)
kk review origin/main --json 2>&1 | tee output.log > results.json
```

### 6. Validate JSON Before Parsing

```bash
# Check if valid JSON
if jq empty results.json 2>/dev/null; then
  echo "Valid JSON"
else
  echo "Invalid JSON, review failed"
  exit 1
fi
```

### 7. Don't Block Initially

Start with `continue-on-error: true` to gather feedback without disrupting development. Tighten controls once your team is comfortable.

```yaml
# Phase 1: Feedback only
- run: kk review origin/main --json > results.json
  continue-on-error: true

# Phase 2: Block on critical
- run: |
    CRITICAL=$(jq '.summary.critical' results.json)
    if [ "$CRITICAL" -gt "0" ]; then exit 1; fi

# Phase 3: Block on high+critical
- run: |
    CRITICAL=$(jq '.summary.critical' results.json)
    HIGH=$(jq '.summary.high' results.json)
    if [ "$((CRITICAL + HIGH))" -gt "0" ]; then exit 1; fi
```

## Summary

**Local Development:**
- Interactive mode with formatted output
- Quick feedback during development
- `kk review`, `kk stg`, `kk diff`

**CI/CD Integration:**
- Use `--json` flag for machine-readable output
- Progress to stderr, data to stdout
- Parse JSON and post to PRs/tickets
- Full git history required (`fetch-depth: 0`)
- Start permissive, tighten gradually

**Key Insight:**
> korekt-cli handles git operations and AI analysis. Your CI scripts handle result presentation and PR/ticket posting. This separation allows flexibility across platforms and workflows.
