/**
 * Detect CI provider from environment variables
 * @returns {string|null} Provider name or null if not detected
 */
export function detectCIProvider() {
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
    return 'github';
  }
  if (process.env.SYSTEM_ACCESSTOKEN && process.env.SYSTEM_PULLREQUEST_PULLREQUESTID) {
    return 'azure';
  }
  if (process.env.BITBUCKET_REPO_SLUG && process.env.BITBUCKET_PR_ID) {
    return 'bitbucket';
  }
  return null;
}

/**
 * Truncates file data (diff and content) for display purposes
 * @param {Object} file - File object with path, status, diff, content, etc.
 * @param {number} maxLength - Maximum length before truncation (default: 500)
 * @returns {Object} File object with truncated diff and content
 */
export function truncateFileData(file, maxLength = 500) {
  return {
    path: file.path,
    status: file.status,
    ...(file.old_path && { old_path: file.old_path }),
    diff:
      file.diff.length > maxLength
        ? `${file.diff.substring(0, maxLength)}... [truncated ${file.diff.length - maxLength} chars]`
        : file.diff,
    content:
      file.content.length > maxLength
        ? `${file.content.substring(0, maxLength)}... [truncated ${file.content.length - maxLength} chars]`
        : file.content,
  };
}

/**
 * Formats error object for JSON output
 * @param {Error} error - Error object from axios or other source
 * @returns {Object} Formatted error output with success: false
 */
export function formatErrorOutput(error) {
  return {
    success: false,
    error: error.message,
    ...(error.response && {
      status: error.response.status,
      data: error.response.data,
    }),
  };
}
