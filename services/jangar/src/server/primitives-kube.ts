import { spawn } from 'node:child_process'

export type KubernetesClient = {
  apply: (resource: Record<string, unknown>) => Promise<Record<string, unknown>>
  applyManifest: (manifest: string, namespace?: string | null) => Promise<Record<string, unknown>>
  applyStatus: (resource: Record<string, unknown>) => Promise<Record<string, unknown>>
  createManifest: (manifest: string, namespace?: string | null) => Promise<Record<string, unknown>>
  delete: (resource: string, name: string, namespace: string) => Promise<Record<string, unknown> | null>
  patch: (
    resource: string,
    name: string,
    namespace: string,
    patch: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  get: (resource: string, name: string, namespace: string) => Promise<Record<string, unknown> | null>
  list: (resource: string, namespace: string, labelSelector?: string) => Promise<Record<string, unknown>>
  listEvents: (namespace: string, fieldSelector?: string) => Promise<Record<string, unknown>>
}

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number | null
}

const runCommand = (command: string, args: string[], input?: string): Promise<CommandResult> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code }))
    if (input) {
      child.stdin.write(input)
    }
    child.stdin.end()
  })

const parseJson = (raw: string, context: string) => {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    throw new Error(`${context} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const kubectl = async (args: string[], input?: string, context?: string) => {
  const result = await runCommand('kubectl', args, input)
  if (result.exitCode === 0) {
    return result.stdout.trim()
  }
  const details = result.stderr.trim() || result.stdout.trim()
  throw new Error(`${context ?? 'kubectl'} failed: ${details || `exit ${result.exitCode}`}`)
}

const notFound = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('NotFound') || message.includes('(NotFound)')
}

export const createKubernetesClient = (): KubernetesClient => ({
  apply: async (resource) => {
    const metadata = (resource.metadata ?? {}) as Record<string, unknown>
    const generateName = typeof metadata.generateName === 'string' ? metadata.generateName.trim() : ''
    const name = typeof metadata.name === 'string' ? metadata.name.trim() : ''
    const useCreate = generateName.length > 0 && name.length === 0
    const command = useCreate ? 'create' : 'apply'
    const output = await kubectl([command, '-f', '-', '-o', 'json'], JSON.stringify(resource), `kubectl ${command}`)
    return parseJson(output, `kubectl ${command}`)
  },
  applyManifest: async (manifest, namespace) => {
    const args = ['apply', '-f', '-', '-o', 'json']
    if (namespace) {
      args.push('-n', namespace)
    }
    const output = await kubectl(args, manifest, 'kubectl apply')
    return parseJson(output, 'kubectl apply')
  },
  applyStatus: async (resource) => {
    const output = await kubectl(
      ['apply', '--subresource=status', '-f', '-', '-o', 'json'],
      JSON.stringify(resource),
      'kubectl apply status',
    )
    return parseJson(output, 'kubectl apply status')
  },
  createManifest: async (manifest, namespace) => {
    const args = ['create', '-f', '-', '-o', 'json']
    if (namespace) {
      args.push('-n', namespace)
    }
    const output = await kubectl(args, manifest, 'kubectl create')
    return parseJson(output, 'kubectl create')
  },
  delete: async (resource, name, namespace) => {
    try {
      const output = await kubectl(
        ['delete', resource, name, '-n', namespace, '-o', 'json'],
        undefined,
        'kubectl delete',
      )
      return parseJson(output, 'kubectl delete')
    } catch (error) {
      if (notFound(error)) return null
      throw error
    }
  },
  patch: async (resource, name, namespace, patch) => {
    const output = await kubectl(
      ['patch', resource, name, '-n', namespace, '--type=merge', '-p', JSON.stringify(patch), '-o', 'json'],
      undefined,
      'kubectl patch',
    )
    return parseJson(output, 'kubectl patch')
  },
  get: async (resource, name, namespace) => {
    try {
      const output = await kubectl(['get', resource, name, '-n', namespace, '-o', 'json'], undefined, 'kubectl get')
      return parseJson(output, 'kubectl get')
    } catch (error) {
      if (notFound(error)) return null
      throw error
    }
  },
  list: async (resource, namespace, labelSelector) => {
    const args = ['get', resource, '-n', namespace, '-o', 'json']
    if (labelSelector) {
      args.push('-l', labelSelector)
    }
    const output = await kubectl(args, undefined, 'kubectl list')
    return parseJson(output, 'kubectl list')
  },
  listEvents: async (namespace, fieldSelector) => {
    const args = ['get', 'events', '-n', namespace, '-o', 'json']
    if (fieldSelector) {
      args.push('--field-selector', fieldSelector)
    }
    const output = await kubectl(args, undefined, 'kubectl events')
    return parseJson(output, 'kubectl events')
  },
})

export const RESOURCE_MAP = {
  Agent: 'agents.agents.proompteng.ai',
  AgentRun: 'agentruns.agents.proompteng.ai',
  AgentProvider: 'agentproviders.agents.proompteng.ai',
  ImplementationSpec: 'implementationspecs.agents.proompteng.ai',
  ImplementationSource: 'implementationsources.agents.proompteng.ai',
  Memory: 'memories.agents.proompteng.ai',
  Orchestration: 'orchestrations.orchestration.proompteng.ai',
  OrchestrationRun: 'orchestrationruns.orchestration.proompteng.ai',
  ApprovalPolicy: 'approvalpolicies.approvals.proompteng.ai',
  Budget: 'budgets.budgets.proompteng.ai',
  SecretBinding: 'secretbindings.security.proompteng.ai',
  Signal: 'signals.signals.proompteng.ai',
  SignalDelivery: 'signaldeliveries.signals.proompteng.ai',
  Schedule: 'schedules.schedules.proompteng.ai',
  Artifact: 'artifacts.artifacts.proompteng.ai',
  Workspace: 'workspaces.workspaces.proompteng.ai',
} as const
