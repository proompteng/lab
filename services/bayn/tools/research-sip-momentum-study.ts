import { deflationBenchmark, pearson } from './research-orb-zab-statistics'
import {
  comboTrials,
  costs,
  neighbors,
  sleeveTrials,
  stocks,
  universes,
  type Noise,
  type Orb,
  type Trial,
} from './research-sip-momentum-protocol'
import { leaveOut, netAt, replay, type Daily, type PreparedDay, type Scenario } from './research-sip-momentum-replay'
import {
  basic,
  blockP,
  bootstrap,
  coverage,
  coverageColumns,
  developmentWindows,
  gateCosts,
  halfYears,
  known,
  metricColumns,
  metrics,
  windowOrder,
  windows,
} from './research-sip-momentum-statistics'

const medianGate = 0.5
const neighborPassFraction = 0.75
const pThreshold = 0.05
const requiredPositiveHalfYears = 5

type Window = ReturnType<typeof windows>[number]
const slice = <T>(values: readonly T[], window: Window): readonly T[] => values.slice(window.first, window.end)
type GateRow = ReturnType<typeof basic>
type GateMetrics = readonly GateRow[]
type GateTable = ReadonlyMap<string, GateMetrics>
const positive = (value: number | null) => value !== null && value > 0
const economic = (row: GateRow) => positive(row.net) && positive(row.exTop5)

const gateMetrics = (daily: readonly Daily[]): GateMetrics => gateCosts.map((bps) => basic(daily, bps))

const plateau = (trial: Trial, table: GateTable) => {
  const adjacent =
    trial.engine === 'combo'
      ? comboTrials(trial.orb, trial.noise).filter(
          (other) => other.id !== trial.id && Math.abs(trial.orbWeight - other.orbWeight) === 0.25,
        )
      : neighbors(trial)
  const center = table.get(trial.id)
  const passing = adjacent
    .filter((other) => {
      const neighbor = table.get(other.id)
      return (
        center !== undefined &&
        neighbor !== undefined &&
        neighbor.every((row, index) => {
          const own = center[index].exTop5
          return economic(row) && row.exTop5 !== null && own !== null && row.exTop5 >= own * medianGate
        })
      )
    })
    .map((other) => other.id)
  return {
    neighbors: adjacent.map((other) => other.id),
    passing,
    pass: adjacent.length >= 2 && passing.length >= Math.ceil(adjacent.length * neighborPassFraction),
  }
}

const gate = (trial: Trial, table: GateTable) => {
  const rows = table.get(trial.id)
  if (rows === undefined) throw new Error(`No metrics for ${trial.id}`)
  const perCost = rows.map((row, i) => ({
    bps: gateCosts[i],
    net: row.net,
    exTop5: row.exTop5,
    blockP: row.complete ? blockP(row.values) : null,
  }))
  const stability = plateau(trial, table)
  return {
    perCost,
    plateau: stability,
    pass:
      stability.pass &&
      perCost.every(
        (row) => positive(row.net) && positive(row.exTop5) && row.blockP !== null && row.blockP < pThreshold,
      ),
  }
}

const select = <T extends Noise | Orb>(options: readonly T[], table: GateTable) => {
  const sharpe = (trial: T) => table.get(trial.id)?.[1].dailySharpe ?? Number.NEGATIVE_INFINITY
  const sorted = options.toSorted((a, b) => sharpe(b) - sharpe(a) || a.id.localeCompare(b.id, 'en'))
  const selected = sorted.find((trial) => {
    const rows = table.get(trial.id)
    return rows !== undefined && rows.every(economic) && plateau(trial, table).pass && gate(trial, table).pass
  })
  const trial = selected ?? sorted[0]
  if (trial === undefined) throw new Error('Empty candidate registry')
  return { trial, diagnostic: selected === undefined }
}

export const development = (days: readonly PreparedDay[]) => {
  const spans = windows(
    days.map((day) => day.date),
    developmentWindows,
  )
  const train = new Map<string, GateMetrics>()
  const validation = new Map<string, GateMetrics>()
  const addTrial = (trial: Trial) => {
    const daily = replay(days, trial, false).map((entry) => entry.total)
    train.set(trial.id, gateMetrics(slice(daily, spans[0])))
    validation.set(trial.id, gateMetrics(slice(daily, spans[1])))
  }
  for (const trial of sleeveTrials) addTrial(trial)
  const orb = select(
    sleeveTrials.filter((trial) => trial.engine === 'orb'),
    train,
  )
  const noise = select(
    sleeveTrials.filter((trial) => trial.engine === 'noise'),
    train,
  )
  const combos = comboTrials(orb.trial, noise.trial)
  for (const combo of combos) addTrial(combo)
  const balanced = combos.find((combo) => combo.orbWeight === 0.5)
  if (balanced === undefined) throw new Error('Missing balanced portfolio')
  const selected = {
    orb: { ...orb, train: gate(orb.trial, train), validation: gate(orb.trial, validation) },
    noise: { ...noise, train: gate(noise.trial, train), validation: gate(noise.trial, validation) },
    combo: { trial: balanced, diagnostic: false, train: gate(balanced, train), validation: gate(balanced, validation) },
  }
  const trialSharpes = [...train.values()].flatMap((rows) => rows[1].dailySharpe ?? [])
  return {
    registry: {
      orb: sleeveTrials.length - sleeveTrials.filter((t) => t.engine === 'noise').length,
      noise: sleeveTrials.filter((t) => t.engine === 'noise').length,
      combo: combos.length,
    },
    benchmark: {
      nTests: train.size,
      nSharpes: trialSharpes.length,
      expectedMaxDailySharpe: deflationBenchmark(trialSharpes, train.size),
    },
    selected,
  }
}

