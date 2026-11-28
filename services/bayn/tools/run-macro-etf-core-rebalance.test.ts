import { expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeFileSystem } from '@effect/platform-node'
import { Cause, ConfigProvider, Effect, Exit, Fiber, Layer, Result, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { TestClock } from 'effect/testing'

import { canonicalHashV1Result, sha256 } from '../src/hash'
import { fixture } from '../src/strategy/macro-etf-core/fixtures.test-support'
import { asset, parameters, universe } from '../src/strategy/macro-etf-core/policy'
import { BarAdjustment, Side, type Bar, type OrderRequest, type Position } from './macro-canary-runner/alpaca'
import { Mode, TimeInForce } from './macro-canary-runner/contract'
import { coexistenceWeights } from './macro-etf-core-runner/allocation'
import { parseOptions, RunnerProfile } from './macro-etf-core-runner/contract'
import { buildScorecard } from './multi-horizon-scorecard-core'
import { SleeveMode, Strategy } from './multi-account-daily-sleeves/contract'
import { runRebalance } from './run-macro-etf-core-rebalance'
import { runDailySleeves } from './run-multi-account-daily-sleeves'

const accountId = '11111111-1234-4234-8123-000000000001'
const orderId = '11111111-1234-4234-8123-000000000002'
const testKey = 'test-key-not-a-credential'
const testSecret = 'test-secret-not-a-credential'
const terminalOrder = { id: orderId, symbol: 'QQQ', client_order_id: 'other-sleeve', status: 'canceled' }
const paper = ['--mode', Mode.PaperSubmit, '--confirm-paper-account', accountId]
const rawPrice = 200.03
const columns = fixture(268)
const dates = [...columns.calendar.map(({ date }) => date), '2017-01-13']
const eastern = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' })
const sessionMidnights = new Map<string, string>()
const timestamp = (date: string, time: string) => {
  const cached = time === '00:00' ? sessionMidnights.get(date) : undefined
  if (cached !== undefined) return cached
  const zone = eastern.formatToParts(new Date(`${date}T12:00:00Z`)).find(({ type }) => type === 'timeZoneName')
  const iso = new Date(`${date}T${time}:00${zone?.value.slice(3)}`).toISOString()
  if (time === '00:00') sessionMidnights.set(date, iso)
  return iso
}

const bookPosition = (symbol: string, qty: number, price = rawPrice): Position => ({
  symbol,
  side: qty > 0 ? 'long' : 'short',
  qty: String(qty),
  qty_available: String(qty),
  market_value: (price * qty).toFixed(2),
})

type Mock = {
  accountId?: string
  key?: string
  secret?: string
  count?: number
  scopedAccountId?: string
  time?: string
  clockTimestamp?: string
  differentNextOpen?: boolean
  open?: boolean
  origin?: string
  maskOptional?: boolean
  adjustFault?:
    | 'missing'
    | 'gap'
    | 'future'
    | 'duplicate'
    | 'order'
    | 'premature'
    | 'prices'
    | 'token'
    | 'empty'
    | 'bad-adjustment'
    | 'feed'
  rawFault?: 'missing' | 'stale' | 'bad-price'
  cash?: string
  buyingPower?: string
  positions?: readonly Position[]
  newPositions?: readonly Position[]
  newCash?: string
  openOrders?: readonly object[]
  history?: readonly object[]
  blocked?: boolean
  hold?: 'calendar' | 'submit'
  advanceOnDispatch?: boolean
  postFault?: 'transport' | 'bad-ack' | 'redirect'
  beforePost?: (index: number, request: OrderRequest) => Promise<void>
}

const mock = (options: Mock = {}) => {
  const count = options.count ?? 268
  const signalDate = dates[count - 1]
  const executionDate = dates[count]
  const now = options.time ?? timestamp(executionDate, '08:00')
  const nextOpen = timestamp(executionDate, '09:30')
  const lastMidnight = timestamp(signalDate, '00:00')
  const end = timestamp(signalDate, '16:00')
  const calls: { url: URL; method: string }[] = []
  const posts: OrderRequest[] = []
  const pending = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  let accountReads = 0
  let positionReads = 0
  let clockReads = 0
  let aborts = 0
  const hold = (signal?: AbortSignal | null) =>
    new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => {
          aborts++
          reject(new Error('canceled mock request'))
        },
        { once: true },
      )
      pending.resolve()
    })
  const adjusted = () => {
    const series = new Map(universe.map((symbol) => [symbol, Array<Bar>()]))
    for (const [i, bars] of columns.bars.slice(0, count).entries()) {
      for (const row of bars) {
        if (options.maskOptional === true && i === count - 1 && (row.symbol === 'XLC' || row.symbol === 'XLRE'))
          continue
        series.get(row.symbol)?.push({
          t: timestamp(row.date, '00:00'),
          o: row.open,
          h: row.high,
          l: row.low,
          c: row.close,
          v: 5000,
        })
      }
    }
    return Object.fromEntries([...series].sort(([a], [b]) => a.localeCompare(b)))
  }
  const raw = () =>
    Object.fromEntries(
      universe.flatMap((symbol) => {
        if (options.rawFault === 'missing' && symbol === 'SHY') return []
        if (options.maskOptional === true && (symbol === 'XLC' || symbol === 'XLRE')) return []
        // XLC before inception legitimately has no raw close.
        if (symbol === 'XLC' && count <= 117) return []
        const t = options.rawFault === 'stale' && symbol === 'HYG' ? timestamp(dates[count - 2], '00:00') : lastMidnight
        return [
          [
            symbol,
            [
              {
                t,
                o: rawPrice,
                h: rawPrice + 1,
                l: rawPrice - 1,
                c: options.rawFault === 'bad-price' && symbol === 'SHY' ? 0.01 : rawPrice,
                v: 100,
              },
            ],
          ],
        ]
      }),
    )
  const submit = Schema.Struct({
    client_order_id: Schema.String,
    symbol: Schema.String,
    side: Schema.Enum(Side),
    qty: Schema.String,
    time_in_force: Schema.Enum(TimeInForce),
    type: Schema.Literal('limit'),
    limit_price: Schema.String,
    extended_hours: Schema.Literal(false),
  })
  const fetchMock: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      const headers = new Headers(init?.headers)
      expect(headers.get('apca-api-key-id')).toBe(options.key ?? testKey)
      expect(headers.get('apca-api-secret-key')).toBe(options.secret ?? testSecret)
      expect(init?.redirect).toBe('error')
      if (url.pathname === '/v2/stocks/bars') {
        expect(url.origin).toBe('https://data.alpaca.markets')
        expect(method).toBe('GET')
        const { searchParams: params } = url
        expect(params.get('symbols')).toBe(universe.join(','))
        expect(params.get('feed')).toBe('sip')
        expect(params.get('timeframe')).toBe('1Day')
        expect(params.get('end')).toBe(end)
        const adjustment = params.get('adjustment')
        if (adjustment === BarAdjustment.Raw) {
          expect(params.get('start')).toBe(lastMidnight)
          return Response.json({ bars: raw(), next_page_token: null })
        }
        expect(adjustment).toBe(BarAdjustment.All)
        expect(params.get('start')).toBe(timestamp(parameters.epoch, '00:00'))
        const all = adjusted()
        // Split HYG across pages as well as splitting the universe.
        const entries = Object.entries(all)
        const splitIndex = entries.findIndex(([symbol]) => symbol === 'HYG')
        const split = Math.floor(count / 2)
        const page = params.get('page_token')
        if (page === null) {
          const bars = Object.fromEntries([...entries.slice(0, splitIndex), ['HYG', all['HYG'].slice(0, split)]])
          if (options.adjustFault === 'missing') delete bars['GLD']
          if (options.adjustFault === 'gap') bars['HYG'].splice(10, 1)
          if (options.adjustFault === 'future')
            bars['HYG'].push({
              ...bars['HYG'][0],
              t: timestamp(executionDate, '00:00'),
            })
          if (options.adjustFault === 'order') bars['HYG'].reverse()
          if (options.adjustFault === 'premature')
            bars['HYG'][0] = { ...bars['HYG'][0], t: timestamp(parameters.epoch, '00:01') }
          if (options.adjustFault === 'prices') bars['HYG'][0] = { ...bars['HYG'][0], c: 0 }
          return Response.json({
            bars,
            next_page_token: 'second',
            ...(options.adjustFault === 'bad-adjustment' ? { adjustment: 'raw' } : {}),
            ...(options.adjustFault === 'feed' ? { feed: 'iex' } : {}),
          })
        }
        expect(page).toBe('second')
        const start = options.adjustFault === 'duplicate' ? split - 1 : split
        return Response.json({
          bars:
            options.adjustFault === 'empty'
              ? {}
              : Object.fromEntries([['HYG', all['HYG'].slice(start)], ...entries.slice(splitIndex + 1)]),
          next_page_token: options.adjustFault === 'token' ? 'second' : null,
        })
      }
      expect(url.origin).toBe('https://paper-api.alpaca.markets')
      switch (url.pathname) {
        case '/v2/calendar':
          expect(url.searchParams.get('start')).toBe(parameters.epoch)
          if (options.hold === 'calendar') return hold(init?.signal)
          return Response.json(dates.slice(0, count + 2).map((date) => ({ date, open: '09:30', close: '16:00' })))
        case '/v2/clock':
          return Response.json({
            timestamp: options.clockTimestamp ?? now,
            is_open: options.open ?? false,
            next_open:
              ++clockReads > 1 && options.differentNextOpen === true ? timestamp(dates[count + 1], '09:30') : nextOpen,
          })
        case '/v2/account':
          return Response.json({
            id: options.accountId ?? accountId,
            status: 'ACTIVE',
            currency: 'USD',
            equity: '200000',
            cash: ++accountReads > 1 ? (options.newCash ?? options.cash ?? '200000') : (options.cash ?? '200000'),
            buying_power: options.buyingPower ?? '200000',
            account_blocked: options.blocked ?? false,
            trading_blocked: false,
            trade_suspended_by_user: false,
          })
        case '/v2/positions':
          return Response.json(
            ++positionReads > 1 ? (options.newPositions ?? options.positions ?? []) : (options.positions ?? []),
          )
        case '/v2/orders': {
          if (method === 'GET')
            return Response.json(url.searchParams.has('after') ? (options.history ?? []) : (options.openOrders ?? []))
          const order = Schema.decodeUnknownSync(submit)(await new Response(init?.body).json())
          posts.push(order)
          if (options.advanceOnDispatch === true && posts.length === 1) {
            pending.resolve()
            await proceed.promise
          }
          await options.beforePost?.(posts.length, order)
          if (options.hold === 'submit') return hold(init?.signal)
          if (options.postFault === 'transport') throw new Error(testSecret)
          if (options.postFault === 'redirect')
            return new Response(null, {
              status: 307,
              headers: { Location: 'https://api.alpaca.markets/v2/orders' },
            })
          return Response.json({
            ...order,
            id: orderId,
            status: 'accepted',
            qty: options.postFault === 'bad-ack' ? '0' : order.qty,
          })
        }
        default:
          throw new Error(`Unexpected mock request: ${url.pathname}`)
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
        ...(options.scopedAccountId === undefined
          ? { BAYN_ALPACA_KEY_ID: testKey, BAYN_ALPACA_SECRET_KEY: testSecret }
          : {
              BAYN_MACRO_CORE_ALPACA_ACCOUNT_ID: options.scopedAccountId,
              BAYN_MACRO_CORE_ALPACA_KEY_ID: testKey,
              BAYN_MACRO_CORE_ALPACA_SECRET_KEY: testSecret,
            }),
        ...(options.origin === undefined ? {} : { BAYN_ALPACA_BASE_URL: options.origin }),
      }),
    ),
  )
  const run = (output: string, flags: readonly string[] = [], advance?: 'interrupt' | 'timeout' | 'cutoff') =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now))
      const program = runRebalance(['--output', output, ...flags])
      if (advance === undefined) return yield* program
      const fiber = yield* Effect.forkChild(program)
      yield* Effect.promise(() => pending.promise)
      if (advance === 'interrupt') yield* Fiber.interrupt(fiber)
      else if (advance === 'cutoff') {
        yield* TestClock.adjust('6 seconds')
        proceed.resolve()
      } else yield* TestClock.adjust('12 seconds')
      return yield* Fiber.join(fiber)
    }).pipe(
      Effect.scoped,
      Effect.provideService(FetchHttpClient.Fetch, fetchMock),
      // @effect-diagnostics-next-line strictEffectProvide:off -- the mock CLI owns its time, files and transport
      Effect.provide(layer),
      Effect.runPromiseExit,
    )
  return { run, posts, calls, abortCount: () => aborts, signalDate, executionDate, fetchMock, now }
}

