import { nativeOrderSafetyFixture } from './operational-safety-orders.test-support'
import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { Authority, KillState } from '../execution/contracts'
import { SafetyViolationKind } from './assessment'
import { makeOperationalSafetyScan, nativeSafetyCoverage, SafetyCheckStatus } from './operational-safety'
import { nativeSafetyFixture } from './operational-safety.test-support'
import { evaluateOperationalAssessment } from './operational-assessment'
import { testHash } from './fixtures.test-support'
import type { OperationalSafetySource } from './operational-safety-source'
import { ReliabilityStatus } from './reliability'
import { orderRequestBody } from '../broker/alpaca-mutations/decisions'
import { MutationOperation } from '../broker/alpaca-mutations/model'
import { mutationIdResult } from '../execution/mutations/decisions'
import { MutationEventSchema, MutationEventType } from '../execution/mutations/model'

const changed = (f: ReturnType<typeof nativeSafetyFixture>, safety: OperationalSafetySource) => ({
  ...f.cut,
  sourceMaterial: { ...f.sourceMaterial, safety },
  sourceMaterialHash: testHash({ ...f.sourceMaterial, safety }),
})

test('native safety derives complete zero-action coverage while missed service remains a failed operating claim', () => {
  const f = nativeSafetyFixture()
  const report = Result.getOrThrow(evaluateOperationalAssessment(f.input, f.cut, f.verifiedSources))
  expect(report.safety.coverage).toBe('COMPLETE')
  expect(report.safety.pass).toBe(true)
  expect(report.safety.violations).toEqual([])
  for (const kind of Object.values(SafetyViolationKind))
    expect(report.nativeSafetyAudit?.checks.some((check) => check.kind === kind)).toBe(true)
  expect(report.reliability.status).toBe(ReliabilityStatus.MissesTarget)
  expect(report.verdict).toBe('REJECTED')
  expect(report.economicQualification).toBe('NOT_ASSESSED')
})

test('current admission cannot use a supplied clean safety declaration or unrelated verified files', () => {
  const f = nativeSafetyFixture()
  expect(
    Result.isFailure(
      evaluateOperationalAssessment(
        { ...f.input, safety: { coverage: 'COMPLETE', violations: [] } },
        f.cut,
        f.verifiedSources,
      ),
    ),
  ).toBe(true)
  const { safety: _safety, ...sourceMaterial } = f.sourceMaterial
  const cut = { ...f.cut, sourceMaterial, sourceMaterialHash: testHash(sourceMaterial) }
  const report = Result.getOrThrow(
    evaluateOperationalAssessment(
      { ...f.input, sourceCutHash: testHash(cut) },
      cut,
      new Set([...f.verifiedSources, testHash('unrelated clean report')]),
    ),
  )
  expect(report.safety.pass).toBe(false)
  expect(report.safety.coverage).toBe('INCOMPLETE')
  expect(report.missing).toContain('INCOMPLETE_SAFETY_AUDIT')
})

test('gaps, missing prospective baselines and a substituted account cannot certify native safety', () => {
  for (const kind of ['baseline', 'gap', 'account'] as const) {
    const f = nativeSafetyFixture()
    const safety = {
      ...f.safety,
      ...(kind === 'baseline'
        ? { baseline: null }
        : kind === 'gap'
          ? { authority: { ...f.authority, version: 3 } }
          : { accountId: 'foreign-account' }),
    }
    const audit = Result.getOrThrow(
      Result.getOrThrow(makeOperationalSafetyScan(changed(f, safety), f.registration)).finish(),
    )
    expect(audit.coverage === 'INCOMPLETE' || audit.violations.length > 0).toBe(true)
  }
})

test('complete authority history preserves a safe hold and recovery rather than requiring unchanged authority', () => {
  const f = nativeSafetyFixture()
  const before = f.authority
  const hold = {
    ...before,
    effective: Authority.Observe,
    kill_state: KillState.Active,
    reason: 'operator hold',
    version: 2,
  }
  const clear = { ...before, version: 3 }
  const safety = {
    ...f.safety,
    authorityTransitions: [
      { capturedAt: f.cut.asOf, previous: before, authority: hold },
      { capturedAt: f.cut.asOf, previous: hold, authority: clear },
    ],
    authority: clear,
  }
  const audit = Result.getOrThrow(
    Result.getOrThrow(makeOperationalSafetyScan(changed(f, safety), f.registration)).finish(),
  )
  expect(audit.coverage).toBe('COMPLETE')
  expect(audit.violations).toEqual([])
})

