import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { resolveAttemptSessionDir } from './pi-session'

describe('Anypi pi-session', () => {
  test('isolates persisted sessions per agent attempt', () => {
    const sessionDir = resolveAttemptSessionDir('/workspace/.anypi/sessions', 'Validation repair #1')
    expect(sessionDir).toMatch(/^\/workspace\/\.anypi\/sessions\/validation-repair-1-[a-f0-9]{8}$/)
  })

  test('normalizes session label to safe filename', () => {
    const dir1 = resolveAttemptSessionDir('/tmp', 'Test Attempt')
    expect(dir1).toMatch(/test-attempt-[a-f0-9]{8}$/)
    const dir2 = resolveAttemptSessionDir('/tmp', 'Test---Attempt')
    expect(dir2).toMatch(/test-attempt-[a-f0-9]{8}$/)
    const dir3 = resolveAttemptSessionDir('/tmp', 'test attempt')
    expect(dir3).toMatch(/test-attempt-[a-f0-9]{8}$/)
    const dir4 = resolveAttemptSessionDir('/tmp', 'Test@#$%Attempt')
    expect(dir4).toMatch(/test-attempt-[a-f0-9]{8}$/)
  })

  test('limits session label length', () => {
    const longLabel = 'a'.repeat(100)
    const sessionDir = resolveAttemptSessionDir('/tmp', longLabel)
    // Should be truncated to 48 chars + UUID prefix (the actual label is 48 chars max)
    const expectedPrefix = '/tmp/aaaaaa'
    expect(sessionDir.startsWith(expectedPrefix)).toBe(true)
    expect(sessionDir.length).toBeLessThan(100)
  })
})

describe('Anypi pi-session timeout artifact capture', () => {
  test('session label truncates at 48 characters', () => {
    const veryLongLabel = 'this-is-a-very-long-label-that-exceeds-the-maximum-length-for-session-directories'
    const sessionDir = resolveAttemptSessionDir('/workspace/.anypi/sessions', veryLongLabel)
    // The label should be truncated and lowercase with hyphens
    expect(sessionDir).toMatch(/^\/workspace\/\.anypi\/sessions\/[a-z0-9-]+-[a-f0-9]{8}$/)
  })
})
