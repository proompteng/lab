import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, Schema } from 'effect'

import {
  firstDate,
  lastDate,
  loadSip,
  readBar,
  summarizeCoverage,
  symbols,
  trainEnd,
  validationEnd,
} from './sip-bayn21-data'
import {
  createReplay,
  liveArchitecture,
  liveIdentity,
  phases,
  simulate,
  type Architecture,
  type Scenario,
} from './sip-bayn21-replay'
import {
  aggregateDay,
  halfYears,
  inPeriod,
  periods,
  summarize,
  type Day,
  type Metrics,
  type Period,
} from './sip-bayn21-statistics'

const evidence = 'docs/bayn/evidence/2026-11-27-3yr-sip-bayn21-v2'
const freezePath = `${evidence}/freeze.json`
const identity = 'bayn.research.wave-2b.v1'
const sleeves = ['ORB', 'MIDDAY', 'NOISE'] as const
const concurrent = 'portfolio' as const
const scopes = [concurrent, ...phases] as const
type Scope = (typeof scopes)[number]
const marketCases = ([1, 2] as const).flatMap((lag) => ([2, 5, 10] as const).map((cost) => ({ lag, cost })))
const liveCollar = 10
const liveStopBuffer = 10

interface Design {
  readonly id: string
  readonly collar: Scenario['collar']
  readonly stopBuffer: Scenario['stopBuffer']
  readonly architecture: Architecture
}

const grid: readonly Design[] = ([10, 15, 20, 25, 35] as const).flatMap((collar) =>
  ([10, 25, 50] as const).map((stopBuffer) => ({
    id: `execution-${collar}-${stopBuffer}`,
    collar,
    stopBuffer,
    architecture: liveArchitecture,
  })),
)
const live = grid[0]

// Predeclared one-factor Midday sensitivities, repeated within each sleeve/sizing
// design. No expansion of the grid in response to development or holdout P&L.
const ablations: readonly Design[] = Array.from({ length: 7 }, (_, index) => {
  const mask = index + 1
  const activeSleeves = phases.filter((_, i) => (mask & (1 << i)) !== 0)
  const label = sleeves.filter((_, i) => (mask & (1 << i)) !== 0).join('+')
  const hasMidday = activeSleeves.includes(phases[1])
  const sizes = hasMidday
    ? (['fixed', 'dispersion', 'volatility', 'both'] as const)
    : (['fixed', 'volatility'] as const)
  const pairsAndBrackets = hasMidday
    ? ([
        [2, 'live'],
        [3, 'live'],
        [2, 300],
        [2, 500],
        [2, 800],
        [2, 'eod'],
      ] as const)
    : ([[2, 'live']] as const)
  return sizes.flatMap((sizing) =>
    pairsAndBrackets.flatMap(([pairs, bracket]) => {
      if (mask === 7 && sizing === 'fixed' && pairs === 2 && bracket === 'live') return []
      return [
        {
          id: `${label}-${sizing}-${pairs}pair-${bracket}`,
          collar: 25 as const,
          stopBuffer: 50 as const,
          architecture: { sleeves: activeSleeves, sizing, pairs, bracket },
        },
      ]
    }),
  )
}).flat()
const developmentDesigns = [...grid, ...ablations]
const caseId = ({ lag, cost }: Pick<Scenario, 'lag' | 'cost'>) => `t+${lag}/${cost}bp`
const primary = caseId({ lag: 2, cost: 5 })
const stress = caseId({ lag: 2, cost: 10 })

type Breakdown = Partial<Record<Period, Metrics>>
type SimulatedCase = {
  readonly scenario: Scenario
  readonly byScope: Map<Scope, Day[]>
  readonly leaveOut: Map<string, Map<Scope, Day[]>>
}
type Input = Awaited<ReturnType<typeof loadSip>>

const simulationCases = (design: Design, exactLosso: boolean) =>
  marketCases.map((market): SimulatedCase => {
    const fullScopes =
      design.collar === liveCollar && design.stopBuffer === liveStopBuffer ? scopes : ([concurrent] as const)
    return {
      scenario: { collar: design.collar, stopBuffer: design.stopBuffer, architecture: design.architecture, ...market },
      byScope: new Map(fullScopes.map((scope) => [scope, []])),
      leaveOut: new Map(
        exactLosso
          ? symbols
              .filter((symbol) => symbol !== 'SPY')
              .map((symbol) => [symbol, new Map(fullScopes.map((scope) => [scope, []]))])
          : [],
      ),
    }
  })

