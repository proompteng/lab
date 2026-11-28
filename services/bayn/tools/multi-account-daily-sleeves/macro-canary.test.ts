import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeFileSystem } from '@effect/platform-node'
import { ConfigProvider, Effect, Exit, Layer, Result } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { TestClock } from 'effect/testing'

import { canonicalHashV1Result } from '../../src/hash'
import { fixtureMarket, regimeClose } from '../../src/strategy/macro-canary-etf/fixtures.test-support'
import { defaultMacroCanaryEtfPolicy, macroCanaryEtfs } from '../../src/strategy/macro-canary-etf/policy'
import { compileMacroCanaryEtfSignal } from '../../src/strategy/macro-canary-etf/signals'
import { utcInstantFromEpochMillis } from '../../src/time'
import { nyTime } from '../macro-canary-runner/market'
import { runDailySleeves } from '../run-multi-account-daily-sleeves'
import { CanaryProfile, SleeveMode, Strategy } from './contract'

const accountId = '11111111-1234-4234-8123-000000000007'
const account = {
  id: accountId,
  currency: 'USD',
  status: 'ACTIVE',
  equity: '50000',
  cash: '50000',
  buying_power: '50000',
  account_blocked: false,
  trading_blocked: false,
  trade_suspended_by_user: false,
}
const fixture = fixtureMarket(252, regimeClose)
const executionSession = fixture.nextOpenSession
const signalSession = fixture.calendar[252]
const calendar = fixture.calendar.slice(0, 254)
const bars = fixture.history.bars.filter(({ session }) => session <= signalSession)
const toProviderBar = ({ session, open, high, low, close, volume }: (typeof bars)[number]) => ({
  t: utcInstantFromEpochMillis(nyTime(session, '00:00')),
  o: open,
  h: high,
  l: low,
  c: close,
  v: volume,
})
const rawSizingBars = bars
  .filter(({ session }) => session === signalSession)
  .map(({ symbol, ...bar }) => ({ symbol, bar: toProviderBar({ symbol, ...bar }) }))
const marketSha256 = Result.getOrThrow(
  canonicalHashV1Result({ calendar, feed: 'sip', timeframe: '1Day', adjustment: 'all', bars, rawSizingBars }),
)
const snapshotSha256 = Result.getOrThrow(canonicalHashV1Result({ account, positions: [], openOrders: [] }))
const evidence = {
  schemaVersion: 'bayn.macro-canary-next-open-evidence.v1',
  signalSession,
  executionSession,
  marketSha256,
  accounts: [{ accountId, snapshotSha256, remainingOneWayTurnoverBps: 60_000 }],
}

