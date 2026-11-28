import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Cause, ConfigProvider, Effect, Exit, Fiber, FileSystem, Layer, Stdio } from 'effect'
import { FetchHttpClient, HttpClient } from 'effect/http'
import { TestClock } from 'effect/testing'

import { AccountStatus, AssetClass, OrderStatus, PositionSide } from '../src/broker/alpaca/model'
import {
  CheckStatus,
  FailureKind,
  Format,
  OntologyStatus,
  Phase,
  intradayPolicyVersion,
  postgresIdentityFailure,
  renderCutoverReport,
  verifyIntraday,
} from './monday-cutover-verifier'
import { runMondayCutover, verifyMondayCutover } from './verify-monday-cutover'

const intradayId = '10101010-1010-4010-8010-101010101010'
const coreId = '20202020-2020-4020-8020-202020202020'
const canaryId = '30303030-3030-4030-8030-303030303030'
const account = { id: intradayId, status: AccountStatus.Active }
const intradayBinding = { account, expectedId: intradayId }
const googl = { symbol: 'GOOGL', qty: '-103', side: PositionSide.Short, asset_class: AssetClass.UsEquity }
const holding = (symbol: string) => ({ symbol, qty: '1', side: PositionSide.Long, asset_class: AssetClass.UsEquity })
const googlOrder = { symbol: 'GOOGL', status: OrderStatus.Held, legs: null }
const behaviorHash = '35534271edfc916e5a2801b31cfb3fc4b3d2640209666fc22c831401040fb58b'
const parameterHash = '40d0643d63c368dd207d0f6a55b3feadb673dbd74b7c8b82bd7ee8d52e256eb5'

describe('cutover phase decisions', () => {
  test('pre-open reports a short GOOGL quantity without rejecting it', () => {
    const report = verifyIntraday(Phase.PreOpen, intradayBinding, [googl], [googlOrder])
    expect(report).toMatchObject({
      status: CheckStatus.Pass,
      evidence: { accountStatus: AccountStatus.Active, googlQuantities: ['-103'], googlOpenOrders: 1 },
    })
    const positiveQty = verifyIntraday(Phase.PreOpen, intradayBinding, [{ ...googl, qty: '103' }], [])
    expect(positiveQty).toMatchObject({ evidence: { googlQuantities: ['-103'] } })
    expect(
      verifyIntraday(
        Phase.PreOpen,
        { ...intradayBinding, account: { ...account, status: AccountStatus.Inactive } },
        [],
        [],
      ).status,
    ).toBe(CheckStatus.Fail)
  })

  test('post-flatten independently rejects a nonzero GOOGL position and a working order', () => {
    expect(verifyIntraday(Phase.PostFlatten, intradayBinding, [googl], []).status).toBe(CheckStatus.Fail)
    expect(verifyIntraday(Phase.PostFlatten, intradayBinding, [], [googlOrder]).status).toBe(CheckStatus.Fail)
    expect(verifyIntraday(Phase.PostFlatten, intradayBinding, [{ ...googl, qty: '0.000' }], []).status).toBe(
      CheckStatus.Pass,
    )
    expect(verifyIntraday(Phase.PostFlatten, intradayBinding, [], []).status).toBe(CheckStatus.Pass)
  })

  test('post-cutover accepts only the named ETFs and requires US equity asset class', () => {
    expect(verifyIntraday(Phase.PostCutover, intradayBinding, ['QQQ', 'SMH', 'XLK'].map(holding), []).status).toBe(
      CheckStatus.Pass,
    )
    for (const position of [holding('AAPL'), holding('SPY'), { ...holding('QQQ'), asset_class: AssetClass.UsOption }]) {
      expect(verifyIntraday(Phase.PostCutover, intradayBinding, [position], []).status).toBe(CheckStatus.Fail)
    }
  })

  test('post-cutover checks both requested behavior hash and the reviewed v3 parameters', () => {
    const verify = (observed: { behaviorHash: string; parameterHash: string } | null) =>
      verifyIntraday(Phase.PostCutover, intradayBinding, [], [], { expectedBehaviorHash: behaviorHash, observed })
    expect(verify({ behaviorHash, parameterHash })).toMatchObject({
      status: CheckStatus.Pass,
      evidence: { verifiedPolicy: intradayPolicyVersion },
    })
    expect(verify({ behaviorHash: 'a'.repeat(64), parameterHash }).status).toBe(CheckStatus.Fail)
    expect(verify({ behaviorHash, parameterHash: 'b'.repeat(64) }).status).toBe(CheckStatus.Fail)
    expect(verify(null).status).toBe(CheckStatus.Fail)
  })

  test('the writer role is rejected even on a standby; a primary is rejected only when standby is required', () => {
    expect(postgresIdentityFailure('bayn_app', true, false)).toContain('writer role')
    expect(postgresIdentityFailure('bayn_audit', false, true)).toContain('not a standby')
    expect(postgresIdentityFailure('bayn_audit', false, false)).toBeNull()
    expect(postgresIdentityFailure('bayn_audit', true, true)).toBeNull()
  })
})

