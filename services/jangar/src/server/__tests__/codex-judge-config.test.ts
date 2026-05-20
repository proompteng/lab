import { afterEach, describe, expect, it } from 'vitest'

import { loadCodexJudgeConfig } from '~/server/codex-judge-config'

const managedEnvKeys = [
  'AGENTS_CODEX_RERUN_ORCHESTRATION',
  'AGENTS_CODEX_RERUN_ORCHESTRATION_NAMESPACE',
  'AGENTS_SYSTEM_IMPROVEMENT_ORCHESTRATION',
  'AGENTS_SYSTEM_IMPROVEMENT_ORCHESTRATION_NAMESPACE',
  'JANGAR_CODEX_RERUN_ORCHESTRATION',
  'JANGAR_CODEX_RERUN_ORCHESTRATION_NAMESPACE',
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
  it('prefers Agents-owned orchestration env names and keeps Jangar aliases transitional', () => {
    process.env.AGENTS_CODEX_RERUN_ORCHESTRATION = 'agents-rerun'
    process.env.AGENTS_CODEX_RERUN_ORCHESTRATION_NAMESPACE = 'agents'
    process.env.AGENTS_SYSTEM_IMPROVEMENT_ORCHESTRATION = 'agents-system'
    process.env.AGENTS_SYSTEM_IMPROVEMENT_ORCHESTRATION_NAMESPACE = 'agents'
    process.env.JANGAR_CODEX_RERUN_ORCHESTRATION = 'jangar-rerun'
    process.env.JANGAR_CODEX_RERUN_ORCHESTRATION_NAMESPACE = 'jangar'
    process.env.JANGAR_SYSTEM_IMPROVEMENT_ORCHESTRATION = 'jangar-system'
    process.env.JANGAR_SYSTEM_IMPROVEMENT_ORCHESTRATION_NAMESPACE = 'jangar'

    expect(loadCodexJudgeConfig()).toMatchObject({
      rerunOrchestrationName: 'agents-rerun',
      rerunOrchestrationNamespace: 'agents',
      systemImprovementOrchestrationName: 'agents-system',
      systemImprovementOrchestrationNamespace: 'agents',
    })
  })

  it('keeps old Jangar orchestration env aliases working for one compatibility release', () => {
    delete process.env.AGENTS_CODEX_RERUN_ORCHESTRATION
    delete process.env.AGENTS_CODEX_RERUN_ORCHESTRATION_NAMESPACE
    delete process.env.AGENTS_SYSTEM_IMPROVEMENT_ORCHESTRATION
    delete process.env.AGENTS_SYSTEM_IMPROVEMENT_ORCHESTRATION_NAMESPACE
    process.env.JANGAR_CODEX_RERUN_ORCHESTRATION = 'legacy-rerun'
    process.env.JANGAR_CODEX_RERUN_ORCHESTRATION_NAMESPACE = 'agents'
    process.env.JANGAR_SYSTEM_IMPROVEMENT_ORCHESTRATION = 'legacy-system'
    process.env.JANGAR_SYSTEM_IMPROVEMENT_ORCHESTRATION_NAMESPACE = 'agents'

    expect(loadCodexJudgeConfig()).toMatchObject({
      rerunOrchestrationName: 'legacy-rerun',
      rerunOrchestrationNamespace: 'agents',
      systemImprovementOrchestrationName: 'legacy-system',
      systemImprovementOrchestrationNamespace: 'agents',
    })
  })
})
