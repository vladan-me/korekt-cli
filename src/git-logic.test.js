import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseNameStatus,
  runLocalReview,
  runUncommittedReview,
  truncateContent,
  normalizeRepoUrl,
  shouldIgnoreFile,
} from './git-logic.js';
import { execa } from 'execa';

describe('parseNameStatus', () => {
  it('should correctly parse M, A, and D statuses', () => {
    const input = 'M\tsrc/main.js\nA\tsrc/utils.js\nD\tdocs/old.md';
    const expected = [
      { status: 'M', path: 'src/main.js', oldPath: 'src/main.js' },
      { status: 'A', path: 'src/utils.js', oldPath: 'src/utils.js' },
      { status: 'D', path: 'docs/old.md', oldPath: 'docs/old.md' },
    ];
    expect(parseNameStatus(input)).toEqual(expected);
  });

  it('should correctly parse R (renamed) status', () => {
    const input = 'R100\tsrc/old.js\tsrc/new.js';
    const expected = [{ status: 'R', path: 'src/new.js', oldPath: 'src/old.js' }];
    expect(parseNameStatus(input)).toEqual(expected);
  });

  it('should correctly parse C (copied) status', () => {
    const input = 'C095\tsrc/template.js\tsrc/copy.js';
    const expected = [{ status: 'C', path: 'src/copy.js', oldPath: 'src/template.js' }];
    expect(parseNameStatus(input)).toEqual(expected);
  });

  it('should handle multiple files with mixed statuses', () => {
    const input = 'M\tsrc/index.js\nR100\told.js\tnew.js\nA\tREADME.md\nD\ttest.js';
    const result = parseNameStatus(input);
    expect(result).toHaveLength(4);
    expect(result[0].status).toBe('M');
    expect(result[1].status).toBe('R');
    expect(result[2].status).toBe('A');
    expect(result[3].status).toBe('D');
  });

  it('should handle empty input', () => {
    expect(parseNameStatus('')).toEqual([]);
  });
});

describe('runUncommittedReview', () => {
  beforeEach(() => {
    vi.mock('execa');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should analyze staged changes only', async () => {
    vi.mocked(execa).mockImplementation(async (cmd, args) => {
      const command = [cmd, ...args].join(' ');

      if (command.includes('remote get-url origin')) {
        return { stdout: 'https://github.com/user/repo.git' };
      }
      if (command.includes('rev-parse --abbrev-ref HEAD')) {
        return { stdout: 'feature-branch' };
      }
      if (command.includes('rev-parse --show-toplevel')) {
        return { stdout: '/fake/repo/path' };
      }
      if (command.includes('diff --cached --name-status')) {
        return { stdout: 'M\tfile.js' };
      }
      if (command.includes('diff --cached -U15 -- file.js')) {
        return { stdout: 'diff --git a/file.js b/file.js\n+new line' };
      }
      if (command.includes('show HEAD:file.js')) {
        return { stdout: 'old content' };
      }

      throw new Error(`Unmocked command: ${command}`);
    });

    const result = await runUncommittedReview('staged', null);

    expect(result).toBeDefined();
    expect(result.repo_url).toBe('https://github.com/user/repo'); // Normalized (no .git)
    expect(result.source_branch).toBe('feature-branch');
    expect(result.commit_messages).toEqual([]);
    expect(result.changed_files).toHaveLength(1);
    expect(result.changed_files[0].path).toBe('file.js');
    expect(result.changed_files[0].status).toBe('M');
  });

  it('should analyze unstaged changes only', async () => {
    vi.mocked(execa).mockImplementation(async (cmd, args) => {
      const command = [cmd, ...args].join(' ');

      if (command.includes('remote get-url origin')) {
        return { stdout: 'https://github.com/user/repo.git' };
      }
      if (command.includes('rev-parse --abbrev-ref HEAD')) {
        return { stdout: 'feature-branch' };
      }
      if (command.includes('rev-parse --show-toplevel')) {
        return { stdout: '/fake/repo/path' };
      }
      if (command === 'git diff --name-status') {
        return { stdout: 'M\tfile.js' };
      }
      if (command.includes('diff -U15 -- file.js')) {
        return { stdout: 'diff --git a/file.js b/file.js\n+new line' };
      }
      if (command.includes('show HEAD:file.js')) {
        return { stdout: 'old content' };
      }

      throw new Error(`Unmocked command: ${command}`);
    });

    const result = await runUncommittedReview('unstaged', null);

    expect(result).toBeDefined();
    expect(result.source_branch).toBe('feature-branch');
    expect(result.changed_files).toHaveLength(1);
  });

  it('should analyze all uncommitted changes', async () => {
    vi.mocked(execa).mockImplementation(async (cmd, args) => {
      const command = [cmd, ...args].join(' ');

      if (command.includes('remote get-url origin')) {
        return { stdout: 'https://github.com/user/repo.git' };
      }
      if (command.includes('rev-parse --abbrev-ref HEAD')) {
        return { stdout: 'feature-branch' };
      }
      if (command.includes('rev-parse --show-toplevel')) {
        return { stdout: '/fake/repo/path' };
      }
      if (command.includes('diff --cached --name-status')) {
        return { stdout: 'M\tstaged.js' };
      }
      if (command === 'git diff --name-status') {
        return { stdout: 'M\tunstaged.js' };
      }
      if (command.includes('diff --cached -U15 -- staged.js')) {
        return { stdout: 'diff staged' };
      }
      if (command.includes('diff -U15 -- unstaged.js')) {
        return { stdout: 'diff unstaged' };
      }
      if (command.includes('show HEAD:staged.js')) {
        return { stdout: 'staged old content' };
      }
      if (command.includes('show HEAD:unstaged.js')) {
        return { stdout: 'unstaged old content' };
      }

      throw new Error(`Unmocked command: ${command}`);
    });

    const result = await runUncommittedReview('all', null);

    expect(result).toBeDefined();
    expect(result.changed_files).toHaveLength(2);
    expect(result.changed_files[0].path).toBe('staged.js');
    expect(result.changed_files[1].path).toBe('unstaged.js');
  });

  it('should return null when no changes found', async () => {
    vi.mocked(execa).mockImplementation(async (cmd, args) => {
      const command = [cmd, ...args].join(' ');

      if (command.includes('remote get-url origin')) {
        return { stdout: 'https://github.com/user/repo.git' };
      }
      if (command.includes('rev-parse --abbrev-ref HEAD')) {
        return { stdout: 'feature-branch' };
      }
      if (command.includes('rev-parse --show-toplevel')) {
        return { stdout: '/fake/repo/path' };
      }
      if (command.includes('diff --cached --name-status')) {
        return { stdout: '' };
      }
      if (command === 'git diff --name-status') {
        return { stdout: '' };
      }

      throw new Error(`Unmocked command: ${command}`);
    });

    const result = await runUncommittedReview('all', null);

    expect(result).toBeNull();
  });
});