const inDirectory = async (f: (directory: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'bayn-macro-etf-core-'))
  try {
    await f(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const success = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(Cause.pretty(exit.cause))
}
const failure = <A, E>(exit: Exit.Exit<A, E>, message: string) => {
  if (Exit.isSuccess(exit)) throw new Error('Expected a failed run')
  const error = Cause.pretty(exit.cause)
  expect(error).toContain(message)
  expect(error).not.toContain(testKey)
  expect(error).not.toContain(testSecret)
}
const records = async (dir: string) => {
  const journal = (await readdir(dir)).find((name) => name.endsWith('submissions.jsonl'))
  if (journal === undefined) throw new Error('No durable journal')
  const path = join(dir, journal)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown)
}
const targets = (receipt: Effect.Success<ReturnType<typeof runRebalance>>) => {
  if (receipt.allocation.targets === null) throw new Error('Missing review allocation')
  return receipt.allocation.targets
}

test('closed CLI inputs and default QQQ/SMH coexistence', () => {
  expect(Result.getOrThrow(parseOptions(['--output', 'new.json']))).toMatchObject({
    mode: Mode.Shadow,
    tif: TimeInForce.Open,
    profile: RunnerProfile.F4,
    capitalBudgetCents: 15_000_000,
    excludeSymbols: ['QQQ', 'SMH'],
  })
  expect(
    Result.getOrThrow(parseOptions(['--output', 'new.json', '--exclude-symbols', 'gld, XLF,gld'])).excludeSymbols,
  ).toEqual(['GLD', 'QQQ', 'SMH', 'XLF'])
  const rejected = [
    ['--profile', 'f4'],
    ['--profile', 'O1'],
    ['--exclude-symbols', 'QQQ,'],
    ['--mode', 'paper-submit', '--confirm-paper-account', accountId, '--exclude-symbols', ''],
    ['--mode', 'live'],
    ['--mode', 'paper-submit'],
    ['--confirm-paper-account', accountId],
    ['--tif', 'gtc'],
    ['--capital-budget-usd', '0.00'],
    ['--capital-budget-usd', '150000.01'],
    ['--capital-budget-usd', '10.001'],
    ['--capital-budget-usd', '1e3'],
    ['--output', 'already-present'],
  ]
  for (const flags of rejected) expect(Result.isFailure(parseOptions(['--output', 'r.json', ...flags]))).toBe(true)
  expect(Result.isFailure(parseOptions([]))).toBe(true)
})

