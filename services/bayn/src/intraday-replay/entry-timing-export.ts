import { Buffer } from 'node:buffer'
import { Data, Effect, FileSystem, Option, Path, Result, Schema } from 'effect'

import { canonicalHashV1Result, sha256 } from '../hash'
import { intradayInstantNanos } from '../market-data/intraday/time'
import { ExecutionDecisionDocumentSchema } from '../shadow-decision-contract'
import { nativeWallClock, utcInstantFromEpochMillisResult } from '../time'
import {
  Sha256Schema,
  SourceRevisionSchema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import { EntryTimingReceiptSchema } from './entry-timing'
import { prepareSignalStudyBatch, SignalScreenRule } from './signal-study'

export class EntryTimingExportFailure extends Data.TaggedError('EntryTimingExportFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const entryTimingMaximumInputBytes = 16 * 1024 * 1024
const maximumSpans = 10_000
const nanosPerMillisecond = 1_000_000n
const maximumTimestampNanos = 253_402_300_799_999_999_999n
const fail = (message: string) => Result.fail(new EntryTimingExportFailure({ message }))

const tempoId = (bytes: number) =>
  Schema.String.check(
    Schema.makeFilter(
      (value) => {
        if (value.length !== Math.ceil(bytes / 3) * 4) return false
        const decoded = Buffer.from(value, 'base64')
        return decoded.length === bytes && decoded.toString('base64') === value && decoded.some((byte) => byte !== 0)
      },
      { expected: `a canonical nonzero ${bytes}-byte Tempo protobuf base64 identifier` },
    ),
  )

enum TempoSpanKind {
  Unspecified = 'SPAN_KIND_UNSPECIFIED',
  Internal = 'SPAN_KIND_INTERNAL',
  Server = 'SPAN_KIND_SERVER',
  Client = 'SPAN_KIND_CLIENT',
  Producer = 'SPAN_KIND_PRODUCER',
  Consumer = 'SPAN_KIND_CONSUMER',
}
enum TempoStatusCode {
  Unset = 'STATUS_CODE_UNSET',
  Ok = 'STATUS_CODE_OK',
  Error = 'STATUS_CODE_ERROR',
}
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const UnixNanos = Schema.String.check(
  Schema.makeFilter(
    (value) => value.length <= 21 && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= maximumTimestampNanos,
    { expected: 'UTC nanoseconds through year 9999' },
  ),
)
const Attribute = Schema.Struct({
  key: StrictNonEmptyStringSchema,
  value: Schema.Record(Schema.String, Schema.Unknown),
})
const Attributes = Schema.Array(Attribute).check(Schema.isMaxLength(1024))
const TempoSpan = Schema.Struct({
  traceId: tempoId(16),
  spanId: tempoId(8),
  parentSpanId: Schema.optionalKey(tempoId(8)),
  traceState: Schema.optionalKey(Schema.String),
  flags: Schema.optionalKey(Count),
  name: StrictNonEmptyStringSchema,
  kind: Schema.Enum(TempoSpanKind),
  startTimeUnixNano: UnixNanos,
  endTimeUnixNano: UnixNanos,
  attributes: Schema.optionalKey(Attributes),
  droppedAttributesCount: Schema.optionalKey(Count),
  events: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
  droppedEventsCount: Schema.optionalKey(Count),
  links: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
  droppedLinksCount: Schema.optionalKey(Count),
  status: Schema.Struct({
    code: Schema.optionalKey(Schema.Enum(TempoStatusCode)),
    message: Schema.optionalKey(Schema.String),
  }),
})

// Tempo's query JSON uses protobuf base64 IDs, string enums and a `batches` envelope.
// It is deliberately not the different OTLP/JSON ingestion wire contract.
const TempoTrace = Schema.Struct({
  batches: Schema.Array(
    Schema.Struct({
      resource: Schema.Struct({ attributes: Attributes, droppedAttributesCount: Schema.optionalKey(Count) }),
      scopeSpans: Schema.Array(
        Schema.Struct({
          scope: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
          spans: Schema.Array(TempoSpan).check(Schema.isMaxLength(maximumSpans)),
          schemaUrl: Schema.optionalKey(Schema.String),
        }),
      ),
      schemaUrl: Schema.optionalKey(Schema.String),
    }),
  ),
})
type Span = typeof TempoSpan.Type
type Resource = typeof Attributes.Type
type RetainedSpan = { readonly span: Span; readonly resource: Resource }

const attribute = (attributes: Resource | undefined, key: string) =>
  attributes?.find((entry) => entry.key === key)?.value
const stringAttribute = (attributes: Resource | undefined, key: string) =>
  Schema.decodeUnknownResult(
    Schema.Struct({ stringValue: StrictNonEmptyStringSchema }),
    strictParseOptions,
  )(attribute(attributes, key)).pipe(Result.map((value) => value.stringValue))
const booleanAttribute = (attributes: Resource | undefined, key: string) =>
  Schema.decodeUnknownResult(
    Schema.Struct({ boolValue: Schema.Boolean }),
    strictParseOptions,
  )(attribute(attributes, key)).pipe(Result.map((value) => value.boolValue))
const hasString = (attributes: Resource | undefined, key: string, expected: string) => {
  const value = stringAttribute(attributes, key)
  return Result.isSuccess(value) && value.success === expected
}
const unique = (spans: readonly RetainedSpan[], message: string) =>
  spans.length === 1 && spans[0] !== undefined ? Result.succeed(spans[0]) : fail(message)
const spanKey = (span: Pick<Span, 'traceId' | 'spanId'>) => `${span.traceId}:${span.spanId}`
const childOf = (child: Span, parent: Span) => child.traceId === parent.traceId && child.parentSpanId === parent.spanId
const containedBy = (child: Span, parent: Span) =>
  BigInt(child.startTimeUnixNano) >= BigInt(parent.startTimeUnixNano) &&
  BigInt(child.endTimeUnixNano) <= BigInt(parent.endTimeUnixNano)
const retainedSpan = ({ span }: RetainedSpan) => ({
  name: span.name,
  traceId: span.traceId,
  spanId: span.spanId,
  parentSpanId: span.parentSpanId ?? null,
  startTimeUnixNano: span.startTimeUnixNano,
  endTimeUnixNano: span.endTimeUnixNano,
})
const nativeWallInterval = ({ span }: RetainedSpan) =>
  Result.gen(function* () {
    if (!hasString(span.attributes, 'bayn.native_wall.clock', nativeWallClock))
      return yield* fail('Native timing requires the explicit millisecond clock')
    const startedAt = yield* Schema.decodeUnknownResult(UtcInstantSchema)(
      yield* stringAttribute(span.attributes, 'bayn.native_wall.started_at'),
    )
    const finishedAt = yield* Schema.decodeUnknownResult(UtcInstantSchema)(
      yield* stringAttribute(span.attributes, 'bayn.native_wall.finished_at'),
    )
    const start = intradayInstantNanos(startedAt)
    const end = intradayInstantNanos(finishedAt)
    if (end < start || start % nanosPerMillisecond !== 0n || end % nanosPerMillisecond !== 0n)
      return yield* fail('Native wall interval is reversed or is not millisecond precision')
    return { clock: nativeWallClock, startedAt, finishedAt, start, end }
  })
const retainedWallInterval = (interval: { readonly startedAt: string; readonly finishedAt: string }) => ({
  clock: nativeWallClock,
  startedAt: interval.startedAt,
  finishedAt: interval.finishedAt,
})

export const buildEntryTimingExport = (input: {
  readonly traceBytes: Uint8Array
  readonly traceSha256: string
  readonly decisionBytes: Uint8Array
  readonly decisionSha256: string
  readonly sourceRevision: string
}) =>
  Result.gen(function* () {
    yield* Schema.decodeUnknownResult(
      Schema.Struct({
        traceSha256: Sha256Schema,
        decisionSha256: Sha256Schema,
        sourceRevision: SourceRevisionSchema,
      }),
      strictParseOptions,
    )({ traceSha256: input.traceSha256, decisionSha256: input.decisionSha256, sourceRevision: input.sourceRevision })
    if (
      input.traceBytes.length > entryTimingMaximumInputBytes ||
      input.decisionBytes.length > entryTimingMaximumInputBytes
    )
      return yield* fail('Entry timing input exceeded its 16 MiB byte bound')
    if (sha256(input.traceBytes) !== input.traceSha256 || sha256(input.decisionBytes) !== input.decisionSha256)
      return yield* fail('Entry timing input SHA-256 differs')
    const text = (bytes: Uint8Array) =>
      Result.try({
        try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        catch: (cause) => new EntryTimingExportFailure({ message: 'Entry timing input is not valid UTF-8', cause }),
      })
    const trace = yield* Schema.decodeUnknownResult(
      Schema.fromJsonString(TempoTrace),
      strictParseOptions,
    )(yield* text(input.traceBytes))
    const decision = yield* Schema.decodeUnknownResult(
      Schema.fromJsonString(ExecutionDecisionDocumentSchema),
      strictParseOptions,
    )(yield* text(input.decisionBytes))
    const target = decision.strategyDecision
    if (target?.schemaVersion !== 'bayn.jev-entry-target.v6')
      return yield* fail('Timing requires the current native committed Jev entry decision')
    const batch = yield* prepareSignalStudyBatch({
      observation: target.evidence.observation,
      batchPlan: target.evidence.batchPlan,
      batchResult: target.evidence.batchResult,
    })
    const spans = trace.batches.flatMap(({ resource, scopeSpans }) =>
      scopeSpans.flatMap(({ spans }) => spans.map((span) => ({ span, resource: resource.attributes }))),
    )
    if (spans.length > maximumSpans) return yield* fail('Entry timing trace exceeded its 10000-span bound')
    const byId = new Map<string, RetainedSpan>()
    for (const value of spans) {
      const key = spanKey(value.span)
      if (byId.has(key)) return yield* fail('Tempo trace contains duplicate span identities')
      if (value.span.parentSpanId === value.span.spanId) return yield* fail('Tempo span cannot parent itself')
      if (BigInt(value.span.endTimeUnixNano) < BigInt(value.span.startTimeUnixNano))
        return yield* fail('Tempo span clock moved backwards')
      for (const attributes of [value.resource, value.span.attributes ?? []])
        if (new Set(attributes.map(({ key }) => key)).size !== attributes.length)
          return yield* fail('Tempo trace contains duplicate attribute keys')
      byId.set(key, value)
    }
    const batchMatches = ({ span }: RetainedSpan) =>
      hasString(span.attributes, 'bayn.entry_timing.batch_id', batch.plan.batchId)
    const planning = yield* unique(
      spans.filter((value) => value.span.name === 'bayn.jev.batch-plan' && batchMatches(value)),
      'Require exactly one native batch planning span',
    )
    const binding = yield* unique(
      spans.filter((value) => value.span.name === 'bayn.jev.entry-decision-binding' && batchMatches(value)),
      'Require exactly one native entry binding span',
    )
    const parent = byId.get(`${binding.span.traceId}:${binding.span.parentSpanId ?? ''}`)
    if (
      parent === undefined ||
      parent.span.name !== 'bayn.execution.cycle-pass' ||
      !childOf(planning.span, parent.span)
    )
      return yield* fail('Planning and decision binding must share their retained native cycle pass')
    const fence = yield* unique(
      spans.filter(({ span }) => span.name === 'bayn.postgres.writer-fence' && childOf(span, binding.span)),
      'Require exactly one writer fence under the accepted entry binding',
    )
    const commit = yield* unique(
      spans.filter(({ span }) => span.name === 'bayn.postgres.commit' && childOf(span, fence.span)),
      'Require exactly one acknowledged commit under the entry writer fence',
    )
    if (spans.some(({ span }) => span.name === 'bayn.postgres.rollback' && childOf(span, fence.span)))
      return yield* fail('An entry writer fence with rollback cannot supply commitment timing')
    const serviceName = yield* stringAttribute(binding.resource, 'service.name')
    const instanceId = yield* stringAttribute(binding.resource, 'service.instance.id')
    const selected = [parent, planning, binding, fence, commit]
    for (const value of selected) {
      if (
        value.span.status.code !== TempoStatusCode.Ok ||
        value.span.traceId !== binding.span.traceId ||
        !hasString(value.resource, 'service.version', input.sourceRevision) ||
        !hasString(value.resource, 'service.namespace', 'bayn') ||
        !hasString(value.resource, 'service.name', serviceName) ||
        !hasString(value.resource, 'service.instance.id', instanceId)
      )
        return yield* fail('Selected timing spans must succeed in the same native source and process')
      const visited = new Set<string>()
      let ancestor: RetainedSpan | undefined = value
      while (ancestor !== undefined) {
        const key = spanKey(ancestor.span)
        if (visited.has(key)) return yield* fail('Selected timing ancestry contains a cycle')
        visited.add(key)
        ancestor = byId.get(`${ancestor.span.traceId}:${ancestor.span.parentSpanId ?? ''}`)
      }
    }
    if (serviceName !== 'bayn-execution-controller')
      return yield* fail('Timing requires a native execution-controller resource')
    for (const [child, ancestor] of [
      [planning, parent],
      [binding, parent],
      [fence, binding],
      [commit, fence],
    ] as const)
      if (!containedBy(child.span, ancestor.span))
        return yield* fail('Native timing span lies outside its retained parent clock')
    if (
      !(yield* booleanAttribute(binding.span.attributes, 'bayn.entry_timing.binding_changed')) ||
      !(yield* booleanAttribute(binding.span.attributes, 'bayn.entry_timing.binding_accepted'))
    )
      return yield* fail('Replayed or rejected entry binding cannot supply commitment timing')
    for (const value of [binding, fence, commit]) {
      if (
        !batchMatches(value) ||
        !hasString(value.span.attributes, 'bayn.entry_timing.decision_hash', decision.contentHash) ||
        !hasString(
          value.span.attributes,
          'bayn.entry_timing.batch_completed_at',
          target.evidence.batchResult.completedAt,
        )
      )
        return yield* fail('Entry timing spans differ from the exact committed native decision and result')
    }
    if (
      !hasString(planning.span.attributes, 'bayn.entry_timing.observation_hash', batch.plan.observationHash) ||
      !hasString(planning.span.attributes, 'bayn.entry_timing.snapshot_hash', batch.snapshot.manifest.contentHash)
    )
      return yield* fail('Planning span differs from the retained observation or snapshot')
    const inputAvailableAt = yield* Schema.decodeUnknownResult(UtcInstantSchema)(
      yield* stringAttribute(planning.span.attributes, 'bayn.entry_timing.input_available_at'),
    )
    const deterministicSelectedAt = yield* Schema.decodeUnknownResult(UtcInstantSchema)(
      yield* stringAttribute(planning.span.attributes, 'bayn.entry_timing.deterministic_selected_at'),
    )
    const inputAt = intradayInstantNanos(inputAvailableAt)
    const selectedAt = intradayInstantNanos(deterministicSelectedAt)
    const completedAt = intradayInstantNanos(target.evidence.batchResult.completedAt)
    const createdAt = intradayInstantNanos(decision.createdAt)
    const cycleWall = yield* nativeWallInterval(parent)
    const planningWall = yield* nativeWallInterval(planning)
    const bindingWall = yield* nativeWallInterval(binding)
    const fenceWall = yield* nativeWallInterval(fence)
    const commitWall = yield* nativeWallInterval(commit)
    for (const [child, ancestor] of [
      [planningWall, cycleWall],
      [bindingWall, cycleWall],
      [fenceWall, bindingWall],
      [commitWall, fenceWall],
    ] as const)
      if (child.start < ancestor.start || child.end > ancestor.end)
        return yield* fail('Native wall interval lies outside its retained parent clock')
    // Effect's Unix-nanosecond projection may drift from currentTimeMillis. Compare
    // domain timestamps only to explicit markers from that same native clock.
    if (
      inputAt < intradayInstantNanos(batch.observation.observedAt) ||
      inputAt > planningWall.start ||
      inputAt < cycleWall.start ||
      selectedAt < inputAt ||
      selectedAt < planningWall.start ||
      selectedAt > planningWall.end ||
      planningWall.end > completedAt ||
      completedAt > createdAt ||
      createdAt > bindingWall.start ||
      bindingWall.start > commitWall.end
    )
      return yield* fail('Native readiness, selection, result, decision and commitment clocks conflict')
    // The marker observes the millisecond bucket after ACK. Its upper bound never
    // claims commitment earlier than that observation, even at an exact boundary.
    const decisionCommittedAt = yield* utcInstantFromEpochMillisResult(
      Number(commitWall.end / nanosPerMillisecond + 1n),
    )
    const timing = yield* Schema.decodeUnknownResult(
      EntryTimingReceiptSchema,
      strictParseOptions,
    )({
      schemaVersion: 'bayn.jev-entry-timing.v2',
      clock: nativeWallClock,
      sourceRevision: input.sourceRevision,
      batchId: batch.plan.batchId,
      observationHash: batch.plan.observationHash,
      snapshotHash: batch.snapshot.manifest.contentHash,
      inputAvailableAt,
      deterministicSelectedAt,
      deterministicSymbol: batch.selected[SignalScreenRule.RelativeMomentum],
      batchCompletedAt: target.evidence.batchResult.completedAt,
      decisionHash: decision.contentHash,
      decisionCommittedAt,
    })
    const timingText = `${JSON.stringify(timing, null, 2)}\n`
    const material = {
      schemaVersion: 'bayn.jev-entry-timing-export.v2',
      sourceFormat: 'TEMPO_QUERY_JSON',
      scope: 'OBSERVED_ENTRY_TIMING_ONLY',
      qualification: 'UNQUALIFIED',
      sourceRevision: input.sourceRevision,
      protocolHash: decision.bindings.strategyProtocolHash,
      inputs: {
        trace: { sha256: input.traceSha256, bytes: input.traceBytes.length },
        decision: { sha256: input.decisionSha256, bytes: input.decisionBytes.length },
      },
      timing: {
        file: 'timing.json',
        sha256: sha256(timingText),
        decisionHash: decision.contentHash,
        batchId: batch.plan.batchId,
      },
      resource: { serviceName, instanceId, sourceRevision: input.sourceRevision },
      spans: {
        cyclePass: retainedSpan(parent),
        planning: retainedSpan(planning),
        binding: retainedSpan(binding),
        writerFence: retainedSpan(fence),
        commit: retainedSpan(commit),
      },
      nativeWall: {
        cyclePass: retainedWallInterval(cycleWall),
        planning: retainedWallInterval(planningWall),
        binding: retainedWallInterval(bindingWall),
        writerFence: retainedWallInterval(fenceWall),
        commit: retainedWallInterval(commitWall),
      },
      commitment: {
        policy: 'UPPER_BOUND_NATIVE_MILLISECOND',
        clock: nativeWallClock,
        observedAt: commitWall.finishedAt,
        receiptAt: decisionCommittedAt,
        addedMilliseconds: 1,
      },
      limitations: [
        'Original trace and native decision bytes must be retained and independently verified; hashes identify bytes, not capture provenance.',
        'The v2 receipt uses the upper bound of the native millisecond bucket observed after COMMIT ACK; trace nanoseconds are a separate clock and remain retained.',
        'No complete source, session or controller coverage, capacity, latency calibration, cost allocation or profitability qualification is established.',
        'Only current native decision schemas are accepted; historical protocols are not rewritten or supplied by fallback.',
      ],
    } as const
    return { timing, timingText, receipt: { ...material, receiptHash: yield* canonicalHashV1Result(material) } }
  }).pipe(
    Result.mapError((cause) =>
      cause instanceof EntryTimingExportFailure
        ? cause
        : new EntryTimingExportFailure({ message: 'Entry timing evidence could not be verified', cause }),
    ),
  )

const readBounded = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = yield* fs.open(path, { flag: 'r' })
    const chunks: Uint8Array[] = []
    let bytes = 0
    for (;;) {
      const chunk = yield* file.readAlloc(64 * 1024)
      if (Option.isNone(chunk)) break
      bytes += chunk.value.length
      if (bytes > entryTimingMaximumInputBytes)
        return yield* new EntryTimingExportFailure({ message: 'Entry timing input exceeded its 16 MiB byte bound' })
      chunks.push(chunk.value)
    }
    const result = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return result
  }).pipe(Effect.scoped, Effect.timeout('10 seconds'))