describe('runLocalReview - branch fetching', () => {
  beforeEach(() => {
    vi.mock('execa');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should fail if target branch does not exist locally', async () => {
    vi.mocked(execa).mockImplementation(async (cmd, args) => {
      const command = [cmd, ...args].join(' ');
      if (command.includes('remote get-url origin')) {
        return { stdout: 'https://github.com/user/repo.git' };
      }
      if (command.includes('rev-parse --abbrev-ref HEAD')) {
        return { stdout: 'current-branch' };
      }
      if (command.includes('rev-parse --show-toplevel')) {
        return { stdout: '/path/to/repo' };
      }
      if (command.includes('rev-parse --verify non-existent-branch')) {
        throw new Error('Branch not found');
      }
      // No other commands should be called
      return { stdout: '' };
    });

    const result = await runLocalReview('non-existent-branch');
    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Branch 'non-existent-branch' does not exist locally.")
    );
  });

  it('should fetch latest changes if target branch exists locally', async () => {
    vi.mocked(execa).mockImplementation(async (cmd, args) => {
      const command = [cmd, ...args].join(' ');
      // Common setup
      if (command.includes('remote get-url origin'))
        return { stdout: 'https://github.com/user/repo.git' };
      if (command.includes('rev-parse --abbrev-ref HEAD')) return { stdout: 'current-branch' };
      if (command.includes('rev-parse --show-toplevel')) return { stdout: '/path/to/repo' };

      // Branch verification and fetch (successful)
      if (command.includes('rev-parse --verify main')) return { stdout: 'commit-hash' };
      if (command === 'git fetch origin main') return { stdout: 'fetch successful' };

      // Rest of the review logic
      if (command.includes('merge-base origin/main HEAD')) return { stdout: 'abc1234' };
      if (command.includes('log')) return { stdout: 'feat: message---EOC---' };
      if (command.includes('diff --name-status')) return { stdout: 'M\tfile.js' };
      if (command.includes('diff -U15')) return { stdout: 'diff content' };
      if (command.includes('show')) return { stdout: 'original content' };

      return { stdout: '' };
    });

    const result = await runLocalReview('main');
    expect(result).not.toBeNull();
    const execaCalls = vi.mocked(execa).mock.calls;
    const fetchCall = execaCalls.find((call) => call[0] === 'git' && call[1].includes('fetch'));
    expect(fetchCall).toBeDefined();
  });

  it('should warn and continue if fetch fails', async () => {
    vi.mocked(execa).mockImplementation(async (cmd, args) => {
      const command = [cmd, ...args].join(' ');
      if (command.includes('remote get-url origin'))
        return { stdout: 'https://github.com/user/repo.git' };
      if (command.includes('rev-parse --abbrev-ref HEAD')) return { stdout: 'current-branch' };
      if (command.includes('rev-parse --show-toplevel')) return { stdout: '/path/to/repo' };
      if (command.includes('rev-parse --verify main')) return { stdout: 'commit-hash' };

      // Simulate fetch failure
      if (command === 'git fetch origin main') {
        throw new Error('Fetch failed');
      }

      // Rest of the logic should still run (uses local branch since fetch failed)
      if (command.includes('merge-base main HEAD')) return { stdout: 'abc1234' };
      if (command.includes('log')) return { stdout: 'feat: message---EOC---' };
      if (command.includes('diff --name-status')) return { stdout: 'M\tfile.js' };
      if (command.includes('diff -U15')) return { stdout: 'diff content' };
      if (command.includes('show')) return { stdout: 'original content' };

      return { stdout: '' };
    });

    const result = await runLocalReview('main');
    expect(result).not.toBeNull(); // Should still proceed
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not fetch remote branch 'origin/main'.")
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Proceeding with local branch 'main' for comparison.")
    );
  });
});

