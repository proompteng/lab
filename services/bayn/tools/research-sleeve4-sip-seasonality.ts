import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem } from 'effect'

import { decodeRegularCalendar, minuteMs } from './midday-research-data'
import { mean } from './midday-research-statistics'
import { readVerifiedSip } from './research-sleeve4-sip-reference'
import { researchStep, sha256, Sleeve4ResearchError, split, validationEnd } from './sleeve4-data'
import {
  bySplit,
  costGrid,
  costs,
  developmentPass,
  dsr,
  dsrThreshold,
  type Fill,
  type Outcome,
} from './sleeve4-evaluation'
import { trialRegistry, type Leg } from './sleeve4-signals'

const groups = [
  ['AMD', 'AVGO', 'COHR', 'INTC', 'LITE', 'MRVL', 'MU', 'WDC'],
  ['GOOGL', 'META', 'MSFT', 'NFLX', 'TSLA'],
] as const
const symbols = new Set<string>(groups.flat())
const lookbacks = [1, 5, 10, 20] as const
const entries = [30, 180, 300, 330] as const
const tails = [1, 2] as const
const thresholds = [0, 20] as const
const duration = 30
export const sameClockRegistry = entries.flatMap((entry) =>
  lookbacks.flatMap((lookback) =>
    tails.flatMap((tail) =>
      thresholds.map((minimumSpread) => ({
        id: `same-clock.${entry}.${lookback}.${tail}.${minimumSpread}`,
        entry,
        lookback,
        tail,
        minimumSpread,
      })),
    ),
  ),
)
type Rule = (typeof sameClockRegistry)[number]
export interface OpenTape {
  readonly date: string
  readonly minutes: number
  // Zero marks unobserved, never an executed price.
  readonly prices: ReadonlyMap<string, Float64Array>
}
const price = (day: OpenTape, symbol: string, minute: number) => {
  const value = day.prices.get(symbol)?.[minute]
  return value === undefined || value <= 0 ? null : value
}

export const sameClockDecision = (prior: readonly OpenTape[], rule: Rule) => {
  const recent = prior.slice(-rule.lookback)
  if (recent.length < rule.lookback) return { observed: false, legs: [] }
  const ranked = groups.map((group) =>
    group
      .flatMap((symbol) => {
        const returns = recent.flatMap((day) => {
          const from = price(day, symbol, rule.entry)
          const to = price(day, symbol, rule.entry + duration)
          return from === null || to === null ? [] : [10_000 * (to / from - 1)]
        })
        return returns.length === recent.length ? [{ symbol, score: mean(returns) }] : []
      })
      .sort((a, b) => a.score - b.score || a.symbol.localeCompare(b.symbol)),
  )
  if (ranked.some((items, i) => items.length < Math.ceil(0.8 * (groups[i]?.length ?? 0)))) {
    return { observed: false, legs: [] }
  }
  const legs: Leg[] = []
  for (const items of ranked) {
    const low = items.slice(0, rule.tail)
    const high = items.slice(-rule.tail)
    if (mean(high.map(({ score }) => score)) - mean(low.map(({ score }) => score)) <= rule.minimumSpread) continue
    const weight = 0.5 / (groups.length * rule.tail)
    legs.push(...low.map(({ symbol }) => ({ symbol, side: -1, weight })))
    legs.push(...high.map(({ symbol }) => ({ symbol, side: 1, weight })))
  }
  return { observed: true, legs }
}

export const sameClockOutcomes = (days: readonly OpenTape[], rule: Rule): Outcome[] => {
  const prior: OpenTape[] = []
  return days.map((day) => {
    if (day.minutes !== 390) return { date: day.date, observed: true, intended: 0, fills: [] }
    const decision = sameClockDecision(prior, rule)
    prior.push(day)
    const fills = decision.legs.flatMap((leg): Fill[] => {
      const entry = price(day, leg.symbol, rule.entry)
      if (entry === null) return []
      const exitMinute = rule.entry + duration
      for (let minute = exitMinute; minute < day.minutes; minute++) {
        const exit = price(day, leg.symbol, minute)
        if (exit !== null) return [{ leg, entry, exit, delay: minute - exitMinute }]
      }
      return [{ leg, entry, exit: null, delay: null }]
    })
    return { date: day.date, observed: decision.observed, intended: decision.legs.length, fills }
  })
}

