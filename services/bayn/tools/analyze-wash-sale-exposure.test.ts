import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { OrderSide } from '../src/execution/contracts'
import { analyzeWashSaleExposure, Sleeve } from './analyze-wash-sale-exposure-core'

const atoms = (value: number) => String(value * 1_000_000_000)
const micros = (usd: number) => String(usd * 1_000_000)
const fill = (
  id: string,
  side: OrderSide,
  date: string,
  shares: number,
  price: number,
  extra: {
    accountId?: string
    sleeve?: Sleeve
    symbol?: string
    at?: string
    feeMicros?: string
    specificLots?: readonly { buyFillId: string; quantityAtoms: string }[]
  } = {},
) => ({
  id,
  accountId: 'acct-b',
  sleeve: Sleeve.B0,
  symbol: 'QQQ',
  side,
  at: `${date}T15:00:00Z`,
  quantityAtoms: atoms(shares),
  priceAtoms: atoms(price),
  feeMicros: '0',
  ...extra,
})
const { Buy, Sell } = OrderSide
const ledger = (fills: readonly unknown[], observedThrough = '2026-12-31') => ({
  schemaVersion: 'bayn.wash-sale-fill-ledger.v1',
  observedThrough,
  taxYear: 2026,
  shortTermRateBps: 3000,
  longTermRateBps: 1500,
  fills,
})
const analyze = (input: unknown) => Result.getOrThrow(analyzeWashSaleExposure(input))

test('uses FIFO or the exact specific-lot quantities and allocates both sides of the fees', () => {
  const old = fill('old', Buy, '2025-12-01', 1, 100, { feeMicros: micros(1) })
  const recent = fill('recent', Buy, '2026-02-10', 1, 120, { feeMicros: micros(2) })
  const sell = fill('exit', Sell, '2026-04-15', 1.5, 150, { feeMicros: micros(3) })
  const fifo = analyze(ledger([sell, recent, old]))
  expect(fifo.dispositions).toMatchObject([
    { buyFillId: 'old', quantityAtoms: atoms(1), netProceedsMicros: micros(148), unadjustedBasisMicros: micros(101) },
    {
      buyFillId: 'recent',
      quantityAtoms: atoms(0.5),
      netProceedsMicros: micros(74),
      unadjustedBasisMicros: micros(61),
    },
  ])
  expect(fifo.totals).toMatchObject({
    tradedNotionalMicros: micros(345),
    preTaxRealizedPnlMicros: micros(60),
    estimatedShortTermTaxMicros: micros(18),
    postTaxRealizedPnlMicros: micros(42),
  })

  const specified = analyze(
    ledger([
      {
        ...sell,
        specificLots: [
          { buyFillId: 'recent', quantityAtoms: atoms(1) },
          { buyFillId: 'old', quantityAtoms: atoms(0.5) },
        ],
      },
      recent,
      old,
    ]),
  )
  expect(specified.dispositions).toMatchObject([
    { buyFillId: 'old', quantityAtoms: atoms(0.5) },
    { buyFillId: 'recent', quantityAtoms: atoms(1) },
  ])
  expect(specified.totals.preTaxRealizedPnlMicros).toBe(micros(49.5))
  expect(specified.openLots).toMatchObject([{ buyFillId: 'old', adjustedBasisMicros: micros(50.5) }])
})

test('matches by taxpayer and symbol across sleeves/accounts, including days −30 and +30 but not ±31', () => {
  const report = analyze(
    ledger([
      fill('source', Buy, '2026-06-01', 10, 100),
      fill('too-early', Buy, '2026-06-30', 10, 90, { accountId: 'acct-o', sleeve: Sleeve.O1 }),
      fill('pre', Buy, '2026-07-01', 3, 80, { accountId: 'acct-f', sleeve: Sleeve.F4 }),
      fill('other-symbol', Buy, '2026-07-10', 10, 80, { symbol: 'SMH' }),
      fill('loss', Sell, '2026-07-31', 10, 70),
      fill('post', Buy, '2026-08-30', 4, 50, { accountId: 'acct-o', sleeve: Sleeve.O1 }),
      fill('too-late', Buy, '2026-08-31', 10, 40, { accountId: 'acct-f', sleeve: Sleeve.F4 }),
    ]),
  )

  expect(report.dispositions).toMatchObject([
    {
      saleFillId: 'loss',
      washMatches: [
        {
          replacementFillId: 'pre',
          replacementSleeve: Sleeve.F4,
          quantityAtoms: atoms(3),
          deferredLossMicros: micros(90),
        },
        {
          replacementFillId: 'post',
          replacementSleeve: Sleeve.O1,
          quantityAtoms: atoms(4),
          deferredLossMicros: micros(120),
        },
      ],
      pendingReplacement: null,
    },
  ])
  expect(report.totals).toMatchObject({
    preTaxRealizedPnlMicros: micros(-300),
    washSaleDeferredMicros: micros(210),
    observedShortTermPnlMicros: micros(-90),
    washSaleWindowsComplete: true,
  })
  expect(report.openLots.filter(({ deferredLossMicros }) => deferredLossMicros !== '0')).toMatchObject([
    { buyFillId: 'pre', adjustedBasisMicros: micros(330) },
    { buyFillId: 'post', adjustedBasisMicros: micros(320) },
  ])
})