test('allows the full F4 allocation only on a verified isolated shadow account', () =>
  inDirectory(async (dir) => {
    const flags = ['--mode', 'shadow', '--exclude-symbols', '', '--capital-budget-usd', '10000']
    const broker = mock({ scopedAccountId: accountId })
    const receipt = success(await broker.run(join(dir, 'isolated.json'), flags))
    expect(receipt.configuredExclusions).toEqual([])
    const signal = receipt.allocation.components[0]?.signal
    if (signal == null) throw new Error('Expected an F4 review signal')
    const qqq = targets(receipt).find(({ symbol }) => symbol === 'QQQ')?.weight
    expect(qqq).toBeGreaterThan(0)
    expect(qqq).toBe(signal.weights[universe.indexOf('QQQ')])
    expect(broker.posts).toEqual([])

    const unscoped = mock()
    failure(await unscoped.run(join(dir, 'unscoped.json'), flags), 'require a verified isolated shadow account')
    expect(unscoped.calls).toEqual([])

    const mismatched = mock({ scopedAccountId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' })
    failure(
      await mismatched.run(join(dir, 'mismatch.json'), flags),
      'Paper account ID does not match the expected account',
    )
    expect(mismatched.calls.map(({ url, method }) => [url.pathname, method])).toEqual([['/v2/account', 'GET']])
    expect(await readdir(dir)).toEqual(['isolated.json'])
  }))

// Frozen unmodified Wave 5C signalModel digests also used by Wave 8A's golden-replay test.
// Exercise the actual SIP-to-evidence adapter and a 50/50 blend over the same five review closes.
test('F2, F4 and their 50/50 blend preserve Wave 5C golden allocations before coexistence', () =>
  inDirectory(async (dir) => {
    const f2: [string, string, string[]][] = []
    const f4: typeof f2 = []
    for (const count of [100, 142, 184, 226, 268]) {
      const broker = mock({ count })
      const receipt = success(await broker.run(join(dir, `equal-${count}.json`), ['--profile', RunnerProfile.Equal]))
      const [a, b] = receipt.allocation.components.map(({ signal }) => signal)
      if (a == null || b == null) throw new Error('Expected both profile observations')
      for (const [sequence, signal] of [
        [f2, a],
        [f4, b],
      ] as const)
        sequence.push([signal.signalDate, signal.executionDate, signal.weights.map((weight) => weight.toFixed(12))])

      const raw = a.weights.map((weight, i) => (weight + b.weights[i]) / 2)
      const offensive = parameters.offense[0].members
      const balance = raw[asset.QQQ] + raw[asset.SMH]
      expect(balance).toBeGreaterThan(0)
      const remaining = offensive.reduce(
        (sum, symbol) => (symbol === 'QQQ' || symbol === 'SMH' ? sum : sum + raw[asset[symbol]]),
        0,
      )
      for (const { symbol, weight } of targets(receipt)) {
        if (symbol === 'QQQ' || symbol === 'SMH') expect(weight).toBe(0)
        else if (symbol === 'SHY') expect(weight).toBeCloseTo(raw[asset.SHY] + (1 - raw.reduce((a, b) => a + b, 0)), 12)
        else
          expect(weight).toBeCloseTo(
            raw[asset[symbol]] * (offensive.some((s) => s === symbol) ? 1 + balance / remaining : 1),
            12,
          )
      }
      expect(broker.posts).toEqual([])
    }
    expect(sha256(JSON.stringify(f2))).toBe('18a14eec78b64707443f8e6414404326c661479af2607f4861af12c80679f33b')
    expect(sha256(JSON.stringify(f4))).toBe('8a6547247e28df4c80892e03dae1588f850dd29765efbb91173a6b62304a490e')
    for (const [profile, i] of [
      [RunnerProfile.F2, 0],
      [RunnerProfile.F4, 1],
    ] as const) {
      const broker = mock()
      const single = success(await broker.run(join(dir, profile), ['--profile', profile]))
      const equal = success(await broker.run(join(dir, `again-${profile}`), ['--profile', RunnerProfile.Equal]))
      expect(single.allocation.components).toEqual([equal.allocation.components[i]])
    }
  }))

test('missing XLC and XLRE mask residual smoothing and reserve their held positions', () =>
  inDirectory(async (dir) => {
    const full = success(await mock().run(join(dir, 'full.json'), ['--profile', RunnerProfile.Equal]))
    const broker = mock({ maskOptional: true, positions: [bookPosition('XLC', 25), bookPosition('XLRE', 25)] })
    const receipt = success(await broker.run(join(dir, 'masked.json'), ['--profile', RunnerProfile.Equal]))
    expect(receipt.signalBars.missingCandidates).toEqual(['XLC', 'XLRE'])
    for (const symbol of ['XLC', 'XLRE'] as const) {
      expect(targets(full)[asset[symbol]].weight).toBeGreaterThan(0)
      expect(receipt.allocation.components.every(({ signal }) => signal?.weights[asset[symbol]] === 0)).toBe(true)
      expect(targets(receipt)[asset[symbol]].weight).toBe(0)
      expect(receipt.plan.orders.some(({ request }) => request.symbol === symbol)).toBe(false)
    }
    expect(receipt.plan.reservedGrossCents).toBe(1_000_150)
    expect(receipt.barSha256).not.toBe(full.barSha256)
  }))

test('an exhausted offense group leaves its weight in SHY, or in cash when SHY is excluded', () => {
  const weights = universe.map((symbol) => (symbol === 'QQQ' ? 0.8 : symbol === 'HYG' ? 0.2 : 0))
  const excluded = new Set<string>(parameters.offense[0].members)
  const eligible = new Set(universe)
  expect(coexistenceWeights(weights, excluded, eligible)[asset.SHY]).toBeCloseTo(0.8, 12)
  excluded.add('SHY')
  const result = coexistenceWeights(weights, excluded, eligible)
  expect(result[asset.SHY]).toBe(0)
  expect(result.reduce((a, b) => a + b, 0)).toBe(0.2)
})

test('shadow is GET-only, reserves both foreign longs and shorts, and produces stable private receipts', () =>
  inDirectory(async (dir) => {
    const positions = [bookPosition('QQQ', 300, 350), bookPosition('SMH', -150, 150), bookPosition('OTHER', 50, 100)]
    const broker = mock({ positions, cash: '90000' })
    const output = join(dir, 'shadow.json')
    const a = success(await broker.run(output))
    const b = success(
      await mock({
        positions: positions.toReversed(),
        cash: '90000',
        time: timestamp(broker.executionDate, '08:10'),
      }).run(join(dir, 'shadow-2.json'), ['--exclude-symbols', 'SMH,QQQ']),
    )
    expect(a.mode).toBe(Mode.Shadow)
    expect(a.schemaVersion).toBe('bayn.macro-etf-core-rebalance-receipt.v1')
    expect(a.barSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(a.planSha256).toBe(b.planSha256)
    expect(a.timestamp).not.toBe(b.timestamp)
    const { mode, timestamp: observedAt, planSha256, ...material } = a
    expect({ mode, observedAt }).toEqual({ mode: Mode.Shadow, observedAt: timestamp(broker.executionDate, '08:00') })
    expect(planSha256).toBe(Result.getOrThrow(canonicalHashV1Result(material)))
    expect(a.plan.reservedGrossCents).toBe(14_000_450)
    expect(a.plan.maximumProjectedGrossCents).toBeLessThanOrEqual(15_000_000)
    expect(a.plan.remainingIntradayGrossCents).toBeGreaterThanOrEqual(3_000_000)
    expect(a.plan.orders.length).toBeGreaterThan(0)
    expect(a.plan.orders.every(({ request }) => !['QQQ', 'SMH', 'OTHER'].includes(request.symbol))).toBe(true)
    expect(broker.calls.every(({ method }) => method === 'GET')).toBe(true)
    expect(broker.calls.filter(({ url }) => url.pathname === '/v2/stocks/bars')).toHaveLength(3)
    expect((await stat(output)).mode & 0o777).toBe(0o600)
    const receiptBytes = await readFile(output, 'utf8')
    expect(JSON.parse(receiptBytes)).toEqual(a)
    const scored = Result.getOrThrow(
      buildScorecard({ intraday: [], macroCore: [JSON.parse(receiptBytes)], macroCanary: [] }),
    )
    expect(scored.sessions[0]?.macroCore?.planSha256).toBe(a.planSha256)
    expect(receiptBytes).not.toContain(testKey)
    expect(receiptBytes).not.toContain(testSecret)
    failure(await broker.run(output), 'EEXIST')
    expect(await readFile(output, 'utf8')).toBe(receiptBytes)
    const target = join(dir, 'private.txt')
    const link = join(dir, 'symlink.json')
    await writeFile(target, 'keep this')
    await symlink(target, link)
    failure(await broker.run(link, paper), 'EEXIST')
    expect(await readFile(target, 'utf8')).toBe('keep this')
    expect(broker.posts).toHaveLength(0)
  }))

test('review orders use raw close, whole shares and inward 15 bp collars without assuming sell fills', () =>
  inDirectory(async (dir) => {
    const broker = mock({ positions: [bookPosition('USO', 100)], cash: '900.00', buyingPower: '899.99' })
    const receipt = success(
      await broker.run(join(dir, 'orders.json'), ['--tif', 'day', '--capital-budget-usd', '20000']),
    )
    expect(receipt.plan).toMatchObject({ reviewDue: true, rebalanceDue: true, budgetCents: 2_000_000 })
    expect(receipt.plan.orders.map(({ request }) => request)).toEqual([
      {
        ...receipt.plan.orders[0].request,
        symbol: 'USO',
        qty: '99',
        side: Side.Sell,
        type: 'limit',
        limit_price: '199.73',
        time_in_force: TimeInForce.Day,
        extended_hours: false,
      },
    ])
    const funded = success(
      await mock({ positions: [bookPosition('USO', 100)], cash: '100000' }).run(join(dir, 'funded.json')),
    )
    const { orders } = funded.plan
    expect(orders[0].request).toMatchObject({ side: Side.Sell, symbol: 'USO', qty: '91' })
    expect(orders.slice(1).length).toBeGreaterThan(0)
    for (const { request, referenceNotionalMicros, limitNotionalCents } of orders.slice(1)) {
      expect(request.limit_price).toBe('200.33')
      expect(request.qty).toMatch(/^[1-9]\d*$/)
      expect(request.time_in_force).toBe(TimeInForce.Open)
      expect(referenceNotionalMicros).toBe(200_030_000 * Number(request.qty))
      expect(limitNotionalCents).toBe(20_033 * Number(request.qty))
    }
  }))

test('10% aggregate drift: near-target no-op, many small drifts rebalance, non-review is read-only', () =>
  inDirectory(async (dir) => {
    const first = success(await mock().run(join(dir, 'empty.json')))
    const books = (scale: number) =>
      targets(first).flatMap(({ symbol, weight }) => {
        const qty = Math.floor((weight * 150_000 * scale) / rawPrice)
        return qty === 0 ? [] : [bookPosition(symbol, qty)]
      })
    const close = success(await mock({ positions: books(0.96) }).run(join(dir, 'deadband.json')))
    expect(close.plan).toMatchObject({ reviewDue: true, rebalanceDue: false, orders: [] })
    const drift = books(0.84)
    expect(
      targets(first).every(
        ({ symbol, weight }) =>
          Math.abs(weight - Number(drift.find((p) => p.symbol === symbol)?.market_value ?? 0) / 150_000) < 0.1,
      ),
    ).toBe(true)
    const outside = success(await mock({ positions: drift }).run(join(dir, 'aggregate.json')))
    expect(outside.plan.rebalanceDue).toBe(true)
    expect(outside.plan.orders.length).toBeGreaterThan(0)
    const offCadence = success(await mock({ count: 267 }).run(join(dir, 'non-review.json'), paper))
    expect(offCadence.allocation.targets).toBeNull()
    expect(offCadence.plan).toMatchObject({ reviewDue: false, rebalanceDue: false, orders: [] })
  }))

test.each([
  ['missing', 'Missing all SIP bar for GLD'],
  ['gap', 'Missing all SIP bar for HYG'],
  ['future', 'duplicate or unexpected all SIP bar'],
  ['duplicate', 'duplicate or unexpected all SIP bar'],
  ['order', 'duplicate or unexpected all SIP bar'],
  ['premature', 'duplicate or unexpected all SIP bar'],
  ['prices', 'Unexpected Alpaca response shape'],
  ['bad-adjustment', 'bar adjustment does not match'],
  ['feed', 'Unexpected Alpaca response shape'],
  ['token', 'pagination did not terminate'],
  ['empty', 'pagination returned an empty continuation'],
] as const)('invalid adjusted SIP history (%s) never yields a receipt or POST', (adjustFault, message) =>
  inDirectory(async (dir) => {
    const broker = mock({ adjustFault })
    failure(await broker.run(join(dir, 'invalid.json'), paper), message)
    expect(await readdir(dir)).toEqual([])
    expect(broker.posts).toHaveLength(0)
  }),
)

test.each([
  ['missing', 'Missing raw SIP bar for SHY'],
  ['stale', 'unexpected raw SIP bar for HYG'],
  ['bad-price', 'unexpected raw SIP bar for SHY'],
] as const)('invalid raw sizing history (%s) never authorizes a plan', (rawFault, message) =>
  inDirectory(async (dir) => {
    const broker = mock({ rawFault })
    failure(await broker.run(join(dir, 'invalid.json')), message)
    expect(await readdir(dir)).toEqual([])
    expect(broker.posts).toHaveLength(0)
  }),
)

test('rejects live and lookalike URLs before any network traffic, and verifies the paper UUID', () =>
  inDirectory(async (dir) => {
    for (const origin of [
      'https://api.alpaca.markets',
      'https://paper-api.alpaca.markets.evil.invalid',
      'https://paper-api.alpaca.markets@api.alpaca.markets',
      'https://paper-api.alpaca.markets:443',
      'https://paper-api.alpaca.markets/v2',
      'http://paper-api.alpaca.markets',
    ]) {
      const broker = mock({ origin })
      failure(await broker.run(join(dir, 'live.json'), paper), 'live is forbidden')
      expect(broker.calls).toEqual([])
    }
    const broker = mock()
    failure(
      await broker.run(join(dir, 'wrong-id.json'), [...paper.slice(0, 3), orderId]),
      'Paper account ID does not match',
    )
    expect(broker.calls.map(({ url }) => url.pathname)).toEqual(['/v2/account'])
    expect(await readdir(dir)).toEqual([])
  }))

test('market clock corroborates finalized close and enforces the exclusive next-open cutoff', () =>
  inDirectory(async (dir) => {
    const { signalDate, executionDate } = mock()
    const cases: [Mock, string][] = [
      [{ time: timestamp(signalDate, '20:14') }, 'Outside the finalized-bar'],
      [{ time: timestamp(executionDate, '09:28') }, 'Outside the finalized-bar'],
      [{ clockTimestamp: timestamp(executionDate, '07:58') }, 'Stale market clock'],
      [{ open: true }, 'Stale market clock'],
    ]
    for (const [input, reason] of cases) {
      const broker = mock(input)
      failure(await broker.run(join(dir, 'window.json'), paper), reason)
      expect(broker.posts).toHaveLength(0)
      expect(broker.calls.some(({ url }) => url.hostname === 'data.alpaca.markets')).toBe(false)
    }
    expect(await readdir(dir)).toEqual([])
    const evening = success(await mock({ time: timestamp(signalDate, '20:15') }).run(join(dir, 'evening.json')))
    expect(String(evening.executionSession)).toBe(executionDate)
  }))

test('paper aborts on open or prior orders, blocked accounts, account/position drift and preflight cutoff', () =>
  inDirectory(async (dir) => {
    const cases: [Mock, string][] = [
      [{ openOrders: [{ ...terminalOrder, status: 'new' }] }, 'Outstanding account orders'],
      [{ history: [terminalOrder] }, 'already has an order for this next-open session'],
      [{ blocked: true }, 'Broker account is blocked'],
      [{ newCash: '199999.99' }, 'account or inventory changed'],
      [{ positions: [bookPosition('QQQ', 4)], newPositions: [bookPosition('QQQ', 5)] }, 'account or inventory changed'],
      [{ differentNextOpen: true }, 'No longer in the verified next-open'],
      [{ history: Array.from({ length: 500 }, () => terminalOrder) }, 'reached the read limit'],
      [{ positions: [bookPosition('SHY', -1)] }, 'Unsupported or inconsistent paper position'],
      [{ positions: [bookPosition('IEF', 3), bookPosition('IEF', 4)] }, 'Unsupported or inconsistent paper position'],
    ]
    for (const [i, [input, reason]] of cases.entries()) {
      const broker = mock(input)
      failure(await broker.run(join(dir, `reject-${i}.json`), paper), reason)
      expect(broker.posts).toHaveLength(0)
    }
    expect((await readdir(dir)).every((file) => !file.endsWith('.jsonl'))).toBe(true)
  }))

test('paper writes the durable receipt and journals every dispatch before POST and each verified ack after it', () =>
  inDirectory(async (dir) => {
    const output = join(dir, 'paper.json')
    const positions = [bookPosition('QQQ', 100), bookPosition('SMH', 50), bookPosition('USO', 100)]
    const shadow = success(await mock({ positions }).run(join(dir, 'shadow.json')))
    const broker = mock({
      positions,
      beforePost: async (index, request) => {
        const entries = await records(dir)
        expect(entries).toHaveLength(index * 2 - 1)
        expect(entries.at(-1)).toMatchObject({ outcome: 'dispatching', planSha256: shadow.planSha256, request })
        if (index > 1) expect(entries.at(-2)).toMatchObject({ outcome: 'acknowledged' })
        expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({ planSha256: shadow.planSha256 })
      },
    })
    const receipt = success(await broker.run(output, paper))
    expect(receipt.planSha256).toBe(shadow.planSha256)
    expect(broker.posts).toEqual(receipt.plan.orders.map(({ request }) => request))
    expect(broker.posts[0]).toMatchObject({ symbol: 'USO', side: Side.Sell })
    expect(broker.posts.length).toBeGreaterThan(1)
    expect(broker.posts.every(({ symbol }) => symbol !== 'QQQ' && symbol !== 'SMH')).toBe(true)
    const history = broker.calls.find(({ url }) => url.searchParams.get('status') === 'all')
    expect(Date.parse(history?.url.searchParams.get('after') ?? '')).toBe(Date.parse(receipt.signalCloseAt) - 1)
    const entries = await records(dir)
    expect(entries).toHaveLength(broker.posts.length * 2)
    for (const [i, request] of broker.posts.entries()) {
      expect(entries[i * 2 + 1]).toMatchObject({
        outcome: 'acknowledged',
        planSha256: receipt.planSha256,
        ack: { ...request, id: orderId },
      })
    }
    const repeat = mock({ positions })
    failure(await repeat.run(join(dir, 'new-profile.json'), [...paper, '--profile', RunnerProfile.F2]), 'EEXIST')
    expect(repeat.posts).toHaveLength(0)
  }))

test.each(['transport', 'bad-ack', 'redirect'] as const)(
  'uncertain paper dispatch (%s) stops the batch and cannot retry through the local fence',
  (postFault) =>
    inDirectory(async (dir) => {
      const broker = mock({ postFault })
      failure(await broker.run(join(dir, 'uncertain.json'), paper), 'No verified acknowledgement')
      expect(broker.posts).toHaveLength(1)
      const entries = await records(dir)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ outcome: 'dispatching', request: broker.posts[0] })
      const repeat = mock()
      failure(await repeat.run(join(dir, 'retry.json'), paper), 'EEXIST')
      expect(repeat.posts).toHaveLength(0)
    }),
)

test('cancels a timed-out calendar read without mutation or receipt', () =>
  inDirectory(async (dir) => {
    const broker = mock({ hold: 'calendar' })
    failure(await broker.run(join(dir, 'timeout.json'), paper, 'timeout'), 'exceeded its 12-second deadline')
    expect(broker.abortCount()).toBe(1)
    expect(broker.posts).toHaveLength(0)
    expect(await readdir(dir)).toEqual([])
  }))

test.each(['timeout', 'interrupt'] as const)(
  'a paper dispatch %s aborts once and preserves its uncertain journal',
  (cancel) =>
    inDirectory(async (dir) => {
      const broker = mock({ hold: 'submit' })
      const exit = await broker.run(join(dir, 'canceled.json'), paper, cancel)
      if (cancel === 'interrupt') expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      else failure(exit, 'No verified acknowledgement')
      expect(broker.abortCount()).toBe(1)
      expect(broker.posts).toHaveLength(1)
      const entries = await records(dir)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ outcome: 'dispatching', request: broker.posts[0] })
    }),
)

