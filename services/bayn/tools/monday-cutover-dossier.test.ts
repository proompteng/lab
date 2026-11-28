import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, FileSystem, Layer, Result, Sink, Stdio } from 'effect'
import { TestClock } from 'effect/testing'

import { AccountStatus, AssetClass, OrderStatus, PositionSide } from '../src/broker/alpaca/model'
import { OrderSide } from '../src/execution/contracts'
import { canonicalHashV1Result } from '../src/hash'
import { macroCanaryEtfs } from '../src/strategy/macro-canary-etf/policy'
import { Profile } from '../src/strategy/macro-etf-core/policy'
import { TimeInForce } from './macro-canary-runner/contract'
import { RunnerProfile } from './macro-etf-core-runner/contract'
import { Block, decodeDossierEvidence, DossierDecision, evaluateDossier } from './monday-cutover-dossier-core'
import { runMondayCutoverDossier } from './monday-cutover-dossier'
import {
  AlpacaEndpoint,
  cutoverReport,
  evaluated,
  Phase,
  skipped,
  verifyIntraday,
  verifyMacro,
} from './monday-cutover-verifier'
import {
  CanaryProfile,
  decodeManifest,
  makePortfolioReceipt,
  SleeveMode,
  Strategy,
} from './multi-account-daily-sleeves/contract'
import { HoldReason, RotationPhase } from './weekly-attribution-receipts'

const accounts = {
  intraday: '11111111-1111-4111-8111-111111111111',
  core: '22222222-2222-4222-8222-222222222222',
  canary: '33333333-3333-4333-8333-333333333333',
}
const session = '2026-11-30'
const signalSession = '2026-11-27'
const monday = (time: string) => `${session}T${time}Z`
const asOf = monday('14:30:50.000')
const open = monday('14:30:00.000')
const atOpen = monday('14:30:00.001234567')
const position = { symbol: 'GOOGL', qty: '-103.00', side: PositionSide.Short, asset_class: AssetClass.UsEquity }
const order = { symbol: 'GOOGL', status: OrderStatus.Held, legs: null }
const brokerReport = (phase: Phase, positions: (typeof position)[] = [], orders: (typeof order)[] = []) => {
  const macro = (id: string) => ({
    account: { id, status: AccountStatus.Active, equity: '10000', buying_power: '10000' },
    expectedId: id,
    endpoint: AlpacaEndpoint.Paper,
    positions: [],
  })
  return cutoverReport(phase, {
    intraday: verifyIntraday(
      phase,
      { account: macro(accounts.intraday).account, expectedId: accounts.intraday },
      positions,
      orders,
    ),
    macroAccounts: verifyMacro(macro(accounts.core), macro(accounts.canary)),
    postgres: evaluated({ standby: true, latestObservation: null }, []),
    autoOntology: skipped('not configured'),
  })
}