const run = (input: Input, designs: readonly Design[], exactLosso: boolean, signal: AbortSignal) => {
  const replaySession = createReplay(input.calendar)
  const cases = new Map(
    designs.map((design) => [
      design.id,
      simulationCases(design, exactLosso && (design.id === live.id || !grid.some(({ id }) => id === design.id))),
    ]),
  )
  let noBaselineSessions = 0
  let noVolatilitySessions = 0
  let sndkEligibleFrom: string | null = null
  for (const [index, session] of input.sessions.entries()) {
    signal.throwIfAborted()
    const replay = replaySession(session)
    if (!replay.baselineReady) noBaselineSessions++
    if (replay.volatilityScale === null) noVolatilitySessions++
    if (replay.sndkReady && sndkEligibleFrom === null) sndkEligibleFrom = session.date
    for (const group of cases.values())
      for (const { scenario, byScope, leaveOut } of group) {
        const outcome = simulate(replay, scenario)
        for (const [scope, days] of byScope)
          days.push(aggregateDay(session.date, outcome, scope === concurrent ? undefined : scope))
        for (const [symbol, byScope] of leaveOut) {
          const variant = simulate(replay, scenario, symbol)
          for (const [scope, days] of byScope)
            days.push(aggregateDay(session.date, variant, scope === concurrent ? undefined : scope))
        }
      }
    if ((index + 1) % 100 === 0)
      process.stderr.write(`Replayed ${index + 1}/${input.sessions.length} calendar sessions\n`)
  }
  return { cases, readiness: { noBaselineSessions, noVolatilitySessions, sndkEligibleFrom } }
}

type DevelopmentMetrics = Pick<Metrics, 'netUsd' | 'sharpe' | 'exTop5NetUsd' | 'sessions' | 'unresolvedExits'>
const thin = ({ netUsd, sharpe, exTop5NetUsd, sessions, unresolvedExits }: Metrics): DevelopmentMetrics => ({
  netUsd,
  sharpe,
  exTop5NetUsd,
  sessions,
  unresolvedExits,
})

const development = (input: ReturnType<typeof run>['cases']) =>
  developmentDesigns
    .map((design) => {
      const outcomes = input.get(design.id)
      if (outcomes === undefined) throw new Error(`Missing development design ${design.id}`)
      const byCase = Object.fromEntries(
        outcomes.map(({ scenario, byScope }) => {
          const days = byScope.get(concurrent) ?? []
          return [
            caseId(scenario),
            {
              train: thin(
                summarize(
                  days.filter(({ date }) => inPeriod(date, 'train')),
                  scenario.cost,
                  false,
                ),
              ),
              validation: thin(
                summarize(
                  days.filter(({ date }) => inPeriod(date, 'validation')),
                  scenario.cost,
                  false,
                ),
              ),
            },
          ]
        }),
      )
      const train = byCase[primary].train
      const val = byCase[primary].validation
      const pass = [primary, stress].every((key) => positive(byCase[key].train) && positive(byCase[key].validation))
      return {
        design,
        byCase,
        pass,
        worstPrimarySharpe: Math.min(train.sharpe ?? -Infinity, val.sharpe ?? -Infinity),
        validationExTop5: val.exTop5NetUsd,
      }
    })
    .sort(
      (a, b) =>
        Number(b.pass) - Number(a.pass) ||
        b.worstPrimarySharpe - a.worstPrimarySharpe ||
        b.validationExTop5 - a.validationExTop5 ||
        a.design.id.localeCompare(b.design.id),
    )

const positive = (metrics: DevelopmentMetrics) =>
  metrics.netUsd !== null && metrics.netUsd > 0 && metrics.exTop5NetUsd > 0

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const compact = (value: unknown) => `${JSON.stringify(value)}\n`
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' })

