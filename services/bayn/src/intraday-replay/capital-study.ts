import { Effect, FileSystem, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevPurpose } from '../jev/portfolio'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { observedQuoteAt } from '../market-data/streaming/projection'
import { Sha256Schema, SourceRevisionSchema, StrictNonEmptyStringSchema, strictParseOptions } from '../schemas'
import {
  capitalAblationDefinition,
  capitalEvents,
  capitalNetDifference,
  CapitalArm,
  CapitalEventKind,
  CapitalTermsSchema,
  createCapitalState,
  finishCapitalState,
  markCapitalState,
  stepCapitalState,
  validateCapitalPopulation,
  type CapitalOpportunity,
  type CapitalTerms,
} from './capital-ablation'
import { MatchedRegistrationSchema, MatchedStudyInputSchema, runMatchedEntryStudy } from './matched-entry-study'
import { prepareSignalStudyBatch, SignalScreenRule, SignalStudyFailure } from './signal-study'
import { openBacktestSource, validateBacktestSourceReceipt, type BacktestSourceManifest } from './source'

export const CapitalStudyInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.capital-study-input.v1'),
  sources: Schema.Array(
    Schema.Struct({
      matched: MatchedStudyInputSchema,
      registration: MatchedRegistrationSchema,
      arrivalsPath: StrictNonEmptyStringSchema,
      receiptPath: StrictNonEmptyStringSchema,
      receiptSha256: Sha256Schema,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
  capital: CapitalTermsSchema,
  evaluatorSourceRevision: SourceRevisionSchema,
})

export const runCapitalStudy = (raw: unknown) =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(CapitalStudyInputSchema, strictParseOptions)(raw)
    const fs = yield* FileSystem.FileSystem
    // Each market retains its existing native inventory, calendar, source, timing and decision verification.
    // Independently verified source cursors then feed ONE portfolio per arm, across both markets.
    const datasets = yield* Effect.forEach(input.sources, (dataset) =>
      Effect.gen(function* () {
        const receipt = yield* Effect.fromResult(
          validateBacktestSourceReceipt(yield* fs.readFileString(dataset.receiptPath), dataset.receiptSha256),
        )
        const matched = yield* runMatchedEntryStudy(
          dataset.matched,
          dataset.registration,
          dataset.arrivalsPath,
          receipt,
        )
        const source = yield* openBacktestSource(
          dataset.arrivalsPath,
          dataset.matched.study.source,
          dataset.matched.study.runId,
          receipt,
        )
        const opportunities: CapitalOpportunity[] = []
        for (const retained of dataset.matched.study.batches) {
          const batch = yield* Effect.fromResult(prepareSignalStudyBatch(retained))
          if (batch.observation.portfolio.purpose !== JevPurpose.Entry) continue
          const pair = matched.pairs.find((value) => value.batchId === batch.plan.batchId)
          if (pair === undefined)
            return yield* new SignalStudyFailure({ message: 'Validated matched opportunity is missing' })
          const timing = dataset.matched.timings.find((entry) => entry.batchId === pair.batchId)?.witness
          const cost = dataset.matched.costs.find((entry) => entry.batchId === pair.batchId)
          opportunities.push({
            batch,
            committedAtMs: timing == null ? null : Date.parse(timing.decisionCommittedAt),
            inferenceCostMicros: pair.inferenceCostMicros,
            operatingCostMicros: pair.sharedOperatingCostMicros,
            knownInferenceCostMicros: cost?.inference?.costMicros ?? '0',
            knownOperatingCostMicros: cost?.sharedOperating?.costMicros ?? '0',
          })
        }
        return { dataset, receipt, matched, source, opportunities, manifest: dataset.matched.study.source }
      }),
    )
    const { contexts, startMs, endMs, protocolHash } = yield* replayCapitalSources(input.capital, datasets)
    const evidenceComplete = datasets.every((dataset) => dataset.matched.summary.completion === 'COMPLETE')
    const report = {
      schemaVersion: 'bayn.capital-study.v1',
      classification: 'DEVELOPMENT_SCENARIO',
      definition: capitalAblationDefinition,
      definitionHash: yield* Effect.fromResult(canonicalHashV1Result(capitalAblationDefinition)),
      protocolHash,
      protocolVersion: defaultJevProtocolDocument.schemaVersion,
      inputDefinition: defaultJevProtocolDocument.inputDefinition,
      registeredSourceRevisions: datasets.map((context) => context.dataset.registration.sourceRevision),
      evaluatorSourceRevision: input.evaluatorSourceRevision,
      inputHash: yield* Effect.fromResult(canonicalHashV1Result(input)),
      capital: input.capital,
      evidenceComplete,
      datasets: datasets.map((context) => ({
        matchedReportHash: context.matched.reportHash,
        sourceReceiptHash: context.receipt.contentHash,
        inheritedEvidenceAssessment: context.matched.summary,
        population: context.matched.observations,
      })),
      scenarios: yield* Effect.forEach(contexts, ({ scenario, states }) =>
        Effect.gen(function* () {
          const arms = [...states.values()].map(finishCapitalState)
          const opportunityHashes = yield* Effect.forEach(arms, (a) =>
            Effect.fromResult(canonicalHashV1Result(a.eligibleOpportunityIds)).pipe(
              Effect.map((hash) => ({ arm: a.arm, hash })),
            ),
          )
          if (new Set(opportunityHashes.map((a) => a.hash)).size !== 1)
            return yield* new SignalStudyFailure({ message: 'Capital arms consumed different eligible populations' })
          const hours = (endMs - startMs) / 3_600_000
          return {
            scenario,
            arms: arms.map((arm) => ({
              ...arm,
              metrics: {
                ...arm.metrics,
                filledEntriesPerElapsedHour: hours <= 0 ? null : arm.metrics.filledEntries / hours,
                admittedOpportunityFraction:
                  arm.metrics.opportunities === 0 ? null : arm.metrics.admitted / arm.metrics.opportunities,
              },
            })),
            eligibleOpportunityIdsHash: opportunityHashes,
            candidateMinusBaselineNetMicros: capitalNetDifference(evidenceComplete, arms),
          }
        }),
      ),
    }
    return { ...report, reportHash: yield* Effect.fromResult(canonicalHashV1Result(report)) }
  })