test('cutoff during a batch records the in-flight acknowledgement but never sends the next order', () =>
  inDirectory(async (dir) => {
    const broker = mock({
      time: new Date(Date.parse(timestamp(dates[268], '09:28')) - 5_000).toISOString(),
      advanceOnDispatch: true,
    })
    failure(await broker.run(join(dir, 'cutoff.json'), paper, 'cutoff'), 'Verified submission window expired')
    expect(broker.posts).toHaveLength(1)
    const entries = await records(dir)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ outcome: 'dispatching', request: broker.posts[0] })
    expect(entries[1]).toMatchObject({ outcome: 'acknowledged', ack: broker.posts[0] })
  }))

const otherAccountId = '22222222-1234-4234-8123-000000000003'
const otherKey = 'other-paper-key-do-not-echo'
const otherSecret = 'other-paper-secret-do-not-echo'
const portfolioSleeves = [
  {
    sleeveId: 'core-a',
    strategy: Strategy.MacroEtfCore,
    profile: RunnerProfile.F4,
    accountId,
    credentialsEnvPrefix: 'CORE_A',
    capitalBudgetUsd: 50_000,
  },
  {
    sleeveId: 'core-b',
    strategy: Strategy.MacroEtfCore,
    profile: RunnerProfile.Equal,
    accountId: otherAccountId,
    credentialsEnvPrefix: 'CORE_B',
    capitalBudgetUsd: 60_000,
  },
]