const run = async (dir: string, name: string, proof: unknown, mode: SleeveMode) => {
  const manifest = join(dir, 'manifest.json')
  const evidencePath = join(dir, 'evidence.json')
  const output = join(dir, `${name}.json`)
  await writeFile(
    manifest,
    JSON.stringify({
      schemaVersion: 'bayn.multi-account-daily-sleeves-config.v1',
      intradayAccountId: '22222222-1234-4234-8123-000000000008',
      sleeves: [
        {
          sleeveId: 'macro-canary',
          strategy: Strategy.MacroCanaryEtf,
          profile: CanaryProfile.O1,
          accountId,
          credentialsEnvPrefix: 'CANARY',
          capitalBudgetUsd: 50_000,
          mode,
        },
      ],
    }),
  )
  if (proof !== undefined) await writeFile(evidencePath, JSON.stringify(proof))
  const now = nyTime(signalSession, '20:30')
  const posts: unknown[] = []
  const adjusted = Object.fromEntries(
    macroCanaryEtfs.map((symbol) => [symbol, bars.filter((bar) => bar.symbol === symbol).map(toProviderBar)]),
  )
  const transport: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      expect(url.origin).toBe(
        url.pathname === '/v2/stocks/bars' ? 'https://data.alpaca.markets' : 'https://paper-api.alpaca.markets',
      )
      expect(new Headers(init?.headers).get('apca-api-key-id')).toBe('test-api-key')
      switch (url.pathname) {
        case '/v2/account':
          return Response.json(account)
        case '/v2/positions':
          return Response.json([])
        case '/v2/orders': {
          if (init?.method !== 'POST') return Response.json([])
          const order = await new Response(init.body).json()
          posts.push(order)
          return Response.json({ ...order, id: '12345678-1234-4234-8123-000000000009', status: 'accepted' })
        }
        case '/v2/calendar':
          return Response.json(calendar.map((date) => ({ date, open: '09:30', close: '16:00' })))
        case '/v2/clock':
          return Response.json({
            is_open: false,
            timestamp: utcInstantFromEpochMillis(now),
            next_open: utcInstantFromEpochMillis(nyTime(executionSession, '09:30')),
          })
        case '/v2/stocks/bars':
          return Response.json({
            bars:
              url.searchParams.get('adjustment') === 'raw'
                ? Object.fromEntries(rawSizingBars.map(({ symbol, bar }) => [symbol, [bar]]))
                : adjusted,
            next_page_token: null,
          })
        default:
          throw new Error('Unexpected fixture route')
      }
    },
    { preconnect: fetch.preconnect },
  )
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      return yield* runDailySleeves([
        '--manifest',
        manifest,
        '--output',
        output,
        '--confirm-paper-submit',
        ...(proof === undefined ? [] : ['--canary-evidence', evidencePath]),
      ])
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
              CANARY_ALPACA_KEY_ID: 'test-api-key',
              CANARY_ALPACA_SECRET_KEY: 'test-api-secret',
            }),
          ),
        ),
      ),
    ),
  )
  return { exit, posts, receipt: JSON.parse(await readFile(output, 'utf8')) as unknown }
}

test('O1 requires exact adjusted history and reconciled account evidence, then uses the production signal and planner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bayn-w11a-canary-'))
  try {
    const noProof = await run(dir, 'no-proof', undefined, SleeveMode.PaperSubmit)
    expect(Exit.isFailure(noProof.exit)).toBe(true)
    expect(noProof.posts).toEqual([])
    expect(noProof.receipt).toMatchObject({
      sleeves: [
        { error: { code: 'UnverifiedCanaryAdjustments', cause: { marketSha256, signalSession, executionSession } } },
      ],
    })

    const stale = await run(
      dir,
      'stale',
      { ...evidence, accounts: [{ ...evidence.accounts[0], snapshotSha256: 'a'.repeat(64) }] },
      SleeveMode.PaperSubmit,
    )
    expect(Exit.isFailure(stale.exit)).toBe(true)
    expect(stale.posts).toEqual([])
    expect(stale.receipt).toMatchObject({
      sleeves: [{ error: { code: 'UnverifiedCanaryAccountEvidence', cause: { snapshotSha256 } } }],
    })

    const shadow = await run(dir, 'shadow', evidence, SleeveMode.Shadow)
    expect(shadow.posts).toEqual([])
    if (Exit.isFailure(shadow.exit)) throw new Error(JSON.stringify(shadow.receipt))
    const expected = Result.getOrThrow(compileMacroCanaryEtfSignal(defaultMacroCanaryEtfPolicy, fixture))
    expect(shadow.receipt).toMatchObject({
      sleeves: [{ disposition: 'shadow', plan: { receipt: { target: expected, marketSha256, phase: 'increase' } } }],
    })
    expect(shadow.exit.value.aggregateTargetExposure.targetCentsBySymbol['QQQ']).toBeGreaterThan(0)
    const paper = await run(dir, 'paper', evidence, SleeveMode.PaperSubmit)
    if (Exit.isFailure(paper.exit)) throw new Error(JSON.stringify(paper.receipt))
    expect(paper.posts.length).toBeGreaterThan(0)
    expect(paper.posts).toEqual(expect.arrayContaining([expect.objectContaining({ time_in_force: 'opg' })]))
    expect(paper.receipt).toMatchObject({ sleeves: [{ disposition: 'submitted' }] })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)
