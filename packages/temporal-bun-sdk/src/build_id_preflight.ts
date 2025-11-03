import { Code, ConnectError } from '@connectrpc/connect'
import { normalizeTlsConfig, type TLSConfigOption } from '@temporalio/common/lib/internal-non-workflow'

import type { TLSConfig } from './config'
import { createWorkflowServiceClient } from './grpc/workflow-service-client'
import type { GetWorkerBuildIdCompatibilityResponse } from './proto/temporal/api/workflowservice/v1/request_response_pb'
import {
  GetWorkerBuildIdCompatibilityRequest,
  UpdateWorkerBuildIdCompatibilityRequest,
} from './proto/temporal/api/workflowservice/v1/request_response_pb'

export interface BuildIdReachabilityOptions {
  address?: string
  namespace?: string
  tls?: TLSConfigOption | TLSConfig | null
  apiKey?: string
  metadata?: Record<string, string>
  allowInsecureTls?: boolean
}

const DEFAULT_ADDRESS = '127.0.0.1:7233'
const DEFAULT_NAMESPACE = 'default'

export async function ensureBuildIdReachable(
  taskQueue: string,
  buildId: string,
  options: BuildIdReachabilityOptions = {},
): Promise<void> {
  const address = options.address ?? process.env.TEMPORAL_ADDRESS ?? DEFAULT_ADDRESS
  const namespace = options.namespace ?? process.env.TEMPORAL_NAMESPACE ?? DEFAULT_NAMESPACE

  const normalizedTls = normalizeTlsConfig(options.tls as TLSConfigOption)
  const workflowHandle = createWorkflowServiceClient({
    address,
    tls: (normalizedTls ?? undefined) as TLSConfig | undefined,
    apiKey: options.apiKey,
    metadata: options.metadata,
    allowInsecureTls: options.allowInsecureTls,
  })
  const workflowClient = workflowHandle.client

  let existingCompatibility: GetWorkerBuildIdCompatibilityResponse | undefined
  try {
    existingCompatibility = await workflowClient.getWorkerBuildIdCompatibility(
      new GetWorkerBuildIdCompatibilityRequest({ namespace, taskQueue }),
    )
  } catch (error) {
    if (isWorkerVersioningDisabledError(error)) {
      return
    }
    throw error
  }

  if (containsBuildId(existingCompatibility, buildId)) {
    return
  }

  try {
    const updateRequest = new UpdateWorkerBuildIdCompatibilityRequest({ namespace, taskQueue })
    updateRequest.operation = { case: 'addNewBuildIdInNewDefaultSet', value: buildId }
    await workflowClient.updateWorkerBuildIdCompatibility(updateRequest)
  } catch (error) {
    if (isWorkerVersioningDisabledError(error)) {
      return
    }
    if (!isAlreadyExistsError(error)) {
      throw error
    }
  }

  let compatibility: GetWorkerBuildIdCompatibilityResponse | undefined
  try {
    compatibility = await workflowClient.getWorkerBuildIdCompatibility(
      new GetWorkerBuildIdCompatibilityRequest({ namespace, taskQueue }),
    )
  } catch (error) {
    if (isWorkerVersioningDisabledError(error)) {
      return
    }
    throw error
  }

  if (!containsBuildId(compatibility, buildId)) {
    throw new Error('buildId not present in compatibility rules')
  }
}

const containsBuildId = (
  compatibility: GetWorkerBuildIdCompatibilityResponse | undefined,
  buildId: string,
): boolean => {
  if (!compatibility) {
    return false
  }

  for (const versionSet of compatibility.majorVersionSets) {
    if (versionSet.buildIds.includes(buildId)) {
      return true
    }
  }

  return false
}

const isAlreadyExistsError = (error: unknown): boolean => {
  if (error instanceof ConnectError) {
    if (error.code === Code.AlreadyExists) {
      return true
    }
    return messageContains(error, 'ALREADY_EXISTS')
  }

  if (!error || typeof error !== 'object') {
    return false
  }

  return messageContains(error, 'ALREADY_EXISTS')
}

const isWorkerVersioningDisabledError = (error: unknown): boolean => {
  if (error instanceof ConnectError) {
    if (error.code !== Code.PermissionDenied && error.code !== Code.FailedPrecondition) {
      return false
    }
    return messageContains(error, 'WORKER VERSIONING') && messageContains(error, 'DISABLED')
  }

  if (!error || typeof error !== 'object') {
    return false
  }

  return messageContains(error, 'WORKER VERSIONING') && messageContains(error, 'DISABLED')
}

const messageContains = (error: unknown, needle: string): boolean => {
  const upperNeedle = needle.toUpperCase()

  if (error instanceof ConnectError) {
    const candidates = [error.rawMessage, error.message]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.toUpperCase().includes(upperNeedle)) {
        return true
      }
    }
  }

  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.toUpperCase().includes(upperNeedle)) {
      return true
    }

    const details = (error as { details?: unknown }).details
    if (typeof details === 'string' && details.toUpperCase().includes(upperNeedle)) {
      return true
    }
  }

  return false
}