const chainedFills = [
  fill('b0-buy', Buy, '2026-01-02', 1, 100),
  fill('b0-sell', Sell, '2026-01-03', 1, 80),
  fill('f4-buy', Buy, '2026-01-04', 1, 90, { accountId: 'acct-f', sleeve: Sleeve.F4 }),
  fill('f4-sell', Sell, '2026-01-05', 1, 100, { accountId: 'acct-f', sleeve: Sleeve.F4 }),
  fill('o1-buy', Buy, '2026-01-06', 1, 80, { accountId: 'acct-o', sleeve: Sleeve.O1 }),
  fill('o1-sell', Sell, '2026-01-07', 1, 120, { accountId: 'acct-o', sleeve: Sleeve.O1 }),
]

test('carries adjusted basis through a chain, even when a raw profit becomes another tax loss', () => {
  const report = analyze(ledger(chainedFills))
  expect(report.dispositions).toMatchObject([
    { preTaxRealizedPnlMicros: micros(-20), washSaleDeferredMicros: micros(20), observedTaxPnlMicros: '0' },
    {
      preTaxRealizedPnlMicros: micros(10),
      adjustedBasisMicros: micros(110),
      washSaleDeferredMicros: micros(10),
      observedTaxPnlMicros: '0',
    },
    { adjustedBasisMicros: micros(90), observedTaxPnlMicros: micros(30), washMatches: [] },
  ])
  expect(report.totals).toMatchObject({
    tradedNotionalMicros: micros(570),
    preTaxRealizedPnlMicros: micros(30),
    washSaleBasisUsedMicros: micros(30),
    washSaleDeferredMicros: micros(30),
    observedShortTermPnlMicros: micros(30),
    estimatedTaxMicros: micros(9),
    postTaxRealizedPnlMicros: micros(21),
    shortTermTaxDragBps: '157.89',
  })
  expect(report.bySleeve).toMatchObject([
    { sleeve: Sleeve.B0, postTaxRealizedPnlMicros: micros(-20) },
    { sleeve: Sleeve.F4, postTaxRealizedPnlMicros: micros(10) },
    { sleeve: Sleeve.O1, postTaxRealizedPnlMicros: micros(31) },
  ])
  expect(report.bySymbol).toEqual([{ symbol: 'QQQ', ...report.totals }])
  expect(report.openLots).toEqual([])
})

test('keeps washed and unwashed shares of a partially matched buy distinct on later sales', () => {
  const report = analyze(
    ledger([
      fill('first-buy', Buy, '2026-02-02', 1, 100),
      fill('first-sale', Sell, '2026-04-01', 1, 80),
      fill('new-buy', Buy, '2026-04-02', 2, 90),
      fill('next-sale', Sell, '2026-05-05', 1.5, 120),
    ]),
  )
  expect(report.dispositions.slice(1)).toMatchObject([
    {
      buyFillId: 'new-buy',
      quantityAtoms: atoms(1),
      adjustedBasisMicros: micros(110),
      observedTaxPnlMicros: micros(10),
    },
    {
      buyFillId: 'new-buy',
      quantityAtoms: atoms(0.5),
      adjustedBasisMicros: micros(45),
      observedTaxPnlMicros: micros(15),
    },
  ])
  expect(report.openLots).toMatchObject([
    { buyFillId: 'new-buy', quantityAtoms: atoms(0.5), adjustedBasisMicros: micros(45), deferredLossMicros: '0' },
  ])
})

