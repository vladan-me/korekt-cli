import { execa } from 'execa';
import chalk from 'chalk';

/**
 * Truncate content to a maximum number of lines using "head and tail".
 * @param {string} content - The string content to truncate
 * @param {number} maxLines - The maximum number of lines to allow (default: 2000)
 * @returns {string} - Truncated content string
 */
export function truncateContent(content, maxLines = 2000) {
  const lines = content.split('\n');
  if (lines.length <= maxLines) {
    return content;
  }

  const halfMax = Math.floor(maxLines / 2);
  const head = lines.slice(0, halfMax).join('\n');
  const tail = lines.slice(-halfMax).join('\n');
  return `${head}\n\n... [truncated] ...\n\n${tail}`;
}

/**
 * Normalize git remote URL to HTTPS format
 * Converts SSH URLs to HTTPS URLs for consistency
 * @param {string} url - The git remote URL
 * @returns {string} - Normalized HTTPS URL
 */
export function normalizeRepoUrl(url) {
  // Handle Azure DevOps SSH format: git@ssh.dev.azure.com:v3/org/project/repo
  const azureDevOpsSshMatch = url.match(/git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+)/);
  if (azureDevOpsSshMatch) {
    const [, org, project, repo] = azureDevOpsSshMatch;
    return `https://dev.azure.com/${org}/${project}/_git/${repo}`;
  }

  // Handle GitHub SSH format: git@github.com:user/repo.git
  const githubSshMatch = url.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (githubSshMatch) {
    const [, user, repo] = githubSshMatch;
    return `https://github.com/${user}/${repo}`;
  }

  // Handle GitLab SSH format: git@gitlab.com:user/repo.git
  const gitlabSshMatch = url.match(/git@gitlab\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (gitlabSshMatch) {
    const [, user, repo] = gitlabSshMatch;
    return `https://gitlab.com/${user}/${repo}`;
  }

  // Handle Bitbucket SSH format: git@bitbucket.org:user/repo.git
  const bitbucketSshMatch = url.match(/git@bitbucket\.org:([^/]+)\/(.+?)(?:\.git)?$/);
  if (bitbucketSshMatch) {
    const [, user, repo] = bitbucketSshMatch;
    return `https://bitbucket.org/${user}/${repo}`;
  }

  // If already HTTPS or other format, return as-is (possibly removing .git suffix)
  return url.replace(/\.git$/, '');
}

/**
 * Check if a file path should be ignored based on patterns
 * Supports glob patterns like *.lock, dist/*
 * @param {string} filePath - The file path to check
 * @param {string[]} patterns - Array of glob patterns to match against
 * @returns {boolean} - True if the file should be ignored
 */
