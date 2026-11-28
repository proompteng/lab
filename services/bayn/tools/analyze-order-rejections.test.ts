import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Result } from 'effect'

import {
  analyzeOrderRejections,
  renderOrderRejectionJson,
  renderOrderRejectionMarkdown,
} from './analyze-order-rejections-core'

const attemptedAt = '2026-11-27T14:30:00.250Z'
const asOf = '2026-11-27T18:10:00Z'
const filled = (attemptId: number, overrides: Record<string, unknown> = {}) => ({
  attemptId,
  attemptedAt,
  terminalAt: attemptedAt,
  symbol: 'QQQ',
  accountTier: 'MARGIN',
  side: 'BUY',
  outcome: 'FILLED',
  quantityAtoms: '2000000000',
  filledQuantityAtoms: '2000000000',
  valuationPriceMicros: '100000000',
  ...overrides,
})
const rejected = (attemptId: number, overrides: Record<string, unknown> = {}) =>
  filled(attemptId, { outcome: 'REJECTED', reason: 'BROKER_ERROR', filledQuantityAtoms: '0', ...overrides })
const quote = {
  limitPriceMicros: '100000000',
  bidPriceMicros: '100000000',
  askPriceMicros: '100010000',
  at: '2026-11-27T14:29:59.250Z',
}
const collar = (attemptId: number, overrides: Record<string, unknown> = {}) =>
  filled(attemptId, { outcome: 'CANCELED', filledQuantityAtoms: '0', collarQuote: quote, ...overrides })
const markout = (barCloseMicros: string, overrides: Record<string, unknown> = {}) => ({
  referencePriceMicros: '100000000',
  barStartAt: '2026-11-27T14:31:00.000Z',
  barCloseMicros,
  ...overrides,
})
const fixture = (attempts: readonly unknown[], cut = asOf) =>
  JSON.stringify({ schemaVersion: 'bayn.order-rejection-evidence.v1', asOf: cut, attempts })
const analyze = (attempts: readonly unknown[]) => {
  const result = analyzeOrderRejections(fixture(attempts))
  if (Result.isFailure(result)) throw new Error(result.failure.message)
  return result.success
}

const cash = { symbol: 'SMH', accountTier: 'CASH' }
const mixedAttempts = [
  filled(1),
  collar(2, { markout: markout('101000000') }),
  rejected(3, { outcome: 'BLOCKED', reason: 'PDT_BLOCK' }),
  rejected(4, { reason: 'BUYING_POWER', markout: markout('99000000') }),
  rejected(5, { ...cash, reason: 'WASH_TRADE_GUARD' }),
  rejected(6, { ...cash, outcome: 'BLOCKED', reason: 'STALE_QUOTE' }),
  rejected(7, {
    ...cash,
    outcome: 'EXPIRED',
    reason: 'MARKET_HALT',
    filledQuantityAtoms: '1500000000',
    valuationPriceMicros: '80000000',
    markout: markout('80000000', { referencePriceMicros: '80000000' }),
  }),
  rejected(8, { ...cash, side: 'SELL', markout: markout('101000000') }),
  filled(9, { symbol: 'SPY', accountTier: 'PORTFOLIO_MARGIN' }),
]

test('attributes all seven causes and uses the full attempt denominator and unfilled quantities', () => {
  const report = analyze(mixedAttempts)

  expect(report).toMatchObject({
    schemaVersion: 'bayn.order-rejection-report.v1',
    severity: 'CRITICAL',
    severityReason: 'PDT_BLOCK',
    overall: {
      attempts: 9,
      missedAttempts: 7,
      rejectionRatePct: 77.7778,
      missedNotionalMicros: '1240000000',
      markedMisses: 4,
      missedBps: 31.25,
      adverseBps: 62.5,
    },
  })
  expect(report.overall.byCause.map(({ cause }) => String(cause))).toEqual([
    'BROKER_ERROR',
    'BUYING_POWER',
    'COLLAR_MISS',
    'MARKET_HALT',
    'PDT_BLOCK',
    'STALE_QUOTE',
    'WASH_TRADE_GUARD',
  ])
  expect(report.cohorts).toMatchObject([
    { symbol: 'QQQ', timeBucket: '0930_1000', accountTier: 'MARGIN', attempts: 4, rejectionRatePct: 75 },
    { symbol: 'SMH', timeBucket: '0930_1000', accountTier: 'CASH', attempts: 4, rejectionRatePct: 100 },
    { symbol: 'SPY', accountTier: 'PORTFOLIO_MARGIN', attempts: 1, missedAttempts: 0, byCause: [] },
  ])
  expect(report.cohorts[0]?.byCause.find(({ cause }) => cause === 'PDT_BLOCK')).toMatchObject({
    missedAttempts: 1,
    rejectionRatePct: 25,
    missedNotionalMicros: '200000000',
    markedMisses: 0,
    missedBps: null,
    adverseBps: null,
  })
  expect(report.overall.byCause.find(({ cause }) => cause === 'MARKET_HALT')).toMatchObject({
    missedNotionalMicros: '40000000',
    markedMisses: 1,
    missedBps: 0,
    adverseBps: 0,
  })
})