const portfolio = async (
  dir: string,
  primary: ReturnType<typeof mock>,
  other: ReturnType<typeof mock>,
  mode: SleeveMode,
  flags: readonly string[] = [],
  outputName = 'portfolio.json',
) => {
  const manifest = join(dir, 'manifest.json')
  const output = join(dir, outputName)
  await writeFile(
    manifest,
    JSON.stringify({
      schemaVersion: 'bayn.multi-account-daily-sleeves-config.v1',
      intradayAccountId: '33333333-1234-4234-8123-000000000004',
      sleeves: portfolioSleeves.map((sleeve) => ({ ...sleeve, mode })),
    }),
  )
  const transport: typeof fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      (new Headers(init?.headers).get('apca-api-key-id') === testKey ? primary.fetchMock : other.fetchMock)(
        input,
        init,
      ),
    { preconnect: fetch.preconnect },
  )
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(primary.now))
      return yield* runDailySleeves(['--manifest', manifest, '--output', output, ...flags])
    }).pipe(
      Effect.scoped,
      Effect.provideService(FetchHttpClient.Fetch, transport),
      // @effect-diagnostics-next-line strictEffectProvide:off -- test composition root
      Effect.provide(
        Layer.mergeAll(
          NodeFileSystem.layer,
          FetchHttpClient.layer,
          TestClock.layer(),
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              CORE_A_ALPACA_KEY_ID: testKey,
              CORE_A_ALPACA_SECRET_KEY: testSecret,
              CORE_B_ALPACA_KEY_ID: otherKey,
              CORE_B_ALPACA_SECRET_KEY: otherSecret,
            }),
          ),
        ),
      ),
    ),
  )
  return { exit, output }
}

