import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  normalizeWorkflowStatus,
  parseWorkflowSteps,
  setWorkflowPhase,
  setWorkflowStepPhase,
  shouldRetryStep,
  validateParameters,
  validateWorkflowSteps,
  type WorkflowStatus,
  type WorkflowStepSpec,
} from '~/server/agents-controller/workflow'

afterEach(() => {
  vi.useRealTimers()
})

describe('agents controller workflow module', () => {
  it('parses workflow steps with normalized numeric fields and string parameters', () => {
    const parsed = parseWorkflowSteps({
      spec: {
        workflow: {
          steps: [
            {
              name: 'build',
              implementationSpecRef: { name: 'impl-build' },
              implementation: { inline: { text: 'do work' } },
              workload: { image: 'ghcr.io/acme/build:1' },
              parameters: {
                keep: 'yes',
                drop: 1,
              },
              retries: -2.7,
              retryBackoffSeconds: 4.9,
              timeoutSeconds: '11',
            },
            {
              implementationSpecRef: { name: 'missing-name' },
            },
          ],
        },
      },
    })

    expect(parsed).toEqual([
      {
        name: 'build',
        implementationSpecRefName: 'impl-build',
        implementationInline: { text: 'do work' },
        parameters: { keep: 'yes' },
        workload: { image: 'ghcr.io/acme/build:1' },
        retries: 0,
        retryBackoffSeconds: 4,
        timeoutSeconds: 11,
      },
    ])
  })

  it('validates run parameters bounds and types', () => {
    const tooManyEntries = Object.fromEntries(Array.from({ length: 101 }, (_value, index) => [`k${index}`, 'v']))
    expect(validateParameters(tooManyEntries)).toEqual({
      ok: false,
      reason: 'ParametersTooLarge',
      message: 'spec.parameters exceeds 100 entries',
    })

    expect(validateParameters({ a: 1 })).toEqual({
      ok: false,
      reason: 'ParameterNotString',
      message: 'spec.parameters.a must be a string',
    })

    expect(validateParameters({ a: 'x'.repeat(2049) })).toEqual({
      ok: false,
      reason: 'ParameterValueTooLarge',
      message: 'spec.parameters.a exceeds 2048 bytes',
    })

    expect(validateParameters({ a: 'ok' })).toEqual({ ok: true })
  })

  it('validates workflow step list and duplicate names', () => {
    expect(validateWorkflowSteps([])).toEqual({
      ok: false,
      reason: 'MissingWorkflowSteps',
      message: 'spec.workflow.steps must include at least one step for workflow runtime',
    })

    const duplicate: WorkflowStepSpec[] = [
      {
        name: 'build',
        implementationSpecRefName: null,
        implementationInline: null,
        parameters: {},
        workload: null,
        retries: 0,
        retryBackoffSeconds: 0,
        timeoutSeconds: 0,
      },
      {
        name: 'build',
        implementationSpecRefName: null,
        implementationInline: null,
        parameters: {},
        workload: null,
        retries: 0,
        retryBackoffSeconds: 0,
        timeoutSeconds: 0,
      },
    ]

    expect(validateWorkflowSteps(duplicate)).toEqual({
      ok: false,
      reason: 'WorkflowStepDuplicate',
      message: 'workflow step name build is duplicated',
    })
  })

  it('propagates parameter validation failures with step context', () => {
    const steps: WorkflowStepSpec[] = [
      {
        name: 'build',
        implementationSpecRefName: null,
        implementationInline: null,
        parameters: {
          foo: 'ok',
          bar: 'x'.repeat(2049),
        },
        workload: null,
        retries: 0,
        retryBackoffSeconds: 0,
        timeoutSeconds: 0,
      },
    ]

    expect(validateWorkflowSteps(steps)).toEqual({
      ok: false,
      reason: 'ParameterValueTooLarge',
      message: 'workflow step build: spec.parameters.bar exceeds 2048 bytes',
    })
  })

  it('normalizes workflow status from existing values and defaults', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'))

    const steps: WorkflowStepSpec[] = [
      {
        name: 'build',
        implementationSpecRefName: null,
        implementationInline: null,
        parameters: {},
        workload: null,
        retries: 0,
        retryBackoffSeconds: 0,
        timeoutSeconds: 0,
      },
      {
        name: 'test',
        implementationSpecRefName: null,
        implementationInline: null,
        parameters: {},
        workload: null,
        retries: 0,
        retryBackoffSeconds: 0,
        timeoutSeconds: 0,
      },
    ]

    const normalized = normalizeWorkflowStatus(
      {
        phase: 'Running',
        lastTransitionTime: '2025-12-01T00:00:00.000Z',
        steps: [
          {
            name: 'build',
            phase: 'Succeeded',
            attempt: 2,
            startedAt: '2025-12-01T00:00:00.000Z',
            finishedAt: '2025-12-01T00:10:00.000Z',
            lastTransitionTime: '2025-12-01T00:10:00.000Z',
            message: 'done',
            jobRef: { type: 'Job', name: 'build-job' },
            jobObservedAt: '2025-12-01T00:10:00.000Z',
            nextRetryAt: '2025-12-01T00:11:00.000Z',
          },
        ],
      },
      steps,
    )

    expect(normalized.phase).toBe('Running')
    expect(normalized.lastTransitionTime).toBe('2025-12-01T00:00:00.000Z')
    expect(normalized.steps).toEqual([
      {
        name: 'build',
        phase: 'Succeeded',
        attempt: 2,
        startedAt: '2025-12-01T00:00:00.000Z',
        finishedAt: '2025-12-01T00:10:00.000Z',
        lastTransitionTime: '2025-12-01T00:10:00.000Z',
        message: 'done',
        jobRef: { type: 'Job', name: 'build-job' },
        jobObservedAt: '2025-12-01T00:10:00.000Z',
        nextRetryAt: '2025-12-01T00:11:00.000Z',
      },
      {
        name: 'test',
        phase: 'Pending',
        attempt: 0,
        startedAt: undefined,
        finishedAt: undefined,
        lastTransitionTime: '2026-01-02T03:04:05.000Z',
        message: undefined,
        jobRef: undefined,
        jobObservedAt: undefined,
        nextRetryAt: undefined,
      },
    ])
  })

  it('updates workflow and step phase transition times only when phase changes', () => {
    vi.useFakeTimers()

    const workflow: WorkflowStatus = {
      phase: 'Pending',
      lastTransitionTime: '2025-01-01T00:00:00.000Z',
      steps: [],
    }

    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'))
    setWorkflowPhase(workflow, 'Running')
    expect(workflow.phase).toBe('Running')
    expect(workflow.lastTransitionTime).toBe('2026-01-02T03:04:05.000Z')

    vi.setSystemTime(new Date('2026-01-03T03:04:05.000Z'))
    setWorkflowPhase(workflow, 'Running')
    expect(workflow.lastTransitionTime).toBe('2026-01-02T03:04:05.000Z')

    const step = {
      name: 'build',
      phase: 'Pending',
      attempt: 0,
      lastTransitionTime: '2025-01-01T00:00:00.000Z',
      message: undefined,
    }

    vi.setSystemTime(new Date('2026-01-04T03:04:05.000Z'))
    setWorkflowStepPhase(step, 'Running', 'started')
    expect(step.phase).toBe('Running')
    expect(step.lastTransitionTime).toBe('2026-01-04T03:04:05.000Z')
    expect(step.message).toBe('started')

    vi.setSystemTime(new Date('2026-01-05T03:04:05.000Z'))
    setWorkflowStepPhase(step, 'Running')
    expect(step.lastTransitionTime).toBe('2026-01-04T03:04:05.000Z')
  })

  it('evaluates retry readiness from nextRetryAt', () => {
    const now = Date.parse('2026-01-02T00:00:00.000Z')

    expect(shouldRetryStep({ name: 'a', phase: 'Retrying', attempt: 1, lastTransitionTime: 'x' }, now)).toBe(true)
    expect(
      shouldRetryStep(
        {
          name: 'a',
          phase: 'Retrying',
          attempt: 1,
          lastTransitionTime: 'x',
          nextRetryAt: 'not-a-date',
        },
        now,
      ),
    ).toBe(true)
    expect(
      shouldRetryStep(
        {
          name: 'a',
          phase: 'Retrying',
          attempt: 1,
          lastTransitionTime: 'x',
          nextRetryAt: '2026-01-02T01:00:00.000Z',
        },
        now,
      ),
    ).toBe(false)
    expect(
      shouldRetryStep(
        {
          name: 'a',
          phase: 'Retrying',
          attempt: 1,
          lastTransitionTime: 'x',
          nextRetryAt: '2026-01-01T23:00:00.000Z',
        },
        now,
      ),
    ).toBe(true)
  })
})
