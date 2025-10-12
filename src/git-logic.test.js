import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseNameStatus,
  findJiraTicketIds,
  findAdoTicketIds,
  extractTicketIds,
  runLocalReview,
  runUncommittedReview,
  truncateContent,
  normalizeRepoUrl,
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

describe('findJiraTicketIds', () => {
  it('should find single Jira ticket ID', () => {
    expect(findJiraTicketIds('PROJ-123')).toEqual(['PROJ-123']);
  });

  it('should find multiple Jira ticket IDs', () => {
    expect(findJiraTicketIds('Fix PROJ-123 and ABC-456')).toEqual(['PROJ-123', 'ABC-456']);
  });

  it('should find Jira ticket in branch name', () => {
    expect(findJiraTicketIds('feature/PROJ-789-add-login')).toEqual(['PROJ-789']);
  });

  it('should return empty array when no tickets found', () => {
    expect(findJiraTicketIds('just a regular message')).toEqual([]);
  });

  it('should handle edge cases', () => {
    expect(findJiraTicketIds('X-1')).toEqual(['X-1']); // Minimum valid
    expect(findJiraTicketIds('VERYLONGPROJ-999999')).toEqual(['VERYLONGPROJ-999999']);
  });
});

describe('findAdoTicketIds', () => {
  it('should find numeric ID in branch name', () => {
    expect(findAdoTicketIds('feature/12345-add-feature', true)).toEqual(['12345']);
  });

  it('should find AB# pattern in commit message', () => {
    expect(findAdoTicketIds('Fix bug AB#67890', false)).toEqual(['67890']);
  });

  it('should find multiple AB# patterns', () => {
    expect(findAdoTicketIds('Fix AB#111 and AB#222', false)).toEqual(['111', '222']);
  });

  it('should be case insensitive for AB# pattern', () => {
    expect(findAdoTicketIds('Fix ab#999', false)).toEqual(['999']);
  });

  it('should return empty array when no match', () => {
    expect(findAdoTicketIds('no ticket here', false)).toEqual([]);
    expect(findAdoTicketIds('no-numbers', true)).toEqual([]);
  });
});

describe('extractTicketIds', () => {
  describe('Jira system', () => {
    it('should extract from branch name first', () => {
      const commits = ['Fix PROJ-456'];
      const branch = 'feature/PROJ-123-new-feature';
      const result = extractTicketIds(commits, branch, 'jira');
      expect(result).toEqual(['PROJ-123', 'PROJ-456']);
    });

    it('should extract from commit messages', () => {
      const commits = ['Add PROJ-111', 'Fix PROJ-222 and ABC-333'];
      const result = extractTicketIds(commits, '', 'jira');
      expect(result).toEqual(['PROJ-111', 'PROJ-222', 'ABC-333']);
    });

    it('should deduplicate ticket IDs', () => {
      const commits = ['Fix PROJ-123', 'Update PROJ-123'];
      const branch = 'feature/PROJ-123-fix';
      const result = extractTicketIds(commits, branch, 'jira');
      expect(result).toEqual(['PROJ-123']);
    });

    it('should maintain order: branch tickets first, then commits', () => {
      const commits = ['Add ABC-999', 'Fix PROJ-111'];
      const branch = 'feature/PROJ-123-test';
      const result = extractTicketIds(commits, branch, 'jira');
      expect(result).toEqual(['PROJ-123', 'ABC-999', 'PROJ-111']);
    });
  });

  describe('Azure DevOps system', () => {
    it('should extract numeric ID from branch', () => {
      const commits = ['Fix AB#67890'];
      const branch = 'feature/12345-new-feature';
      const result = extractTicketIds(commits, branch, 'ado');
      expect(result).toEqual(['12345', '67890']);
    });


    it('should deduplicate ADO tickets', () => {
      const commits = ['Fix AB#123', 'Update AB#123'];
      const result = extractTicketIds(commits, '', 'ado');
      expect(result).toEqual(['123']);
    });
  });

  it('should return empty array when no tickets found', () => {
    const result = extractTicketIds(['no tickets'], 'no-tickets', 'jira');
    expect(result).toEqual([]);
  });

  it('should handle undefined/null branch name', () => {
    const commits = ['Fix PROJ-123'];
    expect(extractTicketIds(commits, null, 'jira')).toEqual(['PROJ-123']);
    expect(extractTicketIds(commits, undefined, 'jira')).toEqual(['PROJ-123']);
  });

  it('should return empty array when ticket system is null', () => {
    const commits = ['Fix PROJ-123', 'Update AB#456'];
    const branch = 'feature/PROJ-789-test';
    const result = extractTicketIds(commits, branch, null);
    expect(result).toEqual([]);
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

  it('should extract ticket IDs from branch name', async () => {
    vi.mocked(execa).mockImplementation(async (cmd, args) => {
      const command = [cmd, ...args].join(' ');

      if (command.includes('remote get-url origin')) {
        return { stdout: 'https://github.com/user/repo.git' };
      }
      if (command.includes('rev-parse --abbrev-ref HEAD')) {
        return { stdout: 'feature/PROJ-123-add-feature' };
      }
      if (command.includes('diff --cached --name-status')) {
        return { stdout: 'M\tfile.js' };
      }
      if (command.includes('diff --cached -U15 -- file.js')) {
        return { stdout: 'diff content' };
      }
      if (command.includes('show HEAD:file.js')) {
        return { stdout: 'old content' };
      }

      throw new Error(`Unmocked command: ${command}`);
    });

    const result = await runUncommittedReview('staged', 'jira');

    expect(result).toBeDefined();
    expect(result.ticket_ids).toEqual(['PROJ-123']);
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
      if (command.includes('reflog show --no-abbrev-commit feature-branch')) {
        // Simulate reflog output - last line is where branch was created
        return { stdout: 'abc123def456 feature-branch@{0}: commit: latest\nfedcba654321 feature-branch@{1}: commit: middle\n510572bc5197788770004d0d0585822adab0128f feature-branch@{2}: branch: Created from master' };
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
    const reflogCall = execaCalls.find(call =>
      call[0] === 'git' && call[1].includes('reflog')
    );
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
      if (command.includes('merge-base main HEAD')) {
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

    // Should have used merge-base with main
    const execaCalls = vi.mocked(execa).mock.calls;
    const mergeBaseCall = execaCalls.find(call =>
      call[0] === 'git' && call[1].includes('merge-base') && call[1].includes('main')
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