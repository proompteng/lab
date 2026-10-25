import { beforeAll, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Buffer } from 'node:buffer'
import { Effect, Exit, FileSystem, Result, Schema } from 'effect'

import { parseEntryTimingExportArgs } from '../../tools/entry-timing-export'
import { sha256, canonicalHashV1Result } from '../hash'
import { nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import { intradayInstantNanos } from '../market-data/intraday/time'
import { type ExecutionDecisionDocument } from '../shadow-decision-contract'
import { EntryTimingReceiptSchema } from './entry-timing'
import { buildEntryTimingExport, entryTimingMaximumInputBytes, exportEntryTiming } from './entry-timing-export'
import { matchedCommittedDecisionFixture } from './matched-entry.test-support'

const sourceRevision = 'a'.repeat(40)
const ms = 1_000_000n
type Attribute = { key: string; value: Record<string, unknown> }
type TestSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Attribute[]
  status: { code?: string }
}
let retained: { enter: ExecutionDecisionDocument; abstain: ExecutionDecisionDocument } | undefined
beforeAll(async () => {
  retained = await Effect.runPromise(
    Effect.gen(function* () {
      const native = nativeJevFixture()
      return {
        enter: yield* matchedCommittedDecisionFixture(native, nativeJevDecisionEvidence(native)),
        abstain: yield* matchedCommittedDecisionFixture(native, nativeJevDecisionEvidence(native, 'wait')),
      }
    }),
  )
})

const fixture = (abstain = false) => {
  if (retained === undefined) throw new Error('Native timing fixtures are not prepared')
  const decision = abstain ? retained.abstain : retained.enter
  const target = decision.strategyDecision
  if (target?.schemaVersion !== 'bayn.jev-entry-target.v6') throw new Error('Missing native entry fixture')
  const observed = intradayInstantNanos(target.evidence.observation.observedAt)
  const created = intradayInstantNanos(decision.createdAt)
  const commitNanos = created + 1000n * ms + 751_734n
  const instant = (nanos: bigint) => new Date(Number(nanos / ms)).toISOString()
  const attribute = (key: string, value: string): Attribute => ({ key, value: { stringValue: value } })
  const bindingAttributes = [
    attribute('bayn.entry_timing.batch_id', target.evidence.batchPlan.batchId),
    attribute('bayn.entry_timing.decision_hash', decision.contentHash),
    attribute('bayn.entry_timing.batch_completed_at', target.evidence.batchResult.completedAt),
  ]
  const id = (value: number) => Buffer.alloc(8, value).toString('base64')
  const span = (
    name: string,
    value: number,
    parent: number | undefined,
    start: bigint,
    end: bigint,
    attributes: Attribute[] = [],
  ): TestSpan => ({
    traceId: Buffer.alloc(16, 7).toString('base64'),
    spanId: id(value),
    ...(parent === undefined ? {} : { parentSpanId: id(parent) }),
    name,
    kind: 'SPAN_KIND_INTERNAL',
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(end),
    attributes: [
      attribute('bayn.native_wall.clock', 'effect.Clock.currentTimeMillis'),
      attribute('bayn.native_wall.started_at', instant(start)),
      attribute('bayn.native_wall.finished_at', instant(end)),
      ...attributes,
    ],
    status: { code: 'STATUS_CODE_OK' },
  })
  const spans = [
    span('bayn.execution.cycle-pass', 1, undefined, observed - ms, commitNanos + 300n),
    span('bayn.jev.batch-plan', 2, 1, observed + 10n * ms, observed + 30n * ms + 123n, [
      attribute('bayn.entry_timing.batch_id', target.evidence.batchPlan.batchId),
      attribute('bayn.entry_timing.observation_hash', target.evidence.batchPlan.observationHash),
      attribute('bayn.entry_timing.snapshot_hash', decision.bindings.snapshotContentHash),
      attribute('bayn.entry_timing.input_available_at', instant(observed + ms)),
      attribute('bayn.entry_timing.deterministic_selected_at', instant(observed + 30n * ms)),
    ]),
    span('bayn.jev.entry-decision-binding', 3, 1, created + 200n * ms, commitNanos + 100n, [
      ...bindingAttributes,
      { key: 'bayn.entry_timing.binding_changed', value: { boolValue: true } },
      { key: 'bayn.entry_timing.binding_accepted', value: { boolValue: true } },
    ]),
    span(
      'bayn.postgres.writer-fence',
      4,
      3,
      created + 200n * ms + 10n,
      commitNanos + 50n,
      structuredClone(bindingAttributes),
    ),
    span('bayn.postgres.commit', 5, 4, created + 800n * ms, commitNanos, structuredClone(bindingAttributes)),
  ]
  const resource = {
    attributes: [
      attribute('service.name', 'bayn-execution-controller'),
      attribute('service.namespace', 'bayn'),
      attribute('service.version', sourceRevision),
      attribute('service.instance.id', 'synthetic-worker'),
    ],
  }
  const trace = { batches: [{ resource, scopeSpans: [{ scope: { name: 'effect' }, spans }] }] }
  const byName = (name: string) => {
    const selected = spans.find((span) => span.name === name)
    if (selected === undefined) throw new Error('Missing synthetic span')
    return selected
  }
  const set = (span: TestSpan, key: string, value: Record<string, unknown>) => {
    const existing = span.attributes.find((attribute) => attribute.key === key)
    if (existing === undefined) throw new Error('Missing synthetic attribute')
    existing.value = value
  }
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  const input = (document: unknown = decision) => {
    const traceBytes = encode(trace)
    const decisionBytes = encode(document)
    return {
      traceBytes,
      decisionBytes,
      traceSha256: sha256(traceBytes),
      decisionSha256: sha256(decisionBytes),
      sourceRevision,
    }
  }
  return { decision, target, observed, created, commitNanos, trace, spans, byName, set, input, encode }
}

