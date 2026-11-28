import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeFileSystem } from '@effect/platform-node'
import { Cause, ConfigProvider, Effect, Exit, Fiber, Layer, Result, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { TestClock } from 'effect/testing'

import { Side, type Bar, type OrderRequest, type Position } from './macro-canary-runner/alpaca'
import { Mode, TimeInForce } from './macro-canary-runner/contract'
import { etfs, macroInputs, type Etf } from './macro-canary-runner/signals'
import { buildScorecard } from './multi-horizon-scorecard-core'
import { parseOptions, runRebalance } from './run-macro-canary-etf-rebalance'

const accountId = '11111111-1234-4234-8123-000000000001'
const otherId = '11111111-1234-4234-8123-000000000002'
const testKey = 'mock-key-not-a-credential'
const testSecret = 'mock-secret-not-a-credential'
const reviewIndex = 252 + 21 * 73

const dates: string[] = []
for (let t = Date.UTC(2016, 0, 4); dates.length <= reviewIndex + 8; t += 86_400_000) {
  const day = new Date(t)
  if (day.getUTCDay() >= 1 && day.getUTCDay() <= 5) dates.push(day.toISOString().slice(0, 10))
}
const offsetFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' })
const timestamp = (date: string, time: string) => {
  const offset = offsetFormatter
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find(({ type }) => type === 'timeZoneName')
  return new Date(`${date}T${time}:00${offset?.value.slice(3)}`).toISOString()
}
const timestamps = dates.map((date) => timestamp(date, '00:00'))

type Regime = 'stagflation' | 'goldilocks' | 'flat' | 'mixed'
const slopes: Readonly<Record<Regime, Partial<Record<Etf, number>>>> = {
  flat: {},
  mixed: { HYG: -0.0018, TLT: -0.001, IEF: 0.0006, GLD: 0.002, DBC: 0.003, UUP: 0.0002, EEM: 0.0004 },
  stagflation: { HYG: -0.0025, TLT: -0.0012, IEF: -0.00045, GLD: 0.0016, DBC: 0.002, UUP: 0.0025, EEM: -0.0013 },
  goldilocks: { HYG: 0.0021, TLT: 0.0007, IEF: 0.0004, GLD: -0.0014, DBC: -0.001, UUP: -0.002, EEM: 0.001 },
}
const adjusted = (regime: Regime, symbol: Etf, t: number) => {
  const i = etfs.indexOf(symbol)
  if (regime === 'flat') return 100 + i
  const slope = slopes[regime][symbol] ?? (regime === 'stagflation' ? -0.00015 : 0.0006) + i * 0.00002
  return (80 + i) * Math.exp(t * slope + 0.045 * Math.sin(t / (5 + i / 2)) + 0.026 * Math.cos(t / 11))
}
const daily = (symbol: Etf, t: number, price: number): Bar => ({
  t: timestamps[t],
  o: price,
  h: price * 1.01,
  l: price * 0.99,
  c: price,
  v: 1_234_567 + etfs.indexOf(symbol),
  n: 1_000,
  vw: price,
})

const receiptIdentity = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.macro-canary-rebalance-receipt.v1'),
  timestamp: Schema.String,
  signalSession: Schema.String,
  executionSession: Schema.String,
  mode: Schema.Literals(['shadow', 'paper-submit']),
  barSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  planSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
})

type MockOptions = {
  regime?: Regime
  prior?: number
  clockTimestamp?: string
  now?: string
  origin?: string
  nextOpen?: string
  seedMissing?: boolean
  barFault?: 'missing' | 'future' | 'raw-stale' | 'duplicate' | 'token-cycle' | 'bad-close'
  rawPrice?: number
  earlyClose?: boolean
  positions?: readonly Position[]
  orders?: readonly object[]
  terminalOrders?: readonly object[]
  equity?: string
  cash?: string
  buyingPower?: string
  secondAccountCash?: string
  secondAccountId?: string
  postFault?: 'transport' | 'bad-ack' | 'redirect'
  advanceBeforePreflight?: string
  hold?: 'calendar' | 'submit'
}

