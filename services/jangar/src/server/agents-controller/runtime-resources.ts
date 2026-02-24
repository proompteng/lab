import { asRecord, asString } from '~/server/primitives-http'

export type RuntimeRef = Record<string, unknown>

type RunKubectlResult = {
  code: number | null
  stdout: string
  stderr: string
}

export type RunKubectl = (args: string[]) => Promise<RunKubectlResult>

type TemporalHandle = {
  workflowId: string
  runId?: string
  namespace?: string
}

type TemporalClient = {
  workflow: {
    cancel: (handle: TemporalHandle) => Promise<void>
  }
}

export const parseRuntimeRef = (raw: unknown): RuntimeRef | null => asRecord(raw) ?? null

export const buildRuntimeRef = (
  type: string,
  name: string,
  namespace: string,
  extra?: Record<string, unknown>,
): RuntimeRef => ({
  type,
  name,
  namespace,
  ...extra,
})

export const deleteRuntimeResource = async (runKubectl: RunKubectl, kind: string, name: string, namespace: string) => {
  const result = await runKubectl(['delete', kind, name, '-n', namespace])
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `failed to delete ${kind}/${name}`)
  }
}

export const cancelRuntime = async (input: {
  runtimeRef: RuntimeRef
  namespace: string
  runKubectl: RunKubectl
  getTemporalClient?: () => Promise<TemporalClient>
}) => {
  const { runtimeRef, namespace, runKubectl, getTemporalClient } = input
  const type = asString(runtimeRef.type) ?? ''
  const name = asString(runtimeRef.name) ?? ''
  const runtimeNamespace = asString(runtimeRef.namespace) ?? namespace
  if (!name) return

  if (type === 'job') {
    await deleteRuntimeResource(runKubectl, 'job', name, runtimeNamespace)
    return
  }

  if (type === 'workflow') {
    const runName = asString(runtimeRef.runName) ?? name
    const result = await runKubectl([
      'delete',
      'job',
      '-n',
      runtimeNamespace,
      '-l',
      `agents.proompteng.ai/agent-run=${runName}`,
      '--ignore-not-found',
    ])
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `failed to delete workflow jobs for ${runName}`)
    }
    return
  }

  if (type === 'temporal') {
    if (!getTemporalClient) {
      throw new Error('temporal runtime cancellation requires getTemporalClient')
    }
    const client = await getTemporalClient()
    const handle = {
      workflowId: asString(runtimeRef.workflowId) ?? name,
      runId: asString(runtimeRef.runId) ?? undefined,
      namespace: asString(runtimeRef.namespace) ?? undefined,
    }
    await client.workflow.cancel(handle)
  }
}
