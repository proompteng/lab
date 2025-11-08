import { mergeHeaders } from '../client/headers'
import { sleep } from '../common/sleep'
import type { GrafConfig } from '../config'
import { loadGrafConfig } from '../config'
import type {
  GrafBatchResponse,
  GrafCleanRequest,
  GrafCleanResponse,
  GrafComplementRequest,
  GrafComplementResponse,
  GrafEntityBatchRequest,
  GrafRelationshipBatchRequest,
} from './types'

export interface GrafRequestMetadata {
  readonly artifactId: string
  readonly workflowId: string
  readonly workflowRunId: string
  readonly streamId?: string
}

export interface GrafClient {
  persistEntities(request: GrafEntityBatchRequest, metadata: GrafRequestMetadata): Promise<GrafBatchResponse>
  persistRelationships(request: GrafRelationshipBatchRequest, metadata: GrafRequestMetadata): Promise<GrafBatchResponse>
  complement(request: GrafComplementRequest, metadata: GrafRequestMetadata): Promise<GrafComplementResponse>
  clean(request: GrafCleanRequest, metadata: GrafRequestMetadata): Promise<GrafCleanResponse>
}

const metadataHeaders = (metadata: GrafRequestMetadata): Record<string, string> => {
  const headers: Record<string, string> = {
    'x-temporal-workflow-id': metadata.workflowId,
    'x-temporal-workflow-run-id': metadata.workflowRunId,
    'x-temporal-artifact-id': metadata.artifactId,
  }
  if (metadata.streamId) {
    headers['x-temporal-stream-id'] = metadata.streamId
  }
  return headers
}

const buildHeaders = (config: GrafConfig, metadata: GrafRequestMetadata): Record<string, string> =>
  mergeHeaders({ 'content-type': 'application/json', ...config.headers }, metadataHeaders(metadata))

const normalizeUrl = (serviceUrl: string): string => serviceUrl.replace(/\/+$/u, '')

const ensurePath = (path: string): string => `${path.startsWith('/') ? '' : '/'}${path}`

export const createGrafClient = (config?: GrafConfig): GrafClient => {
  const resolvedConfig = config ?? loadGrafConfig()
  const baseUrl = normalizeUrl(resolvedConfig.serviceUrl)

  const sendGrafRequest = async <T>(path: string, payload: unknown, metadata: GrafRequestMetadata): Promise<T> => {
    const url = `${baseUrl}${ensurePath(path)}`
    const headers = buildHeaders(resolvedConfig, metadata)
    const body = JSON.stringify(payload)
    const retryPolicy = resolvedConfig.retryPolicy
    let lastError: unknown

    for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), resolvedConfig.requestTimeoutMs)
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        })

        if (!response.ok) {
          const text = await response.text()
          const error = new Error(`Graf request failed (${path}): ${response.status} ${response.statusText} - ${text}`)
          const shouldRetry =
            retryPolicy.retryableStatusCodes.includes(response.status) && attempt < retryPolicy.maxAttempts
          if (!shouldRetry) {
            throw error
          }
          lastError = error
        } else {
          const contentType = response.headers.get('content-type') ?? ''
          if (contentType.includes('application/json')) {
            return (await response.json()) as T
          }
          const text = await response.text()
          return text as unknown as T
        }
      } catch (error) {
        lastError = error
        if (attempt === retryPolicy.maxAttempts) {
          throw error
        }
      } finally {
        clearTimeout(timer)
      }

      if (attempt < retryPolicy.maxAttempts) {
        const delay = Math.min(
          retryPolicy.maxDelayMs,
          retryPolicy.initialDelayMs * retryPolicy.backoffCoefficient ** (attempt - 1),
        )
        await sleep(delay)
      }
    }

    throw lastError ?? new Error(`Graf request failed (${path})`)
  }

  return {
    async persistEntities(request, metadata) {
      const payload = {
        entities: request.entities.map((entity) => ({
          ...entity,
          artifactId: metadata.artifactId,
          streamId: metadata.streamId,
          researchSource: metadata.workflowRunId,
        })),
      }
      return sendGrafRequest('entities', payload, metadata)
    },

    async persistRelationships(request, metadata) {
      const payload = {
        relationships: request.relationships.map((relationship) => ({
          ...relationship,
          artifactId: metadata.artifactId,
          streamId: metadata.streamId,
          researchSource: metadata.workflowRunId,
        })),
      }
      return sendGrafRequest('relationships', payload, metadata)
    },

    complement(request, metadata) {
      const payload: GrafComplementRequest = {
        ...request,
        artifactId: metadata.artifactId,
      }
      return sendGrafRequest('complement', payload, metadata)
    },

    clean(request, metadata) {
      const payload: GrafCleanRequest = {
        ...request,
        artifactId: metadata.artifactId,
      }
      return sendGrafRequest('clean', payload, metadata)
    },
  }
}
