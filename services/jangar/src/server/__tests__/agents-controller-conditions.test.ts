import { describe, expect, it } from 'vitest'

import {
  type Condition,
  deriveStandardConditionUpdates,
  normalizeConditions,
  upsertCondition,
} from '~/server/agents-controller/conditions'

describe('agents controller conditions module', () => {
  it('normalizes raw condition payloads and fills missing transition times', () => {
    const nowIso = () => '2026-02-24T00:00:00.000Z'
    const conditions = normalizeConditions(
      [
        { type: 'Ready', status: 'True', reason: 'Valid', message: 'ok' },
        { type: 'Invalid', reason: 'MissingStatus' },
      ],
      nowIso,
    )

    expect(conditions).toEqual([
      {
        type: 'Ready',
        status: 'True',
        reason: 'Valid',
        message: 'ok',
        lastTransitionTime: '2026-02-24T00:00:00.000Z',
      },
    ])
  })

  it('upserts condition updates only when values change', () => {
    let tick = 0
    const nowIso = () => `2026-02-24T00:00:0${tick++}.000Z`
    const first = upsertCondition([], { type: 'Ready', status: 'True', reason: 'Valid' }, nowIso)
    const second = upsertCondition(first, { type: 'Ready', status: 'True', reason: 'Valid' }, nowIso)
    const third = upsertCondition(second, { type: 'Ready', status: 'False', reason: 'Invalid' }, nowIso)

    expect(second[0]?.lastTransitionTime).toBe(first[0]?.lastTransitionTime)
    expect(third[0]?.status).toBe('False')
    expect(third[0]?.lastTransitionTime).not.toBe(first[0]?.lastTransitionTime)
  })

  it('derives degraded/progressing/ready based on failed phase', () => {
    const updates = deriveStandardConditionUpdates(
      [{ type: 'Failed', status: 'True', reason: 'SubmitFailed', lastTransitionTime: '2026-02-24T00:00:00.000Z' }],
      'Failed',
    )
    const ready = updates.find((entry) => entry.type === 'Ready')
    const progressing = updates.find((entry) => entry.type === 'Progressing')
    const degraded = updates.find((entry) => entry.type === 'Degraded')

    expect(ready?.status).toBe('False')
    expect(progressing?.status).toBe('False')
    expect(degraded?.status).toBe('True')
    expect(degraded?.reason).toBe('SubmitFailed')
  })

  it('normalizes unknown statuses and defaults empty reason/message values', () => {
    const nowIso = () => '2026-02-24T00:00:00.000Z'
    const conditions = normalizeConditions(
      ['invalid-entry', { type: 'Ready', status: 'Maybe', reason: '   ', message: undefined }],
      nowIso,
    )

    expect(conditions).toEqual([
      {
        type: 'Ready',
        status: 'Unknown',
        reason: 'Reconciled',
        message: '',
        lastTransitionTime: '2026-02-24T00:00:00.000Z',
      },
    ])
  })

  it('derives degraded when Ready is explicitly false', () => {
    const updates = deriveStandardConditionUpdates(
      [
        {
          type: 'Ready',
          status: 'False',
          reason: 'DependenciesMissing',
          lastTransitionTime: '2026-02-24T00:00:00.000Z',
        },
      ],
      null,
    )

    const ready = updates.find((entry) => entry.type === 'Ready')
    const degraded = updates.find((entry) => entry.type === 'Degraded')
    const progressing = updates.find((entry) => entry.type === 'Progressing')

    expect(ready?.status).toBe('False')
    expect(progressing?.status).toBe('False')
    expect(degraded?.status).toBe('True')
    expect(degraded?.reason).toBe('DependenciesMissing')
  })

  it('preserves unknown ready status when ready condition is present but not true/false', () => {
    const updates = deriveStandardConditionUpdates(
      [
        {
          type: 'Ready',
          status: 'Pending',
          reason: 'Reconciling',
          lastTransitionTime: '2026-02-24T00:00:00.000Z',
        } as unknown as Condition,
      ],
      null,
    )

    const ready = updates.find((entry) => entry.type === 'Ready')
    const progressing = updates.find((entry) => entry.type === 'Progressing')
    const degraded = updates.find((entry) => entry.type === 'Degraded')

    expect(ready?.status).toBe('Unknown')
    expect(progressing?.reason).toBe('Progressing')
    expect(degraded?.reason).toBe('Degraded')
  })
})
