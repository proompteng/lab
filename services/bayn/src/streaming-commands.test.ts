import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { canonicalJsonV1Result } from './hash'
import { emptyStreamingProjection } from './market-data/streaming/projection'
import { parseStreamingReplayArgs } from './streaming-replay-command'
import { parseStreamingDiagnosticsArgs, summarizeStreamingSymbol } from './streaming-diagnostics-command'

test('streaming commands require an explicit evidence source and reject ambiguous arguments', () => {
  expect(parseStreamingReplayArgs(['--file', 'decision.json'])).toEqual({ _tag: 'File', path: 'decision.json' })
  expect(parseStreamingReplayArgs(['--historical', 'experiment.json'])).toEqual({
    _tag: 'Historical',
    path: 'experiment.json',
  })
  expect(parseStreamingReplayArgs(['--historical', 'experiment.json', '--file', 'decision.json'])._tag).toBe('Invalid')
  expect(parseStreamingReplayArgs(['--decision', 'a'.repeat(64)])._tag).toBe('Decision')
  expect(parseStreamingReplayArgs(['--decision', 'not-a-hash'])._tag).toBe('Invalid')
  expect(parseStreamingReplayArgs(['--file', 'decision.json', '--help'])._tag).toBe('Invalid')
  expect(parseStreamingDiagnosticsArgs(['--since', '2026-09-11T19:00:00Z']).kind).toBe('probe')
  expect(parseStreamingDiagnosticsArgs(['--since', '2026-02-30T19:00:00Z']).kind).toBe('invalid')
  expect(parseStreamingDiagnosticsArgs(['--since', '2026-09-11']).kind).toBe('invalid')
  expect(parseStreamingDiagnosticsArgs(['--help']).kind).toBe('help')
})

test('historical diagnostics require an explicit bounded bootstrap budget', () => {
  const args = ['--since', '2026-09-11T19:00:00Z']
  expect(parseStreamingDiagnosticsArgs(args)).toMatchObject({ kind: 'probe', bootstrapTimeoutMs: 300_000 })
  for (const seconds of ['1', '1800', '3600', '7200', '14400']) {
    expect(parseStreamingDiagnosticsArgs([...args, '--bootstrap-timeout-seconds', seconds])).toMatchObject({
      kind: 'probe',
      bootstrapTimeoutMs: Number(seconds) * 1000,
    })
  }
  for (const seconds of ['0', '-1', '14401', 'Infinity', 'NaN', '1.5', '1e3', ' 300', '']) {
    expect(parseStreamingDiagnosticsArgs([...args, '--bootstrap-timeout-seconds', seconds]).kind).toBe('invalid')
  }
  expect(parseStreamingDiagnosticsArgs([...args, '--bootstrap-timeout-seconds']).kind).toBe('invalid')
  expect(parseStreamingDiagnosticsArgs([...args, '--timeout', '3600']).kind).toBe('invalid')
  expect(parseStreamingDiagnosticsArgs(['--codecs', '--bootstrap-timeout-seconds', '3600']).kind).toBe('invalid')
})

test('streaming diagnostics serialize explicit missing coverage for a configured symbol', () => {
  const symbol = summarizeStreamingSymbol(emptyStreamingProjection('diagnostic-coverage'), 'AMD')
  const encoded = canonicalJsonV1Result({ symbols: [symbol] })
  expect(Result.isSuccess(encoded)).toBe(true)
  if (Result.isFailure(encoded)) return
  expect(JSON.parse(encoded.success)).toEqual({
    symbols: [
      {
        symbol: 'AMD',
        retainedBars: 0,
        retainedFeatures: 0,
        latestQuoteAt: null,
        latestTradeAt: null,
        matchedFeatures: [],
      },
    ],
  })
})