const position = (symbol: string, qty: number, price = 200): Position => ({
  symbol,
  side: qty > 0 ? 'long' : 'short',
  qty: String(qty),
  qty_available: String(qty),
  market_value: String(qty * price),
})

const mock = (options: MockOptions = {}) => {
  const prior = options.prior ?? reviewIndex
  const previousDate = dates[prior]
  const nextDate = dates[prior + 1]
  const now = options.now ?? timestamp(nextDate, '08:00')
  const nextOpen = options.nextOpen ?? timestamp(nextDate, '09:30')
  const regime = options.regime ?? 'stagflation'
  const dayCache = new Map(timestamps.map((time, t) => [time, t]))
  const calls: { url: URL; method: string }[] = []
  const posts: OrderRequest[] = []
  let accountReads = 0
  let clockReads = 0
  let aborted = 0
  const pending = Promise.withResolvers<void>()
  const holdResponse = (signal?: AbortSignal | null) =>
    new Promise<Response>((_, reject) => {
      signal?.addEventListener(
        'abort',
        () => {
          aborted += 1
          reject(new Error('Mock request canceled'))
        },
        { once: true },
      )
      pending.resolve()
    })
  const series = (symbols: readonly Etf[], start: number, end: number, raw: boolean) =>
    symbols.map((symbol) => ({
      symbol,
      bars: Array.from({ length: end - start + 1 }, (_, i) =>
        daily(symbol, i + start, raw ? (options.rawPrice ?? 200) : adjusted(regime, symbol, i + start)),
      ),
    }))
  const mockFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input)
      const method = init?.method ?? 'GET'
      const headers = new Headers(init?.headers)
      expect(headers.get('apca-api-key-id')).toBe(testKey)
      expect(headers.get('apca-api-secret-key')).toBe(testSecret)
      expect(init?.redirect).toBe('error')
      calls.push({ url, method })
      if (url.hostname === 'data.alpaca.markets' && url.pathname === '/v2/stocks/bars') {
        const params = url.searchParams
        expect(method).toBe('GET')
        expect(params.get('feed')).toBe('sip')
        expect(params.get('timeframe')).toBe('1Day')
        const symbols = (params.get('symbols') ?? '').split(',') as Etf[]
        const raw = params.get('adjustment') === 'raw'
        expect(params.get('adjustment')).toBe(raw ? 'raw' : 'all')
        const start = dayCache.get(params.get('start') ?? '')
        if (start === undefined) throw new Error('Unexpected bar start')
        const seed = symbols.length === macroInputs.length
        expect(symbols).toEqual(seed ? [...macroInputs] : [...etfs])
        expect(start).toBe(seed ? 0 : raw ? prior : prior - 319)
        const end = seed ? prior - 320 : prior
        const endBoundary = seed ? end + 1 : prior + 1
        expect(params.get('end')).toBe(new Date(Date.parse(timestamps[endBoundary]) - 1).toISOString())
        const selected = series(symbols, start, end, raw)
        const paged = !raw && !seed
        const page = params.get('page_token')
        const rows = paged ? (page === null ? selected.slice(0, 14) : selected.slice(14)) : selected
        const bars = Object.fromEntries(rows.map(({ symbol, bars }) => [symbol, bars]))
        if (options.seedMissing === true && seed) bars['GLD'].pop()
        if (options.barFault === 'missing' && paged && page === null) bars['DIA'].splice(11, 1)
        if (options.barFault === 'future' && paged && page === null) bars['DIA'].push(daily('DIA', prior + 1, 100))
        if (options.barFault === 'raw-stale' && raw) bars['UUP'] = [daily('UUP', prior - 1, 200)]
        if (options.barFault === 'duplicate' && paged && page === null) bars['DIA'].push(bars['DIA'][0])
        if (options.barFault === 'bad-close' && paged && page === null) bars['DIA'][0] = { ...bars['DIA'][0], c: 0 }
        return Response.json({
          bars,
          next_page_token: paged && (page === null || options.barFault === 'token-cycle') ? 'next-page' : null,
        })
      }

      expect(url.origin).toBe('https://paper-api.alpaca.markets')
      switch (url.pathname) {
        case '/v2/calendar':
          if (options.hold === 'calendar') return holdResponse(init?.signal)
          expect(url.searchParams.get('start')).toBe('2016-01-04')
          expect(url.searchParams.get('date_type')).toBe('TRADING')
          return Response.json(
            dates
              .filter((date) => date <= (url.searchParams.get('end') ?? ''))
              .map((date) => ({
                date,
                open: '09:30',
                close: options.earlyClose === true && date === previousDate ? '13:00' : '16:00',
              })),
          )
        case '/v2/clock':
          clockReads++
          return Response.json({
            timestamp: options.clockTimestamp ?? now,
            is_open: false,
            next_open: clockReads > 1 ? (options.advanceBeforePreflight ?? nextOpen) : nextOpen,
          })
        case '/v2/account':
          accountReads++
          return Response.json({
            id: accountReads > 1 ? (options.secondAccountId ?? accountId) : accountId,
            status: 'ACTIVE',
            currency: 'USD',
            equity: options.equity ?? '100000',
            cash:
              accountReads > 1 ? (options.secondAccountCash ?? options.cash ?? '100000') : (options.cash ?? '100000'),
            buying_power: options.buyingPower ?? '100000',
            account_blocked: false,
            trading_blocked: false,
            trade_suspended_by_user: false,
          })
        case '/v2/positions':
          return Response.json(options.positions ?? [])
        case '/v2/orders':
          if (method === 'POST') {
            const body = init?.body
            if (typeof body !== 'string' && !(body instanceof Uint8Array)) throw new Error('Expected a JSON body')
            const order: OrderRequest = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body))
            posts.push(order)
            if (options.hold === 'submit') return holdResponse(init?.signal)
            if (options.postFault === 'transport') throw new Error(testSecret)
            if (options.postFault === 'redirect')
              return new Response(null, { status: 307, headers: { Location: 'https://api.alpaca.markets/v2/orders' } })
            return Response.json({
              ...order,
              id: otherId,
              status: 'accepted',
              ...(options.postFault === 'bad-ack' ? { qty: '1' } : {}),
            })
          }
          return Response.json(url.searchParams.has('after') ? (options.terminalOrders ?? []) : (options.orders ?? []))
        default:
          return new Response(null, { status: 404 })
      }
    },
    { preconnect: fetch.preconnect },
  )
  const layer = Layer.mergeAll(
    NodeFileSystem.layer,
    FetchHttpClient.layer,
    TestClock.layer(),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        BAYN_ALPACA_KEY_ID: testKey,
        BAYN_ALPACA_SECRET_KEY: testSecret,
        ...(options.origin === undefined ? {} : { BAYN_ALPACA_BASE_URL: options.origin }),
      }),
    ),
  )
  const run = (out: string, flags: readonly string[] = [], cancel?: 'interrupt' | 'deadline') =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now))
      const program = runRebalance(['--output', out, ...flags])
      if (cancel === undefined) return yield* program
      const fiber = yield* Effect.forkChild(program)
      yield* Effect.promise(() => pending.promise)
      if (cancel === 'interrupt') yield* Fiber.interrupt(fiber)
      else yield* TestClock.adjust('12 seconds')
      return yield* Fiber.join(fiber)
    }).pipe(
      Effect.scoped,
      Effect.provideService(FetchHttpClient.Fetch, mockFetch),
      // @effect-diagnostics-next-line strictEffectProvide:off -- this mock CLI run owns the test clock and transport
      Effect.provide(layer),
      Effect.runPromiseExit,
    )
  return {
    run,
    calls,
    posts,
    aborted: () => aborted,
    prior,
    now,
    previousDate,
    nextDate,
    adjustedMaterial: {
      feed: 'sip',
      timeframe: '1Day',
      adjustment: 'all',
      recent: series(etfs, prior - 319, prior, false),
      macroSeed: series(macroInputs, 0, prior - 320, false),
    },
  }
}

