import { submitAgentRunToAgentsService } from '@proompteng/agent-contracts/agent-runs-client'

export type TorghutMarketContextProviderDomain = 'fundamentals' | 'news'
export type TorghutMarketContextSnapshotState = 'missing' | 'stale' | 'fresh'

export type TorghutMarketContextAgentRunSettings = {
  onDemandDispatchNamespace: string
  onDemandDispatchServiceAccountName: string
  onDemandDispatchPriorityClassName: string
  onDemandDispatchCallbackUrl: string
  onDemandDispatchTtlSeconds: number
  onDemandDispatchRepository: string
  onDemandDispatchBaseBranch: string
  onDemandDispatchHeadBranch: string
  onDemandDispatchVcsRefName: string
}

export type TorghutMarketContextAgentRunPayloadParams = {
  symbol: string
  domain: TorghutMarketContextProviderDomain
  snapshotState: TorghutMarketContextSnapshotState
  provider: string
  requestId: string
  now: Date
  settings: TorghutMarketContextAgentRunSettings
}

export type TorghutMarketContextAgentRunPayload = {
  namespace: string
  metadata: {
    generateName: string
    labels: Record<string, string>
  }
  agentRef: { name: string }
  implementationSpecRef: { name: string }
  runtime: {
    type: 'job'
    config: {
      serviceAccountName: string
      priorityClassName: string
    }
  }
  ttlSecondsAfterFinished: number
  vcsRef: { name: string }
  vcsPolicy: {
    required: true
    mode: 'read-only'
  }
  workload: {
    resources: {
      requests: {
        cpu: string
        memory: string
      }
      limits: {
        cpu: string
        memory: string
      }
    }
  }
  parameters: {
    executionMode: 'batch_task'
    symbol: string
    domain: TorghutMarketContextProviderDomain
    asOfUtc: string
    reason: string
    provider: string
    callbackUrl: string
    requestId: string
    repository: string
    base: string
    head: string
  }
}

export type TorghutMarketContextAgentsServiceSubmitResult = Awaited<ReturnType<typeof submitAgentRunToAgentsService>>
export type TorghutMarketContextAgentRunSubmitter = typeof submitAgentRunToAgentsService

const resolveAgentRunReferences = (domain: TorghutMarketContextProviderDomain) =>
  domain === 'fundamentals'
    ? {
        agentName: 'torghut-fundamentals-agent',
        implementationSpecName: 'torghut-market-context-fundamentals-v1',
      }
    : {
        agentName: 'torghut-news-agent',
        implementationSpecName: 'torghut-market-context-news-v1',
      }

const parseNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const coercePayload = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

export const buildTorghutMarketContextAgentRunPayload = (
  params: TorghutMarketContextAgentRunPayloadParams,
): TorghutMarketContextAgentRunPayload => {
  const refs = resolveAgentRunReferences(params.domain)
  const symbolName = params.symbol.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  return {
    namespace: params.settings.onDemandDispatchNamespace,
    metadata: {
      generateName: `torghut-market-context-${params.domain}-${symbolName}-`,
      labels: {
        'torghut.proompteng.ai/purpose': 'market-context-on-demand',
        'torghut.proompteng.ai/domain': params.domain,
        'torghut.proompteng.ai/symbol': symbolName,
      },
    },
    agentRef: { name: refs.agentName },
    implementationSpecRef: { name: refs.implementationSpecName },
    runtime: {
      type: 'job',
      config: {
        serviceAccountName: params.settings.onDemandDispatchServiceAccountName,
        priorityClassName: params.settings.onDemandDispatchPriorityClassName,
      },
    },
    ttlSecondsAfterFinished: params.settings.onDemandDispatchTtlSeconds,
    vcsRef: {
      name: params.settings.onDemandDispatchVcsRefName,
    },
    vcsPolicy: {
      required: true,
      mode: 'read-only',
    },
    workload: {
      resources: {
        requests: {
          cpu: '100m',
          memory: '256Mi',
        },
        limits: {
          cpu: '750m',
          memory: '1Gi',
        },
      },
    },
    parameters: {
      executionMode: 'batch_task',
      symbol: params.symbol,
      domain: params.domain,
      asOfUtc: params.now.toISOString(),
      reason: `on_demand_${params.snapshotState}_snapshot_refresh`,
      provider: params.provider,
      callbackUrl: params.settings.onDemandDispatchCallbackUrl,
      requestId: params.requestId,
      repository: params.settings.onDemandDispatchRepository,
      base: params.settings.onDemandDispatchBaseBranch,
      head: params.settings.onDemandDispatchHeadBranch,
    },
  }
}

export const resolveSubmittedTorghutMarketContextAgentRunName = (
  result: TorghutMarketContextAgentsServiceSubmitResult,
): string | null => {
  if (!result.ok || !result.body) return null
  const resource = coercePayload(result.body.resource)
  const resourceMetadata = coercePayload(resource.metadata)
  const resourceName = parseNonEmptyString(resourceMetadata.name)
  if (resourceName) return resourceName

  const agentRun = coercePayload(result.body.agentRun)
  const externalRunId = parseNonEmptyString(agentRun.externalRunId)
  if (externalRunId) return externalRunId

  return parseNonEmptyString(result.body.existingAgentRunName)
}

export const submitTorghutMarketContextAgentRun = async (
  params: TorghutMarketContextAgentRunPayloadParams & {
    submitAgentRun?: TorghutMarketContextAgentRunSubmitter
  },
) => {
  const submitAgentRun = params.submitAgentRun ?? submitAgentRunToAgentsService
  const result = await submitAgentRun({
    deliveryId: params.requestId,
    payload: buildTorghutMarketContextAgentRunPayload(params),
  })
  if (!result.ok) {
    const status = result.status > 0 ? ` (${result.status})` : ''
    throw new Error(result.error ?? `Agents service AgentRun submission failed${status}`)
  }
  return resolveSubmittedTorghutMarketContextAgentRunName(result) ?? params.requestId
}
