import { describe, expect, it } from 'bun:test'

import { projectedMcpToken } from '../cli/run-observation'
import type { Job, Pod, PodSpec } from '../kube/resources'
import { observeRuns, RUN_LABEL } from '../kube/runs'

const name = 'run'
const uid = 'run-uid'
const namespace = 'agents'
const run = {
  metadata: { name, namespace, uid },
  spec: { agentRef: { name: 'codex-agent' }, runtime: { type: 'job' }, parameters: { head: 'codex/feature' } },
  status: { phase: 'Pending' },
}
const labels = { [RUN_LABEL]: name, 'agents.proompteng.ai/run-uid': uid }
const job: Job = { metadata: { name: 'run-job', uid: 'job-uid', namespace, labels } }
const pod: Pod = {
  metadata: {
    name: 'run-pod',
    ownerReferences: [{ kind: 'Job', name: job.metadata.name, uid: job.metadata.uid }],
    namespace,
    labels,
  },
  spec: { nodeName: 'node-arm', serviceAccountName: 'codex-auto-ontology-runner' },
  status: { phase: 'Running' },
}
const observe = (jobs: Job[], pods: Pod[], cr = run) => observeRuns([cr], jobs, pods, namespace)[0]

describe('fleet workload evidence', () => {
  it('joins by owner, run-UID label, and runtimeRef, but not across namespaces or recreated resources', () => {
    const staleJob = {
      ...job,
      metadata: { ...job.metadata, labels: { ...labels, 'agents.proompteng.ai/run-uid': 'old' } },
    }
    expect(observe([staleJob], [pod]).job).toBeUndefined()
    expect(observe([staleJob], [pod]).pod).toBeUndefined()
    expect(observe([{ ...job, metadata: { ...job.metadata, namespace: 'other' } }], [pod]).pod).toBeUndefined()
    expect(
      observe(
        [job],
        [
          {
            ...pod,
            metadata: {
              ...pod.metadata,
              ownerReferences: [{ kind: 'Job', name: job.metadata.name, uid: 'old-job' }],
            },
          },
        ],
      ).pod,
    ).toBeUndefined()

    const ownerJob = {
      ...job,
      metadata: { ...job.metadata, labels: undefined, ownerReferences: [{ kind: 'AgentRun', name, uid }] },
    }
    const ownerPod = { ...pod, metadata: { ...pod.metadata, labels: undefined } }
    expect(observe([ownerJob], [ownerPod]).pod).toEqual(ownerPod)
    const refRun = {
      ...run,
      status: { ...run.status, runtimeRef: { type: 'job', name: job.metadata.name, uid: job.metadata.uid } },
    }
    expect(
      observe([{ ...job, metadata: { ...job.metadata, labels: undefined } }], [ownerPod], refRun).job?.metadata.uid,
    ).toBe(job.metadata.uid)
  })

  it('does not mistake a scheduled Pending pod or a failed attempt for terminal Job status', () => {
    const pending = { ...pod, status: { phase: 'Pending' } }
    const failed = { ...pod, status: { phase: 'Failed' } }
    expect(observe([{ ...job, status: { active: 1 } }], [pending])).toMatchObject({
      jobPhase: 'Pending',
      podPhase: 'Pending',
      active: true,
      pending: true,
      stale: false,
    })
    expect(
      observe([{ ...job, status: { active: 1 } }], [failed, { ...pod, metadata: { ...pod.metadata, name: 'retry' } }]),
    ).toMatchObject({
      observedPhase: 'Running',
      podPhase: 'Running',
      active: true,
      stale: true,
      pod: { metadata: { name: 'retry' } },
    })
    expect(observe([job], [failed]).observedPhase).toBe('Pending')
  })

  it('detects terminal Jobs even before runtimeRef exists and after Pods have been removed', () => {
    for (const [type, phase] of [
      ['Complete', 'Succeeded'],
      ['Failed', 'Failed'],
    ]) {
      expect(observe([{ ...job, status: { conditions: [{ type, status: 'True' }] } }], [])).toMatchObject({
        phase: 'Pending',
        observedPhase: phase,
        active: false,
        pending: false,
        stale: true,
      })
    }
    expect(observe([], [{ ...pod, status: { phase: 'Succeeded' } }])).toMatchObject({
      observedPhase: 'Succeeded',
      active: false,
      stale: true,
    })
  })

  it('does not infer run completion from an intermediate, looping, or retryable workflow Job', () => {
    const steps = [{ name: 'plan' }, { name: 'implement' }]
    const workflowRun = { ...run, spec: { ...run.spec, runtime: { type: 'workflow' }, workflow: { steps } } }
    const done = {
      ...job,
      metadata: { ...job.metadata, labels: { ...labels, 'agents.proompteng.ai/step-index': '1' } },
      status: { succeeded: 1 },
    }
    expect(observe([done], [], workflowRun)).toMatchObject({
      jobPhase: 'Succeeded',
      observedPhase: undefined,
      active: true,
    })
    const final = {
      ...done,
      metadata: { ...done.metadata, labels: { ...labels, 'agents.proompteng.ai/step-index': '2' } },
    }
    const workflowProgress = {
      ...workflowRun,
      status: { phase: 'Running', workflow: { steps: [{ name: 'plan', phase: 'Succeeded' }] } },
    }
    expect(observe([final], [], workflowProgress).observedPhase).toBe('Succeeded')

    for (const step of [
      { name: 'step', retries: 1 },
      { name: 'step', loop: { maxIterations: 2 } },
    ]) {
      const attempt = { ...done, status: { conditions: [{ type: 'Failed', status: 'True' }] } }
      const cr = { ...workflowRun, spec: { ...workflowRun.spec, workflow: { steps: [step] } } }
      expect(observe([attempt], [], cr).observedPhase).toBeUndefined()
    }
  })

  it('prefers the UID-validated runtimeRef attempt over an older timed-out live Job', () => {
    const olderTimedOutJob: Job = {
      metadata: {
        name: 'run-step-1-attempt-1',
        uid: 'attempt-1-uid',
        namespace,
        creationTimestamp: '2026-07-01T00:00:00Z',
        labels: { ...labels, 'agents.proompteng.ai/step-index': '1' },
      },
      status: { active: 1 },
    }
    const replacementCompletedJob: Job = {
      metadata: {
        name: 'run-step-1-attempt-2',
        uid: 'attempt-2-uid',
        namespace,
        creationTimestamp: '2026-07-01T00:05:00Z',
        labels: { ...labels, 'agents.proompteng.ai/step-index': '1' },
      },
      status: { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] },
    }
    const olderPod: Pod = {
      metadata: {
        name: 'run-step-1-attempt-1-pod',
        namespace,
        creationTimestamp: '2026-07-01T00:00:01Z',
        ownerReferences: [{ kind: 'Job', name: olderTimedOutJob.metadata.name, uid: olderTimedOutJob.metadata.uid }],
        labels,
      },
      spec: { nodeName: 'turin', serviceAccountName: 'codex-auto-ontology-runner' },
      status: { phase: 'Running' },
    }
    const replacementPod: Pod = {
      metadata: {
        name: 'run-step-1-attempt-2-pod',
        namespace,
        creationTimestamp: '2026-07-01T00:05:01Z',
        ownerReferences: [
          { kind: 'Job', name: replacementCompletedJob.metadata.name, uid: replacementCompletedJob.metadata.uid },
        ],
        labels,
      },
      spec: { nodeName: 'node-arm', serviceAccountName: 'codex-auto-ontology-runner' },
      status: { phase: 'Succeeded' },
    }
    const workflowRun = {
      ...run,
      spec: { ...run.spec, runtime: { type: 'workflow' }, workflow: { steps: [{ name: 'implement', retries: 1 }] } },
      status: {
        phase: 'Succeeded',
        runtimeRef: {
          type: 'workflow',
          name: replacementCompletedJob.metadata.name,
          uid: replacementCompletedJob.metadata.uid,
        },
      },
    }
    const observed = observe([olderTimedOutJob, replacementCompletedJob], [olderPod, replacementPod], workflowRun)
    expect(observed.job?.metadata.name).toBe('run-step-1-attempt-2')
    expect(observed.pod?.metadata.name).toBe('run-step-1-attempt-2-pod')
    expect(observed.observedPhase).toBe('Succeeded')
  })
})

describe('MCP identity', () => {
  it('requires a read-only token projection wired to the agent-runner path, not the default kube API token', () => {
    const spec: PodSpec = {
      containers: [
        {
          name: 'agent-runner',
          env: [{ name: 'AGENTS_MCP_IDENTITY_TOKEN_PATH', value: '/run/mcp/token' }],
          volumeMounts: [{ name: 'mcp', mountPath: '/run/mcp', readOnly: true }],
        },
      ],
      volumes: [
        {
          name: 'mcp',
          projected: {
            sources: [{ serviceAccountToken: { audience: 'agents.proompteng.ai/auto-ontology-mcp', path: 'token' } }],
          },
        },
      ],
    }
    expect(projectedMcpToken(spec)).toEqual({
      audience: 'agents.proompteng.ai/auto-ontology-mcp',
      mountPath: '/run/mcp',
    })
    expect(projectedMcpToken({ ...spec, containers: [{ ...spec.containers![0], name: 'sidecar' }] })).toBeUndefined()
    expect(
      projectedMcpToken({
        ...spec,
        volumes: [{ name: 'mcp', projected: { sources: [{ serviceAccountToken: { path: 'token' } }] } }],
      }),
    ).toBeUndefined()
  })
})