const contract = () => {
  // Bind the tool bytes as run (including the shared planner) and the tracked
  // production tree as used. A dirty production tree cannot inherit the receipt.
  if (git('status', '--porcelain', '--', 'services/bayn/src', 'bun.lock') !== '')
    throw new Error('Commit or revert changes to the bound production source and lockfile')
  const tools = [
    'research-3yr-sip-bayn21-v2.ts',
    'sip-bayn21-data.ts',
    'sip-bayn21-replay.ts',
    'sip-bayn21-statistics.ts',
    'verify-intraday-alpha-replay.ts',
  ].map((name) => [name, sha(readFileSync(new URL(name, import.meta.url)))])
  return {
    productionTree: git('rev-parse', 'HEAD:services/bayn/src').trim(),
    lockfileSha256: sha(readFileSync('bun.lock')),
    tools,
  }
}

const receiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal(`${identity}.freeze`),
  sourceHash: Schema.String,
  inputHash: Schema.String,
  nominee: Schema.String,
  developmentPassed: Schema.Boolean,
})

const checkedReceipt = (sourceHash: string) => {
  // Read the default tracked receipt, not a candidate supplied at scoring time.
  const committed = git('show', `HEAD:${freezePath}`)
  if (readFileSync(freezePath, 'utf8') !== committed)
    throw new Error('Freeze receipt does not match the committed file')
  const parsed: unknown = JSON.parse(committed)
  const receipt = Schema.decodeUnknownSync(receiptSchema)(parsed)
  if (receipt.sourceHash !== sourceHash)
    throw new Error('Scoring code or production source differs from the freeze receipt')
  const selected = developmentDesigns.find(({ id }) => id === receipt.nominee)
  if (selected === undefined) throw new Error('Committed nominee lies outside the pre-registered grid')
  return { selected, receipt, freezeSha256: sha(committed) }
}

const summaries = (groups: readonly SimulatedCase[]) =>
  Object.fromEntries(
    groups.map(({ scenario, byScope, leaveOut }) => [
      caseId(scenario),
      Object.fromEntries(
        [...byScope].map(([scope, days]) => {
          const metrics: Breakdown = {}
          const exactLosso: Partial<
            Record<Period, { readonly symbol: string; readonly closedNetUsd: number; readonly unresolvedExits: number }>
          > = {}
          for (const period of periods) {
            metrics[period] = summarize(
              days.filter(({ date }) => inPeriod(date, period)),
              scenario.cost,
              (scenario.collar === liveCollar && scenario.stopBuffer === liveStopBuffer) || leaveOut.size > 0,
            )
            const variants = [...leaveOut].flatMap(([symbol, byScope]) => {
              // Engine attribution is measured inside the combined replay. Omitting
              // another engine's symbol may also affect this engine via timing/headroom.
              const rows = byScope.get(scope)?.filter(({ date }) => inPeriod(date, period)) ?? []
              return [
                {
                  symbol,
                  closedNetUsd: rows.reduce((net, day) => net + day.net, 0),
                  unresolvedExits: rows.reduce((n, day) => n + day.unresolvedExits, 0),
                },
              ]
            })
            const worst = variants.sort(
              (a, b) =>
                b.unresolvedExits - a.unresolvedExits ||
                a.closedNetUsd - b.closedNetUsd ||
                a.symbol.localeCompare(b.symbol),
            )[0]
            if (worst !== undefined) exactLosso[period] = worst
          }
          return [scope, { metrics, exactLosso }]
        }),
      ),
    ]),
  )

const verdict = (base: readonly SimulatedCase[], chosen: readonly SimulatedCase[], developmentPassed: boolean) => {
  const metrics = (groups: readonly SimulatedCase[], key: string, period: Period) => {
    const group = groups.find(({ scenario }) => caseId(scenario) === key)
    if (group === undefined) throw new Error(`Missing scored case ${key}`)
    return summarize(
      (group.byScope.get(concurrent) ?? []).filter(({ date }) => inPeriod(date, period)),
      group.scenario.cost,
      false,
    )
  }
  const score = (period: Period) => metrics(chosen, primary, period)
  const positiveHalfYears = halfYears.filter((period) => {
    const net = score(period).netUsd
    return net !== null && net > 0
  })
  const holdoutPassed = [primary, stress].every((key) => positive(metrics(chosen, key, 'holdout')))
  const beatsLiveInAllStages = (['train', 'validation', 'holdout'] as const).every(
    (period) => (score(period).netUsd ?? -Infinity) > (metrics(base, primary, period).netUsd ?? Infinity),
  )
  return {
    developmentPassed,
    holdoutPassed,
    positiveHalfYears,
    beatsLiveInAllStages,
    passesEconomicGates: developmentPassed && holdoutPassed && positiveHalfYears.length >= 5 && beatsLiveInAllStages,
  }
}