test('every defined safety class needs coverage and a known violation cannot become zero', () => {
  const checks = Object.values(SafetyViolationKind).map((kind) => ({ kind, status: SafetyCheckStatus.Pass }))
  expect(nativeSafetyCoverage([])).toBe('INCOMPLETE')
  expect(nativeSafetyCoverage(checks)).toBe('COMPLETE')
  for (const kind of Object.values(SafetyViolationKind)) {
    expect(nativeSafetyCoverage(checks.filter((check) => check.kind !== kind))).toBe('INCOMPLETE')
    expect(
      nativeSafetyCoverage(
        checks.map((check) => ({
          ...check,
          status: check.kind === kind ? SafetyCheckStatus.Incomplete : check.status,
        })),
      ),
    ).toBe('INCOMPLETE')
  }
})

test('native approved orders reject excess fill quantity and substituted client identity', async () => {
  const { scan, source, rawFills, rawOrders, target, entry, plans, id, document, intent, authority } =
    await nativeOrderSafetyFixture()
  const valid = scan(source)
  expect(valid.checks.filter((check) => check.status === 'VIOLATION')).toEqual([])
  expect(valid.checks.some((check) => check.code === 'NATIVE_LIMIT_AND_SIDE' && check.status === 'PASS')).toBe(true)
  const overfilled = {
    ...source,
    fills: rawFills.map((row, index) =>
      index === 0
        ? { ...row, fill: { ...row.fill, quantityAtoms: (BigInt(target.quantityAtoms) + 1n).toString() } }
        : row,
    ),
  }
  expect(
    scan(overfilled).checks.some(
      (check) => check.code === 'FILLS_WITHIN_SEALED_QUANTITY' && check.status === 'VIOLATION',
    ),
  ).toBe(true)
  const substituted = {
    ...source,
    orders: rawOrders.map((row) => ({ ...row, order: { ...row.order, clientOrderId: 'substituted' } })),
  }
  expect(() => scan(substituted)).toThrow('Broker protection group differs from its sealed native terms')
  const admission = (occurredAt: string) => {
    const material = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      mutationId: Result.getOrThrow(mutationIdResult(id, MutationOperation.Submit)),
      intentId: id,
      sequence: 1,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitStarted,
      requestHash: testHash(Result.getOrThrow(orderRequestBody(intent))),
      consistencyDelayMs: 1000,
      occurredAt,
      routing: { startedAt: occurredAt, requestDispatchedAt: occurredAt, completedAt: occurredAt },
    }
    const event = Schema.decodeUnknownSync(MutationEventSchema)({ ...material, eventId: testHash(material) })
    return {
      authorityGenerationHash: document.bindings.authorityGenerationHash,
      strategyDecisionHash: document.bindings.strategyDecisionHash,
      event,
    }
  }
  const started = admission(entry.at(2))
  const withReceipt = {
    ...source,
    admissions: [
      {
        eventId: started.event.eventId,
        intentId: id,
        authorityGenerationHash: document.bindings.authorityGenerationHash,
        capturedAt: entry.at(2),
        authority,
      },
    ],
  }
  expect(
    scan(withReceipt, [started]).checks.some(
      (check) => check.code === 'AUTHORIZED_MUTATION' && check.status === 'PASS',
    ),
  ).toBe(true)
  const blocked = {
    ...withReceipt,
    admissions: [
      {
        ...withReceipt.admissions[0]!,
        authority: { ...authority, effective: Authority.Observe, kill_state: KillState.Active, reason: 'hold' },
      },
    ],
  }
  expect(
    scan(blocked, [started]).checks.some(
      (check) => check.code === 'AUTHORIZED_MUTATION' && check.status === 'VIOLATION',
    ),
  ).toBe(true)
  const late = admission(plans.get(id)!.submissionDeadlineAt)
  expect(
    scan(
      {
        ...withReceipt,
        admissions: [
          {
            eventId: late.event.eventId,
            intentId: id,
            authorityGenerationHash: document.bindings.authorityGenerationHash,
            capturedAt: late.event.occurredAt,
            authority,
          },
        ],
      },
      [late],
    ).checks.some((check) => check.code === 'ORIGINAL_APPROVED_RISK_AND_DEADLINE' && check.status === 'VIOLATION'),
  ).toBe(true)
})
