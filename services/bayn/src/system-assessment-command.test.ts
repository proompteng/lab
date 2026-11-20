import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { parseSystemAssessmentCommandArgs } from './system-assessment-command'
import { parseForwardPerformanceCommandArgs } from './forward-performance-command'

test('qualification commands move to their research entry point while financial reports reject them', () => {
  for (const [flag, tag] of [
    ['--system-history', 'SystemHistory'],
    ['--system-register', 'SystemRegister'],
    ['--system-assess', 'SystemAssess'],
    ['--system-capture-replay', 'SystemCaptureReplay'],
  ] as const)
    expect(Result.getOrThrow(parseSystemAssessmentCommandArgs([flag ?? '', '/private/evidence.json']))).toEqual({
      _tag: tag,
      path: '/private/evidence.json',
    })
  expect(Result.getOrThrow(parseSystemAssessmentCommandArgs(['--system-capture', 'a'.repeat(64)]))).toEqual({
    _tag: 'SystemCapture',
    registrationHash: 'a'.repeat(64),
  })
  for (const flag of [
    '--system-history',
    '--system-register',
    '--system-capture',
    '--system-capture-replay',
    '--system-assess',
  ])
    expect(Result.isFailure(parseForwardPerformanceCommandArgs([flag, 'a'.repeat(64)]))).toBe(true)
})

test('qualification rejects malformed hashes, missing packets and financial-report options', () => {
  expect(Result.getOrThrow(parseSystemAssessmentCommandArgs(['--help']))).toEqual({ _tag: 'Help' })
  for (const args of [
    [],
    ['--system-capture', 'latest'],
    ['--system-assess', ' '],
    ['--authority-generation', 'a'.repeat(64)],
    ['--system-register', '/private/evidence.json', '--deadline-ms', '100'],
  ])
    expect(Result.isFailure(parseSystemAssessmentCommandArgs(args))).toBe(true)
})
