# Korekt CLI

[![npm version](https://img.shields.io/npm/v/korekt-cli.svg)](https://www.npmjs.com/package/korekt-cli)
[![npm downloads](https://img.shields.io/npm/dm/korekt-cli.svg)](https://www.npmjs.com/package/korekt-cli)
[![license](https://img.shields.io/npm/l/korekt-cli.svg)](https://www.npmjs.com/package/korekt-cli)

AI-powered code review CLI - Keep your kode korekt

`kk` integrates seamlessly with your local Git workflow to provide intelligent code reviews powered by AI.

## Features

*   **AI-Powered Analysis**: Get instant, intelligent code reviews with severity levels, categories, and actionable suggestions
*   **Local Git Integration**: Works with committed changes, staged changes, and unstaged modifications
*   **Ticket System Integration**: Automatically extracts ticket IDs from branch names and commit messages (Jira & Azure DevOps)
*   **Beautiful Output**: Color-coded issues with severity indicators, file locations, and suggested fixes
*   **Ultra-Fast**: Short command syntax (`kk`) for maximum developer efficiency

## Installation

```bash
npm install -g korekt-cli
```

## Quick Start

Configure the CLI with your API credentials:

```bash
kk config --key YOUR_API_KEY
kk config --endpoint https://api.korekt.ai/review/local
```

Run your first review:

```bash
# Review committed changes against a target branch
kk review main

# Review only staged changes
kk stg

# Review only unstaged changes
kk diff

# Review all uncommitted changes (staged + unstaged)
kk all
```

## Usage

### Configuration

```bash
# Set API key
kk config --key YOUR_API_KEY

# Set API endpoint
kk config --endpoint https://api.korekt.ai/review/local

# Set default ticket system (jira or ado)
kk config --ticket-system jira

# Show current configuration
kk config --show
```

### Review Commands

```bash
# Review committed changes (auto-detect base branch)
kk review

# Review against specific branch
kk review main

# Review with ticket system override
kk review main --ticket-system ado

# Review with ignored files
kk review main --ignore "*.lock" "dist/*"

# Dry run (preview payload without sending)
kk review main --dry-run

# Review staged changes only
kk stg
# Aliases: kk staged, kk cached

# Review unstaged changes only
kk diff

# Review all uncommitted changes
kk all

# Include untracked files
kk all --untracked
```

### Alternative Command

Both `kk` and `korekt` commands are available:

```bash
korekt review main  # Same as: kk review main
```

## Environment Variables

You can also configure using environment variables:

```bash
export KOREKT_API_KEY="your-api-key"
export KOREKT_API_ENDPOINT="https://api.korekt.ai/review/local"
export KOREKT_TICKET_SYSTEM="jira"
```

Note: Config file takes precedence over environment variables.

## Help

For more options and detailed help:

```bash
kk --help
kk review --help
```

## Development

To run tests:
```bash
npm test
```

## License

MIT © [Vladan Djokic](https://korekt.ai)

See [LICENSE](./LICENSE) for details.