test('uses the executable bid for a sell collar and signs a profitable short markout as missed', () => {
  const report = analyze([
    collar(1, {
      side: 'SELL',
      outcome: 'EXPIRED',
      collarQuote: { ...quote, at: attemptedAt, bidPriceMicros: '99990000' },
      markout: markout('99000000'),
    }),
  ])
  expect(report.overall.byCause).toMatchObject([{ cause: 'COLLAR_MISS', missedBps: 100, adverseBps: 0 }])
})

test('values remaining fractional quantities exactly, rounding down only after grouping', () => {
  const fraction = {
    quantityAtoms: '1',
    valuationPriceMicros: '600000000',
  }
  const report = analyze([rejected(1, fraction), rejected(2, fraction)])
  expect(report.overall.missedNotionalMicros).toBe('1')
  expect(report.overall.byCause[0]?.missedNotionalMicros).toBe('1')
})

test('groups by Eastern clock boundaries in both daylight and standard time and separates tiers', () => {
  const clocks = [
    '2026-11-27T14:29:59.999Z',
    '2026-11-27T14:30:00Z',
    '2026-11-27T15:00:00Z',
    '2026-11-27T20:30:00Z',
    '2026-11-27T21:00:00Z',
    '2026-07-21T13:30:00Z',
  ]
  const report = analyzeOrderRejections(
    fixture(
      clocks.map((at, i) =>
        filled(i + 1, { attemptedAt: at, terminalAt: at, accountTier: i === 1 ? 'CASH' : 'MARGIN' }),
      ),
      '2026-11-27T21:01:00Z',
    ),
  )
  if (Result.isFailure(report)) throw new Error(report.failure.message)
  expect(
    report.success.cohorts.map(({ timeBucket, accountTier, attempts }) => [
      String(timeBucket),
      String(accountTier),
      attempts,
    ]),
  ).toEqual([
    ['0000_0930', 'MARGIN', 1],
    ['0930_1000', 'CASH', 1],
    ['0930_1000', 'MARGIN', 1],
    ['1000_1530', 'MARGIN', 1],
    ['1530_1600', 'MARGIN', 1],
    ['1600_2400', 'MARGIN', 1],
  ])
})

test.each([
  [10, 'BROKER_ERROR', true, 'CRITICAL', 'CRITICAL_RATE'],
  [11, 'BROKER_ERROR', true, 'WARNING', 'WARNING_RATE'],
  [20, 'BROKER_ERROR', true, 'WARNING', 'WARNING_RATE'],
  [21, 'BROKER_ERROR', true, 'OK', 'BELOW_THRESHOLDS'],
  [21, 'BROKER_ERROR', false, 'WARNING', 'MISSING_MARKOUT'],
  [21, 'PDT_BLOCK', true, 'CRITICAL', 'PDT_BLOCK'],
] as const)(
  'uses exact thresholds and evidence at %i attempts (%s, marked=%s)',
  (count, reason, marked, severity, severityReason) => {
    const report = analyze([
      rejected(1, { reason, ...(marked ? { markout: markout('100000000') } : {}) }),
      ...Array.from({ length: count - 1 }, (_, i) => filled(i + 2)),
    ])
    expect(report).toMatchObject({ severity, severityReason })
  },
)

test('an all-filled population has zero misses and no markout, not missing evidence', () => {
  expect(analyze([filled(1)])).toMatchObject({
    severity: 'OK',
    overall: {
      attempts: 1,
      missedAttempts: 0,
      rejectionRatePct: 0,
      missedNotionalMicros: '0',
      markedMisses: 0,
      missedBps: null,
      adverseBps: null,
    },
  })
})