export function shouldIgnoreFile(filePath, patterns) {
  if (!patterns || patterns.length === 0) {
    return false;
  }

  for (const pattern of patterns) {
    // Convert glob pattern to regex
    // Replace * with [^/]* (matches anything except /)
    // Replace ** with .* (matches anything including /)
    let regexPattern = pattern
      .replace(/\./g, '\\.') // Escape dots
      .replace(/\*\*/g, '___DOUBLESTAR___') // Temporarily replace **
      .replace(/\*/g, '[^/]*') // Replace single * with [^/]*
      .replace(/___DOUBLESTAR___/g, '.*') // Replace ** with .*
      .replace(/\?/g, '.'); // Replace ? with .

    // Handle leading **/ pattern - make it optional so it matches both with and without directory prefix
    // For example, **/*.sql should match both "file.sql" and "dir/file.sql"
    regexPattern = regexPattern.replace(/^\.\*\//, '(?:.*/)?');

    // Add start and end anchors
    regexPattern = '^' + regexPattern + '$';

    const regex = new RegExp(regexPattern);

    if (regex.test(filePath)) {
      return true;
    }
  }

  return false;
}

/**
 * Helper function to parse the complex output of git diff --name-status
 */
export function parseNameStatus(output) {
  const files = [];
  const lines = output.split('\n').filter(Boolean);

  for (const line of lines) {
    const parts = line.split('\t');
    const statusRaw = parts[0];
    let oldPath = null;
    let path = null;
    let status = null;

    if (statusRaw.startsWith('R')) {
      // Renamed files have format R<score>\told-path\tnew-path
      status = 'R';
      oldPath = parts[1];
      path = parts[2];
    } else if (statusRaw.startsWith('C')) {
      // Copied files have format C<score>\told-path\tnew-path
      status = 'C';
      oldPath = parts[1];
      path = parts[2];
    } else {
      // M, A, D files have format <status>\t<path>
      status = statusRaw;
      path = parts[1];
      oldPath = parts[1]; // For consistency, oldPath is the same for M, A, D
    }
    files.push({ status, path, oldPath });
  }
  return files;
}

/**
 * Analyze uncommitted changes (staged or unstaged)
 * @param {string} mode - 'staged' or 'unstaged'
 * @returns {Object|null} - The payload object ready for API submission, or null on error
 */
export async function runUncommittedReview(mode = 'unstaged') {
  try {
    // 1. Get Repo URL, current branch name, and repository root
    const { stdout: repoUrl } = await execa('git', ['remote', 'get-url', 'origin']);
    const { stdout: sourceBranch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branchName = sourceBranch.trim();

    // Get the repository root directory - we'll run all git commands from there
    const { stdout: repoRoot } = await execa('git', ['rev-parse', '--show-toplevel']);
    const repoRootPath = repoRoot.trim();

    // Helper to run git commands from repo root
    const git = async (...args) => {
      const { stdout } = await execa('git', args, { cwd: repoRootPath });
      return stdout;
    };

    // 2. Get changed files based on mode
    let nameStatusOutput;
    if (mode === 'staged') {
      nameStatusOutput = await git('diff', '--cached', '--name-status');
      console.error(chalk.gray('Analyzing staged changes...'));
    } else {
      nameStatusOutput = await git('diff', '--name-status');
      console.error(chalk.gray('Analyzing unstaged changes...'));
    }

    const fileList = parseNameStatus(nameStatusOutput);
    const changedFiles = [];

    for (const file of fileList) {
      const { status, path, oldPath } = file;

      // Get diff for this file
      let diff;
      if (mode === 'staged') {
        diff = await git('diff', '--cached', '-U15', '--', path);
      } else {
        diff = await git('diff', '-U15', '--', path);
      }

      // Get current content from HEAD (before changes)
      let content = '';
      if (status !== 'A') {
        try {
          content = await git('show', `HEAD:${oldPath}`);
        } catch {
          console.warn(
            chalk.yellow(`Could not get HEAD content for ${oldPath}. Assuming it's new.`)
          );
        }
      }

      // Truncate content
      content = truncateContent(content);

      // For deleted files, truncate the diff as well
      if (status === 'D') {
        diff = truncateContent(diff);
      }

      changedFiles.push({
        path: path,
        status: status,
        diff: diff,
        content: content,
        ...((status === 'R' || status === 'C') && { old_path: oldPath }),
      });
    }

    if (!nameStatusOutput.trim() && changedFiles.length === 0) {
      console.error(chalk.yellow('No changes found to review.'));
      return null;
    }

    // 3. Assemble payload
    return {
      repo_url: normalizeRepoUrl(repoUrl.trim()),
      commit_messages: [], // No commits for uncommitted changes
      changed_files: changedFiles,
      source_branch: branchName,
    };
  } catch (error) {
    console.error(chalk.red('Failed to analyze uncommitted changes:'), error.message);
    if (error.stderr) {
      console.error(chalk.red('Git Error:'), error.stderr);
    }
    return null;
  }
}

/**
 * Extract contributors from git commits in a range
 * Returns the author (most commits) and full list of contributors
 * @param {string} diffRange - The git range to analyze (e.g., "abc123..HEAD")
 * @param {string} repoRootPath - The repository root directory
 * @returns {Object} - { author_email, author_name, contributors[] }
 */
export async function getContributors(diffRange, repoRootPath) {
  try {
    // Get all commit authors with email and name (exclude merge commits)
    const { stdout: authorOutput } = await execa(
      'git',
      ['log', '--no-merges', '--format=%ae|%an', diffRange],
      { cwd: repoRootPath }
    );

    if (!authorOutput.trim()) {
      return { author_email: null, author_name: null, contributors: [] };
    }

    const lines = authorOutput.trim().split('\n').filter(Boolean);

    // Count commits per email and track name
    const contributorMap = new Map();
    for (const line of lines) {
      const [email, name] = line.split('|');
      if (!email) continue;

      if (!contributorMap.has(email)) {
        contributorMap.set(email, { email, name: name || email, commits: 0 });
      }
      contributorMap.get(email).commits++;
    }

    // Convert to array and sort by commits (descending)
    const contributors = Array.from(contributorMap.values()).sort((a, b) => b.commits - a.commits);

    // Author = most commits
    const author = contributors[0] || null;

    return {
      author_email: author?.email || null,
      author_name: author?.name || null,
      contributors,
    };
  } catch (error) {
    console.warn(chalk.yellow('Could not extract contributors:'), error.message);
    return { author_email: null, author_name: null, contributors: [] };
  }
}

/**
 * Main function to analyze local git changes and prepare review payload
 * @param {string|null} targetBranch - The branch to compare against. If null, uses git reflog to find fork point.
 * @param {string[]|null} ignorePatterns - Array of glob patterns to ignore files
 * @returns {Object|null} - The payload object ready for API submission, or null on error
 */
export async function runLocalReview(targetBranch = null, ignorePatterns = null) {
  try {
    // 1. Get Repo URL, current branch name, and repository root
    const { stdout: repoUrl } = await execa('git', ['remote', 'get-url', 'origin']);
    const { stdout: sourceBranch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branchName = sourceBranch.trim();

    // Get the repository root directory - we'll run all git commands from there
    const { stdout: repoRoot } = await execa('git', ['rev-parse', '--show-toplevel']);
    const repoRootPath = repoRoot.trim();

    // If a branch is provided, check it exists and try to fetch latest remote version
    let targetBranchRef = targetBranch; // Will be updated to origin/branch if remote exists
    if (targetBranch) {
      // Check if user already specified a remote-tracking branch (e.g., origin/master)
      const isRemoteRef = targetBranch.startsWith('origin/');

      if (isRemoteRef) {
        // User specified origin/branch - verify it exists and use it directly
        try {
          await execa('git', ['rev-parse', '--verify', targetBranch]);
          console.error(
            chalk.gray(`Using remote-tracking branch '${targetBranch}' for comparison.`)
          );
          targetBranchRef = targetBranch;
        } catch {
          console.error(chalk.red(`Remote-tracking branch '${targetBranch}' does not exist.`));
          console.error(chalk.gray(`Try fetching it first with: git fetch origin`));
          return null;
        }
      } else {
        // Local branch name specified - check if it exists locally
        try {
          await execa('git', ['rev-parse', '--verify', targetBranch]);
        } catch {
          console.error(chalk.red(`Branch '${targetBranch}' does not exist locally.`));
          console.error(
            chalk.gray(`Please check out the branch first or specify a different one.`)
          );
          return null;
        }

        // Try to fetch the latest changes from remote (non-destructive)
        try {
          console.error(chalk.gray(`Fetching latest changes for branch '${targetBranch}'...`));
          await execa('git', ['fetch', 'origin', targetBranch]);

          // If fetch succeeded, use the remote-tracking branch for comparison
          // This is safer as it doesn't modify the user's local branch
          targetBranchRef = `origin/${targetBranch}`;
          console.error(
            chalk.gray(`Using remote-tracking branch 'origin/${targetBranch}' for comparison.`)
          );
        } catch {
          console.warn(chalk.yellow(`Could not fetch remote branch 'origin/${targetBranch}'.`));
          console.warn(
            chalk.gray(`Proceeding with local branch '${targetBranch}' for comparison.`)
          );
          // targetBranchRef stays as targetBranch (local branch)
        }
      }
    }

    let mergeBase;

    // 2. If no target branch, use git reflog to find fork point
    if (!targetBranch) {
      try {
        // Use git reflog to find where the branch was created
        const { stdout: reflog } = await execa('git', [
          'reflog',
          'show',
          '--no-abbrev-commit',
          branchName,
        ]);
        const lines = reflog.split('\n');

        // Look for the branch creation point (last line in reflog)
        const creationLine = lines[lines.length - 1];
        if (creationLine) {
          const match = creationLine.match(/^([a-f0-9]{40})/);
          if (match) {
            mergeBase = match[1];
            console.error(
              chalk.gray(`Auto-detected fork point from reflog: ${mergeBase.substring(0, 7)}`)
            );
          }
        }

        if (!mergeBase) {
          throw new Error('Could not find fork point in reflog');
        }
      } catch {
        console.error(
          chalk.red('Could not auto-detect fork point. Please specify a target branch.')
        );
        console.error(chalk.gray('Usage: kk review <target-branch>'));
        return null;
      }
    } else {
      // 3. Use specified target branch (either remote-tracking or local)
      const { stdout: base } = await execa('git', ['merge-base', targetBranchRef, 'HEAD']);
      mergeBase = base.trim();
      console.error(
        chalk.gray(
          `Comparing against ${targetBranchRef} (merge-base: ${mergeBase.substring(0, 7)})...`
        )
      );
    }

    const diffRange = `${mergeBase}..HEAD`;
    console.error(chalk.gray(`Analyzing commits from ${mergeBase.substring(0, 7)} to HEAD...`));

    // 3. Get Commit Messages with proper delimiter
    const { stdout: logOutput } = await execa('git', ['log', '--pretty=%B---EOC---', diffRange], {
      cwd: repoRootPath,
    });
    const commitMessages = logOutput
      .split('---EOC---')
      .map((msg) => msg.trim())
      .filter(Boolean);

    // 4. Get changed files and their status
    const { stdout: nameStatusOutput } = await execa('git', ['diff', '--name-status', diffRange], {
      cwd: repoRootPath,
    });
    const fileList = parseNameStatus(nameStatusOutput);

    // Filter out ignored files
    let filteredFileList = fileList;
    let ignoredCount = 0;
    if (ignorePatterns && ignorePatterns.length > 0) {
      filteredFileList = fileList.filter((file) => {
        const ignored = shouldIgnoreFile(file.path, ignorePatterns);
        if (ignored) {
          ignoredCount++;
          console.error(chalk.gray(`  Ignoring: ${file.path}`));
        }
        return !ignored;
      });
    }

    if (ignoredCount > 0) {
      console.error(chalk.gray(`Ignored ${ignoredCount} file(s) based on patterns\n`));
    }

    console.error(chalk.gray(`Collecting diffs for ${filteredFileList.length} file(s)...`));

    const changedFiles = [];
    for (const file of filteredFileList) {
      const { status, path, oldPath } = file;

      // Run git commands from the repository root to handle all file paths correctly
      // This works regardless of whether we're in a subdirectory or at the repo root
      const { stdout: diff } = await execa('git', ['diff', '-U15', diffRange, '--', path], {
        cwd: repoRootPath,
      });

      // Get the original content from the base commit
      let content = '';
      if (status !== 'A') {
        // Added files have no original content
        try {
          const { stdout: originalContent } = await execa(
            'git',
            ['show', `${mergeBase.trim()}:${oldPath}`],
            { cwd: repoRootPath }
          );
          content = originalContent;
        } catch {
          // This can happen if a file was added and modified in the same branch
          console.warn(
            chalk.yellow(`Could not get original content for ${oldPath}. Assuming it was added.`)
          );
        }
      }

      // Truncate content
      content = truncateContent(content);

      // For deleted files, truncate the diff as well
      let truncatedDiff = diff;
      if (status === 'D') {
        truncatedDiff = truncateContent(diff);
      }

      changedFiles.push({
        path: path,
        status: status,
        diff: truncatedDiff,
        content: content,
        ...((status === 'R' || status === 'C') && { old_path: oldPath }), // Include old_path for renames and copies
      });
    }

    // 5. Get contributors from commits
    const { author_email, author_name, contributors } = await getContributors(
      diffRange,
      repoRootPath
    );

    // 6. Assemble the final payload
    return {
      repo_url: normalizeRepoUrl(repoUrl.trim()),
      commit_messages: commitMessages,
      changed_files: changedFiles,
      source_branch: branchName,
      author_email,
      author_name,
      contributors,
    };
  } catch (error) {
    console.error(chalk.red('Failed to run local review analysis:'), error.message);
    if (error.stderr) {
      console.error(chalk.red('Git Error:'), error.stderr);
    }
    return null; // Return null to indicate failure
  }
}
