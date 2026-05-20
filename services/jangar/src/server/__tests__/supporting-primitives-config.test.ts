import { describe, expect, it } from 'vitest'

import { SWARM_SCHEDULE_ANNOTATION_NATS_SUBJECT_PREFIX } from '@proompteng/agent-contracts/swarm-contracts'

import { resolveSupportingPrimitivesConfig } from '../supporting-primitives-config'
import { resolveScheduleRuntimeInjection, resolveSwarmNatsIntegration } from '../supporting-primitives-swarm-config'

describe('resolveSupportingPrimitivesConfig', () => {
  it('defaults runtime admission status to the Agents status contract without legacy projections', () => {
    const config = resolveSupportingPrimitivesConfig({})

    expect(config.runtimeAdmissionStatusUrl).toBe('http://agents.agents.svc.cluster.local/v1/control-plane/status')
  })

  it('keeps explicit runtime admission URLs configurable for Jangar domain consumers', () => {
    const config = resolveSupportingPrimitivesConfig({
      JANGAR_RUNTIME_ADMISSION_STATUS_URL:
        'http://agents.agents.svc.cluster.local/v1/control-plane/status?view=schedule-runner',
    })

    expect(config.runtimeAdmissionStatusUrl).toBe(
      'http://agents.agents.svc.cluster.local/v1/control-plane/status?view=schedule-runner',
    )
  })

  it('does not retain generic Agent runner image ownership in Jangar config', () => {
    const config = resolveSupportingPrimitivesConfig({
      JANGAR_AGENT_RUNNER_IMAGE: 'registry.example/old-jangar-runner:tag',
      JANGAR_AGENT_IMAGE: 'registry.example/old-jangar-agent:tag',
    })

    expect('defaultWorkloadImage' in config).toBe(false)
  })

  it('normalizes legacy swarm NATS prefixes to the AgentRun subject family', () => {
    expect(resolveSupportingPrimitivesConfig({}).swarmDefaultNatsSubjectPrefix).toBe('agentrun')
    expect(
      resolveSupportingPrimitivesConfig({
        JANGAR_SWARM_NATS_SUBJECT_PREFIX: 'agents.agent_messages',
      }).swarmDefaultNatsSubjectPrefix,
    ).toBe('agentrun')
    expect(
      resolveSupportingPrimitivesConfig({
        JANGAR_SWARM_NATS_SUBJECT_PREFIX: 'workflow',
      }).swarmDefaultNatsSubjectPrefix,
    ).toBe('agentrun')
  })

  it('normalizes Swarm spec NATS prefixes to the AgentRun subject family', () => {
    const integration = resolveSwarmNatsIntegration(
      {
        integrations: {
          nats: {
            subjectPrefix: 'agents.agent_messages',
          },
        },
      },
      {},
      'runtime',
    )

    expect(integration.subjectPrefix).toBe('agentrun')
  })

  it('normalizes Swarm schedule annotation NATS prefixes to the AgentRun subject family', () => {
    const injection = resolveScheduleRuntimeInjection({
      metadata: {
        annotations: {
          [SWARM_SCHEDULE_ANNOTATION_NATS_SUBJECT_PREFIX]: 'agents.agentrun',
        },
      },
    })

    expect(injection.parameters.natsSubjectPrefix).toBe('agentrun')
  })
})
