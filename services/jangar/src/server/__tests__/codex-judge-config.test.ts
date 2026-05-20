import { afterEach, describe, expect, it } from 'vitest'

import { loadCodexJudgeConfig } from '~/server/codex-judge-config'

const managedEnvKeys = [
  'AGENTS_CODEX_AGENT_RUN_NAMESPACE',
  'AGENTS_SYSTEM_IMPROVEMENT_ORCHESTRATION',
  'AGENTS_SYSTEM_IMPROVEMENT_ORCHESTRATION_NAMESPACE',
  'JANGAR_CODEX_WORKFLOW_NAMESPACE',
  'JANGAR_SYSTEM_IMPROVEMENT_ORCHESTRATION',
  'JANGAR_SYSTEM_IMPROVEMENT_ORCHESTRATION_NAMESPACE',
] as const

const originalEnv = new Map<string, string | undefined>()

for (const key of managedEnvKeys) {
  originalEnv.set(key, process.env[key])
}

afterEach(() => {
  for (const key of managedEnvKeys) {
    const original = originalEnv.get(key)
    if (original === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = original
    }
  }
})

describe('codex-judge-config', () => {
  it('uses an AgentRun-native namespace config field for AgentRun callbacks', () => {
    process.env.AGENTS_CODEX_AGENT_RUN_NAMESPACE = 'agents'
    process.env.JANGAR_CODEX_WORKFLOW_NAMESPACE = 'legacy'

    expect(loadCodexJudgeConfig()).toMatchObject({
      agentRunNamespace: 'agents',
      systemImprovementOrchestrationNamespace: 'agents',
    })
  })

  it('ignores the old workflow namespace env after Codex judge moved to AgentRun-native callbacks', () => {
    delete process.env.AGENTS_CODEX_AGENT_RUN_NAMESPACE
    process.env.JANGAR_CODEX_WORKFLOW_NAMESPACE = 'legacy'

    expect(loadCodexJudgeConfig()).toMatchObject({
      agentRunNamespace: null,
      systemImprovementOrchestrationNamespace: 'jangar',
    })
  })

  it('uses only Agents-owned orchestration env names for system-improvement dispatch', () => {
    process.env.AGENTS_SYSTEM_IMPROVEMENT_ORCHESTRATION = 'agents-system'
    process.env.AGENTS_SYSTEM_IMPROVEMENT_ORCHESTRATION_NAMESPACE = 'agents'

    expect(loadCodexJudgeConfig()).toMatchObject({
      systemImprovementOrchestrationName: 'agents-system',
      systemImprovementOrchestrationNamespace: 'agents',
    })
  })

  it('ignores removed Jangar system-improvement orchestration env aliases', () => {
    delete process.env.AGENTS_SYSTEM_IMPROVEMENT_ORCHESTRATION
    delete process.env.AGENTS_SYSTEM_IMPROVEMENT_ORCHESTRATION_NAMESPACE
    process.env.JANGAR_SYSTEM_IMPROVEMENT_ORCHESTRATION = 'legacy-system'
    process.env.JANGAR_SYSTEM_IMPROVEMENT_ORCHESTRATION_NAMESPACE = 'agents'

    expect(loadCodexJudgeConfig()).toMatchObject({
      systemImprovementOrchestrationName: null,
      systemImprovementOrchestrationNamespace: 'jangar',
    })
  })
})
