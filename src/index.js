#!/usr/bin/env node

import { program } from 'commander';
import axios from 'axios';
import chalk from 'chalk';
import readline from 'readline';
import ora from 'ora';
import { createRequire } from 'module';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { runLocalReview } from './git-logic.js';
import { getApiKey, setApiKey, getApiEndpoint, setApiEndpoint } from './config.js';
import { formatReviewOutput } from './formatter.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

/**
 * Helper functions for clean output separation:
 * - log() writes to stderr (progress, info, errors)
 * - output() writes to stdout (final data only)
 */
const log = (msg) => process.stderr.write(msg + '\n');
const output = (msg) => process.stdout.write(msg + '\n');

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

/**
 * Ask for user confirmation before proceeding
 */
async function confirmAction(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolvePromise) => {
    rl.question(message, (answer) => {
      rl.close();
      // Default to 'yes' if the user just presses Enter
      resolvePromise(
        answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes' || answer === ''
      );
    });
  });
}

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
 * Run the CI integration script to post comments
 * @param {string} provider - CI provider (github, azure, bitbucket)
 * @param {Object} results - Review results from API
 * @returns {Promise<void>}
 */
async function runCIScript(provider, results) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const scriptPath = resolve(__dirname, '..', 'scripts', `${provider}.sh`);

  // Create secure temp directory and write results
  const tempDir = mkdtempSync(join(tmpdir(), 'korekt-'));
  const tempFile = join(tempDir, 'results.json');
  writeFileSync(tempFile, JSON.stringify(results, null, 2));

  return new Promise((resolvePromise, reject) => {
    const cleanup = () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch (err) {
        log(chalk.yellow(`Warning: Failed to clean up temp directory: ${err.message}`));
      }
    };

    const child = spawn('bash', [scriptPath, tempFile], {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('close', (code) => {
      cleanup();
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`CI script exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}

program
  .name('kk')
  .description('AI-powered code review CLI - Keep your kode korekt')
  .version(version)
  .addHelpText(
    'after',
    `
Examples:
  $ kk review                      Review committed changes (auto-detect base)
  $ kk review main                 Review changes against main branch
  $ kk stg --dry-run               Preview staged changes review
  $ kk diff                        Review unstaged changes
  $ kk review main --json          Output raw JSON (for CI/CD integration)
  $ kk review main --comment       Review and post comments to PR (CI/CD)

Common Options:
  --dry-run                        Show payload without sending to API
  --json                           Output raw API response as JSON
  --comment                        Post review results as PR comments

Configuration:
  $ kk config --key YOUR_KEY
  $ kk config --endpoint https://api.korekt.ai/api/review
`
  );

program
  .command('review')
  .description('Review the changes in the current branch.')
  .argument(
    '[target-branch]',
    'The branch to compare against (e.g., main, develop). If not specified, auto-detects fork point.'
  )
  .option('--dry-run', 'Show payload without sending to API')
  .option(
    '--ignore <patterns...>',
    'Ignore files matching these patterns (e.g., "*.lock" "dist/*")'
  )
  .option('--json', 'Output raw API response as JSON')
  .option('--comment', 'Post review results as PR comments (auto-detects CI provider)')
  .action(async (targetBranch, options) => {
    const reviewTarget = targetBranch ? `against '${targetBranch}'` : '(auto-detecting fork point)';

    // Progress messages go to stderr
    log(chalk.blue.bold(`🚀 Starting AI Code Review ${reviewTarget}...`));

    const apiKey = getApiKey();
    if (!apiKey) {
      log(chalk.red('API Key not found! Please run `kk config --key YOUR_KEY` first.'));
      process.exit(1);
    }

    const apiEndpoint = getApiEndpoint();
    if (!apiEndpoint) {
      log(
        chalk.red('API Endpoint not found! Please run `kk config --endpoint YOUR_ENDPOINT` first.')
      );
      process.exit(1);
    }

    // Gather all data using our git logic module
    const payload = await runLocalReview(targetBranch, options.ignore);

    if (!payload) {
      log(chalk.red('Could not proceed with review due to errors during analysis.'));
      process.exit(1);
    }

    // If dry-run, just show the payload and exit
    if (options.dryRun) {
      log(chalk.yellow('\n📋 Dry Run - Payload that would be sent:\n'));

      // Create a shortened version for display
      const displayPayload = {
        ...payload,
        changed_files: payload.changed_files.map((file) => truncateFileData(file)),
      };

      log(JSON.stringify(displayPayload, null, 2));
      log(chalk.gray('\n💡 Run without --dry-run to send to API'));
      log(chalk.gray('💡 Diffs and content are truncated in dry-run for readability'));
      return;
    }

    // Show summary and ask for confirmation (auto-confirm in JSON/comment mode)
    if (!options.json && !options.comment) {
      log(chalk.yellow('\n📋 Ready to submit for review:\n'));
      log(`  Branch: ${chalk.cyan(payload.source_branch)}`);
      log(`  Commits: ${chalk.cyan(payload.commit_messages.length)}`);
      log(`  Files: ${chalk.cyan(payload.changed_files.length)}\n`);

      log(chalk.bold(`  ${payload.changed_files.length} files to review:`));
      payload.changed_files.forEach((file) => {
        const statusColor =
          {
            M: chalk.yellow,
            A: chalk.green,
            D: chalk.red,
            R: chalk.blue,
            C: chalk.cyan,
          }[file.status] || ((text) => text);
        log(`    ${statusColor(file.status + ' ' + file.path)}`);
      });
      log('');

      const confirmed = await confirmAction(chalk.bold('Proceed with AI review? (Y/n): '));

      if (!confirmed) {
        log(chalk.yellow('Review cancelled.'));
        return;
      }
    }

    // Send the payload to API with progress indicator
    const spinner = ora('Submitting review to the AI...').start();
    const startTime = Date.now();

    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      spinner.text = `Submitting review to the AI... ${elapsed}s`;
    }, 1000);

    try {
      const response = await axios.post(apiEndpoint, payload, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      clearInterval(timer);
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      spinner.succeed(`Review completed in ${elapsed}s!`);

      // Handle --comment flag: post results to PR
      if (options.comment) {
        const provider = detectCIProvider();
        if (!provider) {
          log(
            chalk.red(
              'Could not detect CI provider. Make sure required environment variables are set:'
            )
          );
          log(chalk.gray('  GitHub: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, COMMIT_HASH'));
          log(chalk.gray('  Azure: SYSTEM_ACCESSTOKEN, SYSTEM_PULLREQUEST_PULLREQUESTID'));
          log(chalk.gray('  Bitbucket: BITBUCKET_REPO_SLUG, BITBUCKET_PR_ID'));
          process.exit(1);
        }

        log(chalk.blue(`Posting review comments to ${provider}...`));
        try {
          await runCIScript(provider, response.data);
          log(chalk.green('Successfully posted review comments!'));
        } catch (err) {
          log(chalk.red(`Failed to post comments: ${err.message}`));
          process.exit(1);
        }
        return;
      }

      // Output results to stdout
      if (options.json) {
        output(JSON.stringify(response.data, null, 2));
      } else {
        formatReviewOutput(response.data);
      }
    } catch (error) {
      clearInterval(timer);
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      spinner.fail(`Review failed after ${elapsed}s`);

      // Error details to stderr
      log(chalk.red('\n❌ An error occurred during the API request:'));
      if (error.response) {
        log(chalk.red('Status:') + ' ' + error.response.status);
        log(chalk.red('Data:') + ' ' + JSON.stringify(error.response.data, null, 2));
      } else {
        log(error.message);
      }

      // If JSON mode, also output error as JSON to stdout
      if (options.json) {
        output(JSON.stringify(formatErrorOutput(error), null, 2));
      }

      process.exit(1);
    }
  });

program
  .command('review-staged')
  .aliases(['stg', 'staged', 'cached'])
  .description('Review staged changes (git diff --cached)')
  .option('--dry-run', 'Show payload without sending to API')
  .option('--json', 'Output raw API response as JSON')
  .action(async (options) => {
    log(chalk.blue.bold('🚀 Reviewing staged changes...'));
    await reviewUncommitted('staged', options);
  });

program
  .command('review-unstaged')
  .alias('diff')
  .description('Review unstaged changes (git diff)')
  .option('--dry-run', 'Show payload without sending to API')
  .option('--json', 'Output raw API response as JSON')
  .action(async (options) => {
    log(chalk.blue.bold('🚀 Reviewing unstaged changes...'));
    await reviewUncommitted('unstaged', options);
  });

async function reviewUncommitted(mode, options) {
  const apiKey = getApiKey();
  if (!apiKey) {
    log(chalk.red('API Key not found! Please run `kk config --key YOUR_KEY` first.'));
    process.exit(1);
  }

  const apiEndpoint = getApiEndpoint();
  if (!apiEndpoint) {
    log(
      chalk.red('API Endpoint not found! Please run `kk config --endpoint YOUR_ENDPOINT` first.')
    );
    process.exit(1);
  }

  const { runUncommittedReview } = await import('./git-logic.js');
  const payload = await runUncommittedReview(mode);

  if (!payload) {
    log(chalk.red('No changes found or error occurred during analysis.'));
    process.exit(1);
  }

  if (options.dryRun) {
    log(chalk.yellow('\n📋 Dry Run - Payload that would be sent:\n'));

    const displayPayload = {
      ...payload,
      changed_files: payload.changed_files.map((file) => truncateFileData(file)),
    };

    log(JSON.stringify(displayPayload, null, 2));
    log(chalk.gray('\n💡 Run without --dry-run to send to API'));
    log(chalk.gray('💡 Diffs and content are truncated in dry-run for readability'));
    return;
  }

  // Show summary and ask for confirmation (auto-confirm in JSON mode)
  if (!options.json) {
    log(chalk.yellow('\n📋 Ready to submit uncommitted changes for review:\n'));
    log(chalk.gray('  Comparing against HEAD (last commit)\n'));
    log(chalk.bold(`  ${payload.changed_files.length} files to review:`));
    payload.changed_files.forEach((file) => {
      const statusColor =
        {
          M: chalk.yellow,
          A: chalk.green,
          D: chalk.red,
          R: chalk.blue,
          C: chalk.cyan,
        }[file.status] || ((text) => text);
      log(`    ${statusColor(file.status + ' ' + file.path)}`);
    });
    log('');

    const confirmed = await confirmAction(chalk.bold('Proceed with AI review? (Y/n): '));

    if (!confirmed) {
      log(chalk.yellow('Review cancelled.'));
      return;
    }
  }

  const spinner = ora('Submitting review to the AI...').start();
  const startTime = Date.now();

  const timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    spinner.text = `Submitting review to the AI... ${elapsed}s`;
  }, 1000);

  try {
    const response = await axios.post(apiEndpoint, payload, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    clearInterval(timer);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    spinner.succeed(`Review completed in ${elapsed}s!`);

    // Output results to stdout
    if (options.json) {
      output(JSON.stringify(response.data, null, 2));
    } else {
      formatReviewOutput(response.data);
    }
  } catch (error) {
    clearInterval(timer);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    spinner.fail(`Review failed after ${elapsed}s`);

    // Error details to stderr
    log(chalk.red('\n❌ An error occurred during the API request:'));
    if (error.response) {
      log(chalk.red('Status:') + ' ' + error.response.status);
      log(chalk.red('Data:') + ' ' + JSON.stringify(error.response.data, null, 2));
    } else {
      log(error.message);
    }

    // If JSON mode, also output error as JSON to stdout
    if (options.json) {
      output(JSON.stringify(formatErrorOutput(error), null, 2));
    }

    process.exit(1);
  }
}

program
  .command('config')
  .description('Configure API settings')
  .option('--key <key>', 'Your API key')
  .option('--endpoint <endpoint>', 'Your API endpoint URL')
  .option('--show', 'Show current configuration')
  .action((options) => {
    // Show current config if --show flag is used
    if (options.show) {
      const apiKey = getApiKey();
      const apiEndpoint = getApiEndpoint();

      console.log(chalk.bold('\nCurrent Configuration:\n'));
      console.log(`  API Key: ${apiKey ? chalk.green('✓ Set') : chalk.red('✗ Not set')}`);
      console.log(
        `  API Endpoint: ${apiEndpoint ? chalk.cyan(apiEndpoint) : chalk.red('✗ Not set')}\n`
      );
      return;
    }

    if (options.key !== undefined) {
      if (!options.key || options.key.trim() === '') {
        console.error(chalk.red('API Key cannot be empty'));
        process.exit(1);
      }
      setApiKey(options.key);
      console.log(chalk.green('✓ API Key saved successfully!'));
    }
    if (options.endpoint !== undefined) {
      if (!options.endpoint || options.endpoint.trim() === '') {
        console.error(chalk.red('API Endpoint cannot be empty'));
        process.exit(1);
      }
      setApiEndpoint(options.endpoint);
      console.log(chalk.green('✓ API Endpoint saved successfully!'));
    }
    if (!options.key && !options.endpoint && !options.show) {
      console.log(chalk.yellow('Please provide at least one configuration option.'));
      console.log('\nUsage:');
      console.log('  kk config --key YOUR_API_KEY');
      console.log('  kk config --endpoint https://api.korekt.ai/api/review');
      console.log('  kk config --show              (view current configuration)');
    }
  });

// Only parse arguments if this file is being run directly (not imported)
// In tests, we set NODE_ENV to 'test' via vitest
if (process.env.NODE_ENV !== 'test') {
  program.parse();
}
