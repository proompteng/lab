import YAML from 'yaml'

type Implementation =
  | { implName: string; implementationText?: never }
  | { implementationText: string; implName?: never }

export type AgentRunParams = Implementation & {
  name?: string
  generateName?: string
  namespace?: string
  agentName: string
  runtimeType: string
  runtimeConfig?: Record<string, string>
  parameters?: Record<string, string>
  memoryRef?: string
  workloadImage?: string
  cpu?: string
  memory?: string
  memoryLimit?: string
  ttl?: number
  secrets?: readonly string[]
  idempotencyKey?: string
  vcsRef?: string
  vcsPolicyMode?: string
  vcsPolicyRequired?: boolean
}

export const DEFAULT_GOOGLE_AGENT = 'google-agent'
export const GOOGLE_ADC_SECRET = 'google-adc-auth'
export const GITHUB_TOKEN_SECRET = 'github-token'

export const resolveGoogleRunSecrets = ({
  secrets = [],
  repository,
  vcsPolicyMode,
}: {
  secrets?: readonly string[]
  repository?: string
  vcsPolicyMode?: string
}) => {
  const defaults = [GOOGLE_ADC_SECRET]
  const hasRepository = Boolean(repository?.trim())
  const isReadWriteVcs = !vcsPolicyMode || vcsPolicyMode === 'read-write'
  if (hasRepository && isReadWriteVcs) {
    defaults.push(GITHUB_TOKEN_SECRET)
  }
  return [...new Set([...defaults, ...secrets])]
}

export const buildAgentRunSpec = (params: AgentRunParams) => {
  const requests = {
    ...(params.cpu ? { cpu: params.cpu } : {}),
    ...(params.memory ? { memory: params.memory } : {}),
  }
  const limits = params.memoryLimit ? { memory: params.memoryLimit } : undefined
  const resources = {
    ...(Object.keys(requests).length ? { requests } : {}),
    ...(limits ? { limits } : {}),
  }

  return {
    agentRef: { name: params.agentName },
    ...(params.implementationText !== undefined
      ? { implementation: { inline: { text: params.implementationText } } }
      : { implementationSpecRef: { name: params.implName } }),
    runtime: {
      type: params.runtimeType,
      ...(params.runtimeConfig && Object.keys(params.runtimeConfig).length > 0 ? { config: params.runtimeConfig } : {}),
    },
    ...(params.parameters && Object.keys(params.parameters).length > 0 ? { parameters: params.parameters } : {}),
    ...(params.memoryRef ? { memoryRef: { name: params.memoryRef } } : {}),
    ...(params.vcsRef ? { vcsRef: { name: params.vcsRef } } : {}),
    ...(params.ttl !== undefined ? { ttlSecondsAfterFinished: params.ttl } : {}),
    ...(params.secrets?.length ? { secrets: [...new Set(params.secrets)] } : {}),
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(params.vcsPolicyMode || params.vcsPolicyRequired
      ? {
          vcsPolicy: {
            ...(params.vcsPolicyMode ? { mode: params.vcsPolicyMode } : {}),
            ...(params.vcsPolicyRequired ? { required: true } : {}),
          },
        }
      : {}),
    ...(params.runtimeType === 'workflow' ? { workflow: { steps: [{ name: 'implement' }] } } : {}),
    ...(params.workloadImage || Object.keys(resources).length
      ? {
          workload: {
            ...(params.workloadImage ? { image: params.workloadImage } : {}),
            ...(Object.keys(resources).length ? { resources } : {}),
          },
        }
      : {}),
  }
}

export const buildAgentRunYaml = (params: AgentRunParams) =>
  YAML.stringify({
    apiVersion: 'agents.proompteng.ai/v1alpha1',
    kind: 'AgentRun',
    metadata: {
      ...(params.name ? { name: params.name } : params.generateName ? { generateName: params.generateName } : {}),
      ...(params.namespace ? { namespace: params.namespace } : {}),
    },
    spec: buildAgentRunSpec(params),
  })