describe('runLocalReview - fork point detection', () => {
  beforeEach(() => {
    vi.mock('execa');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should detect fork point when no target branch specified', async () => {
    // Mock git commands for reflog-based fork point detection
    vi.mocked(execa).mockImplementation(async (cmd, args) => {
      const command = [cmd, ...args].join(' ');

      if (command.includes('remote get-url origin')) {
        return { stdout: 'https://github.com/user/repo.git' };
      }
      if (command.includes('rev-parse --abbrev-ref HEAD')) {
        return { stdout: 'feature-branch' };
      }
      if (command.includes('rev-parse --show-toplevel')) {
        return { stdout: '/path/to/repo' };
      }
      if (command.includes('reflog show --no-abbrev-commit feature-branch')) {
        // Simulate reflog output - last line is where branch was created
        return {
          stdout:
            'abc123def456 feature-branch@{0}: commit: latest\nfedcba654321 feature-branch@{1}: commit: middle\n510572bc5197788770004d0d0585822adab0128f feature-branch@{2}: branch: Created from master',
        };
      }
      if (command.includes('log --pretty=%B---EOC---') && command.includes('510572bc')) {
        return { stdout: 'feat: add feature---EOC---' };
      }
      if (command.includes('diff --name-status') && command.includes('510572bc')) {
        return { stdout: 'M\tfile.js' };
      }
      if (command.includes('diff -U15') && command.includes('510572bc')) {
        return { stdout: 'diff content' };
      }
      if (command.includes('show 510572bc5197788770004d0d0585822adab0128f:file.js')) {
        return { stdout: 'original content' };
      }

      throw new Error(`Unmocked command: ${command}`);
    });

    const result = await runLocalReview(null, 'jira');

    expect(result).toBeDefined();
    expect(result.source_branch).toBe('feature-branch');

    // Should have used reflog to find fork point
    const execaCalls = vi.mocked(execa).mock.calls;
    const reflogCall = execaCalls.find((call) => call[0] === 'git' && call[1].includes('reflog'));
    expect(reflogCall).toBeDefined();
  });

  it('should use specified target branch instead of auto-detecting', async () => {
    vi.mocked(execa).mockImplementation(async (cmd, args) => {
      const command = [cmd, ...args].join(' ');

      if (command.includes('remote get-url origin')) {
        return { stdout: 'https://github.com/user/repo.git' };
      }
      if (command.includes('rev-parse --abbrev-ref HEAD')) {
        return { stdout: 'feature-branch' };
      }
      if (command.includes('rev-parse --show-toplevel')) {
        return { stdout: '/path/to/repo' };
      }
      // Add mocks for the new branch verification and fetch logic
      if (command.includes('rev-parse --verify main')) {
        return { stdout: 'commit-hash' };
      }
      if (command === 'git fetch origin main') {
        return { stdout: '' };
      }
      if (command.includes('merge-base origin/main HEAD')) {
        return { stdout: 'abc123' };
      }
      if (command.includes('log --pretty=%B---EOC---')) {
        return { stdout: 'feat: add feature---EOC---' };
      }
      if (command.includes('diff --name-status')) {
        return { stdout: 'M\tfile.js' };
      }
      if (command.includes('diff -U15')) {
        return { stdout: 'diff content' };
      }
      if (command.includes('show abc123:file.js')) {
        return { stdout: 'original content' };
      }

      throw new Error(`Unmocked command: ${command}`);
    });

    const result = await runLocalReview('main', 'jira');

    expect(result).toBeDefined();

    // Should have used merge-base with origin/main (since fetch succeeded)
    const execaCalls = vi.mocked(execa).mock.calls;
    const mergeBaseCall = execaCalls.find(
      (call) =>
        call[0] === 'git' && call[1].includes('merge-base') && call[1].includes('origin/main')
    );
    expect(mergeBaseCall).toBeDefined();
  });
});

