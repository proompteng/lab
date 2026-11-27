import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem } from 'effect'

import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import { intradayAlphaDefinition } from '../src/strategy/intraday-alpha/policy'
import { regularCalendarReplayInput } from './midday-research-data'
import { sum } from './midday-research-statistics'
import { holdoutEnd, researchStep, sha256, Sleeve4ResearchError, split } from './sleeve4-data'
import { runIntradayAlphaReplayVerification as replay } from './verify-intraday-alpha-replay'

const calendarName = 'calendar_2024_2026.json'
const minuteName = 'alpaca_sip_1m_rth_bayn21_20240102_20261125.tsv.gz'
const manifestSha256 = '5df0cfe213c69e9a6489dde46553db610edb2632b5e54fb76a6347740abcdead'
const calendarSha256 = 'b7a02f0c79aa479de2eba14e6168826cabaf8eef15df4c94cf1f199511752b71'
const compressedSha256 = 'ab163eae8f0c3bc1433d2de31a3a1c6a2e404829408068b9e201f564df4ad4a2'
const rawSha256 = '633184eed156a02dd0b97b0ce2ed1f0366312a33bde430eb83a99fbdd8bb3863'
const expectedRows = 6_491_892
const policyHash = 'f632170473534577a59a98c800bca69917b710c3857a68d0c52ec776ebcdd509'
const phases = [
  IntradayAlphaPhase.MorningOrb,
  IntradayAlphaPhase.MiddayReversion,
  IntradayAlphaPhase.NoiseAreaTrend,
] as const

export const partitionMonths = (raw: Buffer, expected: number) => {
  const byMonth = new Map<string, Buffer[]>()
  let monthOfSpan: string | undefined
  let spanStart = 0
  let rows = 0
  const add = (month: string, start: number, end: number) => {
    const parts = byMonth.get(month) ?? []
    parts.push(raw.subarray(start, end))
    byMonth.set(month, parts)
  }
  for (let start = 0; start < raw.length; ) {
    const newline = raw.indexOf(10, start)
    const end = newline < 0 ? raw.length : newline + 1
    const tab = raw.indexOf(9, start)
    if (tab < start || tab + 21 >= end || raw[tab + 11] !== 84) {
      throw new Error(`Malformed minute timestamp at row ${rows + 1}`)
    }
    const month = raw.toString('ascii', tab + 1, tab + 8)
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error(`Invalid month at row ${rows + 1}`)
    if (month !== monthOfSpan) {
      if (monthOfSpan !== undefined) add(monthOfSpan, spanStart, start)
      spanStart = start
      monthOfSpan = month
    }
    rows++
    start = end
  }
  if (monthOfSpan !== undefined) add(monthOfSpan, spanStart, raw.length)
  if (rows !== expected) throw new Error(`Pinned tape row count differs: ${rows} != ${expected}`)
  return byMonth
}

type ReplayDay = ReturnType<typeof replay>['results'][number]['sessionDetails'][number]
type ReferenceRow = ReturnType<typeof dailyReference>

export const dailyReference = (
  day: Pick<
    ReplayDay,
    | 'date'
    | 'baselineAvailable'
    | 'benchmarkAvailable'
    | 'baselineMissingSymbols'
    | 'missingConcurrentMarkWindows'
    | 'unresolvedExits'
  > & { readonly trades: readonly { phase: IntradayAlphaPhase; netPnlUsd: number }[] },
  startingCapitalUsd: number,
) => {
  const deficiencies = [
    ...(!day.baselineAvailable ? ['NO_BASELINE'] : []),
    ...(day.baselineMissingSymbols.length > 0 ? ['PARTIAL_BASELINE'] : []),
    ...(!day.benchmarkAvailable ? ['BENCHMARK_GAP'] : []),
    ...(day.missingConcurrentMarkWindows > 0 ? ['COHELD_MARK_GAP'] : []),
    ...(day.unresolvedExits.length > 0 ? ['UNRESOLVED_EXIT'] : []),
  ]
  const net =
    deficiencies.length > 0
      ? null
      : phases.map(
          (phase) =>
            (10_000 * sum(day.trades.filter((trade) => trade.phase === phase).map((trade) => trade.netPnlUsd))) /
            startingCapitalUsd,
        )
  const traded = net === null ? null : phases.map((phase) => day.trades.some((trade) => trade.phase === phase))
  return { date: day.date, deficiencies, net, traded }
}

const coverage = (rows: readonly ReferenceRow[]) =>
  Object.fromEntries(
    (['train', 'validation', 'holdout'] as const).map((part) => {
      const days = rows.filter((day) => split(day.date) === part)
      const complete = days.filter((day) => day.net !== null)
      return [
        part,
        {
          days: days.length,
          complete: complete.length,
          tradedByEngine: phases.map((_, i) => complete.filter((day) => day.traded?.[i] === true).length),
          withNonzeroVarianceByEngine: phases.map((_, i) => new Set(complete.map((day) => day.net?.[i])).size > 1),
        },
      ]
    }),
  )

