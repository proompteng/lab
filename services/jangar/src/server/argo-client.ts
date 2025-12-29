import { readFileSync } from 'node:fs'

const normalizeBaseUrl = (value: string) => value.replace(/\/+$/, '')

const DEFAULT_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const asNonEmptyString = (value: unknown) => (typeof value === 'string' && value.trim().length > 0 ? value : null)

const coalesceString = (...values: Array<string | null | undefined>) => {
  for (const value of values) {
    const normalized = asNonEmptyString(value)
    if (normalized) return normalized
  }
  return null
}

const readTokenFile = (path: string) => {
  try {
    const token = readFileSync(path, 'utf8').trim()
    return token.length > 0 ? token : null
  } catch {
    return null
  }
}

const resolveArgoAuthToken = () => {
  const envToken = coalesceString(process.env.ARGO_TOKEN, process.env.ARGO_SERVER_TOKEN)
  if (envToken) return envToken

  const tokenFile = coalesceString(process.env.ARGO_TOKEN_FILE, process.env.ARGO_SERVER_TOKEN_FILE)
  if (tokenFile) return readTokenFile(tokenFile)

  return readTokenFile(DEFAULT_TOKEN_PATH)
}

const extractArtifactLocation = (artifact: Record<string, unknown>) => {
  const s3 = isRecord(artifact.s3) ? artifact.s3 : null
  const gcs = isRecord(artifact.gcs) ? artifact.gcs : null
  const oss = isRecord(artifact.oss) ? artifact.oss : null
  const http = isRecord(artifact.http) ? artifact.http : null

  return {
    key:
      asNonEmptyString(artifact.key) ??
      asNonEmptyString(s3?.key) ??
      asNonEmptyString(gcs?.key) ??
      asNonEmptyString(oss?.key) ??
      null,
    bucket:
      asNonEmptyString(artifact.bucket) ??
      asNonEmptyString(s3?.bucket) ??
      asNonEmptyString(gcs?.bucket) ??
      asNonEmptyString(oss?.bucket) ??
      null,
    url: asNonEmptyString(artifact.url) ?? asNonEmptyString(http?.url) ?? null,
  }
}

const normalizeArtifact = (artifact: Record<string, unknown>, nodeId?: string | null): ArgoArtifact | null => {
  const name = asNonEmptyString(artifact.name)
  if (!name) return null
  const location = extractArtifactLocation(artifact)
  return {
    name,
    key: location.key,
    bucket: location.bucket,
    url: location.url,
    nodeId: nodeId ?? null,
    metadata: artifact,
  }
}

export type ArgoArtifact = {
  name: string
  key: string | null
  bucket: string | null
  url: string | null
  nodeId: string | null
  metadata: Record<string, unknown>
}

export type ArgoWorkflowInfo = {
  name: string
  namespace: string | null
  uid: string | null
}

export type ArgoWorkflowArtifacts = {
  workflow: ArgoWorkflowInfo
  artifacts: ArgoArtifact[]
}

export const extractWorkflowArtifacts = (workflow: Record<string, unknown>): ArgoWorkflowArtifacts => {
  const metadata = isRecord(workflow.metadata) ? workflow.metadata : {}
  const status = isRecord(workflow.status) ? workflow.status : {}
  const outputs = isRecord(status.outputs) ? status.outputs : {}

  const workflowInfo: ArgoWorkflowInfo = {
    name: asNonEmptyString(metadata.name) ?? '',
    namespace: asNonEmptyString(metadata.namespace),
    uid: asNonEmptyString(metadata.uid),
  }

  const artifacts: ArgoArtifact[] = []

  const outputArtifacts = Array.isArray(outputs.artifacts) ? outputs.artifacts : []
  for (const artifact of outputArtifacts) {
    if (!isRecord(artifact)) continue
    const normalized = normalizeArtifact(artifact)
    if (normalized) artifacts.push(normalized)
  }

  const nodes = isRecord(status.nodes) ? status.nodes : {}
  for (const [nodeKey, nodeValue] of Object.entries(nodes)) {
    if (!isRecord(nodeValue)) continue
    const nodeOutputs = isRecord(nodeValue.outputs) ? nodeValue.outputs : {}
    const nodeArtifacts = Array.isArray(nodeOutputs.artifacts) ? nodeOutputs.artifacts : []
    const nodeId = asNonEmptyString(nodeValue.id) ?? nodeKey
    for (const artifact of nodeArtifacts) {
      if (!isRecord(artifact)) continue
      const normalized = normalizeArtifact(artifact, nodeId)
      if (normalized) artifacts.push(normalized)
    }
  }

  return { workflow: workflowInfo, artifacts }
}

export const buildArtifactDownloadUrl = (
  baseUrl: string,
  workflow: ArgoWorkflowInfo,
  artifact: Pick<ArgoArtifact, 'name' | 'nodeId'>,
) => {
  if (!artifact.nodeId) return null
  const base = normalizeBaseUrl(baseUrl)
  if (workflow.uid) {
    return `${base}/artifacts-by-uid/${encodeURIComponent(workflow.uid)}/${encodeURIComponent(
      artifact.nodeId,
    )}/${encodeURIComponent(artifact.name)}`
  }
  if (!workflow.namespace || !workflow.name) return null
  return `${base}/artifacts/${encodeURIComponent(workflow.namespace)}/${encodeURIComponent(
    workflow.name,
  )}/${encodeURIComponent(artifact.nodeId)}/${encodeURIComponent(artifact.name)}`
}

const requestJson = async (url: string, init: RequestInit) => {
  const response = await fetch(url, init)
  const text = await response.text()
  if (!response.ok) {
    const error = new Error(`Argo API ${response.status}: ${text}`)
    ;(error as Error & { status?: number }).status = response.status
    throw error
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : null
}

export const createArgoClient = ({ baseUrl }: { baseUrl: string }) => {
  const normalized = normalizeBaseUrl(baseUrl)
  const buildHeaders = () => {
    const authToken = resolveArgoAuthToken()
    return {
      accept: 'application/json',
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    }
  }

  const getWorkflow = async (namespace: string, name: string) => {
    return requestJson(`${normalized}/api/v1/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`, {
      method: 'GET',
      headers: buildHeaders(),
    })
  }

  const getWorkflowArtifacts = async (namespace: string, name: string) => {
    const workflow = await getWorkflow(namespace, name)
    if (!workflow || typeof workflow !== 'object') return null
    const extracted = extractWorkflowArtifacts(workflow as Record<string, unknown>)
    return {
      workflow: extracted.workflow,
      artifacts: extracted.artifacts.map((artifact) => ({
        ...artifact,
        url: artifact.url ?? buildArtifactDownloadUrl(normalized, extracted.workflow, artifact),
      })),
    }
  }

  return {
    getWorkflow,
    getWorkflowArtifacts,
  }
}
