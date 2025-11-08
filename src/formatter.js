import chalk from 'chalk';
import path from 'path';
import { execaSync } from 'execa';

// Emojis and colors inspired by the provided ADO script
const SEVERITY_ICONS = {
  critical: '🟣',
  high: '🔴',
  medium: '🟠',
  low: '🟡',
};

const SEVERITY_COLORS = {
  critical: chalk.magenta.bold,
  high: chalk.red.bold,
  medium: chalk.yellow.bold,
  low: chalk.gray.bold,
};

const CATEGORY_ICONS = {
  bug: '🐞',
  security: '🛡️',
  best_practice: '✨',
  dependency: '📦',
  performance: '🚀',
  rbac: '🔑',
  syntax: '📝',
  clean_code: '🧼',
  documentation: '📝',
  test_coverage: '🧪',
  readability: '📖',
  default: '⚙️', // Default icon
};

/**
 * Capitalize and replace underscores for category display.
 * @param {string} category
 * @returns {string}
 */
function formatCategory(category) {
  if (!category) return '';
  return category.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Get the git repository root directory.
 * @returns {string} - Absolute path to the git repository root
 */
function getGitRoot() {
  try {
    const { stdout } = execaSync('git', ['rev-parse', '--show-toplevel']);
    return stdout.trim();
  } catch {
    // Fallback to current working directory if not in a git repo
    return process.cwd();
  }
}

/**
 * Convert a relative file path to an absolute path for better IDE integration.
 * @param {string} filePath - The file path from the API response
 * @returns {string} - Absolute file path
 */
function toAbsolutePath(filePath) {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  const gitRoot = getGitRoot();
  return path.join(gitRoot, filePath);
}

/**
 * Format and display the API response in the new, detailed style.
 * @param {Object} data - The API response data
 */
export function formatReviewOutput(data) {
  const { review, summary } = data.data;

  console.log(chalk.bold.blue('🤖 Automated Code Review Results\n'));

  // --- Praises Section ---
  if (review && review.praises && review.praises.length > 0) {
    console.log(chalk.bold.magenta(`✨ Praises (${summary.total_praises})`));
    review.praises.forEach((praise) => {
      const formattedCategory = formatCategory(praise.category);
      const absolutePath = toAbsolutePath(praise.file_path);
      console.log(
        `  ✅ ${chalk.green.bold(formattedCategory)} in ${absolutePath}:${praise.line_number}`
      );
      console.log(`     ${praise.message}\n`);
    });
  }

  // --- Issues Section ---
  if (review && review.issues && review.issues.length > 0) {
    console.log(chalk.bold.red(`⚠️  Issues Found (${summary.total_issues})`));

    // Severity Summary Table
    console.log(chalk.underline('Severity Count:'));
    const severities = ['critical', 'high', 'medium', 'low'];
    severities.forEach((severity) => {
      const count = summary[severity] || 0;
      if (count > 0) {
        const icon = SEVERITY_ICONS[severity];
        const color = SEVERITY_COLORS[severity];
        const label = severity.charAt(0).toUpperCase() + severity.slice(1);
        console.log(`${icon} ${color(label)}: ${count}`);
      }
    });
    console.log(''); // Newline for spacing

    // Issues Details
    review.issues.forEach((issue, index) => {
      const severityIcon = SEVERITY_ICONS[issue.severity] || '❓';
      const severityColor = SEVERITY_COLORS[issue.severity] || chalk.white;
      const categoryIcon = CATEGORY_ICONS[issue.category] || CATEGORY_ICONS.default;
      const formattedCategory = formatCategory(issue.category);
      const absolutePath = toAbsolutePath(issue.file_path);

      console.log(
        `${severityIcon} ${severityColor(
          issue.severity.toUpperCase()
        )} in ${absolutePath}:${issue.line_number} (${categoryIcon} ${formattedCategory})`
      );
      console.log(`   ${issue.message}`);

      if (issue.suggested_fix) {
        console.log(chalk.bold('\n💡 Suggested Fix:'));
        // Indent the suggested fix for readability
        const indentedFix = issue.suggested_fix
          .split('\n')
          .map((line) => `   ${line}`)
          .join('\n');
        console.log(chalk.green(indentedFix));
      }

      // Add separator between issues (but not after the last one)
      if (index < review.issues.length - 1) {
        const terminalWidth = process.stdout.columns || 80;
        console.log(chalk.gray('─'.repeat(terminalWidth)));
      }
      console.log(); // Add a blank line for spacing
    });
  }
}
