import { writeFileSync } from 'node:fs'

import { intradayAlphaDefinition } from '../src/strategy/intraday-alpha/policy'
import {
  checkpoints,
  evaluationEnd,
  evaluationStart,
  readFrozenMiddayTape,
  type Session,
  symbols,
  warmupStart,
} from './midday-research-data'
import {
  type Collar,
  type Cost,
  type DayResult,
  executeBasket,
  noTrade,
  type Protection,
  type Sizing,
  startingCapitalUsd,
} from './midday-research-execution'
import {
  adjacentJumpBps,
  prepareSignalHistory,
  residualDispersion,
  type Selection,
  selectMiddayBasket,
  type SignalName,
  type SignalSession,
} from './midday-research-signal'
import {
  dailySharpe,
  deflatedSharpe,
  expectedMaximumSharpe,
  mean,
  quantile,
  sessionEconomics,
  sum,
} from './midday-research-statistics'

interface Trial {
  readonly signal: SignalName
  readonly gateBps: number | null
  readonly collar: Collar
  readonly protection: Protection
  readonly sizing: Sizing
}

const fixedValues = [intradayAlphaDefinition.entryLimitSlippageBps, 15, 20, 25, 35]
const spreadValues = [1, 1.5, 2]
const atrValues = [0.1, 0.15, 0.2]
const gateValues = [40, 60, 80]
const fixedReference: Collar = { family: 'fixed', value: intradayAlphaDefinition.entryLimitSlippageBps }
const spreadCenter: Collar = { family: 'spread', value: 1.5 }
const atrCenter: Collar = { family: 'atr', value: 0.15 }
const baseline: Trial = {
  signal: 'v2',
  gateBps: null,
  collar: fixedReference,
  protection: 'independent',
  sizing: 'equal-dollar',
}
const costs: readonly Cost[] = [2, 5, 10, 'IEX']
const qualificationCosts = new Set<Cost>([5, 10, 'IEX'])
const trialId = ({ signal, gateBps, collar, protection, sizing }: Trial) =>
  [signal, gateBps ?? 'ungated', `${collar.family}-${collar.value}`, protection, sizing].join('/')

export const trialGrid = () => {
  const grid = new Map<string, Trial>()
  const add = (trial: Trial) => grid.set(trialId(trial), trial)
  const collars: Collar[] = [
    ...fixedValues.map((value): Collar => ({ family: 'fixed', value })),
    ...spreadValues.map((value): Collar => ({ family: 'spread', value })),
    ...atrValues.map((value): Collar => ({ family: 'atr', value })),
  ]
  for (const collar of [...collars.filter(({ family }) => family === 'fixed'), spreadCenter, atrCenter])
    add({ ...baseline, collar })

  const signals: Trial['signal'][] = ['v2', 'beta14', 'beta20', 'beta-z', 'median', 'semi', 'dispersion']
  for (const signal of signals) {
    for (const gateBps of signal === 'dispersion' ? gateValues : [null]) {
      add({ ...baseline, signal, gateBps })
      add({ signal, gateBps, collar: spreadCenter, protection: 'flatten', sizing: 'beta-dollar' })
    }
  }
  for (const protection of ['flatten', 'requote'] as const) {
    for (const collar of collars) add({ signal: 'beta-z', gateBps: null, collar, protection, sizing: 'beta-dollar' })
    add({ signal: 'beta-z', gateBps: null, collar: spreadCenter, protection, sizing: 'equal-dollar' })
  }
  return [...grid.values()]
}

const adjacentValues = (values: readonly number[], center: number) => {
  const index = values.indexOf(center)
  return index > 0 && index + 1 < values.length
    ? values.slice(index - 1, index + 2).filter((value) => value !== center)
    : []
}

const neighbors = (trial: Trial) => {
  const values =
    trial.collar.family === 'fixed' ? fixedValues : trial.collar.family === 'spread' ? spreadValues : atrValues
  return [
    adjacentValues(values, trial.collar.value).map((value) =>
      trialId({ ...trial, collar: { ...trial.collar, value } }),
    ),
    trial.gateBps === null
      ? []
      : adjacentValues(gateValues, trial.gateBps).map((gateBps) => trialId({ ...trial, gateBps })),
  ].filter((group) => group.length === 2)
}