describe('truncateContent', () => {
  it('should not truncate content with fewer lines than maxLines', () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const result = truncateContent(content, 2000);
    expect(result).toBe(content);
  });

  it('should truncate content with more lines than maxLines', () => {
    const content = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
    const result = truncateContent(content, 2000);

    // Should contain head and tail
    expect(result).toContain('line 0');
    expect(result).toContain('line 999'); // Last line of head (first 1000 lines)
    expect(result).toContain('... [truncated] ...');
    expect(result).toContain('line 2000'); // First line of tail (last 1000 lines)
    expect(result).toContain('line 2999');

    // Should not contain middle lines
    expect(result).not.toContain('line 1500');
  });

  it('should respect custom maxLines parameter', () => {
    const content = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const result = truncateContent(content, 100);

    expect(result).toContain('line 0');
    expect(result).toContain('line 49'); // Last of first 50
    expect(result).toContain('... [truncated] ...');
    expect(result).toContain('line 150'); // First of last 50
    expect(result).toContain('line 199');
  });
});

describe('normalizeRepoUrl', () => {
  it('should normalize Azure DevOps SSH URL to HTTPS', () => {
    const sshUrl = 'git@ssh.dev.azure.com:v3/VanillaSoftCollection/VanillaLand/VanillaLand';
    const expected = 'https://dev.azure.com/VanillaSoftCollection/VanillaLand/_git/VanillaLand';
    expect(normalizeRepoUrl(sshUrl)).toBe(expected);
  });

  it('should normalize GitHub SSH URL to HTTPS', () => {
    const sshUrl = 'git@github.com:user/repo.git';
    const expected = 'https://github.com/user/repo';
    expect(normalizeRepoUrl(sshUrl)).toBe(expected);
  });

  it('should normalize GitHub SSH URL without .git suffix', () => {
    const sshUrl = 'git@github.com:user/repo';
    const expected = 'https://github.com/user/repo';
    expect(normalizeRepoUrl(sshUrl)).toBe(expected);
  });

  it('should normalize GitLab SSH URL to HTTPS', () => {
    const sshUrl = 'git@gitlab.com:user/repo.git';
    const expected = 'https://gitlab.com/user/repo';
    expect(normalizeRepoUrl(sshUrl)).toBe(expected);
  });

  it('should normalize Bitbucket SSH URL to HTTPS', () => {
    const sshUrl = 'git@bitbucket.org:user/repo.git';
    const expected = 'https://bitbucket.org/user/repo';
    expect(normalizeRepoUrl(sshUrl)).toBe(expected);
  });

  it('should normalize Bitbucket SSH URL without .git suffix', () => {
    const sshUrl = 'git@bitbucket.org:user/repo';
    const expected = 'https://bitbucket.org/user/repo';
    expect(normalizeRepoUrl(sshUrl)).toBe(expected);
  });

  it('should remove .git suffix from HTTPS URLs', () => {
    const httpsUrl = 'https://github.com/user/repo.git';
    const expected = 'https://github.com/user/repo';
    expect(normalizeRepoUrl(httpsUrl)).toBe(expected);
  });

  it('should keep HTTPS URLs without .git suffix unchanged', () => {
    const httpsUrl = 'https://github.com/user/repo';
    expect(normalizeRepoUrl(httpsUrl)).toBe(httpsUrl);
  });

  it('should keep Azure DevOps HTTPS URLs unchanged', () => {
    const adoUrl = 'https://dev.azure.com/VanillaSoftCollection/VanillaLand/_git/VanillaLand';
    expect(normalizeRepoUrl(adoUrl)).toBe(adoUrl);
  });
});