const fixtureSecret = 'fixture-not-a-real-secret'
const env: Readonly<Record<string, string>> = {
  BAYN_ALPACA_KEY_ID: 'intraday-key',
  BAYN_ALPACA_SECRET_KEY: fixtureSecret,
  BAYN_MACRO_CORE_ALPACA_KEY_ID: 'core-key',
  BAYN_MACRO_CORE_ALPACA_SECRET_KEY: fixtureSecret,
  BAYN_MACRO_CANARY_ALPACA_KEY_ID: 'canary-key',
  BAYN_MACRO_CANARY_ALPACA_SECRET_KEY: fixtureSecret,
}
const balances = { equity: '10000.00', buying_power: '9900.50', status: AccountStatus.Active }
const accounts = new Map([
  ['intraday-key', { ...balances, id: intradayId }],
  ['core-key', { ...balances, id: coreId }],
  ['canary-key', { ...balances, id: canaryId }],
])
type Responder = (url: URL, key: string | null, init?: RequestInit) => Response | Promise<Response> | undefined
const fixture = (vars: Readonly<Record<string, string>> = env, responder?: Responder) => {
  const calls: { method: string | undefined; key: string | null; url: URL; redirect: RequestRedirect | undefined }[] =
    []
  const transport = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      const key = new Headers(init?.headers).get('apca-api-key-id')
      calls.push({ method: init?.method, key, url, redirect: init?.redirect })
      const selected = responder?.(url, key, init)
      if (selected !== undefined) return selected
      if (key === null || !accounts.has(key)) return new Response(null, { status: 403 })
      if (url.pathname === '/v2/account') return Response.json(accounts.get(key))
      if (url.pathname === '/v2/positions' || url.pathname === '/v2/orders') return Response.json([])
      return new Response(null, { status: 404 })
    },
    { preconnect: fetch.preconnect },
  )
  const layer = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    ConfigProvider.layer(ConfigProvider.fromUnknown(vars)),
  )
  const provide = <A, E>(program: Effect.Effect<A, E, HttpClient.HttpClient | FileSystem.FileSystem | Stdio.Stdio>) =>
    program.pipe(
      Effect.provideService(FetchHttpClient.Fetch, transport),
      // @effect-diagnostics-next-line strictEffectProvide:off -- test composition substitutes credentials and transport
      Effect.provide(layer),
    )
  return { calls, provide }
}