const hash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))
const sha = 'a'.repeat(64)
const portfolio = ({
  mode = SleeveMode.Shadow,
  observedAt = monday('14:00:00.000'),
  blocked = null as string | null,
  accountId = accounts.canary,
  executionSession = session,
  capitalBudgetUsd = 10_000,
} = {}) => {
  const manifest = Result.getOrThrow(
    decodeManifest(
      JSON.stringify({
        schemaVersion: 'bayn.multi-account-daily-sleeves-config.v1',
        intradayAccountId: accounts.intraday,
        sleeves: [
          {
            sleeveId: 'core',
            accountId: accounts.core,
            strategy: Strategy.MacroEtfCore,
            profile: RunnerProfile.F4,
            credentialsEnvPrefix: 'CORE',
            capitalBudgetUsd,
            mode,
          },
          {
            sleeveId: 'canary',
            accountId,
            strategy: Strategy.MacroCanaryEtf,
            profile: CanaryProfile.O1,
            credentialsEnvPrefix: 'CANARY',
            capitalBudgetUsd,
            mode,
          },
        ],
      }),
      true,
    ),
  )
  const sessions = { signalSession, executionSession }
  const allocation = {
    excludedSymbols: [],
    components: [{ profile: Profile.F4, policyHash: sha, signal: null }],
    targets: null,
  }
  const plan = {
    blocked,
    budgetCents: 1_000_000,
    cashCents: 1_000_000,
    buyingPowerCents: 1_000_000,
    equityCents: 1_000_000,
    managedGrossCents: 0,
    maximumProjectedGrossCents: 0,
    reservedGrossCents: 0,
    buyLimitNotionalCents: 0,
    overnightCapCents: 15_000_000,
    intradayCapCents: 18_000_000,
    remainingIntradayGrossCents: 18_000_000,
    collarBps: 15,
    deadbandBps: 1000,
    rebalanceDue: false,
    reviewDue: false,
    orders: [],
  }
  const coreMaterial = {
    ...sessions,
    schemaVersion: 'bayn.macro-etf-core-next-open-sleeve-receipt.v1',
    broker: 'alpaca-paper',
    profile: RunnerProfile.F4,
    configuredExclusions: [],
    configuredBudgetCents: 1_000_000,
    signalCloseAt: `${signalSession}T18:00:00.000Z`,
    executionOpenAt: `${executionSession}T14:30:00.000Z`,
    tif: TimeInForce.Open,
    barSha256: sha,
    snapshotSha256: sha,
    signalBars: {
      feed: 'sip',
      timeframe: '1Day',
      adjustment: 'all',
      sessions: 253,
      snapshotSha256: sha,
      missingCandidates: [],
    },
    rawSizingBars: { feed: 'sip', timeframe: '1Day', adjustment: 'raw', rows: [] },
    allocation,
    plan,
  }
  const weights = Object.fromEntries(macroCanaryEtfs.map((symbol) => [symbol, symbol === 'SHY' ? 1 : 0]))
  const outcomes = manifest.sleeves.map(({ sleeveId, accountId, capitalBudgetCents, activeSymbols, strategy }) => {
    const canaryMaterial = {
      ...sessions,
      schemaVersion: 'bayn.macro-canary-next-open-sleeve-receipt.v1',
      broker: 'alpaca-paper',
      mode,
      marketSha256: sha,
      snapshotSha256: sha,
      sleeveSha256: hash({ sleeveId, accountId, capitalBudgetCents, activeSymbols }),
      observedAt,
      resumedRotation: null,
      effectiveTargetWeights: weights,
      target: {
        signalSession,
        nextOpenSession: executionSession,
        review: false,
        policyHash: sha,
        targetWeights: weights,
        attribution: {
          canary: { reviewedAt: signalSession, offCount: 0, defensiveBudget: 0, scores: {}, weights },
          trend: { zScores: {}, weights },
          macro: {
            regime: 'DeflationaryCrash',
            credit: 0,
            inflation: 0,
            dollar: 0,
            strongDollar: false,
            unsmoothedWeights: weights,
            weights,
          },
          blendWeights: { canary: 1, trend: 0, macro: 0 },
          ensembleWeights: weights,
          idleShyWeight: 1,
          unsweptCashWeight: 0,
        },
      },
      rawSizingBars: [],
      budgetCents: 1_000_000,
      spendableCents: 1_000_000,
      remainingOneWayTurnoverBps: null,
      phase: RotationPhase.Hold,
      holdReason: HoldReason.OutsideReview,
      orders: [],
    }
    return {
      sleeveId,
      accountId,
      verifiedAccountId: accountId,
      error: null,
      disposition: mode === SleeveMode.Shadow ? 'shadow' : 'no-orders',
      plan: {
        ...sessions,
        targetExposure: null,
        receipt:
          strategy === Strategy.MacroEtfCore
            ? { ...coreMaterial, mode, timestamp: monday('14:00:00.000'), planSha256: hash(coreMaterial) }
            : { ...canaryMaterial, planSha256: hash(canaryMaterial) },
      },
    } as const
  })
  return Result.getOrThrow(makePortfolioReceipt(manifest, outcomes))
}

