import { describe, expect, it } from 'vitest'

import { buildScheduleRunnerCommand } from '~/server/supporting-primitives-schedule-runner'

describe('supporting primitives schedule runner', () => {
  it('submits scheduled AgentRun and OrchestrationRun resources through the Agents service', () => {
    const command = buildScheduleRunnerCommand()

    expect(command).toContain('/api/agents/control-plane/resources')
    expect(command).toContain('/api/agents/control-plane/resource')
    expect(command).toContain('x-agents-client')
    expect(command).toContain('jangar-schedule-runner')
    expect(command).toContain('idempotency-key')
    expect(command).not.toContain('/apis/${target.group}')
    expect(command).not.toContain('KUBERNETES_SERVICE_HOST')
    expect(command).not.toContain('/var/run/secrets/kubernetes.io/serviceaccount/token')
    expect(command).not.toContain('node:https')
  })
})