describe('read-only verifier wiring', () => {
  test('reads all three accounts using only GET, including flat open orders, and skips unconfigured optional checks', async () => {
    const { calls, provide } = fixture(env, (url, key) =>
      url.pathname === '/v2/positions' && key === 'intraday-key' ? Response.json([googl]) : undefined,
    )
    const report = await Effect.runPromise(provide(verifyMondayCutover({ phase: Phase.PreOpen })))
    expect(report.verdict).toBe(CheckStatus.Pass)
    expect(report.checks.intraday).toMatchObject({ evidence: { googlQuantities: ['-103'] } })
    expect(report.checks.macroAccounts.status).toBe(CheckStatus.Pass)
    expect(report.checks.postgres.status).toBe(CheckStatus.Skipped)
    expect(report.checks.autoOntology).toMatchObject({ status: CheckStatus.Skipped, blocking: false })
    expect(calls.length).toBe(7)
    expect(calls.every(({ method, redirect }) => method === 'GET' && redirect === 'error')).toBe(true)
    expect(calls.find(({ url }) => url.pathname === '/v2/orders')?.url.search).toBe(
      '?status=open&nested=false&limit=500',
    )
    expect(renderCutoverReport(report, Format.Markdown)).toContain('GOOGL position quantity: -103')
  })

  test('post-flatten sees the position when the last working GOOGL order fills before the orders response', async () => {
    let filled = false
    const { provide } = fixture(env, (url, key) => {
      if (key !== 'intraday-key') return undefined
      if (url.pathname === '/v2/orders') {
        filled = true
        return Response.json([])
      }
      if (url.pathname === '/v2/positions') return Response.json(filled ? [googl] : [])
      return undefined
    })
    const report = await Effect.runPromise(provide(verifyMondayCutover({ phase: Phase.PostFlatten })))
    expect(report.verdict).toBe(CheckStatus.Fail)
    expect(report.checks.intraday).toMatchObject({
      evidence: { googlQuantities: ['-103'], googlOpenOrders: 0 },
    })
  })

  test.each([
    ['core-key', intradayId, '#1 and #2'],
    ['canary-key', intradayId, '#1 and #3'],
    ['canary-key', coreId, '#2 and #3'],
  ])('blocks a shared ID before reading macro positions (%s, %s)', async (duplicateKey, id, pair) => {
    const { calls, provide } = fixture(env, (url, key) =>
      url.pathname === '/v2/account' && key === duplicateKey ? Response.json({ ...balances, id }) : undefined,
    )
    const report = await Effect.runPromise(provide(verifyMondayCutover({ phase: Phase.PreOpen })))
    expect(report.verdict).toBe(CheckStatus.Fail)
    expect(report.checks.intraday.status).toBe(CheckStatus.Pass)
    expect(report.checks.macroAccounts).toMatchObject({
      status: CheckStatus.Fail,
      problems: [{ message: `Accounts ${pair} share an Alpaca account ID.` }],
    })
    expect(calls.filter(({ key, url }) => key !== 'intraday-key' && url.pathname === '/v2/positions')).toEqual([])
    expect(renderCutoverReport(report, Format.Json)).not.toContain(id)
  })

  test('macro accounts must both be configured unless explicitly skipped', async () => {
    const { calls, provide } = fixture({
      BAYN_ALPACA_KEY_ID: 'intraday-key',
      BAYN_ALPACA_SECRET_KEY: fixtureSecret,
      BAYN_MACRO_CORE_ALPACA_KEY_ID: 'core-key',
    })
    const failed = await Effect.runPromise(provide(verifyMondayCutover({ phase: Phase.PreOpen })))
    expect(failed.verdict).toBe(CheckStatus.Fail)
    expect(failed.checks.macroAccounts.status).toBe(CheckStatus.Fail)
    const skipped = await Effect.runPromise(
      provide(verifyMondayCutover({ phase: Phase.PreOpen, 'skip-macro-accounts': true })),
    )
    expect(skipped.checks.macroAccounts.status).toBe(CheckStatus.Skipped)
    expect(skipped.verdict).toBe(CheckStatus.Pass)
    expect(calls.every(({ key }) => key === 'intraday-key')).toBe(true)
  })

  test('rejects a live endpoint before sending credentials unless the operator explicitly opts in', async () => {
    const { calls, provide } = fixture({ ...env, BAYN_MACRO_CORE_ALPACA_BASE_URL: 'https://api.alpaca.markets' })
    const blocked = await Effect.runPromise(provide(verifyMondayCutover({ phase: Phase.PreOpen })))
    expect(blocked.verdict).toBe(CheckStatus.Fail)
    expect(calls.some(({ url }) => url.hostname === 'api.alpaca.markets')).toBe(false)
    const allowed = await Effect.runPromise(
      provide(verifyMondayCutover({ phase: Phase.PreOpen, 'allow-live-endpoint': true })),
    )
    expect(allowed.verdict).toBe(CheckStatus.Pass)
    expect(allowed.checks.macroAccounts).toMatchObject({ evidence: { core: { endpoint: 'LIVE' } } })
    expect(calls.filter(({ url }) => url.hostname === 'api.alpaca.markets')).toHaveLength(2)
  })

  test.each([
    ['zero', '0'],
    ['negative', '-0.25'],
    ['infinite', 'Infinity'],
    ['non-decimal', '1e10'],
    ['overflow', '9'.repeat(400)],
  ])('blocks %s macro buying power', async (_label, value) => {
    const { provide } = fixture(env, (url, key) =>
      url.pathname === '/v2/account' && key === 'core-key'
        ? Response.json({ ...balances, id: coreId, buying_power: value })
        : undefined,
    )
    const report = await Effect.runPromise(provide(verifyMondayCutover({ phase: Phase.PreOpen })))
    expect(report.verdict).toBe(CheckStatus.Fail)
    expect(report.checks.macroAccounts.status).toBe(CheckStatus.Fail)
  })

  test('warns rather than blocks for positive equity outside the expected sleeve balance', async () => {
    const { provide } = fixture(env, (url, key) =>
      url.pathname === '/v2/account' && key === 'core-key'
        ? Response.json({ ...balances, id: coreId, equity: '8999.99' })
        : undefined,
    )
    const report = await Effect.runPromise(provide(verifyMondayCutover({ phase: Phase.PreOpen })))
    expect(report.verdict).toBe(CheckStatus.Pass)
    expect(report.checks.macroAccounts).toMatchObject({
      status: CheckStatus.Pass,
      warnings: [expect.stringContaining('$9,000')],
    })
  })

  test('fails closed on malformed and saturated order responses', async () => {
    for (const orders of [
      [{ symbol: 'GOOGL', status: fixtureSecret }],
      Array.from({ length: 500 }, () => ({
        ...googlOrder,
        symbol: 'QQQ',
      })),
    ]) {
      const { provide } = fixture(env, (url) => (url.pathname === '/v2/orders' ? Response.json(orders) : undefined))
      const report = await Effect.runPromise(provide(verifyMondayCutover({ phase: Phase.PostFlatten })))
      expect(report.verdict).toBe(CheckStatus.Fail)
      expect(report.checks.intraday).toMatchObject({
        status: CheckStatus.Fail,
        problems: [{ kind: FailureKind.Decode }],
      })
      const json = renderCutoverReport(report, Format.Json)
      expect(json).toContain('<redacted>')
      expect(json).not.toContain(fixtureSecret)
    }
  })

  test('CLI post-cutover requires both configured runtime hashes when the policy hash flag is supplied', async () => {
    const options = { phase: Phase.PostCutover, 'expected-policy-hash': behaviorHash } as const
    const { provide } = fixture({
      ...env,
      BAYN_STRATEGY_BEHAVIOR_HASH: behaviorHash,
      BAYN_STRATEGY_PARAMETER_HASH: parameterHash,
    })
    const report = await Effect.runPromise(provide(verifyMondayCutover(options)))
    expect(report.verdict).toBe(CheckStatus.Pass)
    expect(report.checks.intraday).toMatchObject({ evidence: { verifiedPolicy: intradayPolicyVersion } })
    expect((await Effect.runPromise(fixture().provide(verifyMondayCutover(options)))).verdict).toBe(CheckStatus.Fail)
  })

  test('rejects the writer login and a missing standby URL without disclosing connection strings', async () => {
    const url = `postgresql://audit:${fixtureSecret}@invalid.test/bayn?user=bayn_app`
    const writer = fixture({ ...env, BAYN_POSTGRES_URL: url })
    const report = await Effect.runPromise(writer.provide(verifyMondayCutover({ phase: Phase.PreOpen })))
    expect(report.verdict).toBe(CheckStatus.Fail)
    const json = renderCutoverReport(report, Format.Json)
    expect(json).toContain('bayn_app writer role is forbidden')
    expect(json).not.toContain(url)
    expect(json).not.toContain(fixtureSecret)

    const noUrl = await Effect.runPromise(
      fixture().provide(verifyMondayCutover({ phase: Phase.PreOpen, 'require-standby': true })),
    )
    expect(noUrl.verdict).toBe(CheckStatus.Fail)
    expect(noUrl.checks.postgres).toMatchObject({
      problems: [{ message: '--require-standby needs BAYN_POSTGRES_URL.' }],
    })
  })

  test('bad CA or invalid database URL blocks and retains only a redacted diagnostic', async () => {
    for (const vars of [
      { BAYN_POSTGRES_URL: `postgresql://audit:${fixtureSecret}@[invalid` },
      {
        BAYN_POSTGRES_URL: `postgres://audit:${fixtureSecret}@invalid.test/bayn`,
        BAYN_POSTGRES_CA_PATH: `/no-such-certificate-${fixtureSecret}`,
      },
    ]) {
      const { provide } = fixture({ ...env, ...vars })
      const report = await Effect.runPromise(provide(verifyMondayCutover({ phase: Phase.PreOpen })))
      expect(report.checks.postgres.status).toBe(CheckStatus.Fail)
      const json = renderCutoverReport(report, Format.Json)
      expect(json).toContain('<redacted>')
      expect(json).not.toContain(fixtureSecret)
    }
  })

  test.each([
    [() => Response.json({ status: 'ok' }), OntologyStatus.Healthy],
    [() => Response.json({ status: 'degraded', error: fixtureSecret }, { status: 503 }), OntologyStatus.Degraded],
    [() => new Response(fixtureSecret), OntologyStatus.Degraded],
    [() => Promise.reject(new Error(fixtureSecret)), OntologyStatus.Unreachable],
  ])('keeps ontology health %p strictly advisory', async (response, status) => {
    const { calls, provide } = fixture({ ...env, AUTO_ONTOLOGY_API_URL: 'https://ontology.test' }, (url) =>
      url.pathname === '/api/health' ? response() : undefined,
    )
    const report = await Effect.runPromise(provide(verifyMondayCutover({ phase: Phase.PreOpen })))
    expect(report.verdict).toBe(CheckStatus.Pass)
    expect(report.checks.autoOntology).toMatchObject({ status, blocking: false })
    expect(calls.find(({ url }) => url.pathname === '/api/health')).toMatchObject({ method: 'GET', key: null })
    expect(renderCutoverReport(report, Format.Json)).not.toContain(fixtureSecret)
    expect(renderCutoverReport(report, Format.Markdown)).not.toContain(fixtureSecret)
  })

  test('3-second advisory deadline aborts a stalled health response body', async () => {
    const pending = Promise.withResolvers<void>()
    let aborted = 0
    const { provide } = fixture({ ...env, AUTO_ONTOLOGY_API_URL: 'https://ontology.test' }, (url, _key, init) => {
      if (url.pathname !== '/api/health') return undefined
      return new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            pending.resolve()
            return new Promise<void>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => {
                  aborted++
                  reject(new Error('fixture aborted'))
                },
                { once: true },
              )
            })
          },
        }),
      )
    })
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(provide(verifyMondayCutover({ phase: Phase.PreOpen })))
        yield* Effect.promise(() => pending.promise)
        yield* TestClock.adjust('3 seconds')
        return yield* Fiber.join(fiber)
      }).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off -- bound the mock body with the test clock
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(report.verdict).toBe(CheckStatus.Pass)
    expect(report.checks.autoOntology).toMatchObject({
      status: OntologyStatus.Unreachable,
      problem: { kind: FailureKind.Timeout },
    })
    expect(aborted).toBe(1)
  })

  test('an unexpected ontology probe defect is advisory; a broker defect is not', async () => {
    const { provide } = fixture({ ...env, AUTO_ONTOLOGY_API_URL: 'https://ontology.test' })
    const defect = (path: string) =>
      provide(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient
          const faulty = HttpClient.mapRequestEffect(client, (request) =>
            request.url.endsWith(path) ? Effect.die(fixtureSecret) : Effect.succeed(request),
          )
          return yield* verifyMondayCutover({ phase: Phase.PreOpen }).pipe(
            Effect.provideService(HttpClient.HttpClient, faulty),
          )
        }),
      )
    const report = await Effect.runPromise(defect('/api/health'))
    expect(report.verdict).toBe(CheckStatus.Pass)
    expect(report.checks.autoOntology.status).toBe(OntologyStatus.Unreachable)
    expect(renderCutoverReport(report, Format.Json)).not.toContain(fixtureSecret)
    const exit = await Effect.runPromiseExit(defect('/v2/orders'))
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  })

  test('writes a private report before returning a failing exit, and does not overwrite a report', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bayn-cutover-verifier-'))
    try {
      const output = join(directory, 'result.md')
      const { provide } = fixture(env, (url) =>
        url.pathname === '/v2/orders' ? Response.json([googlOrder]) : undefined,
      )
      const args = ['--phase', 'post-flatten', '--format', 'markdown', '--output', output]
      const exit = await Effect.runPromiseExit(provide(runMondayCutover(args)))
      expect(Exit.isFailure(exit)).toBe(true)
      const text = await readFile(output, 'utf8')
      expect(text).toContain('Bayn Monday cutover: FAIL')
      expect(text).toContain('An open GOOGL order remains.')
      expect((await stat(output)).mode & 0o777).toBe(0o600)

      const passing = fixture()
      const overwrite = await Effect.runPromiseExit(passing.provide(runMondayCutover(args)))
      expect(Exit.isFailure(overwrite)).toBe(true)
      expect(await readFile(output, 'utf8')).toBe(text)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