const executionDiagnostics = (sessions: readonly Session[]) =>
  symbols
    .filter((symbol) => symbol !== 'SPY')
    .map((symbol) => {
      const medians: number[] = []
      const p75: number[] = []
      const lastSpreads: number[] = []
      const jumps: number[] = []
      for (const session of sessions) {
        const tape = session.tapes.get(symbol)
        for (
          let minute = checkpoints.entryStartMinuteFromOpen;
          minute <= checkpoints.entryEndMinuteFromOpen;
          minute++
        ) {
          const quote = tape?.quotes.get(minute)
          if (quote !== undefined) {
            medians.push(quote.medianBps)
            p75.push(quote.p75Bps)
            lastSpreads.push((20_000 * (quote.lastAsk - quote.lastBid)) / (quote.lastAsk + quote.lastBid))
          }
          const bar = tape?.bars.get(minute)
          const next = tape?.bars.get(minute + 1)
          if (bar !== undefined && next !== undefined) jumps.push(adjacentJumpBps(bar, next))
        }
      }
      return {
        symbol,
        possibleMinutes:
          sessions.length * (checkpoints.entryEndMinuteFromOpen - checkpoints.entryStartMinuteFromOpen + 1),
        quoteMinutes: medians.length,
        adjacentOpenMinutes: jumps.length,
        medianMinuteMedianSpreadBps: quantile(medians, 0.5),
        p90MinuteMedianSpreadBps: quantile(medians, 0.9),
        medianMinuteP75SpreadBps: quantile(p75, 0.5),
        p90LastSpreadBps: quantile(lastSpreads, 0.9),
        medianCloseToNextOpenBps: quantile(jumps, 0.5),
        p90AbsCloseToNextOpenBps: quantile(jumps.map(Math.abs), 0.9),
      }
    })

const distribution = (values: readonly number[]) => ({
  count: values.length,
  mean: values.length > 0 ? mean(values) : null,
  max: values.length > 0 ? Math.max(...values) : null,
})

const aggregateExecution = (days: readonly DayResult[]) => {
  const selected = days.filter((day) => day.selected > 0)
  const partial = days.filter((day) => day.filled > 0 && day.filled < day.selected)
  const count = (predicate: (day: DayResult) => boolean) => days.filter(predicate).length
  const total = (value: (day: DayResult) => number) => sum(days.map(value))
  return {
    selectedBaskets: selected.length,
    fourLegIntendedBaskets: count((day) => day.selected === 4),
    fourLegCompleteBaskets: count((day) => day.filled === 4),
    fourLegCompleteRate: count((day) => day.filled === 4) / days.length,
    initialFourLegCompleteBaskets: count((day) => day.initialFilled === 4),
    partialBaskets: partial.length,
    oneSidedBasketsBeforeProtection: count((day) => day.initialOneSided),
    oneSidedBasketsAfterProtection: count((day) => day.oneSided),
    noSignalDays: count((day) => day.status === 'no-signal'),
    legsMissingExecutionMinuteEvidence: total((day) => day.noEntryEvidence),
    legsNotPlaced: total((day) => day.entriesUnavailable),
    filledLegs: total((day) => day.filled),
    flattenedOrphanLegs: total((day) => day.flattenCount),
    rescuedLegs: total((day) => day.rescueCount),
    unresolvedOrphans: total((day) => day.unresolvedOrphans),
    maxOrphanExitDelayMinutes: Math.max(...days.map((day) => day.maxOrphanExitDelayMinutes)),
    residualBeforeProtectionUsd: distribution(selected.map((day) => day.initialResidualUsd)),
    partialBasketResidualAfterProtectionUsd: distribution(partial.map((day) => day.residualUsd)),
    residualAfterProtectionUsd: distribution(selected.map((day) => day.residualUsd)),
    betaResidualAfterProtectionUsd: distribution(
      selected.flatMap((day) => (day.betaResidualUsd === null ? [] : [day.betaResidualUsd])),
    ),
    orphanNotionalAfterProtectionUsd: distribution(days.map((day) => day.orphanUsd)),
    peakDirectionalBoundUsd: distribution(selected.map((day) => day.peakDirectionalBoundUsd)),
    peakSinglePairLegUsd: distribution(selected.map((day) => day.peakPairOrphanUsd)),
    peakSinglePairLegBetaUsd: distribution(
      selected.flatMap((day) => (day.peakPairOrphanBetaUsd === null ? [] : [day.peakPairOrphanBetaUsd])),
    ),
    modeledExecutionCostUsd: total((day) => day.executionCostUsd),
    modeledSellFeesUsd: total((day) => day.modeledFeesUsd),
    entryAdverseMarkoutUsd: days.some((day) => day.adverseMarkoutUsd !== null)
      ? total((day) => day.adverseMarkoutUsd ?? 0)
      : null,
    entryAdverseMarkoutDays: count((day) => day.adverseMarkoutUsd !== null),
  }
}

