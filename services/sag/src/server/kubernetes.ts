import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'

import type { AgentRunEvaluationInput, ConnectorKind } from './gateway'

type KubernetesAgentRun = {
  metadata?: {
    name?: string
    namespace?: string
    creationTimestamp?: string
  }
  spec?: {
    agentRef?: {
      name?: string
    }
    runtime?: {
      type?: string
    }
    secrets?: unknown[]
    parameters?: Record<string, unknown>
  }
  status?: {
    phase?: string
  }
}

type KubernetesList<T> = {
  items?: T[]
}

const serviceAccountPath = '/var/run/secrets/kubernetes.io/serviceaccount'

export const listLiveAgentRuns = async (limit = 25): Promise<AgentRunEvaluationInput[]> => {
  const host = process.env.KUBERNETES_SERVICE_HOST
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443'
  if (!host) return []

  const list = await requestJson<KubernetesList<KubernetesAgentRun>>(
    host,
    port,
    '/apis/agents.proompteng.ai/v1alpha1/namespaces/agents/agentruns',
  ).catch((error) => {
    console.error('sag.kubernetes.list_agentruns_failed', error)
    return { items: [] }
  })

  return (list.items ?? [])
    .sort(
      (left, right) =>
        Date.parse(right.metadata?.creationTimestamp ?? '1970-01-01') -
        Date.parse(left.metadata?.creationTimestamp ?? '1970-01-01'),
    )
    .slice(0, limit)
    .map(toEvaluationInput)
}

const toEvaluationInput = (item: KubernetesAgentRun): AgentRunEvaluationInput => {
  const name = item.metadata?.name ?? 'agentrun'
  const namespace = item.metadata?.namespace ?? 'agents'
  const agent = item.spec?.agentRef?.name ?? 'agent'
  const requestedSecrets = (item.spec?.secrets ?? []).map(secretName).filter(Boolean)
  const requestedConnectors: ConnectorKind[] = ['kubernetes']
  const requestedTools = [
    item.spec?.runtime?.type ? `runtime:${item.spec.runtime.type}` : 'runtime:unknown',
    item.status?.phase ? `phase:${item.status.phase}` : 'phase:unknown',
  ]
  const parameters = item.spec?.parameters ?? {}
  const parameterKeys = Object.keys(parameters)
  if (parameterKeys.length > 0) requestedConnectors.push('policy')

  return {
    actorId: 'greg',
    name,
    namespace,
    agent,
    requestedSecrets,
    requestedConnectors,
    requestedTools,
    manifest: JSON.stringify(
      {
        apiVersion: 'agents.proompteng.ai/v1alpha1',
        kind: 'AgentRun',
        metadata: { name, namespace },
        spec: {
          agentRef: { name: agent },
          runtime: { type: item.spec?.runtime?.type ?? 'unknown' },
          secrets: requestedSecrets,
          parameters: Object.fromEntries(parameterKeys.slice(0, 12).map((key) => [key, '<redacted>'])),
        },
        status: { phase: item.status?.phase ?? 'unknown' },
      },
      null,
      2,
    ),
  }
}

const secretName = (value: unknown) => {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'name' in value && typeof value.name === 'string') return value.name
  return ''
}

const requestJson = <T>(host: string, port: string, path: string) =>
  new Promise<T>((resolve, reject) => {
    const token = readFileSync(`${serviceAccountPath}/token`, 'utf8')
    const ca = readFileSync(`${serviceAccountPath}/ca.crt`)
    const req = httpsRequest(
      {
        host,
        port,
        path,
        method: 'GET',
        ca,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Kubernetes API ${res.statusCode}: ${body.slice(0, 300)}`))
            return
          }
          resolve(JSON.parse(body) as T)
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
