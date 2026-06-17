import { describe, expect, test } from 'vitest'

import {
  commitIfNeeded,
  gitStatusShort,
  isNoChecksReportedResult,
  isNoRequiredChecksResult,
  parseCiChecks,
  parseCiChecksResult,
  parsePullRequestList,
  pushBranch,
  runValidationCommands,
  summarizeChecks,
} from './git'
import type { CommandResult, ValidationResult } from './types'

describe('Anypi git module', () => {
  describe('parsePullRequestList', () => {
    test('parses a single pull request from GitHub API response', () => {
      const raw = '[{"number":123,"html_url":"https://github.com/proompteng/lab/pull/123"}]'
      const result = parsePullRequestList(raw)
      expect(result).toEqual({ number: 123, url: 'https://github.com/proompteng/lab/pull/123' })
    })

    test('returns null for empty array', () => {
      expect(parsePullRequestList('[]')).toBeNull()
    })

    test('returns null for empty string', () => {
      expect(parsePullRequestList('')).toBeNull()
    })

    test('returns null for invalid JSON', () => {
      expect(parsePullRequestList('not json')).toBeNull()
    })

    test('returns null for array with non-object elements', () => {
      expect(parsePullRequestList('[1,2,3]')).toBeNull()
    })

    test('returns null for object without number', () => {
      expect(parsePullRequestList('[{"html_url":"https://example.com"}]')).toBeNull()
    })

    test('returns null for number less than or equal to zero', () => {
      expect(parsePullRequestList('[{"number":0}]')).toBeNull()
      expect(parsePullRequestList('[{"number":-1}]')).toBeNull()
    })

    test('handles number as string and converts to number', () => {
      const raw = '[{"number":"456","html_url":"https://github.com/proompteng/lab/pull/456"}]'
      const result = parsePullRequestList(raw)
      expect(result).toEqual({ number: 456, url: 'https://github.com/proompteng/lab/pull/456' })
    })
  })

  describe('parseCiChecks', () => {
    test('parses empty string as empty array', () => {
      expect(parseCiChecks('')).toEqual([])
    })

    test('parses JSON array of checks', () => {
      const raw = JSON.stringify([
        { name: 'lint', workflow: 'CI', bucket: 'pass', state: 'SUCCESS' },
        { name: 'test', workflow: 'CI', bucket: 'pending', state: 'QUEUED' },
        { name: 'security', workflow: 'Security', bucket: 'fail', state: 'FAILURE', link: 'https://example.com' },
      ])
      const checks = parseCiChecks(raw)
      expect(checks).toHaveLength(3)
      expect(checks[0]).toMatchObject({
        name: 'lint',
        workflow: 'CI',
        bucket: 'pass',
        state: 'SUCCESS',
      })
      expect(checks[1]).toMatchObject({
        name: 'test',
        workflow: 'CI',
        bucket: 'pending',
        state: 'QUEUED',
      })
      expect(checks[2]).toMatchObject({
        name: 'security',
        workflow: 'Security',
        bucket: 'fail',
        state: 'FAILURE',
        link: 'https://example.com',
      })
    })

    test('handles missing optional fields', () => {
      const raw = JSON.stringify([{ name: 'simple-check' }])
      const checks = parseCiChecks(raw)
      expect(checks).toHaveLength(1)
      expect(checks[0]).toMatchObject({
        name: 'simple-check',
        workflow: undefined,
        state: undefined,
        bucket: undefined,
        link: undefined,
      })
    })

    test('throws on invalid JSON', () => {
      expect(() => parseCiChecks('not json')).toThrow()
    })

    test('throws on non-array JSON', () => {
      expect(() => parseCiChecks('{}')).toThrow(/not an array/)
    })
  })

  describe('parseCiChecksResult', () => {
    test('parses successful command result', () => {
      const result: CommandResult = {
        command: 'gh',
        args: ['pr', 'checks', 'main', '--json', 'name,bucket'],
        exitCode: 0,
        stdout: JSON.stringify([{ name: 'check1', bucket: 'pass' }]),
        stderr: '',
        durationMs: 100,
      }
      const checks = parseCiChecksResult(result)
      expect(checks).toHaveLength(1)
      expect(checks[0]).toMatchObject({ name: 'check1', bucket: 'pass' })
    })

    test('throws on non-zero exit code with stderr', () => {
      const result: CommandResult = {
        command: 'gh',
        args: ['pr', 'checks', 'main'],
        exitCode: 1,
        stdout: '',
        stderr: 'error: branch not found',
        durationMs: 50,
      }
      expect(() => parseCiChecksResult(result)).toThrow(/gh pr checks failed.*error: branch not found/)
    })

    test('throws on non-zero exit code with stdout', () => {
      const result: CommandResult = {
        command: 'gh',
        args: ['pr', 'checks', 'main'],
        exitCode: 1,
        stdout: 'some error output',
        stderr: '',
        durationMs: 50,
      }
      expect(() => parseCiChecksResult(result)).toThrow(/gh pr checks failed.*some error output/)
    })

    test('uses stdout when stderr is empty on error', () => {
      const result: CommandResult = {
        command: 'gh',
        args: ['pr', 'checks', 'main'],
        exitCode: 1,
        stdout: 'no checks reported',
        stderr: '',
        durationMs: 50,
      }
      expect(() => parseCiChecksResult(result)).toThrow(/gh pr checks failed.*no checks reported/)
    })

    test('uses no output fallback when both stdout and stderr are empty', () => {
      const result: CommandResult = {
        command: 'gh',
        args: ['pr', 'checks', 'main'],
        exitCode: 1,
        stdout: '',
        stderr: '',
        durationMs: 50,
      }
      expect(() => parseCiChecksResult(result)).toThrow(/gh pr checks failed.*no output/)
    })
  })

  describe('isNoChecksReportedResult', () => {
    test('returns true for "no checks reported" in stderr', () => {
      const result: CommandResult = {
        command: 'gh',
        args: ['pr', 'checks', 'main'],
        exitCode: 1,
        stdout: '',
        stderr: "no checks reported on the 'main' branch",
        durationMs: 10,
      }
      expect(isNoChecksReportedResult(result)).toBe(true)
    })

    test('returns true for "no checks reported" in stdout', () => {
      const result: CommandResult = {
        command: 'gh',
        args: ['pr', 'checks', 'main'],
        exitCode: 1,
        stdout: "no checks reported on the 'main' branch",
        stderr: '',
        durationMs: 10,
      }
      expect(isNoChecksReportedResult(result)).toBe(true)
    })

    test('returns true for case-insensitive match', () => {
      const result: CommandResult = {
        command: 'gh',
        args: ['pr', 'checks', 'main'],
        exitCode: 1,
        stdout: 'NO CHECKS REPORTED',
        stderr: '',
        durationMs: 10,
      }
      expect(isNoChecksReportedResult(result)).toBe(true)
    })

    test('returns false for successful exit code', () => {
      const result: CommandResult = {
        command: 'gh',
        args: ['pr', 'checks', 'main'],
        exitCode: 0,
        stdout: JSON.stringify([{ name: 'check', bucket: 'pass' }]),
        stderr: '',
        durationMs: 10,
      }
      expect(isNoChecksReportedResult(result)).toBe(false)
    })

    test('returns false for different error message', () => {
      const result: CommandResult = {
        command: 'gh',
        args: ['pr', 'checks', 'main'],
        exitCode: 1,
        stdout: '',
        stderr: 'unknown flag: --json',
        durationMs: 10,
      }
      expect(isNoChecksReportedResult(result)).toBe(false)
    })
  })

  describe('isNoRequiredChecksResult', () => {
    test('is an alias for isNoChecksReportedResult', () => {
      const result: CommandResult = {
        command: 'gh',
        args: ['pr', 'checks', 'main', '--required'],
        exitCode: 1,
        stdout: '',
        stderr: "no checks reported on the 'main' branch",
        durationMs: 10,
      }
      expect(isNoRequiredChecksResult(result)).toBe(true)
    })
  })

  describe('summarizeChecks', () => {
    test('counts passed and skipped checks', () => {
      const checks = [
        { name: 'lint', bucket: 'pass' },
        { name: 'type-check', bucket: 'skipping' },
      ]
      const summary = summarizeChecks(checks)
      expect(summary.passed).toHaveLength(2)
      expect(summary.pending).toHaveLength(0)
      expect(summary.failed).toHaveLength(0)
      expect(summary.summary).toContain('2 passed/skipped')
    })

    test('counts pending checks', () => {
      const checks = [
        { name: 'test', bucket: 'pending' },
        { name: 'build', bucket: 'pending' },
        { name: 'deploy', bucket: 'pending' },
      ]
      const summary = summarizeChecks(checks)
      expect(summary.pending).toHaveLength(3)
      expect(summary.summary).toContain('3 pending')
    })

    test('counts failed and cancelled checks', () => {
      const checks = [
        { name: 'test', bucket: 'fail' },
        { name: 'lint', bucket: 'cancel' },
      ]
      const summary = summarizeChecks(checks)
      expect(summary.failed).toHaveLength(2)
      expect(summary.summary).toContain('2 failed/cancelled')
    })

    test('builds correct summary string', () => {
      const checks = [
        { name: 'lint', bucket: 'pass' },
        { name: 'test', bucket: 'pending' },
        { name: 'security', bucket: 'fail' },
      ]
      const summary = summarizeChecks(checks)
      expect(summary.summary).toBe('1 passed/skipped, 1 pending, 1 failed/cancelled')
    })

    test('handles empty array', () => {
      const summary = summarizeChecks([])
      expect(summary.passed).toHaveLength(0)
      expect(summary.pending).toHaveLength(0)
      expect(summary.failed).toHaveLength(0)
      expect(summary.summary).toBe('0 passed/skipped, 0 pending, 0 failed/cancelled')
    })
  })
})
