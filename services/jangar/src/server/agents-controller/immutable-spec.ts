import { asRecord } from '~/server/primitives-http'

import { parseStringList } from './env-config'
import { sha256Hex, stableJsonStringifyForHash } from './template-hash'

export const buildAgentRunImmutableSpecSnapshot = (agentRun: Record<string, unknown>) => {
  const spec = asRecord(agentRun.spec) ?? {}
  const secrets = parseStringList(spec.secrets).slice().sort()
  const systemPromptRaw = spec.systemPrompt
  return {
    agentRef: asRecord(spec.agentRef) ?? null,
    implementationSpecRef: asRecord(spec.implementationSpecRef) ?? null,
    implementation: asRecord(spec.implementation) ?? null,
    runtime: asRecord(spec.runtime) ?? null,
    workflow: asRecord(spec.workflow) ?? null,
    secrets,
    systemPrompt: typeof systemPromptRaw === 'string' ? systemPromptRaw : null,
    systemPromptRef: asRecord(spec.systemPromptRef) ?? null,
    vcsRef: asRecord(spec.vcsRef) ?? null,
    memoryRef: asRecord(spec.memoryRef) ?? null,
  }
}

export const hashAgentRunImmutableSpec = (agentRun: Record<string, unknown>) =>
  sha256Hex(stableJsonStringifyForHash(buildAgentRunImmutableSpecSnapshot(agentRun)))