const fixture = async <A>(fn: (dir: string) => Promise<A>) => {
  const directory = await mkdtemp(join(tmpdir(), 'bayn-macro-canary-'))
  try {
    return await fn(directory)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

const verify = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(Cause.pretty(exit.cause))
}
const rejected = <A, E>(exit: Exit.Exit<A, E>, message: string) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) return
  const error = Cause.pretty(exit.cause)
  expect(error).toContain(message)
  expect(error).not.toContain(testSecret)
  expect(error).not.toContain(testKey)
}
const paper = ['--mode', 'paper-submit', '--confirm-paper-account', accountId]
const independentCanonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(independentCanonical).join(',')}]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${independentCanonical(item)}`)
    .join(',')}}`
}
const sha256 = (value: unknown) => createHash('sha256').update(independentCanonical(value)).digest('hex')

test('defaults to shadow and rejects ambiguous or unsafe options', () => {
  expect(parseOptions(['--output', 'r.json'])).toEqual(
    Result.succeed({
      output: 'r.json',
      mode: Mode.Shadow,
      tif: TimeInForce.Open,
      excludeSymbols: [],
    }),
  )
  for (const flags of [
    ['--mode', 'live'],
    ['--mode', 'paper-submit'],
    ['--confirm-paper-account', accountId],
    ['--capital-budget-usd', '150001'],
    ['--capital-budget-usd', '10e3'],
    ['--exclude-symbols', 'QQQ,'],
    ['--tif', 'opg', '--tif', 'day'],
    ['--bogus'],
    ['--tif', 'gtc'],
  ])
    expect(Result.isFailure(parseOptions(['--output', 'r.json', ...flags]))).toBe(true)
})