export const makeWindows = (months: readonly string[], cutoff: string) => {
  const result = []
  const ordered = [...new Set(months)].sort()
  const lookbackDays = Math.max(35, intradayAlphaDefinition.trailingBaseline.lookbackSessions * 3)
  for (let offset = 0; offset < ordered.length; offset += 3) {
    const startMonth = ordered[offset]
    const endMonth = ordered[Math.min(ordered.length - 1, offset + 2)]
    if (startMonth === undefined || endMonth === undefined) throw new Error('Window bounds are missing')
    const start = `${startMonth}-01`
    const warmupFloor = new Date(Date.parse(start) - lookbackDays * 86_400_000).toISOString().slice(0, 10)
    const sliceEnd = new Date(Date.parse(`${endMonth}-01`) + 32 * 86_400_000).toISOString().slice(0, 7)
    const endOfMonth = new Date(Date.parse(`${sliceEnd}-01`) - 86_400_000).toISOString().slice(0, 10)
    const end = endOfMonth < cutoff ? endOfMonth : cutoff
    result.push({ start, end, months: ordered.filter((m) => m >= warmupFloor.slice(0, 7) && m <= endMonth) })
  }
  return result
}

const validateSha = (name: string, bytes: Uint8Array, expected: string) => {
  if (sha256(bytes) !== expected) throw new Error(`Pinned digest mismatch for ${name}`)
  return bytes
}

const stage = (source: string, workspace: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const manifest = yield* fs.readFile(join(source, 'MANIFEST.json'))
    yield* researchStep('Verify SIP manifest', () => validateSha('MANIFEST.json', manifest, manifestSha256))
    const compressed = yield* fs.readFile(join(source, minuteName))
    const partitions = yield* researchStep('Split the verified SIP tape by month', () => {
      const raw = gunzipSync(validateSha(minuteName, compressed, compressedSha256))
      validateSha('raw SIP minute bars', raw, rawSha256)
      return partitionMonths(raw, expectedRows)
    })
    for (const [month, parts] of partitions) yield* fs.writeFile(join(workspace, `${month}.tsv`), Buffer.concat(parts))
    return [...partitions.keys()]
  })

const run = (args: readonly string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const [source, output] = args
      if (args.length !== 2 || source === undefined || output === undefined) {
        return yield* new Sleeve4ResearchError({
          operation: 'Parse arguments',
          cause:
            'Usage: bun services/bayn/tools/research-sleeve4-sip-reference.ts <verified input directory> <new output JSON>',
        })
      }
      const fs = yield* FileSystem.FileSystem
      const calendarBytes = yield* fs.readFile(join(source, calendarName))
      const calendar = yield* researchStep('Verify and normalize the Wave 1 calendar', () =>
        regularCalendarReplayInput(
          JSON.parse(Buffer.from(validateSha(calendarName, calendarBytes, calendarSha256)).toString()) as unknown,
        ),
      )
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-sleeve4-sip-' })
      const months = yield* stage(source, workspace)
      const verifierSource = yield* fs.readFile(join(import.meta.dir, 'verify-intraday-alpha-replay.ts'))
      const rowsByCost = new Map<number, ReferenceRow[]>()
      for (const window of makeWindows(months, holdoutEnd)) {
        const first = window.months[0]
        if (first === undefined)
          return yield* new Sleeve4ResearchError({ operation: 'Replay SIP window', cause: 'No input partitions' })
        const windowInput = {
          query: { start: `${first}-01`, end: window.end },
          response: calendar.response.filter(({ date }) => date >= `${first}-01` && date <= window.end),
        }
        const reference = yield* researchStep(`Replay SIP window ${window.start} through ${window.end}`, () => {
          const receipt = replay(
            window.months.map((month) => join(workspace, `${month}.tsv`)),
            windowInput,
            {
              evaluationStart: window.start,
            },
          )
          if (receipt.policyHash !== policyHash) throw new Error('Unexpected v2 policy identity')
          return receipt.results.map(({ slippageBps, sessionDetails }) => ({
            slippageBps,
            rows: sessionDetails.map((day) => dailyReference(day, receipt.assumptions.startingCapitalUsd)),
          }))
        })
        for (const { slippageBps, rows } of reference) {
          const previous = rowsByCost.get(slippageBps) ?? []
          previous.push(...rows)
          rowsByCost.set(slippageBps, previous)
        }
      }
      if (rowsByCost.size !== 3 || [2, 5, 10].some((cost) => !rowsByCost.has(cost))) {
        return yield* new Sleeve4ResearchError({
          operation: 'Verify replay costs',
          cause: 'Expected exactly 2, 5 and 10 bp results',
        })
      }
      const dates = calendar.response.filter((day) => day.date <= holdoutEnd).map(({ date }) => date)
      const results = yield* researchStep('Reconcile every benchmark day against the frozen calendar', () =>
        [...rowsByCost].map(([slippageBps, rows]) => {
          if (rows.length !== dates.length || rows.some((day, i) => day.date !== dates[i])) {
            throw new Error(`Missing, duplicated or unordered daily reference at ${slippageBps} bp`)
          }
          return { slippageBps, coverage: coverage(rows), rows }
        }),
      )
      const receipt = {
        schemaVersion: 'bayn.sleeve4.sip-reference.v1',
        evidenceClass: 'RETROSPECTIVE_SIP_BAR_SCENARIO',
        policyHash,
        verifierSha256: sha256(verifierSource),
        sources: { manifestSha256, calendarSha256, compressedSha256, rawSha256, expectedRows },
        metric: 'Engine daily additive modeled net basis points on replay starting equity; null on incomplete days',
        engineOrder: phases,
        results,
      }
      yield* fs.writeFileString(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
    }),
  )

if (import.meta.main) {
  NodeRuntime.runMain(
    run(process.argv.slice(2)).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- the standalone research CLI owns scoped local input files
      Effect.provide(NodeServices.layer),
    ),
  )
}