test('portfolio uses distinct credentials and real Wave 9C planning with full QQQ, without POSTing in Shadow', async () => {
  await inDirectory(async (dir) => {
    const primary = mock()
    const other = mock({ accountId: otherAccountId, key: otherKey, secret: otherSecret })
    const { exit, output } = await portfolio(dir, primary, other, SleeveMode.Shadow, ['--confirm-paper-submit'])
    const receipt = success(exit)
    expect(receipt.isolation.allBrokerAccountsVerified).toBe(true)
    for (const sleeve of receipt.sleeves) {
      expect(sleeve.disposition).toBe('shadow')
      expect(sleeve.plan?.targetExposure?.find(({ symbol }) => symbol === 'QQQ')?.targetCents).toBeGreaterThan(0)
    }
    expect(receipt.aggregateTargetExposure.targetCentsBySymbol['QQQ']).toBe(
      receipt.sleeves.reduce(
        (total, { plan }) => total + (plan?.targetExposure?.find(({ symbol }) => symbol === 'QQQ')?.targetCents ?? 0),
        0,
      ),
    )
    expect(primary.posts).toEqual([])
    expect(other.posts).toEqual([])
    expect((await readdir(dir)).sort()).toEqual(['manifest.json', 'portfolio.json'])
    const stored = await readFile(output, 'utf8')
    for (const value of [testKey, testSecret, otherKey, otherSecret]) expect(stored).not.toContain(value)
    expect(JSON.parse(stored)).toEqual(receipt)
  })
})