// Golden vectors from the unmodified Wave 5D features/targets(mix, ..., -1) on the full fixture,
// with the reference sweep applied to the residual. Pinned source: 12529c2cd54bcfc2f9f6ae8e4a11ab07817f9c54.
const reference: Readonly<Record<Exclude<Regime, 'flat'>, Partial<Record<Etf, number>>>> = {
  stagflation: {
    SHY: 0.060209424955557804,
    GLD: 0.2539494765161648,
    SLV: 0.061968317119089324,
    DBC: 0.122177742074647,
    UUP: 0.45521880149522415,
    EFA: 0.046476237839317,
  },
  goldilocks: {
    SPY: 0.059691582878570765,
    QQQ: 0.059522785224808174,
    IWM: 0.06480415014020678,
    XLK: 0.05034842879438776,
    XLV: 0.08812162166163011,
    TLT: 0.08725931110628221,
    IEF: 0.08503926212252104,
    SHY: 1.7478200158012012e-7,
    HYG: 0.09731546719749644,
    LQD: 0.09731546719749644,
    GLD: 1.7478200158012012e-7,
    SLV: 0.06487697813166428,
    EFA: 0.19704686238218472,
    EEM: 0.04865773359874822,
  },
  mixed: {
    SPY: 0.009369816469462706,
    QQQ: 0.009200537120970662,
    IWM: 0.029201339554918923,
    IEF: 0.07760890285573943,
    SHY: 0.09026398967418879,
    LQD: 0.09759317453879851,
    GLD: 0.2579649041582158,
    SLV: 0.06506211635919901,
    DBC: 0.29441952476090116,
    UUP: 0.00007331125743504347,
    EFA: 0.048796587269399255,
    EEM: 0.02044579598077068,
  },
}

