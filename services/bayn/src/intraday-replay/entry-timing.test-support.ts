import { Buffer } from 'node:buffer'
import { sha256 } from '../hash'
import { intradayInstantNanos } from '../market-data/intraday/time'
import type { ExecutionDecisionDocument } from '../shadow-decision-contract'

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
export const nativeEntryTimingFixture = (decision: ExecutionDecisionDocument, sourceRevision = 'a'.repeat(40)) => {
  const target = decision.strategyDecision
  if (target?.schemaVersion !== 'bayn.jev-entry-target.v7') throw new Error('Missing native entry fixture')
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