describe('shouldIgnoreFile', () => {
  it('should return false when no patterns provided', () => {
    expect(shouldIgnoreFile('file.js', [])).toBe(false);
    expect(shouldIgnoreFile('file.js', null)).toBe(false);
    expect(shouldIgnoreFile('file.js', undefined)).toBe(false);
  });

  it('should match exact filename', () => {
    expect(shouldIgnoreFile('package-lock.json', ['package-lock.json'])).toBe(true);
    expect(shouldIgnoreFile('package.json', ['package-lock.json'])).toBe(false);
  });

  it('should match files with * wildcard', () => {
    expect(shouldIgnoreFile('file.lock', ['*.lock'])).toBe(true);
    expect(shouldIgnoreFile('package-lock.json', ['*.lock'])).toBe(false);
    expect(shouldIgnoreFile('test.min.js', ['*.min.js'])).toBe(true);
  });

  it('should match files in directories with *', () => {
    expect(shouldIgnoreFile('dist/bundle.js', ['dist/*'])).toBe(true);
    expect(shouldIgnoreFile('dist/css/style.css', ['dist/*'])).toBe(false); // * doesn't match /
    expect(shouldIgnoreFile('src/index.js', ['dist/*'])).toBe(false);
  });

  it('should match files recursively with **', () => {
    expect(shouldIgnoreFile('dist/bundle.js', ['dist/**'])).toBe(true);
    expect(shouldIgnoreFile('dist/css/style.css', ['dist/**'])).toBe(true);
    expect(shouldIgnoreFile('dist/js/vendor/lib.js', ['dist/**'])).toBe(true);
    expect(shouldIgnoreFile('src/index.js', ['dist/**'])).toBe(false);
  });

  it('should match with ? wildcard for single character', () => {
    expect(shouldIgnoreFile('test1.js', ['test?.js'])).toBe(true);
    expect(shouldIgnoreFile('test2.js', ['test?.js'])).toBe(true);
    expect(shouldIgnoreFile('test12.js', ['test?.js'])).toBe(false);
    expect(shouldIgnoreFile('test.js', ['test?.js'])).toBe(false);
  });

  it('should handle multiple patterns', () => {
    const patterns = ['*.lock', '*.log', 'dist/*'];
    expect(shouldIgnoreFile('yarn.lock', patterns)).toBe(true);
    expect(shouldIgnoreFile('error.log', patterns)).toBe(true);
    expect(shouldIgnoreFile('dist/bundle.js', patterns)).toBe(true);
    expect(shouldIgnoreFile('src/index.js', patterns)).toBe(false);
  });

  it('should match files with dots in paths', () => {
    expect(shouldIgnoreFile('file.test.js', ['*.test.js'])).toBe(true);
    expect(shouldIgnoreFile('component.spec.ts', ['*.spec.ts'])).toBe(true);
  });

  it('should match nested paths correctly', () => {
    expect(shouldIgnoreFile('src/components/Button.js', ['src/components/*'])).toBe(true);
    expect(shouldIgnoreFile('src/components/forms/Input.js', ['src/components/*'])).toBe(false);
    expect(shouldIgnoreFile('src/components/forms/Input.js', ['src/components/**'])).toBe(true);
  });

  it('should handle edge cases', () => {
    expect(shouldIgnoreFile('', ['*'])).toBe(true);
    expect(shouldIgnoreFile('file', ['*'])).toBe(true);
    expect(shouldIgnoreFile('path/to/file', ['**'])).toBe(true);
  });

  it('should match SQL files with **/*.sql pattern', () => {
    const pattern = ['**/*.sql'];
    expect(shouldIgnoreFile('SqlScripts/02_CreateTables.sql', pattern)).toBe(true);
    expect(shouldIgnoreFile('SqlScripts/03_CreateStoredProcedures.sql', pattern)).toBe(true);
    expect(shouldIgnoreFile('SqlScripts/20251006000000_CreateDatabase.sql', pattern)).toBe(true);
    expect(shouldIgnoreFile('db/migrations/001_init.sql', pattern)).toBe(true);
    expect(shouldIgnoreFile('file.sql', pattern)).toBe(true);
    expect(shouldIgnoreFile('file.js', pattern)).toBe(false);
  });
});