const reconciliation = {
  id: 'b'.repeat(64),
  positionSnapshotId: 'c'.repeat(64),
  at: monday('14:30:31.000'),
  positionsAt: monday('14:30:30.000'),
  exact: true,
  coversActivity: true,
  positionCount: 0,
}
const fill = {
  id: 'fill-1',
  brokerEventId: 'd'.repeat(64),
  symbol: 'GOOGL',
  side: OrderSide.Buy,
  at: atOpen,
  quantityAtoms: '103000000000',
  accountingReceipt: { id: 'e'.repeat(64), brokerEventId: 'd'.repeat(64), recordedAt: monday('14:30:20.000') },
}
const fixture = () => ({
  schemaVersion: 'bayn.monday-cutover-dossier-evidence.v1',
  preOpen: {
    accountId: accounts.intraday,
    completedAt: monday('14:29:30.000'),
    report: brokerReport(Phase.PreOpen, [position]),
  },
  postFlatten: {
    accounts: { ...accounts },
    startedAt: monday('14:30:45.000'),
    report: brokerReport(Phase.PostFlatten),
  },
  settlement: {
    accountId: accounts.intraday,
    capturedAt: monday('14:30:40.000'),
    openingPositions: [{ symbol: 'GOOGL', quantityAtoms: '-103000000000' }],
    fills: [fill],
    reconciliation,
    nonFlatLedgerSymbols: 0,
  },
  shadowReadiness: portfolio(),
})
const evaluate = (input: unknown, now = asOf) =>
  evaluateDossier(Result.getOrThrow(decodeDossierEvidence(JSON.stringify(input))), now)
const expectHold = (input: unknown, code: Block, now = asOf) => {
  const report = evaluate(input, now)
  expect(report.decision).toBe(DossierDecision.Hold)
  expect(report.blockingReasons.map((reason) => reason.code)).toContain(code)
}

test('only the exact settled opening flatten and both timely F4/O1 shadow plans authorize', () => {
  const input = fixture()
  const report = evaluate(input)
  expect(report).toMatchObject({ decision: DossierDecision.Authorize, session, asOf, blockingReasons: [] })
  expect(evaluate(input)).toEqual(report)
  // An opening fill can arrive as multiple executions; each needs an independently bound receipt.
  expect(
    evaluate({
      ...input,
      settlement: {
        ...input.settlement,
        fills: [
          { ...fill, quantityAtoms: '50000000000' },
          {
            ...fill,
            id: 'fill-2',
            brokerEventId: 'f'.repeat(64),
            quantityAtoms: '53000000000',
            accountingReceipt: { ...fill.accountingReceipt, id: '0'.repeat(64), brokerEventId: 'f'.repeat(64) },
          },
        ],
      },
    }).decision,
  ).toBe(DossierDecision.Authorize)
})

test('holds on a stranded GOOGL, a different position, a working order, or nonflat ledger', () => {
  const input = fixture()
  for (const report of [
    brokerReport(Phase.PostFlatten, [position]),
    brokerReport(Phase.PostFlatten, [{ ...position, symbol: 'QQQ' }]),
    brokerReport(Phase.PostFlatten, [], [order]),
  ])
    expectHold({ ...input, postFlatten: { ...input.postFlatten, report } }, Block.NonFlat)
  expectHold({ ...input, settlement: { ...input.settlement, nonFlatLedgerSymbols: 1 } }, Block.NonFlat)
  expectHold(
    { ...input, settlement: { ...input.settlement, reconciliation: { ...reconciliation, positionCount: 1 } } },
    Block.NonFlat,
  )
})