test.each([-500n, 500n])('keeps native wall timing independent of a %sms trace-clock offset', (offsetMs) => {
  const f = fixture()
  for (const span of f.spans) {
    span.startTimeUnixNano = String(BigInt(span.startTimeUnixNano) + offsetMs * ms)
    span.endTimeUnixNano = String(BigInt(span.endTimeUnixNano) + offsetMs * ms)
  }
  const result = Result.getOrThrow(buildEntryTimingExport(f.input()))
  expect(result.timing.decisionCommittedAt).toBe(new Date(Number(f.commitNanos / ms + 1n)).toISOString())
})

test.each([false, true])('exports exact native timing and a conservative v2 receipt, abstention=%s', (abstain) => {
  const f = fixture(abstain)
  const result = Result.getOrThrow(buildEntryTimingExport(f.input()))
  expect(Result.isSuccess(Schema.decodeUnknownResult(EntryTimingReceiptSchema)(result.timing))).toBeTrue()
  expect(result.timing.decisionHash).toBe(f.decision.contentHash)
  expect(result.timing.deterministicSymbol).toBe('AAPL')
  expect(f.target.selectedSymbols).toEqual(abstain ? [] : ['AAPL'])
  const receiptNanos = intradayInstantNanos(result.timing.decisionCommittedAt)
  expect(receiptNanos).toBe(f.commitNanos + 248_266n)
  expect(receiptNanos - f.commitNanos).toBeGreaterThanOrEqual(0n)
  expect(receiptNanos - f.commitNanos).toBeLessThan(ms)
  expect(result.receipt.commitment).toEqual({
    policy: 'UPPER_BOUND_NATIVE_MILLISECOND',
    clock: 'effect.Clock.currentTimeMillis',
    observedAt: new Date(Number(f.commitNanos / ms)).toISOString(),
    receiptAt: result.timing.decisionCommittedAt,
    addedMilliseconds: 1,
  })
  expect(result.receipt.spans.commit.endTimeUnixNano).toBe(String(f.commitNanos))
  expect(result.receipt.timing.sha256).toBe(sha256(result.timingText))
  const { receiptHash, ...material } = result.receipt
  expect(receiptHash).toBe(Result.getOrThrow(canonicalHashV1Result(material)))
  expect(result.receipt.qualification).toBe('UNQUALIFIED')
  expect(result.receipt.scope).toBe('OBSERVED_ENTRY_TIMING_ONLY')
})

