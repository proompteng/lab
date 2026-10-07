import { expect, test } from 'bun:test'

import { parseControlStudyArgs } from './control-study-command'

const args = [
  '--input',
  'input.json',
  '--input-sha256',
  'a'.repeat(64),
  '--arrivals',
  'source.ndjson.gz',
  '--source-receipt',
  'receipt.json',
  '--source-receipt-sha256',
  'b'.repeat(64),
  '--output',
  'report.json',
]

test('control command admits frozen study and provider-free preflight arguments', () => {
  expect(parseControlStudyArgs(['--help'])).toEqual({ _tag: 'Help' })
  expect(parseControlStudyArgs(args)).toMatchObject({ _tag: 'Run', mode: 'study' })
  expect(parseControlStudyArgs([...args, '--mode', 'preflight'])).toMatchObject({
    _tag: 'Run',
    mode: 'preflight',
    evidenceDirectory: undefined,
  })
  expect(parseControlStudyArgs([...args, '--evidence-directory', 'new-evidence'])).toMatchObject({
    _tag: 'Run',
    mode: 'study',
    evidenceDirectory: 'new-evidence',
  })
})

test('control command rejects ambiguous authority, mode and input identities', () => {
  for (const invalid of [
    [],
    args.slice(0, -1),
    [...args, '--broker', 'paper'],
    [...args, '--input', 'different.json'],
    [...args, '--mode', 'live'],
    [...args, '--mode', 'preflight', '--evidence-directory', 'evidence'],
    args.map((value) => (value === 'a'.repeat(64) ? 'not-a-hash' : value)),
    args.map((value) => (value === 'b'.repeat(64) ? 'B'.repeat(64) : value)),
    args.map((value) => (value === 'report.json' ? '' : value)),
    args.map((value) => (value === 'input.json' ? '--mode' : value)),
  ])
    expect(parseControlStudyArgs(invalid)).toEqual({ _tag: 'Invalid' })
})