test('does not infer opening carry from a closing fill or final flat', () => {
  const input = fixture()
  expectHold({ ...input, preOpen: { ...input.preOpen, report: brokerReport(Phase.PreOpen) } }, Block.OpeningCarry)
  expectHold({ ...input, settlement: { ...input.settlement, openingPositions: [] } }, Block.OpeningCarry)
  expectHold(
    { ...input, postFlatten: { ...input.postFlatten, report: brokerReport(Phase.PostCutover) } },
    Block.PostFlattenVerification,
  )
})

test('blocks skipped preflight checks even when the upstream verifier verdict is PASS', () => {
  const input = fixture()
  const pre = input.preOpen.report
  const post = input.postFlatten.report
  expectHold(
    {
      ...input,
      preOpen: {
        ...input.preOpen,
        report: {
          ...pre,
          checks: { ...pre.checks, macroAccounts: { ...skipped('no macro accounts'), blocking: true } },
        },
      },
    },
    Block.PreOpenVerification,
  )
  expectHold(
    {
      ...input,
      postFlatten: {
        ...input.postFlatten,
        report: {
          ...post,
          checks: { ...post.checks, postgres: { ...skipped('no standby'), blocking: true } },
        },
      },
    },
    Block.PostFlattenVerification,
  )
})

test('rejects a partial, wrong-side, wrong-symbol, duplicated, missing, or off-window flatten', () => {
  const input = fixture()
  for (const fills of [
    [],
    [{ ...fill, quantityAtoms: '102000000000' }],
    [{ ...fill, quantityAtoms: '104000000000' }],
    [{ ...fill, side: OrderSide.Sell }],
    [{ ...fill, symbol: 'QQQ' }],
    [{ ...fill, at: monday('14:29:59.999999999') }],
    [{ ...fill, at: monday('14:31:00.000') }],
    [
      { ...fill, quantityAtoms: '50000000000' },
      { ...fill, quantityAtoms: '53000000000' },
    ],
  ])
    expectHold({ ...input, settlement: { ...input.settlement, fills } }, Block.FlattenFill)
})

test('requires exact reconciliation after the fill and an event-bound accounting receipt', () => {
  const input = fixture()
  for (const cut of [
    null,
    { ...reconciliation, exact: false },
    { ...reconciliation, coversActivity: false },
    { ...reconciliation, positionsAt: open },
    { ...reconciliation, positionsAt: null },
    { ...reconciliation, positionsAt: monday('14:30:32.000') },
  ])
    expectHold({ ...input, settlement: { ...input.settlement, reconciliation: cut } }, Block.ReconciliationReceipt)
  for (const accountingReceipt of [
    null,
    { ...fill.accountingReceipt, brokerEventId: 'f'.repeat(64) },
    { ...fill.accountingReceipt, recordedAt: monday('14:30:32.000') },
  ])
    expectHold(
      { ...input, settlement: { ...input.settlement, fills: [{ ...fill, accountingReceipt }] } },
      Block.AccountingReceipt,
    )
})

test('holds on every UUID collision and on mismatched settlement or shadow bindings', () => {
  const input = fixture()
  for (const binding of [
    { ...accounts, core: accounts.intraday },
    { ...accounts, canary: accounts.intraday },
    { ...accounts, canary: accounts.core },
  ])
    expectHold({ ...input, postFlatten: { ...input.postFlatten, accounts: binding } }, Block.AccountCollision)
  expectHold({ ...input, settlement: { ...input.settlement, accountId: accounts.core } }, Block.AccountMismatch)
  expectHold(
    { ...input, shadowReadiness: portfolio({ accountId: '44444444-4444-4444-8444-444444444444' }) },
    Block.AccountMismatch,
  )
})

