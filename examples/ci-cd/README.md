# CI/CD Integration Examples

Ready-to-use CI/CD configurations for automated code reviews on pull requests.

## Available Platforms

| Platform                | Configuration File                                                       |
|-------------------------|--------------------------------------------------------------------------|
| **GitHub Actions**      | [.github/workflows/pr-review.yml](../../.github/workflows/pr-review.yml) |
| **Azure DevOps**        | [azure-devops/azure-pipelines.yml](azure-devops/azure-pipelines.yml)     |
| **Bitbucket Pipelines** | [bitbucket/bitbucket-pipelines.yml](bitbucket/bitbucket-pipelines.yml)   |

## Setup

1. **Copy the configuration file** for your platform to your repository
2. **Add your API key** as a secret/variable named `KOREKT_API_KEY`
3. **Commit and push** - the workflow will run automatically on pull requests

That's it! The workflow will:
- Run AI code review on every PR
- Post results as a PR comment with inline suggestions
- Set commit status (pass/fail based on critical issues)

## Customization

Each configuration file includes comments explaining how to:
- Change target branches
- Ignore specific files
- Adjust failure behavior
- Customize review scope

## Getting Help

See the [main README](../../README.md) for CLI usage and troubleshooting.