test('bounds the entire native millisecond bucket even when the trace end is exact', () => {
  const f = fixture()
  const commit = f.byName('bayn.postgres.commit')
  commit.endTimeUnixNano = String(f.commitNanos - 751_734n)
  const result = Result.getOrThrow(buildEntryTimingExport(f.input()))
  expect(result.receipt.commitment.addedMilliseconds).toBe(1)
  expect(intradayInstantNanos(result.timing.decisionCommittedAt)).toBe(BigInt(commit.endTimeUnixNano) + ms)
})

test.each([
  'bayn.jev.batch-plan',
  'bayn.jev.entry-decision-binding',
  'bayn.postgres.writer-fence',
  'bayn.postgres.commit',
  'bayn.execution.cycle-pass',
])('rejects missing %s', (name) => {
  const f = fixture()
  f.spans.splice(
    f.spans.findIndex((span) => span.name === name),
    1,
  )
  expect(Result.isFailure(buildEntryTimingExport(f.input()))).toBeTrue()
})

test.each([
  'bayn.jev.batch-plan',
  'bayn.jev.entry-decision-binding',
  'bayn.postgres.writer-fence',
  'bayn.postgres.commit',
])('rejects ambiguous %s', (name) => {
  const f = fixture()
  f.spans.push({ ...structuredClone(f.byName(name)), spanId: Buffer.alloc(8, 9).toString('base64') })
  expect(Result.isFailure(buildEntryTimingExport(f.input()))).toBeTrue()
})

test.each(['STATUS_CODE_ERROR', 'STATUS_CODE_UNSET', undefined])('rejects commit without success: %s', (code) => {
  const f = fixture()
  f.byName('bayn.postgres.commit').status = code === undefined ? {} : { code }
  expect(Result.isFailure(buildEntryTimingExport(f.input()))).toBeTrue()
})

test.each(['bayn.entry_timing.binding_changed', 'bayn.entry_timing.binding_accepted'])('rejects false %s', (key) => {
  const f = fixture()
  f.set(f.byName('bayn.jev.entry-decision-binding'), key, { boolValue: false })
  expect(Result.isFailure(buildEntryTimingExport(f.input()))).toBeTrue()
})

test('rejects an unrelated matching commit and a rollback under the writer fence', () => {
  for (const unrelated of [true, false]) {
    const f = fixture()
    const commit = f.byName('bayn.postgres.commit')
    if (unrelated) commit.parentSpanId = f.byName('bayn.execution.cycle-pass').spanId
    else
      f.spans.push({
        ...structuredClone(commit),
        name: 'bayn.postgres.rollback',
        spanId: Buffer.alloc(8, 9).toString('base64'),
      })
    expect(Result.isFailure(buildEntryTimingExport(f.input()))).toBeTrue()
  }
})

test.each(['decision_hash', 'batch_id', 'batch_completed_at'])('rejects a substituted commit %s', (key) => {
  const f = fixture()
  f.set(f.byName('bayn.postgres.commit'), `bayn.entry_timing.${key}`, { stringValue: 'f'.repeat(64) })
  expect(Result.isFailure(buildEntryTimingExport(f.input()))).toBeTrue()
})

test.each(['observation_hash', 'snapshot_hash'])('rejects planning identity substitution: %s', (key) => {
  const f = fixture()
  f.set(f.byName('bayn.jev.batch-plan'), `bayn.entry_timing.${key}`, { stringValue: 'f'.repeat(64) })
  expect(Result.isFailure(buildEntryTimingExport(f.input()))).toBeTrue()
})

test('rejects source, process and same-trace ancestry substitution', () => {
  const source = fixture()
  expect(Result.isFailure(buildEntryTimingExport({ ...source.input(), sourceRevision: 'b'.repeat(40) }))).toBeTrue()
  const processFixture = fixture()
  const foreign = structuredClone(processFixture.trace.batches[0])
  if (foreign === undefined) throw new Error('Missing trace batch')
  foreign.resource.attributes = foreign.resource.attributes.map((value) =>
    value.key === 'service.instance.id' ? { ...value, value: { stringValue: 'other-worker' } } : value,
  )
  const foreignScope = foreign.scopeSpans[0]
  if (foreignScope === undefined) throw new Error('Missing trace scope')
  foreignScope.spans.splice(0)
  const planning = processFixture.byName('bayn.jev.batch-plan')
  processFixture.spans.splice(processFixture.spans.indexOf(planning), 1)
  foreignScope.spans.push(planning)
  processFixture.trace.batches.push(foreign)
  expect(Result.isFailure(buildEntryTimingExport(processFixture.input()))).toBeTrue()
  const trace = fixture()
  trace.byName('bayn.postgres.commit').traceId = Buffer.alloc(16, 8).toString('base64')
  expect(Result.isFailure(buildEntryTimingExport(trace.input()))).toBeTrue()
})

