#!/usr/bin/env node

import { program } from 'commander';
import axios from 'axios';
import chalk from 'chalk';
import readline from 'readline';
import ora from 'ora';
import { runLocalReview } from './git-logic.js';
import { getApiKey, setApiKey, getApiEndpoint, setApiEndpoint, getTicketSystem, setTicketSystem } from './config.js';
import { formatReviewOutput } from './formatter.js';

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
  .version('0.2.0')
  .addHelpText('after', `
Examples:
  $ kk review                      Review committed changes (auto-detect base)
  $ kk review main                 Review changes against main branch
  $ kk stg --dry-run               Preview staged changes review
  $ kk diff                        Review unstaged changes
  $ kk all                         Review all uncommitted changes

Common Options:
  --dry-run                        Show payload without sending to API
  --ticket-system <system>         Use specific ticket system (jira or ado)

Configuration:
  $ kk config --key YOUR_KEY
  $ kk config --endpoint https://api.korekt.ai/review/local
  $ kk config --ticket-system ado
`);

program
  .command('review')
  .description('Review the changes in the current branch.')
  .argument('[target-branch]', 'The branch to compare against (e.g., main, develop). If not specified, auto-detects fork point.')
  .option('--ticket-system <system>', 'Ticket system to use (jira or ado)')
  .option('--dry-run', 'Show payload without sending to API')
  .option('--ignore <patterns...>', 'Ignore files matching these patterns (e.g., "*.lock" "dist/*")')
  .action(async (targetBranch, options) => {
    const reviewTarget = targetBranch ? `against '${targetBranch}'` : '(auto-detecting fork point)';
    console.log(chalk.blue.bold(`🚀 Starting AI Code Review ${reviewTarget}...`));

    const apiKey = getApiKey();
    if (!apiKey) {
      console.error(
        chalk.red('API Key not found! Please run `kk config --key YOUR_KEY` first.')
      );
      return;
    }

    const apiEndpoint = getApiEndpoint();
    if (!apiEndpoint) {
      console.error(
        chalk.red('API Endpoint not found! Please run `kk config --endpoint YOUR_ENDPOINT` first.')
      );
      return;
    }

    // Step 1: Determine ticket system to use (or null if not configured)
    const ticketSystem = options.ticketSystem || getTicketSystem() || null;

    // Validate ticket system
    if (ticketSystem && !['jira', 'ado'].includes(ticketSystem.toLowerCase())) {
      console.error(chalk.red(`Invalid ticket system: ${ticketSystem}`));
      console.error(chalk.gray('Valid options: jira, ado'));
      return;
    }

    // Step 2: Gather all data using our git logic module
    const payload = await runLocalReview(targetBranch, ticketSystem, options.ignore);

    if (!payload) {
      console.error(chalk.red('Could not proceed with review due to errors during analysis.'));
      return;
    }

    // Step 3: Add ticket system to payload if specified
    if (ticketSystem) {
      payload.ticket_system = ticketSystem;
      console.log(chalk.gray(`Using ticket system: ${ticketSystem}`));
    }

    // Step 4: If dry-run, just show the payload and exit
    if (options.dryRun) {
      console.log(chalk.yellow('\n📋 Dry Run - Payload that would be sent:\n'));

      // Create a shortened version for display
      const displayPayload = {
        ...payload,
        changed_files: payload.changed_files.map(file => ({
          path: file.path,
          status: file.status,
          ...(file.old_path && { old_path: file.old_path }),
          diff: file.diff.length > 500 ? `${file.diff.substring(0, 500)}... [truncated ${file.diff.length - 500} chars]` : file.diff,
          content: file.content.length > 500 ? `${file.content.substring(0, 500)}... [truncated ${file.content.length - 500} chars]` : file.content,
        })),
      };

      console.log(JSON.stringify(displayPayload, null, 2));
      console.log(chalk.gray('\n💡 Run without --dry-run to send to API'));
      console.log(chalk.gray('💡 Diffs and content are truncated in dry-run for readability'));
      return;
    }

    // Step 5: Show summary and ask for confirmation
    console.log(chalk.yellow('\n📋 Ready to submit for review:\n'));
    console.log(`  Branch: ${chalk.cyan(payload.source_branch)}`);
    console.log(`  Commits: ${chalk.cyan(payload.commit_messages.length)}`);
    console.log(`  Files: ${chalk.cyan(payload.changed_files.length)}\n`);

    console.log(chalk.bold('  Files to review:'));
    payload.changed_files.forEach(file => {
      const statusColor = {
        'M': chalk.yellow,
        'A': chalk.green,
        'D': chalk.red,
        'R': chalk.blue,
        'C': chalk.cyan,
      }[file.status] || (text => text);
      console.log(`    ${statusColor(file.status + ' ' + file.path)}`);
    });
    console.log();

    const confirmed = await confirmAction(chalk.bold('Proceed with AI review? (Y/n): '));

    if (!confirmed) {
      console.log(chalk.yellow('Review cancelled.'));
      return;
    }

    // Step 6: Send the payload to your API
    const spinner = ora('Submitting review to the AI...').start();
    const startTime = Date.now();

    // Update spinner with elapsed time every second
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      spinner.text = `Submitting review to the AI... ${elapsed}s`;
    }, 1000);

    try {
      const response = await axios.post(apiEndpoint, payload, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      clearInterval(timer);
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      spinner.succeed(`Review completed in ${elapsed}s!`);

      // Step 6: Format and display the results beautifully
      formatReviewOutput(response.data);
    } catch (error) {
      clearInterval(timer);
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      spinner.fail(`Review failed after ${elapsed}s`);
      console.error(chalk.red('\n❌ An error occurred during the API request:'));
      if (error.response) {
        console.error(chalk.red('Status:'), error.response.status);
        console.error(chalk.red('Data:'), JSON.stringify(error.response.data, null, 2));
      } else {
        console.error(error.message);
      }
    }
  });