export const replayCapitalSources = (
  capital: CapitalTerms,
  datasets: readonly {
    readonly manifest: BacktestSourceManifest
    readonly source: Effect.Success<ReturnType<typeof openBacktestSource>>
    readonly opportunities: readonly CapitalOpportunity[]
  }[],
) =>
  Effect.gen(function* () {
    const symbols = datasets.flatMap((context) => context.manifest.marketSources.flatMap((source) => source.symbols))
    if (new Set(symbols).size !== symbols.length)
      return yield* new SignalStudyFailure({
        message: 'Capital source universes must be disjoint; duplicated records cannot fund two portfolios',
      })
    const opportunities = datasets.flatMap((context) => context.opportunities)
    const protocolHash = yield* Effect.fromResult(validateCapitalPopulation(opportunities, capital))
    const contexts = yield* Effect.forEach(capital.scenarios, (scenario) =>
      Effect.gen(function* () {
        const states = new Map(
          yield* Effect.forEach(Object.values(CapitalArm), (arm) =>
            Effect.fromResult(createCapitalState(arm, capital.openingCashMicros)).pipe(
              Effect.map((state) => [arm, state] as const),
            ),
          ),
        )
        return { scenario, states }
      }),
    )
    const startMs = Math.min(...datasets.map((context) => context.manifest.coverageStartMs))
    const endMs = Math.max(...datasets.map((context) => context.manifest.coverageEndMs))
    const events = contexts
      .flatMap((context) => capitalEvents(opportunities, context.scenario, endMs).map((event) => ({ context, event })))
      .sort((a, b) => a.event.atMs - b.event.atMs)
    for (const { context, event } of events) {
      const projections = yield* Effect.forEach(datasets, (dataset) =>
        Effect.gen(function* () {
          const manifest = dataset.manifest
          if (event.atMs < manifest.coverageStartMs || event.atMs > manifest.coverageEndMs) return null
          yield* dataset.source.advanceTo(event.atMs)
          return {
            symbols: manifest.marketSources.flatMap((source) => source.symbols),
            projection: (yield* dataset.source.cursor).projection,
          }
        }),
      )
      const quoteAt = (symbol: string | null | undefined) => {
        if (symbol == null) return undefined
        const source = projections.find((projection) => projection?.symbols.includes(symbol))
        return source == null ? undefined : observedQuoteAt(source.projection, symbol, event.atMs)
      }
      for (const [arm, state] of context.states) {
        const selected = event.opportunity.batch.selected[SignalScreenRule.Jev]
        const symbol = event.kind === CapitalEventKind.Opportunity ? selected : state.active?.terms.symbol
        const stepped = yield* Effect.fromResult(
          stepCapitalState(
            state,
            capital,
            context.scenario,
            event,
            quoteAt(symbol),
            quoteAt(state.portfolio.ledger.positions[0]?.symbol),
          ),
        )
        context.states.set(
          arm,
          yield* Effect.fromResult(
            markCapitalState(stepped, event.atMs, quoteAt(stepped.portfolio.ledger.positions[0]?.symbol)),
          ),
        )
      }
    }
    for (const dataset of datasets) yield* dataset.source.finish
    return { contexts, startMs, endMs, protocolHash }
  })