test.each(['stagflation', 'goldilocks'] as const)('matches frozen Wave 5D target weights in %s', (regime) =>
  fixture(async (dir) => {
    const broker = mock({ regime })
    const receipt = verify(await broker.run(join(dir, 'reference.json')))
    const stag = regime === 'stagflation'
    expect(receipt.signals.reviewDue).toBe(true)
    expect(receipt.signals.macro.quadrant).toBe(stag ? 'Stagflation' : 'Goldilocks')
    expect(receipt.signals.canaries.map((c) => [c.symbol, c.protective])).toEqual(
      (['EEM', 'HYG', 'IEF', 'TLT'] as const).map((symbol) => [symbol, stag]),
    )
    expect(receipt.signals.macro.unsmoothedWeights.filter(({ value }) => value > 0)).toEqual(
      stag
        ? [
            { symbol: 'SHY', value: 0.2 },
            { symbol: 'GLD', value: 0.2 },
            { symbol: 'DBC', value: 0.2 },
            { symbol: 'UUP', value: 0.4 },
          ]
        : [
            { symbol: 'SPY', value: 0.25 },
            { symbol: 'QQQ', value: 0.25 },
            { symbol: 'XLK', value: 0.25 },
            { symbol: 'IEF', value: 0.25 },
          ],
    )
    expect(receipt.signals.tsmomScores.map(({ symbol }) => symbol)).toEqual([...etfs])
    for (const { symbol, weight } of receipt.signals.targetWeights)
      expect(weight).toBeCloseTo(reference[regime][symbol] ?? 0, 13)
    expect(receipt.signals.targetWeights.reduce((total, { weight }) => total + weight, 0)).toBeCloseTo(1, 13)
    expect(broker.posts).toEqual([])
  }),
)

test('matches the Wave 5D blend when offensive and defensive canary baskets overlap', () =>
  fixture(async (dir) => {
    const broker = mock({ regime: 'mixed' })
    const receipt = verify(await broker.run(join(dir, 'mixed.json')))
    expect(receipt.signals.canaryProtection).toBe(0.5)
    const canary = receipt.signals.sleeves.find(({ name }) => name === 'canary')
    expect(canary?.weights.find(({ symbol }) => symbol === 'GLD')?.value).toBeGreaterThan(0.25)
    expect(canary?.weights.find(({ symbol }) => symbol === 'DBC')?.value).toBeGreaterThan(0.25)
    for (const { symbol, weight } of receipt.signals.targetWeights)
      expect(weight).toBeCloseTo(reference.mixed[symbol] ?? 0, 13)
  }))

test('writes a deterministic private shadow receipt with independent bar and plan hash verification', () =>
  fixture(async (dir) => {
    const broker = mock({ earlyClose: true })
    const path = join(dir, 'receipt.json')
    const otherPath = join(dir, 'same-receipt.json')
    const receipt = verify(await broker.run(path))
    verify(await broker.run(otherPath))
    const text = await readFile(path, 'utf8')
    expect(await readFile(otherPath, 'utf8')).toBe(text)
    expect(JSON.parse(text)).toEqual(receipt)
    expect(Schema.is(receiptIdentity)(receipt)).toBe(true)
    const scored = Result.getOrThrow(buildScorecard({ intraday: [], macroCore: [], macroCanary: [JSON.parse(text)] }))
    expect(scored.sessions[0]?.macroCanary?.planSha256).toBe(receipt.planSha256)
    const { mode, timestamp: observedAt, planSha256, ...plan } = receipt
    expect(mode).toBe(Mode.Shadow)
    expect(observedAt).toBe(broker.now)
    expect<string>(receipt.signalSession).toBe(broker.previousDate)
    expect(receipt.signalCloseAt).toBe(timestamp(broker.previousDate, '13:00'))
    expect<string>(receipt.executionSession).toBe(broker.nextDate)
    expect(receipt.barSha256).toBe(sha256(broker.adjustedMaterial))
    expect(planSha256).toBe(sha256(plan))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(text).not.toContain(testSecret)
    expect(text).not.toContain(testKey)
    expect(broker.posts).toEqual([])
    rejected(await broker.run(path), 'EEXIST')
    expect(await readFile(path, 'utf8')).toBe(text)
  }))

