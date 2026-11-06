import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'
import {
  measureReliability,
  ObligationClass,
  ObligationOutcome,
  ReliabilityStatus,
} from '../../src/system-assessment/reliability'
import { testHash } from '../../src/system-assessment/fixtures.test-support'
import { formalModelExecutable, runFormalModel as model } from './model'

const formal = formalModelExecutable === undefined ? describe.skip : describe
const at = (ms: number) => new Date(Date.parse('2026-11-06T14:30:00.000Z') + ms).toISOString()
formal('reliability from original obligations and completion witnesses', () => {
  test('reproduces denominators, deadline misses, pending work and empty recovery without accepting supplied counters', () => {
    const samples = fc.sample(
      fc.array(
        fc.record({
          kind: fc.constantFrom(...Object.values(ObligationClass)),
          due: fc.integer({ min: 0, max: 2000 }),
          window: fc.integer({ min: 0, max: 1000 }),
          delay: fc.integer({ min: -1, max: 1100 }),
          outcome: fc.constantFrom('absent', 'correct', 'failed'),
        }),
        { maxLength: 40 },
      ),
      { seed: 261108, numRuns: 80 },
    )
    const cases = samples.map((rows) => ({
      asOf: at(3000),
      schedule: rows.map((row, index) => ({
        obligationId: testHash(index),
        class: row.kind,
        dueAt: at(row.due),
        deadlineAt: at(row.due + row.window),
        scheduleEvidenceHash: testHash('schedule'),
      })),
      completions: rows.flatMap((row, index) =>
        row.outcome === 'absent'
          ? []
          : [
              {
                obligationId: testHash(index),
                outcome: row.outcome === 'correct' ? ObligationOutcome.Correct : ObligationOutcome.Failed,
                completedAt: at(row.due + row.delay),
                evidenceHash: testHash('receipt'),
              },
            ],
      ),
    }))
    for (const count of [390, 999, 1000]) {
      for (const failures of [0, 1, 2]) {
        const schedule = Array.from({ length: count }, (_, index) => ({
          obligationId: testHash(index),
          class: ObligationClass.Decision,
          dueAt: at(0),
          deadlineAt: at(1000),
          scheduleEvidenceHash: testHash('original schedule'),
        }))
        cases.push({
          asOf: at(3000),
          schedule,
          completions: schedule.slice(failures).map((row) => ({
            obligationId: row.obligationId,
            outcome: ObligationOutcome.Correct,
            completedAt: at(1000),
            evidenceHash: testHash('durable receipt'),
          })),
        })
      }
    }
    const first = cases.at(-1),
      obligation = first?.schedule[0],
      completion = first?.completions[0]
    if (first === undefined || obligation === undefined || completion === undefined) throw Error('Missing fixture')
    cases.push(
      { ...first, schedule: [...first.schedule, obligation] },
      { ...first, completions: [...first.completions, completion] },
      { ...first, completions: [{ ...completion, obligationId: testHash('orphan') }] },
      { ...first, asOf: at(500) },
    )
    const expanded = cases.flatMap((input) =>
      [false, true].flatMap((retained) =>
        [false, true].map((recoveryComplete) => ({ input, retained, recoveryComplete })),
      ),
    )
    const expected = expanded.map(({ input, retained, recoveryComplete }) => {
      const result = measureReliability(input, retained, recoveryComplete)
      return Result.isFailure(result) ? null : { status: result.success.status, classes: result.success.classes }
    })
    expect(
      model(
        expanded.map(({ input, retained, recoveryComplete }) => ({
          operation: 'measureWork',
          asOf: String(Date.parse(input.asOf)),
          retained,
          recoveryComplete,
          schedule: input.schedule.map((row) => ({
            id: row.obligationId,
            kind: row.class,
            due: String(Date.parse(row.dueAt)),
            deadline: String(Date.parse(row.deadlineAt)),
          })),
          completions: input.completions.map((row) => ({
            id: row.obligationId,
            at: String(Date.parse(row.completedAt)),
            correct: row.outcome === ObligationOutcome.Correct,
          })),
        })),
      ),
    ).toEqual(expected)
    for (const failures of [0, 1, 2]) {
      const result = Result.getOrThrow(measureReliability(cases[samples.length + failures]))
      expect(result.classes[0]?.status).toBe(
        failures === 0 ? ReliabilityStatus.MeetsTarget : ReliabilityStatus.MissesTarget,
      )
    }
  })
})
