import { asRecord, asString } from '~/server/primitives-http'
import type { KubernetesClient } from '~/server/primitives-kube'

export type RuntimeRef = Record<string, unknown>

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

export const deleteRuntimeResource = async (
  kube: Pick<KubernetesClient, 'delete'>,
  kind: string,
  name: string,
  namespace: string,
) => {
  await kube.delete(kind, name, namespace, { wait: false })
}

export const cancelRuntime = async (input: {
  runtimeRef: RuntimeRef
  namespace: string
  kube: Pick<KubernetesClient, 'delete' | 'list'>
  getTemporalClient?: () => Promise<TemporalClient>
}) => {
  const { runtimeRef, namespace, kube, getTemporalClient } = input
  const type = asString(runtimeRef.type) ?? ''
  const name = asString(runtimeRef.name) ?? ''
  const runtimeNamespace = asString(runtimeRef.namespace) ?? namespace
  if (!name) return

  if (type === 'job') {
    await deleteRuntimeResource(kube, 'job', name, runtimeNamespace)
    return
  }

  if (type === 'workflow') {
    const runName = asString(runtimeRef.runName) ?? name
    const listed = await kube.list('jobs.batch', runtimeNamespace, `agents.proompteng.ai/agent-run=${runName}`)
    const items = Array.isArray(listed.items) ? listed.items : []
    for (const item of items) {
      const metadata = asRecord(item?.metadata)
      const jobName = asString(metadata?.name)
      if (!jobName) continue
      await kube.delete('job', jobName, runtimeNamespace, { wait: false })
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