test('sizes the idle SHY carry in integer shares using separate raw SIP close and collar', () =>
  fixture(async (dir) => {
    const base = mock({ regime: 'flat', rawPrice: 200 })
    const split = mock({ regime: 'flat', rawPrice: 100 })
    const a = verify(await base.run(join(dir, 'a.json')))
    const b = verify(await split.run(join(dir, 'b.json'), ['--tif', 'day']))
    expect(a.signals).toEqual(b.signals)
    expect(a.signals.idleShyWeight).toBeCloseTo(2 / 3, 13)
    expect(a.signals.targetWeights.find(({ symbol }) => symbol === 'SHY')?.weight).toBeCloseTo(0.75, 13)
    expect(a.barSha256).toBe(b.barSha256)
    expect(a.planSha256).not.toBe(b.planSha256)
    expect(a.plan.orders).toHaveLength(1)
    expect(b.plan.orders).toHaveLength(1)
    const [shyA] = a.plan.orders
    const [shyB] = b.plan.orders
    expect(shyA.request).toMatchObject({
      symbol: 'SHY',
      side: 'buy',
      qty: '499',
      limit_price: '200.30',
      time_in_force: 'opg',
      extended_hours: false,
    })
    expect(shyB.request).toMatchObject({
      symbol: 'SHY',
      side: 'buy',
      qty: '998',
      limit_price: '100.15',
      time_in_force: 'day',
    })
    expect(shyA.limitNotionalCents).toBe(20_030 * 499)
    expect(shyA.referenceNotionalMicros).toBe(200_000_000 * 499)
    expect(a.plan.expectedTurnover).toBe(shyA.referenceNotionalMicros / (2 * 100_000 * 1_000_000))
  }))

test('suppresses orders inside the absolute ten-point band and on non-review sessions', () =>
  fixture(async (dir) => {
    const start = mock()
    const first = verify(await start.run(join(dir, 'first.json')))
    const positions = first.signals.targetWeights
      .map(({ symbol, weight }) => ({ symbol, qty: Math.floor(weight * 500) }))
      .flatMap(({ symbol, qty }) => (qty === 0 ? [] : [position(symbol, qty)]))
    const within = mock({ positions, cash: '3000' })
    const aligned = verify(await within.run(join(dir, 'within.json')))
    expect(aligned.plan.sizing.some(({ outsideBand }) => outsideBand)).toBe(false)
    expect(aligned.plan.orders).toEqual([])
    expect(aligned.plan.expectedTurnover).toBe(0)
    const offDate = mock({ prior: reviewIndex + 1 })
    const next = verify(await offDate.run(join(dir, 'next.json'), paper))
    expect(next.signals.reviewDue).toBe(false)
    expect(next.signals.reviewedAt).toBe(first.signalSession)
    expect(next.signals.targetWeights).toEqual(first.signals.targetWeights)
    expect(next.plan.orders).toEqual([])
    expect(offDate.posts).toEqual([])
  }))

test('coexists without selling excluded inventory, caps sleeve/account gross and never spends pending sells', () =>
  fixture(async (dir) => {
    const positions = [position('QQQ', 410), position('SMH', 60), position('DIA', 50)]
    const broker = mock({ regime: 'goldilocks', positions, equity: '400000', cash: '900000' })
    const receipt = verify(
      await broker.run(join(dir, 'shared.json'), ['--exclude-symbols', 'QQQ,SMH', '--capital-budget-usd', '50000']),
    )
    expect(receipt.plan.excludedSymbols).toEqual(['QQQ', 'SMH'])
    expect(receipt.plan.excludedTargetWeight).toBeGreaterThan(0)
    expect(receipt.plan.otherGrossCents).toBe(9_400_000)
    expect(receipt.plan.budgetCents).toBe(5_000_000)
    expect(receipt.plan.orders[0]?.request).toMatchObject({
      symbol: 'DIA',
      side: 'sell',
      qty: '50',
      limit_price: '199.70',
    })
    expect(receipt.plan.orders.every(({ request }) => !['QQQ', 'SMH'].includes(request.symbol))).toBe(true)
    expect(receipt.plan.buyLimitNotionalCents).toBeLessThanOrEqual(4_000_000)
    expect(receipt.plan.maximumProjectedGrossCents).toBeLessThanOrEqual(15_000_000)
    expect(receipt.plan.remainingIntradayGrossCents).toBeGreaterThanOrEqual(3_000_000)

    const budgetOnly = mock({ regime: 'goldilocks', positions, equity: '400000', cash: '0' })
    const capped = verify(await budgetOnly.run(join(dir, 'budget.json'), ['--capital-budget-usd', '50000']))
    expect(capped.plan.excludedSymbols).toEqual(['QQQ', 'SMH'])
    expect(capped.plan.orders.map(({ request }) => request.side)).toEqual([Side.Sell])

    const capLimited = mock({
      positions: [position('SMH', 743)],
      equity: '500000',
      cash: '400000',
      buyingPower: '300',
    })
    const limited = verify(await capLimited.run(join(dir, 'cap.json'), ['--exclude-symbols', 'SMH']))
    expect(limited.plan.budgetCents).toBe(140_000)
    expect(limited.plan.buyLimitNotionalCents).toBeLessThanOrEqual(30_000)
    expect(limited.plan.maximumProjectedGrossCents).toBeLessThanOrEqual(15_000_000)
  }))

