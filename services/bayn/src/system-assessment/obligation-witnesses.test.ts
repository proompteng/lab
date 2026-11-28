import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { MutationEventType } from '../execution/mutations/model'
import { MutationOperation } from '../broker/alpaca-mutations/model'
import { testHash } from './fixtures.test-support'
import { emptySourceCutFixture } from './source-cut.test-support'
import { earliestDurableWitnesses, indexObligationWitnesses } from './obligation-witnesses'
import { ObligationClass } from './reliability'
import type { SystemSourceCut } from './source-cut'

describe('indexed obligation evidence', () => {
  test('joins a complete twenty-session one-second reconciliation window in one witness traversal', () => {
    const { input, cut } = emptySourceCutFixture()
    const registration = {
      ...input.registration,
      obligations: { ...input.registration.obligations, reconciliationIntervalMs: 1000 },
    }
    const schedule = registration.calendar.sessions.flatMap((session, day) =>
      Array.from({ length: 390 * 60 }, (_, second) => {
        const dueAt = new Date(Date.parse(session.openAt) + second * 1000).toISOString()
        return {
          obligationId: `${day}:${second}`,
          class: ObligationClass.Reconciliation,
          dueAt,
          deadlineAt: new Date(Date.parse(dueAt) + 1000).toISOString(),
          scheduleEvidenceHash: cut.sourceMaterialHash,
        }
      }),
    )
    let visited = 0
    const witnesses = schedule.map((obligation) => ({
      get kind(): 'RECONCILIATION' {
        visited += 1
        return 'RECONCILIATION'
      },
      sourceHash: obligation.obligationId,
      sourceAt: obligation.dueAt,
      witnessedAt: obligation.deadlineAt,
      correct: true,
    }))
    const indexed = Result.getOrThrow(
      indexObligationWitnesses(
        { ...cut, asOf: '2026-12-01T00:00:00.000Z', durableObservations: witnesses },
        registration,
        schedule,
        new Map(),
        new Map(),
      ),
    )
    expect(schedule).toHaveLength(468000)
    expect(indexed.size).toBe(schedule.length)
    expect(visited).toBeLessThanOrEqual(schedule.length * 5)
    expect(indexed.get('0:0')?.[0]?.witness).toBe(witnesses[0])
    expect(indexed.get('19:23399')?.[0]?.witness).toBe(witnesses.at(-1))
  }, 30000)

  test('retains failures and late witnesses without lending them to a neighboring interval or another class', () => {
    const { input, cut } = emptySourceCutFixture()
    const at = (ms: number) => new Date(Date.parse(input.registration.calendar.sessions[0]!.openAt) + ms).toISOString()
    const schedule = [0, 60000].flatMap((offset) =>
      [ObligationClass.Decision, ObligationClass.Reconciliation].map((kind) => ({
        obligationId: `${kind}:${offset}`,
        class: kind,
        dueAt: at(offset),
        deadlineAt: at(offset + 10000),
        scheduleEvidenceHash: cut.sourceMaterialHash,
      })),
    )
    const witness = (
      kind: SystemSourceCut['durableObservations'][number]['kind'],
      sourceAt: number,
      witnessedAt: number,
      correct = true,
    ) => ({
      kind,
      sourceHash: testHash({ kind, sourceAt }),
      sourceAt: at(sourceAt),
      witnessedAt: at(witnessedAt),
      correct,
    })
    const observations = [
      witness('RECONCILIATION', -1, 0),
      witness('RECONCILIATION', 0, 1, false),
      witness('RECONCILIATION', 0, 20000),
      witness('RECONCILIATION', 59999, 60001),
      witness('RECONCILIATION', 60000, 60001),
      witness('RECONCILIATION', 120000, 120001),
      witness('RECONCILIATION', 60001, 180001),
      witness('DECISION', 0, 1),
      witness('DECISION', 60000, 60001),
      witness('CONTROLLER', 61000, 61001),
      witness('BATCH', 0, 1),
    ]
    const indexed = Result.getOrThrow(
      indexObligationWitnesses(
        { ...cut, asOf: at(180000), durableObservations: observations },
        input.registration,
        schedule,
        new Map([
          [
            testHash({ kind: 'CONTROLLER', sourceAt: 61000 }),
            { sourceAt: at(59999), completedAt: at(61000), correct: true },
          ],
        ]),
        new Map([[testHash({ kind: 'DECISION', sourceAt: 0 }), { sourceAt: at(0), correct: false }]]),
      ),
    )
    expect(indexed.get('RECONCILIATION:0')?.map((row) => row.witness)).toEqual(observations.slice(1, 4))
    expect(indexed.get('RECONCILIATION:0')?.map((row) => row.correct)).toEqual([false, true, true])
    expect(indexed.get('RECONCILIATION:60000')?.map((row) => row.witness)).toEqual([observations[4]])
    expect(indexed.get('DECISION:0')?.map((row) => row.correct)).toEqual([false, true])
    expect(indexed.has('DECISION:60000')).toBe(false)
  })

  test('uncertain admission can complete handling but only a final matching mutation can complete recovery', () => {
    const { input, cut } = emptySourceCutFixture()
    const dueAt = input.registration.calendar.sessions[0]!.openAt
    const event = {
      schemaVersion: 'bayn.paper-mutation-event.v1' as const,
      mutationId: testHash('mutation'),
      intentId: testHash('intent'),
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitUnknown,
      eventId: testHash('unknown'),
      requestHash: testHash('request'),
      consistencyDelayMs: 1000,
      occurredAt: dueAt,
    }
    const events = [
      event,
      { ...event, sequence: 3, eventId: testHash('recovered'), eventType: MutationEventType.RecoveryFound },
    ]
    const schedule = [ObligationClass.Mutation, ObligationClass.Recovery].map((kind) => ({
      obligationId: testHash({ registrationHash: cut.registrationHash, mutationId: event.mutationId, class: kind }),
      class: kind,
      dueAt,
      deadlineAt: cut.asOf,
      scheduleEvidenceHash: cut.sourceMaterialHash,
    }))
    const observations = events.map((event) => ({
      kind: 'MUTATION' as const,
      sourceHash: event.eventId,
      sourceAt: dueAt,
      witnessedAt: dueAt,
      correct: true,
    }))
    const indexed = Result.getOrThrow(
      indexObligationWitnesses(
        {
          ...cut,
          mutations: events.map((event) => ({
            authorityGenerationHash: testHash('generation'),
            strategyDecisionHash: testHash('decision'),
            event,
          })),
          durableObservations: [...observations, { ...observations[0]!, sourceHash: testHash('foreign mutation') }],
        },
        input.registration,
        schedule,
        new Map(),
        new Map(),
      ),
    )
    expect(indexed.get(schedule[0]!.obligationId)?.map((row) => row.witness)).toEqual(observations)
    expect(indexed.get(schedule[1]!.obligationId)?.map((row) => row.witness)).toEqual([observations[1]])
  })

  test('controller visibility selects the first correct retained observation for the exact source time', () => {
    const { cut } = emptySourceCutFixture()
    const witness = {
      kind: 'CONTROLLER' as const,
      sourceHash: testHash('pass'),
      sourceAt: '2026-11-02T14:31:00.000Z',
      witnessedAt: '2026-11-02T14:31:01.000Z',
      correct: true,
    }
    const later = { ...witness, witnessedAt: '2026-11-02T14:31:02.000Z' }
    const earliest = earliestDurableWitnesses({
      ...cut,
      durableObservations: [
        later,
        { ...witness, correct: false },
        witness,
        { ...witness, witnessedAt: '2027-01-01T00:00:00.000Z' },
      ],
    })
    expect(earliest.size).toBe(1)
    expect(earliest.get(`CONTROLLER:${witness.sourceHash}:${witness.sourceAt}`)).toBe(witness)
  })
})
