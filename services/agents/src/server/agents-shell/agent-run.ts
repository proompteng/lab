import { randomUUID } from 'node:crypto'

import type { AgentsShellConfig } from './config'
import { asPositiveInteger } from './limits'
import type { AgentStartInput } from './schemas'

const slugifyKubernetesName = (value: string) => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'task'
}

const boundedKubernetesName = (parts: string[]) => {
  const suffix = randomUUID().slice(0, 8)
  const prefix = parts.map(slugifyKubernetesName).filter(Boolean).join('-')
  const maxPrefixLength = 63 - suffix.length - 1
  return `${prefix.slice(0, maxPrefixLength).replace(/-+$/g, '')}-${suffix}`
}

const agentRunNameFromInput = (task: string) => boundedKubernetesName(['agents-shell', task])

export const buildAgentRunManifest = (config: AgentsShellConfig, args: AgentStartInput) => {
  const agentRunName = agentRunNameFromInput(args.task)
  const baseBranch = args.baseBranch ?? config.agentBaseBranch
  const headBranch = args.headBranch ?? `codex/${agentRunName}`
  const repository = args.repository ?? config.agentRepository
  const agentName = args.agentName ?? config.agentName
  const tokenBudget = asPositiveInteger(args.tokenBudget, 'tokenBudget', config.agentDefaultTokenBudget, 1_000_000, 1)
  const ttlSecondsAfterFinished = asPositiveInteger(
    args.ttlSecondsAfterFinished,
    'ttlSecondsAfterFinished',
    config.agentDefaultTtlSecondsAfterFinished,
    604_800,
    0,
  )

  return {
    apiVersion: 'agents.proompteng.ai/v1alpha1',
    kind: 'AgentRun',
    metadata: {
      name: agentRunName,
      namespace: config.agentNamespace,
      labels: {
        'app.kubernetes.io/name': 'agents-shell',
        'app.kubernetes.io/component': 'delegated-agent',
      },
    },
    spec: {
      agentRef: { name: agentName },
      implementation: {
        inline: {
          summary: `agents-shell delegated work: ${args.task.slice(0, 200)}`,
          text: args.task,
          acceptanceCriteria: args.acceptanceCriteria,
          source: {
            provider: 'custom',
            externalId: `${repository}:${headBranch}`,
            url: config.resource,
          },
          vcsRef: { name: config.agentVcsRef },
        },
      },
      goal: {
        objective: args.task,
        tokenBudget,
      },
      ttlSecondsAfterFinished,
      parameters: {
        repository,
        base: baseBranch,
        head: headBranch,
        stage: 'implementation',
      },
      runtime: {
        type: 'job',
        config: {
          serviceAccountName: config.agentRuntimeServiceAccount,
        },
      },
      secrets: config.agentSecrets,
      vcsRef: { name: config.agentVcsRef },
      vcsPolicy: {
        required: true,
        mode: 'read-write',
      },
    },
  }
}