test('excludes retained shares of the sold lot, closed buys and already-used replacement shares', () => {
  const report = analyze(
    ledger([
      fill('partial', Buy, '2026-01-02', 2, 100),
      fill('closed-buy', Buy, '2026-01-03', 1, 50, { accountId: 'closed' }),
      fill('closed-sell', Sell, '2026-01-04', 1, 60, { accountId: 'closed' }),
      fill('first', Sell, '2026-01-05', 1, 80),
      fill('repl', Buy, '2026-01-06', 1.5, 80, { accountId: 'replacement' }),
      fill('second', Sell, '2026-01-07', 1, 90),
    ]),
  )
  expect(report.dispositions).toMatchObject([
    { saleFillId: 'closed-sell', washMatches: [] },
    {
      saleFillId: 'first',
      washMatches: [{ replacementFillId: 'repl', quantityAtoms: atoms(1), deferredLossMicros: micros(20) }],
    },
    {
      saleFillId: 'second',
      washMatches: [{ replacementFillId: 'repl', quantityAtoms: atoms(0.5), deferredLossMicros: micros(5) }],
      observedTaxPnlMicros: micros(-5),
    },
  ])
  expect(report.openLots).toMatchObject([
    { buyFillId: 'repl', quantityAtoms: atoms(1), adjustedBasisMicros: micros(100) },
    { buyFillId: 'repl', quantityAtoms: atoms(0.5), adjustedBasisMicros: micros(45) },
  ])
})

test('does not let a second lot sold in the same fill replace a loss and matches losses in acquisition order', () => {
  const report = analyze(
    ledger([
      fill('first-lot', Buy, '2026-02-02', 1, 100),
      fill('second-lot', Buy, '2026-02-05', 1, 120),
      fill('sell-both', Sell, '2026-02-06', 2, 80, {
        specificLots: [
          { buyFillId: 'second-lot', quantityAtoms: atoms(1) },
          { buyFillId: 'first-lot', quantityAtoms: atoms(1) },
        ],
      }),
      fill('replacement', Buy, '2026-02-07', 1, 80),
    ]),
  )
  expect(report.dispositions).toMatchObject([
    { buyFillId: 'first-lot', washMatches: [{ replacementFillId: 'replacement', deferredLossMicros: micros(20) }] },
    { buyFillId: 'second-lot', washMatches: [], observedTaxPnlMicros: micros(-40) },
  ])
})

test('uses New York dates and nanosecond execution order for same-day fills', () => {
  const report = analyze(
    ledger([
      fill('after', Buy, '', 0.25, 90, { at: '2026-10-16T00:00:00.000000004Z' }),
      fill('buy', Buy, '', 1, 100, { at: '2026-10-16T00:00:00.000000001Z' }),
      fill('before', Buy, '', 0.25, 90, { at: '2026-10-16T00:00:00.000000002Z' }),
      fill('sell', Sell, '', 1, 80, { at: '2026-10-16T00:00:00.000000003Z' }),
      fill('nov', Buy, '', 0.5, 90, { at: '2026-11-15T01:30:00Z' }),
    ]),
  )
  expect(report.dispositions).toMatchObject([
    {
      tradeDate: '2026-10-15',
      washMatches: [
        { replacementFillId: 'before', replacementTradeDate: '2026-10-15', replacementBeforeSale: true },
        { replacementFillId: 'after', replacementTradeDate: '2026-10-15', replacementBeforeSale: false },
        { replacementFillId: 'nov', replacementTradeDate: '2026-11-14', replacementBeforeSale: false },
      ],
      washSaleDeferredMicros: micros(20),
    },
  ])
})

test('withholds tax estimates for unmatched open windows and uses next-year evidence without counting next-year turnover', () => {
  const buyAndSell = [fill('entry', Buy, '2026-12-01', 2, 100), fill('exit', Sell, '2026-12-31', 2, 80)]
  const replacement = fill('next-year', Buy, '2027-01-15', 1, 90)
  const incomplete = analyze(ledger([...buyAndSell, replacement], '2027-01-29'))
  expect(incomplete.dispositions).toMatchObject([
    {
      pendingReplacement: { quantityAtoms: atoms(1), lossMicros: micros(20), windowEndsOn: '2027-01-30' },
    },
  ])
  expect(incomplete.totals).toMatchObject({
    preTaxRealizedPnlMicros: micros(-40),
    washSaleDeferredMicros: micros(20),
    pendingWashSaleLossMicros: micros(20),
    washSaleWindowsComplete: false,
    estimatedTaxMicros: null,
    postTaxRealizedPnlMicros: null,
    shortTermTaxDragBps: null,
  })
  const complete = analyze(ledger([...buyAndSell, replacement], '2027-01-30'))
  expect(complete.dispositions).toMatchObject([{ pendingReplacement: null }])
  expect(complete.totals).toMatchObject({
    tradedNotionalMicros: micros(360),
    washSaleWindowsComplete: true,
    estimatedTaxMicros: '0',
    postTaxRealizedPnlMicros: micros(-40),
  })
})

