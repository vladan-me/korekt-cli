# Vladan CLI

An AI-powered code reviewer CLI that integrates with your local Git workflow.

## Features

*   **Local Code Analysis**: Reviews your code locally without pushing to a remote repository.
*   **Git Integration**: Works with committed changes, staged changes, and even unstaged modifications.
*   **Ticket System Integration**: Automatically extracts ticket IDs from branch names and commit messages (Jira & Azure DevOps supported).
*   **Configurable**: Set your API key, endpoint, and preferred ticket system.

## Installation

```bash
npm install -g vladan-cli
```

## Usage

First, configure the CLI with your API credentials:

```bash
vladan-cli config --key YOUR_API_KEY
vladan-cli config --endpoint https://your-api.com/review/local
```

Then, you can run a review:

```bash
# Review committed changes against a target branch
vladan-cli review main

# Review only staged changes
vladan-cli stg

# Review only unstaged changes
vladan-cli diff

# Review all uncommitted changes (staged + unstaged)
vladan-cli all
```

For more options, run:
```bash
vladan-cli --help
```

## Development

To run tests:
```bash
npm test
```
