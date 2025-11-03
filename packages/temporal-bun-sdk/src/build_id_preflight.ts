import type { temporal } from '@temporalio/proto'
import type { NativeConnectionOptions } from '@temporalio/worker'
import { NativeConnection } from '@temporalio/worker'

type PreflightConnectionOptions = NativeConnectionOptions & {
  namespace?: string
}

export async function ensureBuildIdReachable(
  taskQueue: string,
  buildId: string,
  connectionOptions: PreflightConnectionOptions = {},
): Promise<void> {
  const address = connectionOptions.address ?? process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233'
  const namespace = connectionOptions.namespace ?? process.env.TEMPORAL_NAMESPACE ?? 'default'

  const { namespace: _ignoredNamespace, ...nativeOptions } = connectionOptions

  const connection = await NativeConnection.connect({
    ...nativeOptions,
    address,
  })

  try {
    let existingCompatibility: temporal.api.workflowservice.v1.IGetWorkerBuildIdCompatibilityResponse | undefined
    try {
      existingCompatibility = await connection.workflowService.getWorkerBuildIdCompatibility({
        namespace,
        taskQueue,
      })
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
      await connection.workflowService.updateWorkerBuildIdCompatibility({
        namespace,
        taskQueue,
        addNewBuildIdInNewDefaultSet: buildId,
      })
    } catch (error) {
      if (isWorkerVersioningDisabledError(error)) {
        return
      }
      if (!isAlreadyExistsError(error)) {
        throw error
      }
    }

    let compatibility: temporal.api.workflowservice.v1.IGetWorkerBuildIdCompatibilityResponse | undefined
    try {
      compatibility = await connection.workflowService.getWorkerBuildIdCompatibility({
        namespace,
        taskQueue,
      })
    } catch (error) {
      if (isWorkerVersioningDisabledError(error)) {
        return
      }
      throw error
    }

    if (!containsBuildId(compatibility, buildId)) {
      throw new Error('buildId not present in compatibility rules')
    }
  } finally {
    await connection.close()
  }
}

const containsBuildId = (
  compatibility: temporal.api.workflowservice.v1.IGetWorkerBuildIdCompatibilityResponse,
  buildId: string,
): boolean => {
  if (!compatibility.majorVersionSets) {
    return false
  }

  for (const versionSet of compatibility.majorVersionSets) {
    if (!versionSet?.buildIds) {
      continue
    }
    const entries = versionSet.buildIds as Array<string | { buildId?: string }>

    for (const entry of entries) {
      if (typeof entry === 'string') {
        if (entry === buildId) {
          return true
        }
        continue
      }

      if (entry?.buildId === buildId) {
        return true
      }
    }
  }

  return false
}

const ALREADY_EXISTS_STATUS_CODE = 6
const PERMISSION_DENIED_STATUS_CODE = 7

const isAlreadyExistsError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false
  }

  const grpcCode = (error as { code?: unknown }).code
  if (typeof grpcCode === 'number' && grpcCode === ALREADY_EXISTS_STATUS_CODE) {
    return true
  }

  const message = (error as { message?: unknown }).message
  if (typeof message === 'string' && message.toUpperCase().includes('ALREADY_EXISTS')) {
    return true
  }

  const details = (error as { details?: unknown }).details
  return typeof details === 'string' && details.toUpperCase().includes('ALREADY_EXISTS')
}

const isWorkerVersioningDisabledError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false
  }

  const grpcCode = (error as { code?: unknown }).code
  if (typeof grpcCode === 'number' && grpcCode === PERMISSION_DENIED_STATUS_CODE) {
    if (hasWorkerVersioningDisabledMessage(error)) {
      return true
    }
  }

  return hasWorkerVersioningDisabledMessage(error)
}

const hasWorkerVersioningDisabledMessage = (error: { message?: unknown; details?: unknown }): boolean => {
  const message = typeof error.message === 'string' ? error.message : undefined
  const details = typeof error.details === 'string' ? error.details : undefined

  const haystacks = [message, details]
  for (const haystack of haystacks) {
    if (!haystack) {
      continue
    }
    const upper = haystack.toUpperCase()
    if (upper.includes('WORKER VERSIONING') && upper.includes('DISABLED')) {
      return true
    }
  }
  return false
}