test('uses tacked holding periods and nets a long-term loss against short-term gain without granting a tax credit', () => {
  const report = analyze(
    ledger([
      fill('original', Buy, '2025-01-15', 1, 100),
      fill('old-loss', Sell, '2025-06-15', 1, 70),
      fill('replace', Buy, '2025-07-15', 1, 90),
      fill('tacked-loss', Sell, '2026-02-16', 1, 90),
      fill('short-buy', Buy, '2025-03-01', 1, 100, { symbol: 'SPY' }),
      fill('short-gain', Sell, '2026-03-01', 1, 135, { symbol: 'SPY' }),
    ]),
  )
  expect(report.dispositions).toMatchObject([
    { saleFillId: 'tacked-loss', term: 'long-term', adjustedBasisMicros: micros(120) },
    { saleFillId: 'short-gain', term: 'short-term' },
  ])
  expect(report.totals).toMatchObject({
    observedLongTermPnlMicros: micros(-30),
    observedShortTermPnlMicros: micros(35),
    estimatedShortTermTaxMicros: micros(1.5),
    estimatedTaxMicros: micros(1.5),
    postTaxRealizedPnlMicros: micros(33.5),
  })
  expect(report.bySymbol).toMatchObject([
    { symbol: 'QQQ', estimatedTaxMicros: '0' },
    { symbol: 'SPY', estimatedTaxMicros: micros(10.5) },
  ])
})

test('respects the month-end holding boundary across leap years and applies the long-term rate after it', () => {
  const report = analyze({
    ...ledger(
      [
        fill('buy', Buy, '2023-02-28', 2, 100),
        fill('anniversary', Sell, '2024-02-29', 1, 150),
        fill('beyond', Sell, '2024-03-01', 1, 150),
      ],
      '2024-03-01',
    ),
    taxYear: 2024,
  })
  expect(report.dispositions).toMatchObject([{ term: 'short-term' }, { term: 'long-term' }])
  expect(report.totals).toMatchObject({
    observedShortTermPnlMicros: micros(50),
    observedLongTermPnlMicros: micros(50),
    estimatedShortTermTaxMicros: micros(15),
    estimatedTaxMicros: micros(22.5),
    postTaxRealizedPnlMicros: micros(77.5),
  })
})

test('does not let display precision hide an unresolved fractional-share loss', () => {
  const report = analyze(
    ledger(
      [
        { ...fill('small-buy', Buy, '2026-05-04', 1, 100), quantityAtoms: '1' },
        { ...fill('small-loss', Sell, '2026-05-05', 1, 90), quantityAtoms: '1' },
      ],
      '2026-05-05',
    ),
  )
  expect(report.dispositions).toMatchObject([{ pendingReplacement: { quantityAtoms: '1', lossMicros: '0' } }])
  expect(report.totals).toMatchObject({ washSaleWindowsComplete: false, estimatedTaxMicros: null })
})

