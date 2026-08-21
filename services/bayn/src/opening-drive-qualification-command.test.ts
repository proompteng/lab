import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { parseOpeningDriveQualificationCommand } from './opening-drive-qualification-command'

describe('opening-drive qualification command arguments', () => {
  test('accepts explicit help and a complete ordered qualification range', () => {
    expect(parseOpeningDriveQualificationCommand(['--help'])).toEqual(Result.succeed({ action: 'help' }))
    expect(parseOpeningDriveQualificationCommand(['--end', '2026-01-07', '--start', '2026-01-05'])).toEqual(
      Result.succeed({
        action: 'qualify',
        request: { start: '2026-01-05', end: '2026-01-07' },
      }),
    )
  })

  test('fails malformed, incomplete, duplicate, unknown, and unordered arguments', () => {
    for (const args of [
      [],
      ['--start', '2026-01-05'],
      ['--help', '--start', '2026-01-05', '--end', '2026-01-07'],
      ['--start', '2026-01-05', '--start', '2026-01-07'],
      ['--start', '2026-01-05', '--until', '2026-01-07'],
      ['--start', '--end', '2026-01-07', '2026-01-08'],
      ['--start', '2026/01/05', '--end', '2026-01-07'],
      ['--start', '2026-01-32', '--end', '2026-02-05'],
      ['--start', '2026-01-08', '--end', '2026-01-07'],
    ] as const) {
      const result = parseOpeningDriveQualificationCommand(args)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: 'OpeningDriveQualificationProgramError',
          operation: 'request',
        })
      }
    }
  })
})