test('portfolio checks confirmation before broker I/O and a swapped credential withholds other paper sleeves', async () => {
  await inDirectory(async (dir) => {
    const primary = mock()
    const swapped = mock({ key: otherKey, secret: otherSecret })
    const unconfirmed = await portfolio(dir, primary, swapped, SleeveMode.PaperSubmit)
    failure(unconfirmed.exit, 'PaperSubmitNotConfirmed')
    expect(primary.calls).toHaveLength(0)
    expect(swapped.calls).toHaveLength(0)

    const { exit, output } = await portfolio(dir, primary, swapped, SleeveMode.PaperSubmit, ['--confirm-paper-submit'])
    failure(exit, 'AccountMismatch')
    expect(primary.posts).toEqual([])
    expect(swapped.calls.map(({ url }) => url.pathname)).toEqual(['/v2/account'])
    const body = await readFile(output, 'utf8')
    expect(JSON.parse(body)).toMatchObject({
      isolation: { allBrokerAccountsVerified: false },
      sleeves: [
        { disposition: 'withheld', verifiedAccountId: accountId, error: null },
        { disposition: 'failed', verifiedAccountId: null, error: { stage: 'reconcile' } },
      ],
    })
    for (const value of [testKey, testSecret, otherKey, otherSecret]) expect(body).not.toContain(value)
  })
})