test('fails closed on gaps, stale/future/duplicate bars, invalid payloads and broken pagination', () =>
  fixture(async (dir) => {
    const cases: readonly [MockOptions, string][] = [
      [{ barFault: 'missing' }, 'Missing all SIP bar for DIA'],
      [{ barFault: 'future' }, 'unexpected all SIP bar for DIA'],
      [{ barFault: 'duplicate' }, 'duplicate or unexpected all SIP bar for DIA'],
      [{ barFault: 'raw-stale' }, 'unexpected raw SIP bar for UUP'],
      [{ seedMissing: true }, 'Missing all SIP bar for GLD'],
      [{ barFault: 'token-cycle' }, 'did not terminate'],
      [{ barFault: 'bad-close' }, 'Unexpected Alpaca response shape'],
      [{ clockTimestamp: '2022-01-01T15:00:00Z' }, 'Stale market clock'],
      [{ nextOpen: timestamp(dates[reviewIndex + 2], '09:30') }, 'does not corroborate the upcoming open'],
      [{ now: timestamp(dates[reviewIndex], '17:30') }, 'Outside the finalized-bar'],
      [{ now: timestamp(dates[reviewIndex + 1], '09:29') }, 'Outside the finalized-bar'],
    ]
    for (const [options, reason] of cases) {
      const broker = mock(options)
      rejected(await broker.run(join(dir, 'no-plan.json'), paper), reason)
      expect(broker.posts).toEqual([])
    }
    expect(await readdir(dir)).toEqual([])
  }))

test('does not round available fractional shares up when sizing an exit', () =>
  fixture(async (dir) => {
    const broker = mock({
      positions: [{ ...position('DIA', 100), qty_available: '1.999999999999999999' }],
      cash: '80000',
    })
    const receipt = verify(await broker.run(join(dir, 'fractional.json')))
    expect(receipt.plan.orders[0]?.request).toMatchObject({ symbol: 'DIA', side: 'sell', qty: '1' })
  }))

test('rejects live or lookalike destinations before network access, and mismatched paper identities', () =>
  fixture(async (dir) => {
    for (const origin of [
      'https://api.alpaca.markets',
      'https://paper-api.alpaca.markets.evil.test',
      'http://paper-api.alpaca.markets',
      'https://paper-api.alpaca.markets@api.alpaca.markets',
      'https://paper-api.alpaca.markets/v2',
    ]) {
      const broker = mock({ origin })
      rejected(await broker.run(join(dir, 'no-plan.json'), paper), '(live is forbidden)')
      expect(broker.calls).toEqual([])
    }
    const broker = mock()
    rejected(
      await broker.run(join(dir, 'no-plan.json'), [...paper.slice(0, 3), otherId]),
      'Paper account ID does not match',
    )
    expect(broker.posts).toEqual([])
    expect(await readdir(dir)).toEqual([])
  }))