type PlannedDay =
  | { readonly session: Session; readonly selection: Selection; readonly minute: number }
  | { readonly status: 'no-signal' | 'benchmark-unavailable' | 'baseline-unavailable' }

const planDays = (
  history: readonly SignalSession[],
  trial: Trial,
  omitted: string | undefined,
): readonly PlannedDay[] =>
  history.flatMap<PlannedDay>(({ session, checkpoints: points, baselineAvailable }, index) => {
    if (session.date < evaluationStart) return []
    if (!baselineAvailable) return [{ status: 'baseline-unavailable' }]
    for (const [offset, point] of points.entries()) {
      if (point.benchmarkDevBps === undefined) return [{ status: 'benchmark-unavailable' }]
      const preceding =
        trial.gateBps === null
          ? []
          : history.slice(Math.max(0, index - 14), index).flatMap((prior) => {
              const previous = prior.checkpoints[offset]
              if (previous === undefined) return []
              const iqr = residualDispersion(previous, omitted)
              return iqr === null ? [] : [iqr]
            })
      const selection = selectMiddayBasket({
        point,
        signal: trial.signal,
        omitted,
        requireBeta: trial.sizing === 'beta-dollar',
        allowSingle: trial.protection === 'independent',
        gateBps: trial.gateBps,
        priorDispersion: preceding.length < 10 ? null : quantile(preceding, 0.5),
      })
      if (selection.groups.length > 0) return [{ session, selection, minute: point.minute }]
    }
    return [{ status: 'no-signal' }]
  })

const scoreDays = (planned: readonly PlannedDay[], trial: Trial, cost: Cost) =>
  planned.map((day) => ('status' in day ? noTrade(day.status) : executeBasket({ ...day, ...trial, cost })))

const scoreTrial = (history: readonly SignalSession[], trial: Trial, equities: readonly string[]) => {
  const planned = planDays(history, trial, undefined)
  const omittedPlans = equities.map((symbol) => ({ symbol, days: planDays(history, trial, symbol) }))
  return {
    trial,
    id: trialId(trial),
    scenarios: costs.map((cost) => {
      const days = scoreDays(planned, trial, cost)
      const daily = days.map(({ netUsd }) => netUsd)
      const loso = omittedPlans.map(({ symbol, days: plannedWithout }) => {
        const values = scoreDays(plannedWithout, trial, cost)
        const unresolvedDays = values.filter(({ netUsd }) => netUsd === null).length
        return {
          omitted: symbol,
          netUsd: unresolvedDays > 0 ? null : sum(values.map(({ netUsd }) => netUsd ?? 0)),
          unresolvedDays,
        }
      })
      const worst = loso.some(({ netUsd }) => netUsd === null)
        ? null
        : (loso.toSorted((left, right) => (left.netUsd ?? 0) - (right.netUsd ?? 0))[0] ?? null)
      return {
        cost,
        ...sessionEconomics(daily),
        execution: aggregateExecution(days),
        dailyNetUsd: daily,
        unresolved: days.flatMap((day, index) =>
          day.netUsd === null ? [{ sessionIndex: index, reason: day.status, symbols: day.unresolvedExitSymbols }] : [],
        ),
        loso,
        worstLoso: worst,
      }
    }),
  }
}

type Scored = ReturnType<typeof scoreTrial>
type Scenario = Scored['scenarios'][number] & { readonly deflatedSharpe: number | null }
type TrialResult = Omit<Scored, 'scenarios'> & { readonly scenarios: readonly Scenario[] }

const withDeflatedSharpe = (scored: readonly Scored[]) => {
  const sharpes = scored.flatMap(({ scenarios }) =>
    scenarios.flatMap(({ dailyNetUsd }) => {
      const complete = dailyNetUsd.filter((daily) => daily !== null)
      if (complete.length !== dailyNetUsd.length) return []
      const sr = dailySharpe(complete)
      return sr === null ? [] : [sr]
    }),
  )
  const benchmark = expectedMaximumSharpe(sharpes)
  return {
    trialCount: scored.reduce((total, row) => total + row.scenarios.length, 0),
    finiteSharpeTrials: sharpes.length,
    expectedMaximumDailySharpe: benchmark,
    results: scored.map(
      ({ scenarios, ...row }): TrialResult => ({
        ...row,
        scenarios: scenarios.map((scenario) => {
          const complete = scenario.dailyNetUsd.filter((daily) => daily !== null)
          return {
            ...scenario,
            deflatedSharpe:
              complete.length === scenario.dailyNetUsd.length ? deflatedSharpe(complete, benchmark) : null,
          }
        }),
      }),
    ),
  }
}