test('enforces the 60-second snapshot freshness boundary and rejects future or out-of-order cuts', () => {
  const input = fixture()
  expect(evaluate(input, monday('14:31:30.000')).decision).toBe(DossierDecision.Authorize)
  expectHold(input, Block.StaleEvidence, monday('14:31:30.001'))
  expectHold(input, Block.StaleEvidence, monday('14:30:44.999'))
  expectHold(input, Block.StaleEvidence, monday('14:29:59.999'))
  expectHold({ ...input, preOpen: { ...input.preOpen, completedAt: open } }, Block.StaleEvidence)
  expectHold(
    { ...input, postFlatten: { ...input.postFlatten, startedAt: monday('14:30:39.999') } },
    Block.StaleEvidence,
  )
})

test('rejects missing, tampered, wrong-session, late, blocked, non-$10k, and non-shadow portfolio evidence', () => {
  const { shadowReadiness, ...input } = fixture()
  expectHold(input, Block.ShadowReadiness)
  expectHold({ ...input, shadowReadiness: null }, Block.ShadowReadiness)
  for (const receipt of [
    { ...shadowReadiness, portfolioSha256: sha },
    portfolio({ mode: SleeveMode.PaperSubmit }),
    portfolio({ observedAt: monday('14:28:00.000') }),
    portfolio({ blocked: 'working-order' }),
    portfolio({ capitalBudgetUsd: 12_000 }),
    portfolio({ executionSession: '2026-12-01' }),
  ])
    expectHold({ ...input, shadowReadiness: receipt }, Block.ShadowReadiness)
})

test('current-evidence mode checks the clock and never emits account identifiers', async () => {
  const chunks: string[] = []
  const input = JSON.stringify(fixture())
  const layer = Layer.mergeAll(
    FileSystem.layerNoop({ readFileString: () => Effect.succeed(input) }),
    Stdio.layerTest({
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Effect.sync(() => {
            chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
          }),
        ),
    }),
    TestClock.layer(),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(asOf))
      yield* runMondayCutoverDossier(['--evidence', 'unused.json'])
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- isolate local IO and the clock under test
      Effect.provide(layer),
    ),
  )
  const text = chunks.join('')
  expect(JSON.parse(text)).toMatchObject({ asOf, replay: false, decision: DossierDecision.Authorize })
  for (const uuid of Object.values(accounts)) expect(text).not.toContain(uuid)
})

test('CLI emits deterministic replay JSON, exits nonzero on holds, and does not print input errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bayn-dossier-'))
  const path = join(dir, 'evidence.json')
  const run = (instant: string, file = path) =>
    Bun.spawnSync({
      cmd: [
        process.execPath,
        join(import.meta.dir, 'monday-cutover-dossier.ts'),
        '--evidence',
        file,
        '--as-of',
        instant,
      ],
      env: {},
      stdout: 'pipe',
      stderr: 'pipe',
    })
  try {
    await writeFile(path, JSON.stringify(fixture()))
    const pass = run(asOf)
    expect(pass.exitCode).toBe(0)
    expect(JSON.parse(pass.stdout.toString())).toMatchObject({ replay: true, decision: DossierDecision.Authorize })
    expect(run(asOf).stdout.toString()).toBe(pass.stdout.toString())
    const stale = run(monday('14:31:30.001'))
    expect(stale.exitCode).not.toBe(0)
    expect(JSON.parse(stale.stdout.toString())).toMatchObject({ decision: DossierDecision.Hold })
    const missing = run(asOf, join(dir, 'missing.json'))
    expect(missing.exitCode).not.toBe(0)
    expect(JSON.parse(missing.stdout.toString())).toMatchObject({
      blockingReasons: [{ code: Block.EvidenceUnavailable }],
    })
    const marker = 'fixture-private-marker'
    await writeFile(path, JSON.stringify({ ...fixture(), preOpen: { completedAt: marker } }))
    const malformed = run(asOf)
    expect(malformed.exitCode).not.toBe(0)
    expect(JSON.parse(malformed.stdout.toString())).toMatchObject({
      blockingReasons: [{ code: Block.InvalidEvidence }],
    })
    expect(malformed.stdout.toString() + malformed.stderr.toString()).not.toContain(marker)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