const decodeDevelopmentTapes = (raw: Buffer, calendar: unknown, expectedRows: number): readonly OpenTape[] => {
  const dates = new Map(
    decodeRegularCalendar(calendar)
      .providerSessions.filter(({ date }) => date <= validationEnd)
      .map(({ date, regularOpenAt, regularCloseAt }) => {
        const open = Date.parse(regularOpenAt)
        const minutes = (Date.parse(regularCloseAt) - open) / minuteMs
        return [date, { date, open, minutes, prices: new Map<string, Float64Array>() }] as const
      }),
  )
  let rows = 0
  for (let start = 0; start < raw.length; ) {
    const newline = raw.indexOf(10, start)
    const end = newline < 0 ? raw.length : newline + 1
    const tab = raw.indexOf(9, start)
    if (tab < start || tab + 21 >= end || raw[tab + 11] !== 84)
      throw new Error(`Invalid timestamp column at row ${rows + 1}`)
    const symbol = raw.toString('ascii', start, tab)
    const date = raw.toString('ascii', tab + 1, tab + 11)
    rows++
    start = end
    if (date > validationEnd || !symbols.has(symbol)) continue
    const tape = dates.get(date)
    const first = raw.indexOf(9, tab + 1)
    const second = raw.indexOf(9, first + 1)
    const timestamp = Date.parse(raw.toString('ascii', tab + 1, first))
    if (
      tape === undefined ||
      first <= tab ||
      second <= first ||
      second >= end ||
      !Number.isFinite(timestamp) ||
      timestamp % minuteMs !== 0
    )
      throw new Error(`Invalid development price row ${rows}`)
    const minute = (timestamp - tape.open) / minuteMs
    if (minute < 0 || minute >= tape.minutes) continue
    const open = Number(raw.toString('ascii', first + 1, second))
    if (!Number.isFinite(open) || open <= 0) throw new Error(`Invalid development open at row ${rows}`)
    const prices = tape.prices.get(symbol) ?? new Float64Array(tape.minutes)
    if (prices[minute] !== 0) throw new Error(`Duplicate development price at row ${rows}`)
    prices[minute] = open
    tape.prices.set(symbol, prices)
  }
  if (rows !== expectedRows) throw new Error('Pinned research tape row count changed')
  return [...dates.values()]
}

const adjacent = (a: Rule, b: Rule) =>
  a.entry === b.entry &&
  Math.abs(lookbacks.indexOf(a.lookback) - lookbacks.indexOf(b.lookback)) +
    Math.abs(tails.indexOf(a.tail) - tails.indexOf(b.tail)) +
    Math.abs(thresholds.indexOf(a.minimumSpread) - thresholds.indexOf(b.minimumSpread)) ===
    1

const develop = (tapes: readonly OpenTape[]) => {
  const totalTrials = trialRegistry.length + sameClockRegistry.length
  const grid = sameClockRegistry.map((rule) => {
    const outcomes = bySplit(sameClockOutcomes(tapes, rule))
    const train = costGrid(outcomes.train)
    const validation = costGrid(outcomes.validation)
    return {
      rule,
      validationDays: outcomes.validation,
      train,
      validation,
      economicPass: developmentPass(train, validation),
    }
  })
  const hurdles = costs.map((cost) => ({
    cost,
    nullSharpe: dsrThreshold(
      grid.map(({ validation }) => validation[cost]?.dailySharpe ?? null),
      tapes.filter((tape) => split(tape.date) === 'validation').length,
      totalTrials,
    ),
  }))
  const trials = grid.map(({ validationDays, ...item }) => {
    const neighbors = grid.filter(({ rule }) => adjacent(rule, item.rule))
    const viable = neighbors.filter(({ economicPass }) => economicPass).map(({ rule }) => rule.id)
    const plateau = viable.length >= 2 && viable.length * 2 >= neighbors.length
    return {
      ...item,
      adjacentEconomicPasses: viable,
      plateau,
      qualified: item.economicPass && plateau,
      validationDsr: hurdles.map(({ cost, nullSharpe }) => ({
        cost,
        probability: dsr(validationDays, cost, nullSharpe),
      })),
    }
  })
  const selected = trials
    .filter(({ qualified }) => qualified)
    .sort(
      (a, b) =>
        (b.validation[10]?.exTop5Bps ?? -Infinity) - (a.validation[10]?.exTop5Bps ?? -Infinity) ||
        a.rule.id.localeCompare(b.rule.id),
    )[0]
  return { totalTrials, hurdles, selected: selected?.rule.id ?? null, trials }
}

const run = (args: readonly string[]) =>
  Effect.gen(function* () {
    const [source, output] = args
    if (args.length !== 2 || source === undefined || output === undefined) {
      return yield* new Sleeve4ResearchError({
        operation: 'Parse arguments',
        cause:
          'Usage: bun services/bayn/tools/research-sleeve4-sip-seasonality.ts <verified input directory> <new output JSON>',
      })
    }
    const fs = yield* FileSystem.FileSystem
    const { tapes, sources } = yield* Effect.gen(function* () {
      const data = yield* readVerifiedSip(source)
      const tapes = yield* researchStep('Decode SIP training and validation opens', () =>
        decodeDevelopmentTapes(data.raw, data.calendar, data.sources.expectedRows),
      )
      return { tapes, sources: data.sources }
    })
    const result = {
      schemaVersion: 'bayn.sleeve4.sip-seasonality-development.v1',
      qualification: 'DEVELOPMENT_ONLY',
      sources,
      registrySha256: sha256(JSON.stringify(sameClockRegistry)),
      cohorts: { groups, duration, developmentCutoff: validationEnd, holdoutOpened: false },
      ...develop(tapes),
    }
    yield* fs.writeFileString(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  })

if (import.meta.main) {
  NodeRuntime.runMain(
    run(process.argv.slice(2)).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- the standalone research CLI owns local input files
      Effect.provide(NodeServices.layer),
    ),
  )
}
