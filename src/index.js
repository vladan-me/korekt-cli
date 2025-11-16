#!/usr/bin/env node

import { program } from 'commander';
import axios from 'axios';
import chalk from 'chalk';
import readline from 'readline';
import ora from 'ora';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runLocalReview } from './git-logic.js';
import {
  getApiKey,
  setApiKey,
  getApiEndpoint,
  setApiEndpoint,
  getTicketSystem,
  setTicketSystem,
} from './config.js';
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

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      // Default to 'yes' if the user just presses Enter
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes' || answer === '');
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
  $ kk all                         Review all uncommitted changes
  $ kk review main --json          Output raw JSON (for CI/CD integration)

Common Options:
  --dry-run                        Show payload without sending to API
  --json                           Output raw API response as JSON
  --ticket-system <system>         Use specific ticket system (jira or ado)

Configuration:
  $ kk config --key YOUR_KEY
  $ kk config --endpoint https://api.korekt.ai/review/local
  $ kk config --ticket-system ado

CI/CD Integration:
  $ kk get-script github           Output GitHub Actions integration script
  $ kk get-script bitbucket        Output Bitbucket Pipelines integration script
  $ kk get-script azure            Output Azure DevOps integration script
`
  );

program
  .command('review')
  .description('Review the changes in the current branch.')
  .argument(
    '[target-branch]',
    'The branch to compare against (e.g., main, develop). If not specified, auto-detects fork point.'
  )
  .option('--ticket-system <system>', 'Ticket system to use (jira or ado)')
  .option('--dry-run', 'Show payload without sending to API')
  .option(
    '--ignore <patterns...>',
    'Ignore files matching these patterns (e.g., "*.lock" "dist/*")'
  )
  .option('--json', 'Output raw API response as JSON')
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

    // Determine ticket system to use (or null if not configured)
    const ticketSystem = options.ticketSystem || getTicketSystem() || null;

    // Validate ticket system
    if (ticketSystem && !['jira', 'ado'].includes(ticketSystem.toLowerCase())) {
      log(chalk.red(`Invalid ticket system: ${ticketSystem}`));
      log(chalk.gray('Valid options: jira, ado'));
      process.exit(1);
    }

    // Gather all data using our git logic module
    const payload = await runLocalReview(targetBranch, ticketSystem, options.ignore);

    if (!payload) {
      log(chalk.red('Could not proceed with review due to errors during analysis.'));
      process.exit(1);
    }

    // Add ticket system to payload if specified
    if (ticketSystem) {
      payload.ticket_system = ticketSystem;
      log(chalk.gray(`Using ticket system: ${ticketSystem}`));
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

    // Show summary and ask for confirmation (auto-confirm in JSON mode)
    if (!options.json) {
      log(chalk.yellow('\n📋 Ready to submit for review:\n'));
      log(`  Branch: ${chalk.cyan(payload.source_branch)}`);
      log(`  Commits: ${chalk.cyan(payload.commit_messages.length)}`);
      log(`  Files: ${chalk.cyan(payload.changed_files.length)}\n`);

      log(chalk.bold('  Files to review:'));
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
  .option('--ticket-system <system>', 'Ticket system to use (jira or ado)')
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
  .option('--ticket-system <system>', 'Ticket system to use (jira or ado)')
  .option('--dry-run', 'Show payload without sending to API')
  .option('--untracked', 'Include untracked files in the review')
  .option('--json', 'Output raw API response as JSON')
  .action(async (options) => {
    log(chalk.blue.bold('🚀 Reviewing unstaged changes...'));
    await reviewUncommitted('unstaged', options);
  });

program
  .command('review-all-uncommitted')
  .alias('all')
  .description('Review all uncommitted changes (staged + unstaged)')
  .option('--ticket-system <system>', 'Ticket system to use (jira or ado)')
  .option('--dry-run', 'Show payload without sending to API')
  .option('--untracked', 'Include untracked files in the review')
  .option('--json', 'Output raw API response as JSON')
  .action(async (options) => {
    log(chalk.blue.bold('🚀 Reviewing all uncommitted changes...'));
    await reviewUncommitted('all', options);
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

  const ticketSystem = options.ticketSystem || getTicketSystem() || null;

  if (ticketSystem && !['jira', 'ado'].includes(ticketSystem.toLowerCase())) {
    log(chalk.red(`Invalid ticket system: ${ticketSystem}`));
    log(chalk.gray('Valid options: jira, ado'));
    process.exit(1);
  }

  const { runUncommittedReview } = await import('./git-logic.js');
  const payload = await runUncommittedReview(mode, ticketSystem, options.untracked);

  if (!payload) {
    log(chalk.red('No changes found or error occurred during analysis.'));
    process.exit(1);
  }

  if (ticketSystem) {
    payload.ticket_system = ticketSystem;
    log(chalk.gray(`Using ticket system: ${ticketSystem}`));
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
    log(chalk.bold('  Files to review:'));
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
  .option('--ticket-system <system>', 'Ticket system (jira, ado)')
  .option('--show', 'Show current configuration')
  .action((options) => {
    // Show current config if --show flag is used
    if (options.show) {
      const apiKey = getApiKey();
      const apiEndpoint = getApiEndpoint();
      const ticketSystem = getTicketSystem();

      console.log(chalk.bold('\nCurrent Configuration:\n'));
      console.log(`  API Key: ${apiKey ? chalk.green('✓ Set') : chalk.red('✗ Not set')}`);
      console.log(
        `  API Endpoint: ${apiEndpoint ? chalk.cyan(apiEndpoint) : chalk.red('✗ Not set')}`
      );
      console.log(
        `  Ticket System: ${ticketSystem ? chalk.cyan(ticketSystem) : chalk.gray('Not configured')}\n`
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
    if (options.ticketSystem !== undefined) {
      if (options.ticketSystem === '') {
        // Clear ticket system
        setTicketSystem(null);
        console.log(chalk.green('✓ Ticket System cleared!'));
      } else {
        // Validate ticket system
        const validSystems = ['jira', 'ado'];
        if (!validSystems.includes(options.ticketSystem.toLowerCase())) {
          console.error(chalk.red(`Invalid ticket system: ${options.ticketSystem}`));
          console.error(chalk.gray(`Valid options: ${validSystems.join(', ')}`));
          return;
        }
        setTicketSystem(options.ticketSystem);
        console.log(chalk.green('✓ Ticket System saved successfully!'));
      }
    }
    if (!options.key && !options.endpoint && options.ticketSystem === undefined && !options.show) {
      console.log(chalk.yellow('Please provide at least one configuration option.'));
      console.log('\nUsage:');
      console.log('  kk config --key YOUR_API_KEY');
      console.log('  kk config --endpoint https://api.korekt.ai/review/local');
      console.log('  kk config --ticket-system jira');
      console.log('  kk config --show              (view current configuration)');
    }
  });

program
  .command('get-script <provider>')
  .description('Output a CI/CD integration script for a specific provider')
  .addHelpText(
    'after',
    `
