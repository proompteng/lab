import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { checkProperty } from '../testing/property-test-support'
import {
  measureReliability,
  ObligationClass,
  ObligationOutcome,
  ReliabilityStatus,
  reliabilityFraction,
} from './reliability'

const id = (index: number) => index.toString(16).padStart(64, '0')
const dueAt = '2026-10-01T14:00:00.000Z'
const deadlineAt = '2026-10-01T14:00:30.000Z'
const asOf = '2026-10-01T14:01:00.000Z'
const schedule = Object.values(ObligationClass).map((kind, index) => ({
  obligationId: id(index),
  class: kind,
  dueAt,
  deadlineAt,
  scheduleEvidenceHash: id(100),
}))
const completions = schedule.map((item) => ({
  obligationId: item.obligationId,
  outcome: ObligationOutcome.Correct,
  completedAt: deadlineAt,
  evidenceHash: id(101),
}))

describe('system reliability', () => {
  test('requires each class independently and permits completion exactly at its deadline', () => {
    const result = Result.getOrThrow(measureReliability({ asOf, schedule, completions }))
    expect(result.status).toBe(ReliabilityStatus.MeetsTarget)
    expect(result.classes.every((item) => item.correctOnTime === '1' && item.scheduled === '1')).toBe(true)
  })

  test('counts scheduled work that never started instead of shrinking the denominator', () => {
    const result = Result.getOrThrow(measureReliability({ asOf, schedule, completions: completions.slice(1) }))
    expect(result.status).toBe(ReliabilityStatus.MissesTarget)
    expect(result.classes[0]?.scheduled).toBe('1')
    expect(result.classes[0]?.missed).toEqual([id(0)])
  })

  test('an empty class does not report perfect reliability', () => {
    expect(Result.getOrThrow(measureReliability({ asOf, schedule: [], completions: [] })).status).toBe(
      ReliabilityStatus.Undetermined,
    )
    expect(
      Result.getOrThrow(measureReliability({ asOf, schedule: schedule.slice(1), completions: completions.slice(1) }))
        .status,
    ).toBe(ReliabilityStatus.Undetermined)
  })

  test('a safe failure and a late recovery are not successful service', () => {
    const failed = completions.map((item) =>
      item.obligationId === id(0) ? { ...item, outcome: ObligationOutcome.Failed } : item,
    )
    const late = completions.map((item) =>
      item.obligationId === id(3) ? { ...item, completedAt: '2026-10-01T14:00:30.001Z' } : item,
    )
    expect(Result.getOrThrow(measureReliability({ asOf, schedule, completions: failed })).status).toBe(
      ReliabilityStatus.MissesTarget,
    )
    expect(Result.getOrThrow(measureReliability({ asOf, schedule, completions: late })).status).toBe(
      ReliabilityStatus.MissesTarget,
    )
  })

  test('pending work cannot establish a complete observation window', () => {
    expect(Result.getOrThrow(measureReliability({ asOf: dueAt, schedule, completions: [] })).status).toBe(
      ReliabilityStatus.Undetermined,
    )
  })

  test('duplicate, unregistered, premature, and future completions fail validation', () => {
    expect(Result.isFailure(measureReliability({ asOf, schedule: [...schedule, ...schedule], completions }))).toBe(true)
    expect(
      Result.isFailure(measureReliability({ asOf, schedule, completions: [...completions, ...completions] })),
    ).toBe(true)
    for (const patch of [
      { obligationId: id(500) },
      { completedAt: '2026-10-01T13:59:59.999Z' },
      { completedAt: '2026-10-01T14:01:00.001Z' },
    ]) {
      const changed = completions.map((item, index) => (index === 0 ? { ...item, ...patch } : item))
      expect(Result.isFailure(measureReliability({ asOf, schedule, completions: changed }))).toBe(true)
    }
  })

  test('99.9 percent uses exact integer comparisons, including small populations', () => {
    expect(reliabilityFraction(999n, 1000n)).toBe(ReliabilityStatus.MeetsTarget)
    expect(reliabilityFraction(998n, 1000n)).toBe(ReliabilityStatus.MissesTarget)
    expect(reliabilityFraction(998n, 999n)).toBe(ReliabilityStatus.MissesTarget)
    expect(reliabilityFraction(0n, 0n)).toBe(ReliabilityStatus.Undetermined)
  })

  test('property: the ratio gate equals the integer failure budget', () => {
    checkProperty(
      'system-reliability-budget',
      fc.property(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 0, max: 100_000 }), (scheduled, sample) => {
        const bad = sample % (scheduled + 1)
        expect(reliabilityFraction(BigInt(scheduled - bad), BigInt(scheduled)) === ReliabilityStatus.MeetsTarget).toBe(
          bad <= Math.floor(scheduled / 1000),
        )
      }),
    )
  })
})
