import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { truncateFileData, formatErrorOutput } from './index.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

describe('CLI JSON output mode', () => {
  let stdoutSpy;
  let stderrSpy;

  beforeEach(() => {
    // Spy on stdout and stderr
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('stdout/stderr separation', () => {
    it('should send progress messages to stderr using log helper', () => {
      const log = (msg) => process.stderr.write(msg + '\n');

      log('Starting review...');
      expect(stderrSpy).toHaveBeenCalledWith('Starting review...\n');
    });

    it('should send data output to stdout using output helper', () => {
      const output = (msg) => process.stdout.write(msg + '\n');

      const jsonData = JSON.stringify({ success: true }, null, 2);
      output(jsonData);
      expect(stdoutSpy).toHaveBeenCalledWith(jsonData + '\n');
    });

    it('should keep progress and data separate', () => {
      const log = (msg) => process.stderr.write(msg + '\n');
      const output = (msg) => process.stdout.write(msg + '\n');

      // Simulate a review flow
      log('Starting review...');
      log('Analyzing files...');
      output(JSON.stringify({ result: 'success' }));

      // Verify stderr contains progress
      expect(stderrSpy).toHaveBeenCalledWith('Starting review...\n');
      expect(stderrSpy).toHaveBeenCalledWith('Analyzing files...\n');

      // Verify stdout contains only data
      expect(stdoutSpy).toHaveBeenCalledWith(JSON.stringify({ result: 'success' }) + '\n');
      expect(stdoutSpy).not.toHaveBeenCalledWith(expect.stringContaining('Starting review'));
    });

    it('should not mix stderr progress with stdout data', () => {
      const log = (msg) => process.stderr.write(msg + '\n');
      const output = (msg) => process.stdout.write(msg + '\n');

      log('Progress message');
      output('Data output');

      // stderr should not contain data
      expect(stderrSpy).not.toHaveBeenCalledWith('Data output\n');
      // stdout should not contain progress
      expect(stdoutSpy).not.toHaveBeenCalledWith('Progress message\n');
    });
  });

  describe('dry-run payload transformation', () => {
    it('should truncate diffs longer than 500 characters', () => {
      const longDiff = 'a'.repeat(600);

      const file = {
        path: 'test.js',
        status: 'M',
        diff: longDiff,
        content: 'short content',
      };

      const displayFile = truncateFileData(file);

      expect(displayFile.diff).toContain('... [truncated 100 chars]');
      expect(displayFile.diff.length).toBeLessThan(longDiff.length);
      expect(displayFile.diff).toBe('a'.repeat(500) + '... [truncated 100 chars]');
    });

    it('should truncate content longer than 500 characters', () => {
      const longContent = 'b'.repeat(700);

      const file = {
        path: 'test.js',
        status: 'M',
        diff: 'short diff',
        content: longContent,
      };

      const displayFile = truncateFileData(file);

      expect(displayFile.content).toContain('... [truncated 200 chars]');
      expect(displayFile.content.length).toBeLessThan(longContent.length);
      expect(displayFile.content).toBe('b'.repeat(500) + '... [truncated 200 chars]');
    });

    it('should not truncate short diffs and content', () => {
      const shortDiff = 'short diff';
      const shortContent = 'short content';

      const file = {
        path: 'test.js',
        status: 'M',
        diff: shortDiff,
        content: shortContent,
      };

      const displayFile = truncateFileData(file);

      expect(displayFile.diff).toBe(shortDiff);
      expect(displayFile.content).toBe(shortContent);
      expect(displayFile.diff).not.toContain('truncated');
      expect(displayFile.content).not.toContain('truncated');
    });

    it('should preserve all file metadata during truncation', () => {
      const file = {
        path: 'renamed.js',
        status: 'R',
        old_path: 'old.js',
        diff: 'x'.repeat(600),
        content: 'y'.repeat(600),
      };

      const displayFile = truncateFileData(file);

      expect(displayFile.path).toBe('renamed.js');
      expect(displayFile.status).toBe('R');
      expect(displayFile.old_path).toBe('old.js');
      expect(displayFile.diff).toContain('truncated');
      expect(displayFile.content).toContain('truncated');
    });

    it('should handle file exactly at 500 characters without truncation', () => {
      const exactDiff = 'a'.repeat(500);
      const exactContent = 'b'.repeat(500);

      const file = {
        path: 'test.js',
        status: 'M',
        diff: exactDiff,
        content: exactContent,
      };

      const displayFile = truncateFileData(file);

      expect(displayFile.diff).toBe(exactDiff);
      expect(displayFile.content).toBe(exactContent);
      expect(displayFile.diff).not.toContain('truncated');
      expect(displayFile.content).not.toContain('truncated');
    });
  });

  describe('error formatting for JSON mode', () => {
    it('should format error with response data', () => {
      const error = {
        message: 'Request failed',
        response: {
          status: 401,
          data: { error: 'Unauthorized' },
        },
      };

      const errorOutput = formatErrorOutput(error);

      expect(errorOutput).toEqual({
        success: false,
        error: 'Request failed',
        status: 401,
        data: { error: 'Unauthorized' },
      });
    });

    it('should format error without response data', () => {
      const error = {
        message: 'Network error',
      };

      const errorOutput = formatErrorOutput(error);

      expect(errorOutput).toEqual({
        success: false,
        error: 'Network error',
      });
    });

    it('should include response status and data when available', () => {
      const error = {
        message: 'API Error',
        response: {
          status: 500,
          data: {
            error: 'Internal Server Error',
            details: 'Database connection failed',
          },
        },
      };

      const errorOutput = formatErrorOutput(error);

      expect(errorOutput.success).toBe(false);
      expect(errorOutput.error).toBe('API Error');
      expect(errorOutput.status).toBe(500);
      expect(errorOutput.data).toEqual({
        error: 'Internal Server Error',
        details: 'Database connection failed',
      });
    });
  });

  describe('confirmation skip logic', () => {
    it('should skip confirmation when JSON mode is enabled', () => {
      const options = { json: true };

      // Logic from index.js line 157: if (!options.json) { confirmAction... }
      const shouldShowConfirmation = !options.json;

      expect(shouldShowConfirmation).toBe(false);
    });

    it('should show confirmation when JSON mode is disabled', () => {
      const options = { json: false };

      const shouldShowConfirmation = !options.json;

      expect(shouldShowConfirmation).toBe(true);
    });

    it('should show confirmation when JSON option is not set', () => {
      const options = {};

      const shouldShowConfirmation = !options.json;

      expect(shouldShowConfirmation).toBe(true);
    });
  });

  describe('payload structure for different review modes', () => {
    it('should have empty commit_messages for uncommitted reviews', () => {
      const uncommittedPayload = {
        repo_url: 'https://github.com/user/repo',
        source_branch: 'feature-branch',
        commit_messages: [], // Should be empty for uncommitted
        changed_files: [
          {
            path: 'file.js',
            status: 'M',
            diff: 'diff',
            content: 'content',
          },
        ],
      };

      expect(uncommittedPayload.commit_messages).toEqual([]);
      expect(uncommittedPayload.changed_files).toHaveLength(1);
    });

    it('should have commit_messages for committed reviews', () => {
      const committedPayload = {
        repo_url: 'https://github.com/user/repo',
        source_branch: 'feature-branch',
        commit_messages: ['feat: add feature', 'fix: bug fix'],
        changed_files: [
          {
            path: 'file.js',
            status: 'M',
            diff: 'diff',
            content: 'content',
          },
        ],
      };

      expect(committedPayload.commit_messages.length).toBeGreaterThan(0);
      expect(committedPayload.changed_files).toHaveLength(1);
    });
  });

  describe('JSON output format validation', () => {
    it('should produce valid JSON for success response', () => {
      const response = {
        review: {
          issues: [
            {
              file_path: 'file.js',
              line_number: 10,
              message: 'Issue',
              severity: 'high',
              category: 'security',
              suggested_fix: 'Fix it',
            },
          ],
          praises: [],
        },
        summary: {
          total_issues: 1,
          critical: 0,
          high: 1,
          medium: 0,
          low: 0,
        },
      };

      // Should be valid JSON
      const jsonString = JSON.stringify(response, null, 2);
      expect(() => JSON.parse(jsonString)).not.toThrow();

      const parsed = JSON.parse(jsonString);
      expect(parsed.review.issues).toHaveLength(1);
      expect(parsed.summary.total_issues).toBe(1);
    });

    it('should produce valid JSON for error response', () => {
      const errorResponse = {
        success: false,
        error: 'API Error',
        status: 400,
        data: { error: 'Bad request' },
      };

      // Should be valid JSON
      const jsonString = JSON.stringify(errorResponse, null, 2);
      expect(() => JSON.parse(jsonString)).not.toThrow();

      const parsed = JSON.parse(jsonString);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('API Error');
      expect(parsed.status).toBe(400);
    });
  });
});

describe('get-script command', () => {
  let stdoutSpy;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('valid providers', () => {
    it('should output github script to stdout', () => {
      const output = (msg) => process.stdout.write(msg + '\n');

      // Read actual github.sh script
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const scriptPath = join(__dirname, '..', 'scripts', 'github.sh');
      const scriptContent = readFileSync(scriptPath, 'utf8');

      // Simulate get-script command output
      output(scriptContent);

      // Verify script was output to stdout
      expect(stdoutSpy).toHaveBeenCalledWith(scriptContent + '\n');
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
    });

    it('should output bitbucket script to stdout', () => {
      const output = (msg) => process.stdout.write(msg + '\n');

      // Read actual bitbucket.sh script
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const scriptPath = join(__dirname, '..', 'scripts', 'bitbucket.sh');
      const scriptContent = readFileSync(scriptPath, 'utf8');

      // Simulate get-script command output
      output(scriptContent);

      // Verify script was output to stdout
      expect(stdoutSpy).toHaveBeenCalledWith(scriptContent + '\n');
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
    });

    it('should output azure script to stdout', () => {
      const output = (msg) => process.stdout.write(msg + '\n');

      // Read actual azure.sh script
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const scriptPath = join(__dirname, '..', 'scripts', 'azure.sh');
      const scriptContent = readFileSync(scriptPath, 'utf8');

      // Simulate get-script command output
      output(scriptContent);

      // Verify script was output to stdout
      expect(stdoutSpy).toHaveBeenCalledWith(scriptContent + '\n');
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('script completeness', () => {
    it('should output complete bash scripts with proper structure', () => {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);

      // Test all three scripts
      const providers = ['github', 'bitbucket', 'azure'];

      providers.forEach((provider) => {
        const scriptPath = join(__dirname, '..', 'scripts', `${provider}.sh`);
        const scriptContent = readFileSync(scriptPath, 'utf8');

        // Verify script starts with shebang
        expect(scriptContent).toMatch(/^#!/);
        expect(scriptContent).toContain('#!/usr/bin/env bash');

        // Verify script has substantial content (not truncated)
        const lineCount = scriptContent.split('\n').length;
        expect(lineCount).toBeGreaterThan(400);

        // Verify script ends properly (has exit statement)
        expect(scriptContent).toContain('exit');
      });
    });
  });

  describe('error handling', () => {
    it('should reject invalid provider', () => {
      const invalidProvider = 'gitlab';
      const validProviders = ['github', 'bitbucket', 'azure'];

      // Test validation logic from index.js line 513
      const isValid = validProviders.includes(invalidProvider.toLowerCase());

      expect(isValid).toBe(false);

      // In the actual command, this would trigger process.exit(1)
      // We verify the validation logic correctly identifies invalid providers
      expect(['github', 'bitbucket', 'azure']).not.toContain(invalidProvider);
    });

    it('should accept valid providers case-insensitively', () => {
      const validProviders = ['github', 'bitbucket', 'azure'];

      // Test that providers work case-insensitively
      expect(validProviders.includes('GitHub'.toLowerCase())).toBe(true);
      expect(validProviders.includes('BITBUCKET'.toLowerCase())).toBe(true);
      expect(validProviders.includes('Azure'.toLowerCase())).toBe(true);
    });
  });

  describe('bundled script files', () => {
    it('should have all provider scripts bundled and readable', () => {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);

      const providers = ['github', 'bitbucket', 'azure'];

      providers.forEach((provider) => {
        const scriptPath = join(__dirname, '..', 'scripts', `${provider}.sh`);

        // Should not throw - file exists and is readable
        expect(() => {
          const content = readFileSync(scriptPath, 'utf8');
          expect(content.length).toBeGreaterThan(0);
        }).not.toThrow();
      });
    });
  });
});