Providers:
  github      GitHub Actions integration script
  bitbucket   Bitbucket Pipelines integration script
  azure       Azure DevOps integration script

Usage:
  kk get-script github | bash -s results.json
  kk get-script bitbucket > bitbucket.sh && chmod +x bitbucket.sh
  kk get-script azure > azure.sh
`
  )
  .action((provider) => {
    const validProviders = ['github', 'bitbucket', 'azure'];

    if (!validProviders.includes(provider.toLowerCase())) {
      console.error(chalk.red(`Invalid provider: ${provider}`));
      console.error(chalk.gray(`Valid providers: ${validProviders.join(', ')}`));
      process.exit(1);
    }

    try {
      // Get the directory where this script is located
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);

      // Build path to the script file
      const scriptPath = join(__dirname, '..', 'scripts', `${provider.toLowerCase()}.sh`);

      // Read and output the script
      const scriptContent = readFileSync(scriptPath, 'utf8');
      output(scriptContent);
    } catch (error) {
      console.error(chalk.red(`Failed to read script: ${error.message}`));
      process.exit(1);
    }
  });

// Only parse arguments if this file is being run directly (not imported)
// In tests, we set NODE_ENV to 'test' via vitest
if (process.env.NODE_ENV !== 'test') {
  program.parse();
}