test.each([
  ['missing attempt population', fixture([])],
  ['wrong evidence version', '{"schemaVersion":"bayn.live-profitability-evidence.v1","sessions":[]}'],
  ['duplicate attempt', fixture([filled(1), rejected(1)])],
  ['working order', fixture([filled(1, { outcome: 'PARTIALLY_FILLED' })])],
  ['unknown tier', fixture([filled(1, { accountTier: 'UNKNOWN' })])],
  ['unknown rejection code', fixture([rejected(1, { reason: 'RANDOM_CANCEL' })])],
  ['filled order with a rejection', fixture([filled(1, { reason: 'BUYING_POWER' })])],
  ['filled order with a remainder', fixture([filled(1, { filledQuantityAtoms: '1' })])],
  ['rejected order with a fill', fixture([rejected(1, { filledQuantityAtoms: '1' })])],
  ['blocked order with a fill', fixture([rejected(1, { outcome: 'BLOCKED', filledQuantityAtoms: '1' })])],
  ['overfill', fixture([rejected(1, { outcome: 'CANCELED', filledQuantityAtoms: '2000000001' })])],
  ['unknown cancel', fixture([filled(1, { outcome: 'CANCELED', filledQuantityAtoms: '0' })])],
  ['direct collar label without proof', fixture([rejected(1, { reason: 'COLLAR_MISS' })])],
  ['collar only on canceled or expired attempts', fixture([collar(1, { outcome: 'REJECTED' })])],
  ['collar and explicit reason', fixture([collar(1, { reason: 'PDT_BLOCK' })])],
  ['partial fill with collar evidence', fixture([collar(1, { filledQuantityAtoms: '1' })])],
  ['limit is executable at equality', fixture([collar(1, { collarQuote: { ...quote, askPriceMicros: '100000000' } })])],
  ['crossed quote', fixture([collar(1, { collarQuote: { ...quote, bidPriceMicros: '100020000' } })])],
  [
    'quote older than fail-closed limit by 1 ns',
    fixture([collar(1, { collarQuote: { ...quote, at: '2026-11-27T14:29:59.249999999Z' } })]),
  ],
  ['future quote by 1 ns', fixture([collar(1, { collarQuote: { ...quote, at: '2026-11-27T14:30:00.250000001Z' } })])],
  ['attempt not terminal by the cut', fixture([filled(1, { terminalAt: '2026-11-27T18:10:00.000000001Z' })])],
  ['terminal event before attempt', fixture([filled(1, { terminalAt: '2026-11-27T14:30:00.249Z' })])],
  ['reference mark is zero', fixture([rejected(1, { markout: markout('101000000', { referencePriceMicros: '0' }) })])],
  [
    'bar overlaps the attempt',
    fixture([rejected(1, { markout: markout('101000000', { barStartAt: '2026-11-27T14:30:00.000Z' }) })]),
  ],
  [
    'bar is not the next minute',
    fixture([rejected(1, { markout: markout('101000000', { barStartAt: '2026-11-27T14:32:00.000Z' }) })]),
  ],
  [
    'bar has not completed by the cut',
    fixture([rejected(1, { markout: markout('101000000') })], '2026-11-27T14:31:59.999999999Z'),
  ],
])('fails closed on %s', (_label, input) => {
  expect(Result.isFailure(analyzeOrderRejections(input))).toBe(true)
})

const cliPath = join(import.meta.dir, 'analyze-order-rejections.ts')
const runCli = (cwd: string, args: string[]) => {
  const result = Bun.spawnSync([process.execPath, cliPath, ...args], { cwd, env: { TZ: 'Pacific/Honolulu' } })
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

test('CLI pipes deterministic reports for a breach, returns nonzero and leaves the fixture unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bayn-order-rejections-'))
  const path = join(dir, 'evidence.json')
  const input = fixture(mixedAttempts)
  try {
    writeFileSync(path, input)
    const report = analyze(mixedAttempts)
    const json = runCli(dir, ['--fixture', path, '--format', 'json'])
    const markdown = runCli(dir, ['--fixture', path, '--format', 'markdown'])
    expect(json).toEqual({ exitCode: 2, stdout: `${renderOrderRejectionJson(report)}\n`, stderr: '' })
    expect(markdown).toEqual({ exitCode: 2, stdout: `${renderOrderRejectionMarkdown(report)}\n`, stderr: '' })
    expect(markdown.stdout).toContain('| All | — | — | — | 9 | 7 | 77.7778% | $1240.000000 | 4 | 31.25 | 62.5 |')
    expect(readdirSync(dir)).toEqual(['evidence.json'])
    expect(readFileSync(path, 'utf8')).toBe(input)

    writeFileSync(path, fixture(mixedAttempts.toReversed()))
    expect(runCli(dir, ['--fixture', path, '--format', 'json'])).toEqual(json)
    expect(runCli(dir, ['--fixture', path])).toEqual(markdown)

    writeFileSync(path, fixture([filled(1)]))
    expect(runCli(dir, ['--fixture', path, '--format', 'json'])).toEqual({
      exitCode: 0,
      stdout: `${renderOrderRejectionJson(analyze([filled(1)]))}\n`,
      stderr: '',
    })
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('CLI redacts raw args, paths, JSON syntax, schema failures and rejects duplicate flags', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bayn-order-rejections-'))
  const marker = 'SYNTHETIC-DO-NOT-ECHO'
  const path = join(dir, `${marker}.json`)
  const check = (args: string[], error: string) => {
    const result = runCli(dir, args)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(error)
    expect(result.stderr).not.toContain(marker)
  }
  try {
    check([], 'OrderRejectionCommandError')
    check(['--fixture', path, '--format', marker], 'OrderRejectionCommandError')
    check(['--fixture', path, '--fixture', path], 'OrderRejectionCommandError')
    check(['--fixture', path], 'OrderRejectionCommandError')
    writeFileSync(path, `not JSON ${marker}`)
    check(['--fixture', path], 'OrderRejectionEvidenceError')
    writeFileSync(path, fixture([rejected(1, { message: marker })]))
    check(['--fixture', path], 'OrderRejectionEvidenceError')
    writeFileSync(path, fixture([rejected(1, { reason: marker })]))
    check(['--fixture', path], 'OrderRejectionEvidenceError')
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})