export const exportEntryTiming = (input: {
  readonly tracePath: string
  readonly traceSha256: string
  readonly decisionPath: string
  readonly decisionSha256: string
  readonly sourceRevision: string
  readonly outputPath: string
}) =>
  Effect.gen(function* () {
    const traceBytes = yield* readBounded(input.tracePath)
    const decisionBytes = yield* readBounded(input.decisionPath)
    const result = yield* Effect.fromResult(buildEntryTimingExport({ ...input, traceBytes, decisionBytes }))
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(input.outputPath, { mode: 0o700 })
    const write = (name: string, text: string) =>
      Effect.gen(function* () {
        const file = yield* fs.open(path.join(input.outputPath, name), { flag: 'wx', mode: 0o600 })
        yield* file.writeAll(new TextEncoder().encode(text))
        yield* file.sync
      })
    yield* write('timing.json', result.timingText)
    yield* write('receipt.json', `${JSON.stringify(result.receipt, null, 2)}\n`)
    const directory = yield* fs.open(input.outputPath, { flag: 'r' })
    yield* directory.sync
    return result.receipt
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) =>
      cause instanceof EntryTimingExportFailure
        ? cause
        : new EntryTimingExportFailure({
            message: 'Entry timing export failed; a directory without receipt.json is incomplete',
            cause,
          }),
    ),
  )