test('paper portfolio keeps completed sleeves, journals an uncertain write, and never retries it', async () => {
  await inDirectory(async (dir) => {
    const primary = mock()
    const other = mock({ accountId: otherAccountId, key: otherKey, secret: otherSecret, postFault: 'transport' })
    const { exit, output } = await portfolio(dir, primary, other, SleeveMode.PaperSubmit, ['--confirm-paper-submit'])
    failure(exit, 'TransportError')
    expect(primary.posts.length).toBeGreaterThan(0)
    expect(other.posts).toHaveLength(1)
    const journals = (await readdir(dir)).filter((name) => name.endsWith('submissions.jsonl'))
    expect(journals).toHaveLength(2)
    const body = await readFile(output, 'utf8')
    expect(JSON.parse(body)).toMatchObject({
      sleeves: [{ disposition: 'submitted' }, { disposition: 'failed', error: { stage: 'paper-submit' } }],
    })
    const secondJournal = journals.find((name) => name.includes(sha256(otherAccountId).slice(0, 12)))
    if (secondJournal === undefined) throw new Error('No durable account fence')
    const entries = (await readFile(join(dir, secondJournal), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown)
    expect(entries).toMatchObject([{ outcome: 'prepared' }, { outcome: 'dispatching' }])
    const duplicate = await portfolio(
      dir,
      primary,
      other,
      SleeveMode.PaperSubmit,
      ['--confirm-paper-submit'],
      'retry.json',
    )
    failure(duplicate.exit, 'FileOperationFailed')
    expect(other.posts).toHaveLength(1)
  })
})