const positive = (value: number | null | undefined) => value !== null && value !== undefined && value > 0
const gating = (candidate: TrialResult, reference: TrialResult) => {
  const eligible =
    candidate.trial.signal !== 'v2' &&
    candidate.trial.sizing === 'beta-dollar' &&
    candidate.trial.protection !== 'independent'
  const perCost = candidate.scenarios.map((scenario, index) => {
    const control = reference.scenarios[index]
    const drift = scenario.execution.betaResidualAfterProtectionUsd
    const baselineDrift = control?.execution.betaResidualAfterProtectionUsd
    const gates = {
      resolved: scenario.unresolved.length === 0,
      fourLegCompletion: scenario.execution.fourLegCompleteRate >= 0.75,
      noOrphans: scenario.execution.orphanNotionalAfterProtectionUsd.max === 0,
      ...(qualificationCosts.has(scenario.cost)
        ? {
            positiveNet: positive(scenario.netUsd),
            positiveExTop5: positive(scenario.exTop5Usd),
            positiveFolds: scenario.foldNetUsd.every(positive),
            positiveLoso: positive(scenario.worstLoso?.netUsd),
            bootstrap: scenario.bootstrapPValue !== null && scenario.bootstrapPValue <= 0.05,
            dsr: scenario.deflatedSharpe !== null && scenario.deflatedSharpe >= 0.95,
            improvesExTop5:
              scenario.exTop5Usd !== null && control?.exTop5Usd != null && scenario.exTop5Usd > control.exTop5Usd,
            noWorseBetaDrift:
              drift.count === scenario.execution.selectedBaskets &&
              drift.mean !== null &&
              baselineDrift?.mean != null &&
              drift.mean <= baselineDrift.mean,
          }
        : {}),
    }
    return { cost: scenario.cost, gates, passes: Object.values(gates).every(Boolean) }
  })
  return { eligible, perCost, passes: eligible && perCost.every(({ passes }) => passes) }
}

const plateauAssessment = (results: readonly TrialResult[]) => {
  const reference = results.find(({ id }) => id === trialId(baseline))
  if (reference === undefined) throw new Error('Missing baseline trial')
  const byId = new Map(results.map((row) => [row.id, { row, gate: gating(row, reference) }]))
  return results.map((row) => {
    const gate = gating(row, reference)
    const plateau = neighbors(row.trial).map((pair) => ({
      neighbors: pair.map((id) => {
        const match = byId.get(id)
        const retainsEightyPercent = row.scenarios
          .filter(({ cost }) => qualificationCosts.has(cost))
          .every(({ cost, exTop5Usd }) => {
            const neighborNet = match?.row.scenarios.find((scenario) => scenario.cost === cost)?.exTop5Usd
            return exTop5Usd !== null && exTop5Usd > 0 && neighborNet != null && neighborNet >= 0.8 * exTop5Usd
          })
        return { id, tested: match !== undefined, passesCoreGates: match?.gate.passes ?? false, retainsEightyPercent }
      }),
    }))
    return {
      ...row,
      gate,
      plateau,
      qualifies:
        gate.passes &&
        plateau.some(({ neighbors: adjacent }) =>
          adjacent.every((neighbor) => neighbor.passesCoreGates && neighbor.retainsEightyPercent),
        ),
    }
  })
}

export const runMiddayBetaNeutralResearch = (directory: string) => {
  const { sessions, sources } = readFrozenMiddayTape(directory)
  const history = prepareSignalHistory(sessions)
  const evaluation = sessions.filter(({ date }) => date >= evaluationStart)
  const equities = symbols.filter((symbol) => symbol !== 'SPY')
  const scored = trialGrid().map((trial) => scoreTrial(history, trial, equities))
  const { results, ...multipleTesting } = withDeflatedSharpe(scored)
  const trials = plateauAssessment(results)
  return {
    schemaVersion: 'bayn.midday-beta-neutral-research.v1',
    sources,
    startingCapitalUsd,
    warmupStart,
    evaluationStart,
    evaluationEnd,
    sessions: evaluation.map(({ date }) => date),
    multipleTesting,
    diagnostics: executionDiagnostics(evaluation),
    reference: trialId(baseline),
    qualifiedIds: trials.filter(({ qualifies }) => qualifies).map(({ id }) => id),
    trials,
  }
}

if (import.meta.main) {
  const [directory, output, ...rest] = process.argv.slice(2)
  if (directory === undefined || output === undefined || rest.length > 0)
    throw new Error('Usage: bun services/bayn/tools/research-midday-beta-neutral.ts <dataset-directory> <results.json>')
  writeFileSync(output, JSON.stringify(runMiddayBetaNeutralResearch(directory), null, 2) + '\n', { flag: 'wx' })
}