test.each([
  'zero',
  'short',
  'hex',
  'noncanonical',
  'numeric-enum',
  'duplicate-span',
  'duplicate-attribute',
  'cyclic-parent',
  'malformed-nanos',
])('rejects malformed Tempo evidence: %s', (scenario) => {
  const f = fixture()
  const commit = f.byName('bayn.postgres.commit')
  switch (scenario) {
    case 'zero':
      commit.spanId = Buffer.alloc(8).toString('base64')
      break
    case 'short':
      commit.spanId = Buffer.alloc(7, 3).toString('base64')
      break
    case 'hex':
      commit.spanId = '0303030303030303'
      break
    case 'noncanonical':
      commit.spanId = `${commit.spanId}\n`
      break
    case 'numeric-enum':
      commit.status = { code: '1' }
      break
    case 'duplicate-span':
      f.spans.push(structuredClone(commit))
      break
    case 'duplicate-attribute':
      commit.attributes.push(structuredClone(commit.attributes[0] ?? { key: 'missing', value: {} }))
      break
    case 'cyclic-parent':
      f.byName('bayn.execution.cycle-pass').parentSpanId = commit.spanId
      break
    case 'malformed-nanos':
      commit.endTimeUnixNano = 'not-a-number'
      break
  }
  expect(Result.isFailure(buildEntryTimingExport(f.input()))).toBeTrue()
})

test('checks raw nanosecond containment before millisecond quantization', () => {
  const f = fixture()
  f.byName('bayn.postgres.writer-fence').endTimeUnixNano = String(f.commitNanos - 1n)
  expect(Result.isFailure(buildEntryTimingExport(f.input()))).toBeTrue()
})

test('requires readiness within its explicit native cycle-pass interval', () => {
  const f = fixture()
  const cyclePass = f.byName('bayn.execution.cycle-pass')
  f.set(cyclePass, 'bayn.native_wall.started_at', { stringValue: new Date(Number(f.observed / ms + 1n)).toISOString() })
  expect(Result.isSuccess(buildEntryTimingExport(f.input()))).toBeTrue()
  f.set(cyclePass, 'bayn.native_wall.started_at', { stringValue: new Date(Number(f.observed / ms + 2n)).toISOString() })
  expect(Result.isFailure(buildEntryTimingExport(f.input()))).toBeTrue()
})

test.each(['missing', 'foreign-clock', 'reversed', 'outside-parent', 'fractional-millisecond'])(
  'rejects invalid native wall provenance: %s',
  (scenario) => {
    const f = fixture()
    const commit = f.byName('bayn.postgres.commit')
    switch (scenario) {
      case 'missing':
        commit.attributes = commit.attributes.filter(({ key }) => key !== 'bayn.native_wall.clock')
        break
      case 'foreign-clock':
        f.set(commit, 'bayn.native_wall.clock', { stringValue: 'trace-unix-nanos' })
        break
      case 'reversed':
        f.set(commit, 'bayn.native_wall.finished_at', { stringValue: new Date(Number(f.created / ms)).toISOString() })
        break
      case 'outside-parent':
        f.set(commit, 'bayn.native_wall.finished_at', {
          stringValue: new Date(Number(f.commitNanos / ms + 1n)).toISOString(),
        })
        break
      case 'fractional-millisecond':
        f.set(commit, 'bayn.native_wall.finished_at', {
          stringValue: new Date(Number(f.commitNanos / ms)).toISOString().replace('Z', '001Z'),
        })
        break
    }
    expect(Result.isFailure(buildEntryTimingExport(f.input()))).toBeTrue()
  },
)