test('paper submits only the durable verified plan and journals broker acknowledgements', () =>
  fixture(async (dir) => {
    const broker = mock({ positions: [position('DIA', 100)], cash: '80000' })
    const receipt = verify(await broker.run(join(dir, 'paper.json'), paper))
    expect(broker.posts).toEqual(receipt.plan.orders.map(({ request }) => request))
    expect(broker.posts.length).toBeGreaterThan(1)
    expect(broker.posts[0]).toMatchObject({ symbol: 'DIA', side: 'sell' })
    const journal = (await readdir(dir)).find((name) => name.endsWith('-submissions.jsonl'))
    if (journal === undefined) throw new Error('Missing the account/session journal')
    const entries = (await readFile(join(dir, journal), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(entries).toHaveLength(broker.posts.length * 2)
    for (let i = 0; i < broker.posts.length; i++) {
      expect(entries[2 * i]).toMatchObject({
        outcome: 'dispatching',
        planSha256: receipt.planSha256,
        clientOrderId: broker.posts[i].client_order_id,
      })
      expect(entries[2 * i + 1]).toMatchObject({
        outcome: 'acknowledged',
        ack: { id: otherId, client_order_id: broker.posts[i].client_order_id },
      })
    }
    rejected(await broker.run(join(dir, 'repeat.json'), paper), 'EEXIST')
    expect(broker.posts).toHaveLength(receipt.plan.orders.length)

    const rerun = mock({ terminalOrders: [{ id: otherId, ...broker.posts[0], status: 'canceled' }] })
    rejected(await rerun.run(join(dir, 'replay.json'), paper), 'already has a runner order')
    expect(rerun.posts).toEqual([])
  }))

test('paper fails closed on open orders, account changes and a missed open before dispatch', () =>
  fixture(async (dir) => {
    const cases: readonly [MockOptions, string][] = [
      [
        { orders: [{ id: otherId, symbol: 'QQQ', client_order_id: 'noise-area', status: 'new' }] },
        'Outstanding account orders',
      ],
      [{ secondAccountCash: '99999.01' }, 'Broker state changed'],
      [{ secondAccountId: otherId }, 'Paper account ID does not match'],
      [{ advanceBeforePreflight: timestamp(dates[reviewIndex + 2], '09:30') }, 'No longer in the verified next-open'],
      [
        {
          orders: Array.from({ length: 500 }, () => ({
            id: otherId,
            symbol: 'QQQ',
            client_order_id: 'noise-area',
            status: 'new',
          })),
        },
        'reached the read limit',
      ],
    ]
    for (const [i, [options, reason]] of cases.entries()) {
      const broker = mock(options)
      rejected(await broker.run(join(dir, `rejected-${i}.json`), paper), reason)
      expect(broker.posts).toEqual([])
    }
  }))

test.each(['transport', 'bad-ack', 'redirect'] as const)(
  'never retries an uncertain paper dispatch (%s)',
  (postFault) =>
    fixture(async (dir) => {
      const broker = mock({ postFault })
      rejected(await broker.run(join(dir, 'paper.json'), paper), 'No verified acknowledgement')
      expect(broker.posts).toHaveLength(1)
      const journal = (await readdir(dir)).find((name) => name.endsWith('-submissions.jsonl'))
      if (journal === undefined) throw new Error('Missing the dispatch journal')
      const lines = (await readFile(join(dir, journal), 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({ outcome: 'dispatching' })
    }),
)

test('aborts a timed-out Alpaca read once without a receipt or any mutations', () =>
  fixture(async (dir) => {
    const broker = mock({ hold: 'calendar' })
    rejected(await broker.run(join(dir, 'timeout.json'), paper, 'deadline'), 'exceeded its 12-second deadline')
    expect(broker.aborted()).toBe(1)
    expect(broker.calls).toHaveLength(1)
    expect(broker.posts).toEqual([])
    expect(await readdir(dir)).toEqual([])
  }))

test('interruption cancels one in-flight paper request and preserves its durable dispatch record', () =>
  fixture(async (dir) => {
    const broker = mock({ hold: 'submit' })
    const exit = await broker.run(join(dir, 'interrupted.json'), paper, 'interrupt')
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(broker.aborted()).toBe(1)
    expect(broker.posts).toHaveLength(1)
    const journal = (await readdir(dir)).find((name) => name.endsWith('-submissions.jsonl'))
    if (journal === undefined) throw new Error('Missing the in-flight dispatch journal')
    const lines = (await readFile(join(dir, journal), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({ outcome: 'dispatching' })
  }))
