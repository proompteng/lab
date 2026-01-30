import YAML from 'yaml'

export type AgentRunParams = {
  name?: string
  generateName?: string
  namespace?: string
  agentName: string
  implName: string
  runtimeType: string
  runtimeConfig?: Record<string, string>
  parameters?: Record<string, string>
  memoryRef?: string
  workloadImage?: string
  cpu?: string
  memory?: string
}

export const buildAgentRunYaml = (params: AgentRunParams) => {
  const metadata: Record<string, unknown> = {}
  if (params.name) {
    metadata.name = params.name
  } else if (params.generateName) {
    metadata.generateName = params.generateName
  }
  if (params.namespace) {
    metadata.namespace = params.namespace
  }

  const spec: Record<string, unknown> = {
    agentRef: { name: params.agentName },
    implementationSpecRef: { name: params.implName },
    runtime: {
      type: params.runtimeType,
      ...(params.runtimeConfig && Object.keys(params.runtimeConfig).length > 0 ? { config: params.runtimeConfig } : {}),
    },
    ...(params.parameters && Object.keys(params.parameters).length > 0 ? { parameters: params.parameters } : {}),
  }

  if (params.memoryRef) {
    spec.memoryRef = { name: params.memoryRef }
  }

  if (params.runtimeType === 'workflow') {
    spec.workflow = { steps: [{ name: 'implement' }] }
  }

  if (params.workloadImage || params.cpu || params.memory) {
    const workload: Record<string, unknown> = {}
    if (params.workloadImage) {
      workload.image = params.workloadImage
    }
    if (params.cpu || params.memory) {
      workload.resources = { requests: {} as Record<string, string> }
      if (params.cpu) (workload.resources as { requests: Record<string, string> }).requests.cpu = params.cpu
      if (params.memory) (workload.resources as { requests: Record<string, string> }).requests.memory = params.memory
    }
    spec.workload = workload
  }

  const manifest = {
    apiVersion: 'agents.proompteng.ai/v1alpha1',
    kind: 'AgentRun',
    metadata,
    spec,
  }

  return YAML.stringify(manifest)
}