test('rejects clock reversals and a selection annotation outside its actual planning span', () => {
  const f = fixture()
  const plan = f.byName('bayn.jev.batch-plan')
  f.set(plan, 'bayn.entry_timing.deterministic_selected_at', {
    stringValue: new Date(Number(f.observed / ms)).toISOString(),
  })
  expect(Result.isFailure(buildEntryTimingExport(f.input()))).toBeTrue()
  const backwards = fixture()
  backwards.byName('bayn.postgres.commit').endTimeUnixNano = String(f.created - 1n)
  expect(Result.isFailure(buildEntryTimingExport(backwards.input()))).toBeTrue()
})

test('rejects changed bytes, changed native identities and old protocols without fallback', () => {
  const f = fixture()
  expect(Result.isFailure(buildEntryTimingExport({ ...f.input(), decisionSha256: 'f'.repeat(64) }))).toBeTrue()
  expect(Result.isFailure(buildEntryTimingExport({ ...f.input(), traceSha256: 'f'.repeat(64) }))).toBeTrue()
  expect(Result.isFailure(buildEntryTimingExport(f.input({ ...f.decision, contentHash: 'f'.repeat(64) })))).toBeTrue()
  const old = {
    ...f.decision,
    strategyDecision: {
      ...f.target,
      evidence: {
        ...f.target.evidence,
        observation: {
          ...f.target.evidence.observation,
          protocol: { ...f.target.evidence.observation.protocol, schemaVersion: 'bayn.jev.protocol.v11' },
        },
      },
    },
  }
  expect(Result.isFailure(buildEntryTimingExport(f.input(old)))).toBeTrue()
})

test('writes private new outputs only after verifying bounded pinned input bytes', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const f = fixture()
      const input = f.input()
      const tracePath = `${directory}/trace.json`
      const decisionPath = `${directory}/decision.json`
      yield* fs.writeFile(tracePath, input.traceBytes)
      yield* fs.writeFile(decisionPath, input.decisionBytes)
      const args = {
        tracePath,
        decisionPath,
        traceSha256: input.traceSha256,
        decisionSha256: input.decisionSha256,
        sourceRevision,
        outputPath: `${directory}/new-output`,
      }
      const receipt = yield* exportEntryTiming(args)
      expect(sha256(yield* fs.readFile(`${args.outputPath}/timing.json`))).toBe(receipt.timing.sha256)
      expect((yield* fs.stat(args.outputPath)).mode & 0o777).toBe(0o700)
      expect((yield* fs.stat(`${args.outputPath}/timing.json`)).mode & 0o777).toBe(0o600)
      expect((yield* fs.stat(`${args.outputPath}/receipt.json`)).mode & 0o777).toBe(0o600)
      expect(Exit.isFailure(yield* Effect.exit(exportEntryTiming(args)))).toBeTrue()
      const invalidOutput = `${directory}/invalid-output`
      expect(
        Exit.isFailure(
          yield* Effect.exit(exportEntryTiming({ ...args, outputPath: invalidOutput, traceSha256: 'f'.repeat(64) })),
        ),
      ).toBeTrue()
      expect(yield* fs.exists(invalidOutput)).toBeFalse()
      yield* fs.writeFile(tracePath, new Uint8Array(entryTimingMaximumInputBytes + 1))
      expect(Exit.isFailure(yield* Effect.exit(exportEntryTiming({ ...args, outputPath: invalidOutput })))).toBeTrue()
      expect(yield* fs.exists(invalidOutput)).toBeFalse()
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})

test('command requires unique flags, pinned inputs and an explicit source', () => {
  const args = [
    '--trace',
    '/private/trace.json',
    '--trace-sha256',
    'a'.repeat(64),
    '--decision',
    '/private/decision.json',
    '--decision-sha256',
    'b'.repeat(64),
    '--source-revision',
    sourceRevision,
    '--output',
    '/private/new-output',
  ]
  expect(Result.isSuccess(parseEntryTimingExportArgs(args))).toBeTrue()
  expect(Result.isSuccess(parseEntryTimingExportArgs(['--help']))).toBeTrue()
  for (const invalid of [
    [],
    args.slice(0, -2),
    [...args, '--trace', '/other'],
    [...args, '--unknown', 'value'],
    ['--help', 'extra'],
    args.map((value) => (value === sourceRevision ? 'development' : value)),
  ])
    expect(Result.isFailure(parseEntryTimingExportArgs(invalid))).toBeTrue()
})
