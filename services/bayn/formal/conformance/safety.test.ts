import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import { Authority, KillState, OrderSide, RiskOutcome } from '../../src/execution/contracts'
import { MutationOperation } from '../../src/broker/alpaca-mutations/model'
import { orderRequestBody } from '../../src/broker/alpaca-mutations/decisions'
import { mutationIdResult } from '../../src/execution/mutations/decisions'
import { MutationEventSchema, MutationEventType } from '../../src/execution/mutations/model'
import { nativeOrderSafetyFixture } from '../../src/system-assessment/operational-safety-orders.test-support'
import { testHash } from '../../src/system-assessment/fixtures.test-support'
import { formalModelExecutable, runFormalModel as model } from '../../src/system-assessment/formal-model.test-support'

const formal = formalModelExecutable === undefined ? describe.skip : describe
formal('native auditor consumes original admission and routing evidence', () => {
  test('detects kill restrictions, foreign generations, late admission and late transmission in the full scan', async () => {
    const f = await nativeOrderSafetyFixture()
    const plan = f.plans.get(f.id)
    if (plan === undefined) throw Error('Missing native plan')
    const cutoff = Date.parse(plan.submissionDeadlineAt)
    const cases = Object.values(Authority).flatMap((effective) =>
      Object.values(KillState).flatMap((kill) =>
        [false, true].flatMap((foreign) =>
          [-1, 0, 1].flatMap((offset) =>
            [-1, 0, 1].map((routeOffset) => ({
              effective,
              kill,
              foreign,
              started: new Date(cutoff + offset).toISOString(),
              dispatched: new Date(cutoff + routeOffset).toISOString(),
            })),
          ),
        ),
      ),
    )
    const orderedCases = cases.filter((row) => row.started <= row.dispatched)
    const expectedAuthority = model(
      orderedCases.map((row) => ({
        operation: 'mutationAuthority',
        mutationOperation: MutationOperation.Submit,
        closeOnly: f.target.side === OrderSide.Sell,
        authority: {
          maximum: f.authority.maximum,
          effective: row.effective,
          killState: row.kill,
          generationHash: row.foreign ? testHash('foreign') : f.authority.generation_hash,
          generationMaximum: Authority.Execution,
          generationAccountId: f.target.accountId,
        },
      })),
    )
    const expectedTiming = model(
      orderedCases.map((row) => ({
        operation: 'nativeAuditTiming',
        approved: f.delta.evaluation.decision.outcome === RiskOutcome.Approved,
        decided: String(Date.parse(f.delta.evaluation.decision.decidedAt)),
        started: String(Date.parse(row.started)),
        expires: String(Date.parse(f.delta.evaluation.decision.expiresAt)),
        cutoff: String(cutoff),
        routeStarted: String(Date.parse(row.started)),
        dispatched: String(Date.parse(row.dispatched)),
      })),
    )
    const observed = orderedCases.map((row, index) => {
      const material = {
        schemaVersion: 'bayn.paper-mutation-event.v1',
        mutationId: Result.getOrThrow(mutationIdResult(f.id, MutationOperation.Submit)),
        intentId: f.id,
        sequence: 1,
        operation: MutationOperation.Submit,
        eventType: MutationEventType.SubmitStarted,
        requestHash: testHash(Result.getOrThrow(orderRequestBody(f.intent))),
        consistencyDelayMs: 1000,
        occurredAt: row.started,
        routing: {
          startedAt: row.started,
          requestDispatchedAt: row.dispatched,
          completedAt: new Date(cutoff + 2).toISOString(),
        },
      }
      const event = Schema.decodeUnknownSync(MutationEventSchema)({ ...material, eventId: testHash(material) })
      const authority = {
        ...f.authority,
        effective: row.effective,
        kill_state: row.kill,
        generation_hash: row.foreign ? testHash('foreign') : f.authority.generation_hash,
      }
      const audit = f.scan(
        {
          ...f.source,
          admissions: [
            {
              eventId: event.eventId,
              intentId: f.id,
              authorityGenerationHash: f.authority.generation_hash,
              capturedAt: row.started,
              authority,
            },
          ],
        },
        [
          {
            event,
            authorityGenerationHash: f.authority.generation_hash,
            strategyDecisionHash: f.document.bindings.strategyDecisionHash,
          },
        ],
      )
      const passed = (code: string) => {
        const check = audit.checks.find((check) => check.code === code)
        if (check === undefined) throw Error(`Native auditor omitted ${code}`)
        return check.status === 'PASS'
      }
      expect(passed('AUTHORIZED_MUTATION')).toBe(expectedAuthority[index] !== null && !row.foreign)
      return { admission: passed('ORIGINAL_APPROVED_RISK_AND_DEADLINE'), routing: passed('TRANSMISSION_BEFORE_EXPIRY') }
    })
    expect(expectedTiming).toEqual(observed)
    expect(observed.some((row) => row.admission && row.routing)).toBe(true)
    expect(observed.some((row) => !row.admission && !row.routing)).toBe(true)
  })
})