export const argumentsFor = (args: readonly string[]) => {
  const [mode, flag, path] = args
  if (
    (mode !== '--freeze' && mode !== '--score') ||
    (args.length !== 1 &&
      (args.length !== 3 || flag !== '--output' || path === undefined || path === '' || path.startsWith('--')))
  )
    throw new Error(
      'Usage: bun services/bayn/tools/research-3yr-sip-bayn21-v2.ts --freeze|--score [--output <new-file>]',
    )
  return { mode, output: path ?? (mode === '--freeze' ? freezePath : `${evidence}/results.json`) }
}

const runCli = async (signal: AbortSignal) => {
  const { mode, output } = argumentsFor(process.argv.slice(2))
  const source = contract()
  const sourceHash = sha(compact(source))
  const frozen = mode === '--score' ? checkedReceipt(sourceHash) : undefined
  const s3 = new Bun.S3Client({
    endpoint: process.env['AGENTS_ARTIFACTS_ENDPOINT'] || 'http://rook-ceph-rgw-objectstore.rook-ceph.svc:80',
    bucket: process.env['AGENTS_ARTIFACTS_BUCKET'] || 'agents-artifacts',
    region: 'us-east-1',
  })
  const input = await loadSip(s3, frozen === undefined ? validationEnd : lastDate, signal)
  const inputHash = sha(compact(input.inputs))
  const splits = {
    train: [firstDate, trainEnd],
    validation: ['2025-07-01', validationEnd],
    holdout: ['2026-04-01', lastDate],
  }
  const common = { source, sourceHash, inputs: input.inputs, inputHash, liveIdentity, splits, rows: input.rows }
  if (frozen === undefined) {
    const { cases, readiness } = run(input, developmentDesigns, false, signal)
    const ranking = development(cases)
    const best = ranking[0]
    writeFileSync(
      output,
      compact({
        schemaVersion: `${identity}.freeze`,
        ...common,
        readiness,
        coverage: summarizeCoverage(input.sessions),
        nominee: best.design.id,
        developmentPassed: best.pass,
        ranking,
      }),
      { flag: 'wx' },
    )
    return
  }
  if (frozen.receipt.inputHash !== inputHash) throw new Error('Input bytes differ from the freeze receipt')
  const designs = grid.some(({ id }) => id === frozen.selected.id) ? grid : [...grid, frozen.selected]
  const { cases, readiness } = run(input, designs, true, signal)
  const base = cases.get(live.id)
  const chosen = cases.get(frozen.selected.id)
  if (base === undefined || chosen === undefined) throw new Error('Missing required scoring cases')
  const coverage = summarizeCoverage(input.sessions)
  const nvda = (date: string, at: 'open' | 'close') => {
    const session = input.sessions.find((row) => row.date === date)
    return session === undefined
      ? null
      : (readBar(session, 'NVDA', at === 'open' ? 0 : session.minutes - 1)?.[at] ?? null)
  }
  writeFileSync(
    output,
    compact({
      schemaVersion: `${identity}.results`,
      ...common,
      readiness,
      coverage,
      qualification: 'UNQUALIFIED',
      freezeSha256: frozen.freezeSha256,
      nominee: frozen.selected,
      nvdaSplitCheck: { preSplitClose: nvda('2024-06-07', 'close'), postSplitOpen: nvda('2024-06-10', 'open') },
      decision: verdict(base, chosen, frozen.receipt.developmentPassed),
      studies: designs.map((design) => ({ design, byCase: summaries(cases.get(design.id) ?? []) })),
    }),
    { flag: 'wx' },
  )
}

class Wave2BResearchError extends Data.TaggedError('Wave2BResearchError')<{
  readonly message: string
  readonly cause: unknown
}> {}

if (import.meta.main) {
  // Resolve the evidence paths and git identity from the checkout root.
  process.chdir(fileURLToPath(new URL('../../../', import.meta.url)))
  NodeRuntime.runMain(
    Effect.tryPromise({ try: runCli, catch: (cause) => new Wave2BResearchError({ message: String(cause), cause }) }),
  )
}