program
  .command('review-staged')
  .aliases(['stg', 'staged', 'cached'])
  .description('Review staged changes (git diff --cached)')
  .option('--ticket-system <system>', 'Ticket system to use (jira or ado)')
  .option('--dry-run', 'Show payload without sending to API')
  .action(async (options) => {
    console.log(chalk.blue.bold('🚀 Reviewing staged changes...'));
    await reviewUncommitted('staged', options);
  });

program
  .command('review-unstaged')
  .alias('diff')
  .description('Review unstaged changes (git diff)')
  .option('--ticket-system <system>', 'Ticket system to use (jira or ado)')
  .option('--dry-run', 'Show payload without sending to API')
  .option('--untracked', 'Include untracked files in the review')
  .action(async (options) => {
    console.log(chalk.blue.bold('🚀 Reviewing unstaged changes...'));
    await reviewUncommitted('unstaged', options);
  });

program
  .command('review-all-uncommitted')
  .alias('all')
  .description('Review all uncommitted changes (staged + unstaged)')
  .option('--ticket-system <system>', 'Ticket system to use (jira or ado)')
  .option('--dry-run', 'Show payload without sending to API')
  .option('--untracked', 'Include untracked files in the review')
  .action(async (options) => {
    console.log(chalk.blue.bold('🚀 Reviewing all uncommitted changes...'));
    await reviewUncommitted('all', options);
  });

async function reviewUncommitted(mode, options) {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error(
      chalk.red('API Key not found! Please run `kk config --key YOUR_KEY` first.')
    );
    return;
  }

  const apiEndpoint = getApiEndpoint();
  if (!apiEndpoint) {
    console.error(
      chalk.red('API Endpoint not found! Please run `kk config --endpoint YOUR_ENDPOINT` first.')
    );
    return;
  }

  const ticketSystem = options.ticketSystem || getTicketSystem() || null;

  if (ticketSystem && !['jira', 'ado'].includes(ticketSystem.toLowerCase())) {
    console.error(chalk.red(`Invalid ticket system: ${ticketSystem}`));
    console.error(chalk.gray('Valid options: jira, ado'));
    return;
  }

  // Import the function we'll create
  const { runUncommittedReview } = await import('./git-logic.js');
  const payload = await runUncommittedReview(mode, ticketSystem, options.untracked);

  if (!payload) {
    // No changes found or error occurred - message already printed by runUncommittedReview
    return;
  }

  if (ticketSystem) {
    payload.ticket_system = ticketSystem;
    console.log(chalk.gray(`Using ticket system: ${ticketSystem}`));
  }

  if (options.dryRun) {
    console.log(chalk.yellow('\n📋 Dry Run - Payload that would be sent:\n'));

    const displayPayload = {
      ...payload,
      changed_files: payload.changed_files.map(file => ({
        path: file.path,
        status: file.status,
        ...(file.old_path && { old_path: file.old_path }),
        diff: file.diff.length > 500 ? `${file.diff.substring(0, 500)}... [truncated ${file.diff.length - 500} chars]` : file.diff,
        content: file.content.length > 500 ? `${file.content.substring(0, 500)}... [truncated ${file.content.length - 500} chars]` : file.content,
      })),
    };

    console.log(JSON.stringify(displayPayload, null, 2));
    console.log(chalk.gray('\n💡 Run without --dry-run to send to API'));
    console.log(chalk.gray('💡 Diffs and content are truncated in dry-run for readability'));
    return;
  }

  // Show summary and ask for confirmation
  console.log(chalk.yellow('\n📋 Ready to submit uncommitted changes for review:\n'));
  console.log(chalk.gray('  Comparing against HEAD (last commit)\n'));
  console.log(chalk.bold('  Files to review:'));
  payload.changed_files.forEach(file => {
    const statusColor = {
      'M': chalk.yellow,
      'A': chalk.green,
      'D': chalk.red,
      'R': chalk.blue,
      'C': chalk.cyan,
    }[file.status] || (text => text);
    console.log(`    ${statusColor(file.status + ' ' + file.path)}`);
  });
  console.log();

  const confirmed = await confirmAction(chalk.bold('Proceed with AI review? (Y/n): '));

  if (!confirmed) {
    console.log(chalk.yellow('Review cancelled.'));
    return;
  }

  const spinner = ora('Submitting review to the AI...').start();
  const startTime = Date.now();

  // Update spinner with elapsed time every second
  const timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    spinner.text = `Submitting review to the AI... ${elapsed}s`;
  }, 1000);

  try {
    const response = await axios.post(apiEndpoint, payload, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    clearInterval(timer);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    spinner.succeed(`Review completed in ${elapsed}s!`);

    formatReviewOutput(response.data);
  } catch (error) {
    clearInterval(timer);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    spinner.fail(`Review failed after ${elapsed}s`);
    console.error(chalk.red('\n❌ An error occurred during the API request:'));
    if (error.response) {
      console.error(chalk.red('Status:'), error.response.status);
      console.error(chalk.red('Data:'), JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
    }
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
      console.log(`  API Endpoint: ${apiEndpoint ? chalk.cyan(apiEndpoint) : chalk.red('✗ Not set')}`);
      console.log(`  Ticket System: ${ticketSystem ? chalk.cyan(ticketSystem) : chalk.gray('Not configured')}\n`);
      return;
    }

    if (options.key) {
      setApiKey(options.key);
      console.log(chalk.green('✓ API Key saved successfully!'));
    }
    if (options.endpoint) {
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

program.parse();
