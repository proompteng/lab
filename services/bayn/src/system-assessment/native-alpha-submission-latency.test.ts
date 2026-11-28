import { beforeAll, describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations/model'
import { MutationEventSchema, MutationEventType } from '../execution/mutations/model'
import { reproduceAlphaBaselinePreparation } from '../observe-composition/alpha-baseline-preparation'
import { preparedAlphaBaselineFixture } from '../observe-composition/alpha-baseline-preparation.test-support'
import { nativeAlphaDecisionFixture } from '../strategy/intraday-alpha/alpha-decision.test-support'
import { ControllerPassEvidenceSchema } from './decision-work'
import { testHash } from './fixtures.test-support'
import { alphaLatencyFixture } from './native-alpha-latency.test-support'
import { measureAlphaDecisionLatency } from './native-decision-latency'
import { StrategyBoundSystemSourceCutSchema } from './source-cut'

type Cut = typeof StrategyBoundSystemSourceCutSchema.Type
let fixture: ReturnType<typeof alphaLatencyFixture>
let cut: Cut
let at: (offset: number) => string

const event = (intentId: string, sequence: number, eventType: MutationEventType, offset: number) =>
  Schema.decodeUnknownSync(MutationEventSchema)({
    schemaVersion: 'bayn.paper-mutation-event.v1',
    eventId: testHash({ intentId, sequence, eventType }),
    mutationId: testHash({ intentId }),
    intentId,
    sequence,
    operation: MutationOperation.Submit,
    eventType,
    requestHash: testHash({ request: intentId }),
    consistencyDelayMs: 1000,
    occurredAt: at(offset),
    ...(sequence === 2 ? { routing: { startedAt: at(10), requestDispatchedAt: at(11), completedAt: at(offset) } } : {}),
  })

const withMutations = (mutations: Cut['mutations']): Cut => ({
  ...cut,
  mutations,
  durableObservations: [
    ...cut.durableObservations.filter((w) => w.kind !== 'MUTATION'),
    ...mutations.map(({ event: mutation }) => ({
      kind: 'MUTATION' as const,
      sourceHash: mutation.eventId,
      sourceAt: mutation.occurredAt,
      witnessedAt: new Date(Date.parse(mutation.occurredAt) + 100).toISOString(),
      correct: true,
    })),
  ],
})

beforeAll(async () => {
  const retained = preparedAlphaBaselineFixture()
  fixture = alphaLatencyFixture({}, retained.payload.acquisition.trailingBaseline)
  const calendar = fixture.registration.calendar.marketCalendar
  const session = calendar.sessions.find((entry) => entry.date === retained.payload.sessionDate)
  if (session === undefined) throw new Error('Missing registered baseline preparation session')
  const preparationAt = (offset: number) => new Date(Date.parse(session.openAt) + offset).toISOString()
  const preparation = Result.getOrThrow(
    reproduceAlphaBaselinePreparation({
      ...retained.payload,
      accountId: fixture.identity.accountId,
      authorityGenerationHash: fixture.owned.payload.authorityGenerationHash,
      executionBuild: fixture.executionBuild,
      calendar,
      acquisition: {
        ...retained.payload.acquisition,
        startedAt: preparationAt(0),
        completedAt: preparationAt(1000),
      },
    }),
  )
  const { document } = await nativeAlphaDecisionFixture({
    accountId: fixture.identity.accountId,
    authorityGenerationHash: fixture.owned.payload.authorityGenerationHash,
    calendar,
    baselinePreparation: {
      contentHash: preparation.contentHash,
      payload: preparation.payload,
      recordedAt: preparationAt(1001),
    },
  })
  const target = document.strategyDecision
  if (target?.schemaVersion !== 'bayn.intraday-alpha-target.v2' || !document.dispatchable)
    throw new Error('Expected a real dispatchable native alpha decision')
  const observation = target.evidence.observation
  const observationHash = testHash(observation)
  at = (offset: number) => new Date(Date.parse(observation.observedAt) + offset).toISOString()
  const pass = Schema.decodeUnknownSync(ControllerPassEvidenceSchema)({
    ...fixture.pass,
    completedAt: at(10),
    observation: {
      result: 'SUCCESS',
      outcome: 'ACQUIRED',
      executionBuild: fixture.executionBuild,
      observedAt: at(10),
      executionIssuedAt: at(-10),
      alphaObservationReferences: { hashes: [observationHash], complete: true },
    },
  })
  const passes = [
    pass,
    ...fixture.cut.controllerPasses.filter((entry) => entry.receiptHash !== fixture.pass.receiptHash),
  ]
  cut = Schema.decodeUnknownSync(StrategyBoundSystemSourceCutSchema)({
    ...fixture.cut,
    alphaObservations: [{ contentHash: observationHash, payload: observation }],
    decisions: [{ sessionDate: observation.manifest['sessionDate'], document }],
    controllerPasses: passes,
    durableObservations: [
      {
        kind: 'ALPHA_OBSERVATION',
        sourceHash: observationHash,
        sourceAt: observation.observedAt,
        witnessedAt: at(100),
        correct: true,
      },
      {
        kind: 'DECISION',
        sourceHash: document.contentHash,
        sourceAt: document.createdAt,
        witnessedAt: at(110),
        correct: true,
      },
      ...passes.map((p) => ({
        kind: 'CONTROLLER',
        sourceHash: p.receiptHash,
        sourceAt: p.completedAt,
        witnessedAt: new Date(Date.parse(p.completedAt) + 100).toISOString(),
        correct: true,
      })),
    ],
  })
  cut = withMutations(
    document.orderedIntentIds
      .flatMap((intentId) => [
        event(intentId, 1, MutationEventType.SubmitStarted, 10),
        event(intentId, 2, MutationEventType.SubmitAccepted, 30),
      ])
      .map((entry) => ({
        authorityGenerationHash: document.bindings.authorityGenerationHash,
        strategyDecisionHash: document.bindings.strategyDecisionHash,
        event: entry,
      })),
  )
}, 30_000)

const measure = (source: Cut = cut) =>
  Result.getOrThrow(measureAlphaDecisionLatency(fixture.registration, source, fixture.identity))

describe('native alpha submission completion timing', () => {
  test('includes every real planned leg through independently witnessed submission completion', () => {
    const result = measure()
    expect(result.status).toBe('MEASURED')
    expect(result.p95FullBatchMs).toBe(140)
    expect(result.samples[0]?.mutationIds).toHaveLength(4)
    expect(result.samples[0]?.decisionHashes).toEqual([cut.decisions[0]?.document.contentHash])
    expect(result.samples[0]?.abstained).toBe(false)
  })

  test('unknown submission remains unresolved until the original mutation is recovered', () => {
    const selected = cut.mutations[1]
    if (selected === undefined) throw new Error('Missing submission fixture')
    const unknown = { ...selected, event: event(selected.event.intentId, 2, MutationEventType.SubmitUnknown, 30) }
    const mutations = cut.mutations.map((row) => (row.event.eventId === selected.event.eventId ? unknown : row))
    const unresolved = measure(withMutations(mutations))
    expect(unresolved.status).toBe('INCOMPLETE')
    expect(unresolved.p95FullBatchMs).toBeNull()
    expect(unresolved.missing).toContain(`UNRESOLVED_ALPHA_SUBMISSION:${selected.event.intentId}`)
    const recovered = measure(
      withMutations([
        ...mutations,
        { ...selected, event: event(selected.event.intentId, 3, MutationEventType.RecoveryFound, 1500) },
      ]),
    )
    expect(recovered.status).toBe('MEASURED')
    expect(recovered.p95FullBatchMs).toBe(1610)
    expect(recovered.samples[0]?.mutationIds).toHaveLength(4)
  })

  test('missing routing, missing witnesses and omitted legs withhold the complete percentile', () => {
    const selected = cut.mutations[1]
    if (selected === undefined) throw new Error('Missing submission fixture')
    const { routing: _routing, ...withoutRouting } = selected.event
    for (const source of [
      withMutations(cut.mutations.filter((row) => row.event.intentId !== selected.event.intentId)),
      withMutations(
        cut.mutations.map((row) =>
          row.event.eventId === selected.event.eventId ? { ...row, event: withoutRouting } : row,
        ),
      ),
      { ...cut, durableObservations: cut.durableObservations.filter((w) => w.sourceHash !== selected.event.eventId) },
      { ...cut, durableObservations: cut.durableObservations.filter((w) => w.kind !== 'DECISION') },
    ]) {
      const result = measure(source)
      expect(result.status).toBe('INCOMPLETE')
      expect(result.p95FullBatchMs).toBeNull()
      expect(result.missing.length).toBeGreaterThan(0)
    }
  })

  test('changed ownership, noncausal clocks and discontinuous mutation histories are violated', () => {
    const selected = cut.mutations[1]
    if (selected === undefined) throw new Error('Missing submission fixture')
    for (const replacement of [
      { ...selected, authorityGenerationHash: testHash('foreign generation') },
      { ...selected, strategyDecisionHash: testHash('foreign decision') },
      { ...selected, event: { ...selected.event, sequence: 3 } },
      { ...selected, event: { ...selected.event, requestHash: testHash('changed request') } },
      { ...selected, event: { ...selected.event, occurredAt: at(-1) } },
    ]) {
      const result = measure(
        withMutations(cut.mutations.map((row) => (row.event.eventId === selected.event.eventId ? replacement : row))),
      )
      expect(result.status).toBe('VIOLATED')
      expect(result.p95FullBatchMs).toBeNull()
    }
  })
})