test('rejects malformed or incomplete inventory evidence rather than defaulting to FIFO or combining accounts', () => {
  const buy = fill('buy', Buy, '2026-04-01', 1, 100)
  const sell = fill('sell', Sell, '2026-05-02', 1, 120)
  for (const fixture of [
    ledger([buy, buy]),
    ledger([buy, { ...sell, at: '2026-04-01T15:00:00.000000000Z' }]),
    ledger([buy, sell], '2026-05-01'),
    ledger([sell]),
    ledger([buy, { ...sell, accountId: 'different' }]),
    ledger([buy, { ...sell, quantityAtoms: atoms(2) }]),
    ledger([buy, { ...sell, specificLots: [{ buyFillId: 'missing', quantityAtoms: atoms(1) }] }]),
    ledger([buy, { ...sell, specificLots: [{ buyFillId: 'buy', quantityAtoms: atoms(0.5) }] }]),
    ledger([buy, { ...sell, quantityAtoms: atoms(2), specificLots: [{ buyFillId: 'buy', quantityAtoms: atoms(2) }] }]),
    ledger([
      buy,
      {
        ...sell,
        specificLots: [
          { buyFillId: 'buy', quantityAtoms: atoms(0.5) },
          { buyFillId: 'buy', quantityAtoms: atoms(0.5) },
        ],
      },
    ]),
    ledger([buy, { ...sell, specificLots: [] }]),
    ledger([{ ...buy, specificLots: [{ buyFillId: 'buy', quantityAtoms: atoms(1) }] }]),
    ledger([{ ...buy, quantityAtoms: '1.01' }]),
    ledger([{ ...buy, side: 'SHORT' }]),
    ledger([{ ...buy, symbol: 'BTC/USD' }]),
    ledger([{ ...buy, at: '2026-02-30T15:00:00Z' }]),
    ledger([{ ...buy, unexpected: true }]),
    ledger([buy], '2025-12-31'),
    { ...ledger([buy]), shortTermRateBps: 10_001 },
  ]) {
    expect(analyzeWashSaleExposure(fixture)._tag).toBe('Failure')
  }
})

const cli = fileURLToPath(new URL('./analyze-wash-sale-exposure.ts', import.meta.url))
const run = (...args: string[]) =>
  Bun.spawnSync({ cmd: [process.execPath, cli, ...args], env: { TZ: 'Etc/UTC' }, stdout: 'pipe', stderr: 'pipe' })

test('the offline CLI produces deterministic JSON and markdown without changing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bayn-wash-sale-'))
  try {
    const path = join(dir, 'fills.json')
    const input = JSON.stringify(ledger(chainedFills))
    writeFileSync(path, input)
    const json = run('--fixture', path, '--format', 'json')
    expect(json.exitCode).toBe(0)
    expect(json.stderr.toString()).toBe('')
    expect(JSON.parse(json.stdout.toString())).toEqual(analyze(ledger(chainedFills)))
    expect(readFileSync(path, 'utf8')).toBe(input)
    expect(readdirSync(dir)).toEqual(['fills.json'])

    writeFileSync(path, JSON.stringify(ledger(chainedFills.toReversed())))
    const reversed = run('--fixture', path, '--format', 'json')
    expect(reversed.exitCode).toBe(0)
    expect(reversed.stdout.toString()).toBe(json.stdout.toString())

    const markdown = run('--fixture', path, '--format', 'markdown')
    expect(markdown.exitCode).toBe(0)
    expect(markdown.stderr.toString()).toBe('')
    expect(markdown.stdout.toString()).toContain('# Bayn wash-sale exposure')
    expect(markdown.stdout.toString()).toContain('| b0-sell | b0-buy | QQQ | B0 | f4-buy | F4 |')
    expect(markdown.stdout.toString()).toContain('157.89')
    expect(run('--fixture', path).stdout.toString()).toBe(markdown.stdout.toString())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the CLI fails closed on bad options, unreadable files, bad JSON and invalid fills without leaking values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bayn-wash-sale-error-'))
  try {
    const marker = 'sensitive-fixture-marker'
    const path = join(dir, `${marker}.json`)
    const assertFailure = (args: string[], message: string) => {
      const result = run(...args)
      expect(result.exitCode).toBe(1)
      expect(result.stdout.toString()).toBe('')
      expect(result.stderr.toString()).toContain(message)
      expect(result.stderr.toString()).not.toContain(marker)
    }
    assertFailure([], 'Usage:')
    assertFailure(['--fixture', path, '--fixture', path], 'Usage:')
    assertFailure(['--fixture', path, '--format', marker], 'Usage:')
    assertFailure(['--fixture', path, '--account', marker], 'Usage:')
    assertFailure(['--fixture', path], 'Cannot read fixture')
    writeFileSync(path, `{ "${marker}":`)
    assertFailure(['--fixture', path], 'Invalid fixture JSON')
    writeFileSync(path, JSON.stringify({ ...ledger([]), [marker]: 'private' }))
    assertFailure(['--fixture', path], 'Invalid fixture schema')
    writeFileSync(path, JSON.stringify(ledger([fill(marker, Sell, '2026-04-01', 1, 80)])))
    assertFailure(['--fixture', path], 'Sale exceeds held quantity')
    expect(run('--help').stdout.toString()).toContain('--fixture')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