const losoUniverse = (trial: Trial): readonly string[] =>
  trial.engine === 'orb'
    ? stocks
    : trial.engine === 'noise'
      ? universes[trial.universe]
      : [...stocks, ...universes[trial.noise.universe]]

const loso = (trial: Trial, scenarios: readonly Scenario[], spans: readonly Window[], details: boolean) => {
  // Every enrolled name is evaluated; unchanged paths reuse the baseline from leaveOut.
  const bySymbol = losoUniverse(trial).map((symbol) => {
    const daily = scenarios.map((scenario) => leaveOut(scenario, symbol))
    const rows = spans.map((window) => {
      const days = slice(daily, window)
      if (!days.every(known)) return costs.map(() => null)
      return costs.map((bps) => days.reduce((n, day) => n + netAt(day, bps), 0))
    })
    return { symbol, rows }
  })
  const worst = spans.map((_, index) =>
    costs.map((_, bpsIndex) => {
      let minimum: number | null = null
      let name: string | null = null
      let knownCount = 0
      let positiveCount = 0
      for (const { symbol, rows } of bySymbol) {
        const net = rows[index][bpsIndex]
        if (net === null) continue
        knownCount++
        if (net > 0) positiveCount++
        if (minimum === null || net < minimum) {
          minimum = net
          name = symbol
        }
      }
      return [minimum, name, knownCount, positiveCount]
    }),
  )
  return { worst, bySymbol: details ? bySymbol : undefined }
}

export const score = (days: readonly PreparedDay[], freeze: ReturnType<typeof development>) => {
  const spans = windows(
    days.map((day) => day.date),
    windowOrder,
  )
  const registry = [...sleeveTrials, ...comboTrials(freeze.selected.orb.trial, freeze.selected.noise.trial)]
  const selected = Object.values(freeze.selected)
  const gateTables = spans.map(() => new Map<string, GateMetrics>())
  const chosenDaily = new Map<string, readonly Daily[]>()
  const trials = registry.map((trial) => {
    const scenarios = replay(days, trial, true)
    const daily = scenarios.map((scenario) => scenario.total)
    const keepDetails = selected.some((entry) => entry.trial.id === trial.id)
    if (keepDetails) chosenDaily.set(trial.id, daily)
    const rows = spans.map((window, i) => {
      const period = slice(daily, window)
      gateTables[i].set(
        trial.id,
        gateMetrics(period).map((row) => ({ ...row, values: keepDetails ? row.values : [] })),
      )
      return {
        coverage: coverage(period),
        costs: costs.map((bps) => metrics(period, bps, freeze.benchmark.expectedMaxDailySharpe)),
      }
    })
    return { trial, rows, loso: loso(trial, scenarios, spans, keepDetails) }
  })
  const plateaus = registry.map((trial) => {
    const windows = gateTables.slice(0, 3).map((table) => plateau(trial, table))
    return { id: trial.id, neighbors: windows[0].neighbors, passing: windows.map((window) => window.passing) }
  })
  const qualification = selected.map(({ trial, diagnostic, train, validation }) => {
    const holdout = gate(trial, gateTables[2])
    const positiveHalfYears = halfYears.filter(
      (_, index) => gateTables[index + 3].get(trial.id)?.every((row) => positive(row.net)) ?? false,
    )
    const clears =
      !diagnostic &&
      train.pass &&
      validation.pass &&
      holdout.pass &&
      positiveHalfYears.length >= requiredPositiveHalfYears
    return { id: trial.id, diagnostic, train, validation, holdout, positiveHalfYears, clears }
  })
  const orb = chosenDaily.get(freeze.selected.orb.trial.id)
  const noise = chosenDaily.get(freeze.selected.noise.trial.id)
  if (orb === undefined || noise === undefined) throw new Error('Missing frozen sleeve daily series')
  const correlations = spans.map((window) => {
    const pairs = slice(orb, window).flatMap((row, i) => {
      const other = noise[window.first + i]
      return known(row) && known(other) ? [[row, other] as const] : []
    })
    return {
      sessions: pairs.length,
      pearson: costs.map((bps) =>
        pearson(
          pairs.map(([a]) => netAt(a, bps)),
          pairs.map(([, b]) => netAt(b, bps)),
        ),
      ),
    }
  })
  const allEtfsExTop5 = sleeveTrials.flatMap((trial) =>
    trial.engine !== 'noise' || trial.universe !== 'all'
      ? []
      : [
          {
            id: trial.id,
            positiveHalfYears: halfYears.filter(
              (_, index) => gateTables[index + 3].get(trial.id)?.every((row) => positive(row.exTop5)) ?? false,
            ),
          },
        ],
  )
  return {
    costOrder: costs,
    windowOrder,
    coverageColumns,
    metricColumns,
    losoColumns: ['worstKnownNetUsd', 'worstKnownOmission', 'knownOmissions', 'positiveOmissions'],
    comparison: { allEtfsExTop5, correlations },
    bootstrap,
    qualification,
    plateaus,
    trials,
  }
}

export const precision = (_key: string, value: unknown) =>
  typeof value === 'number' && !Number.isInteger(value) ? Number(value.toFixed(8)) : value

export const canonical = (value: unknown) => JSON.stringify(value)

export const requireFreezeMatch = (observed: unknown, recomputed: unknown) => {
  if (canonical(observed) !== canonical(recomputed))
    throw new Error('Development freeze does not match verified source, data or selection')
}
