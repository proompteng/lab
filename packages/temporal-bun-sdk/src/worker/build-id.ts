import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { Effect } from 'effect'

import { sleep } from '../common/sleep'
import type { LogFields, Logger } from '../observability/logger'
import type {
  GetWorkerBuildIdCompatibilityRequest,
  UpdateWorkerBuildIdCompatibilityRequest,
  UpdateWorkerBuildIdCompatibilityResponse,
} from '../proto/temporal/api/workflowservice/v1/request_response_pb'
import {
  GetWorkerBuildIdCompatibilityRequestSchema,
  UpdateWorkerBuildIdCompatibilityRequestSchema,
} from '../proto/temporal/api/workflowservice/v1/request_response_pb'

const MAX_ATTEMPTS = 3
const BACKOFF_BASE_MS = 250
const TRANSIENT_CODES = new Set([Code.Unavailable, Code.DeadlineExceeded, Code.Aborted, Code.Internal])
const FEATURE_UNAVAILABLE_CODES = new Set([Code.Unimplemented, Code.FailedPrecondition])

interface WorkerVersioningCapabilityResult {
  supported: boolean
  reason?: string
  code?: Code
}

export interface RegisterWorkerBuildIdCompatibilityOptions {
  sleep?(millis: number): Promise<void>
  logger?: Logger
}

interface WorkflowServiceClientLike {
  getWorkerBuildIdCompatibility(request: GetWorkerBuildIdCompatibilityRequest): Promise<unknown>
  updateWorkerBuildIdCompatibility(
    request: UpdateWorkerBuildIdCompatibilityRequest,
  ): Promise<UpdateWorkerBuildIdCompatibilityResponse>
}

const describeCode = (code: Code | number): string => {
  const maybeName = Code[code as Code]
  return typeof maybeName === 'string' ? `${maybeName} (${code})` : String(code)
}

export async function registerWorkerBuildIdCompatibility(
  workflowService: WorkflowServiceClientLike,
  namespace: string,
  taskQueue: string,
  buildId: string,
  options: RegisterWorkerBuildIdCompatibilityOptions = {},
): Promise<void> {
  const request = create(UpdateWorkerBuildIdCompatibilityRequestSchema, {
    namespace,
    taskQueue,
    operation: {
      case: 'addNewBuildIdInNewDefaultSet',
      value: buildId,
    },
  })
  const backoff = options.sleep ?? sleep
  const logger = options.logger

  const logWithFallback = async (level: 'info' | 'warn', message: string, fields?: LogFields): Promise<void> => {
    if (logger) {
      await Effect.runPromise(logger.log(level, message, fields))
      return
    }
    const payload = fields ? `${message} ${JSON.stringify(fields)}` : message
    if (level === 'warn') {
      console.warn(`[temporal-bun-sdk] ${payload}`)
    } else {
      console.info(`[temporal-bun-sdk] ${payload}`)
    }
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await workflowService.updateWorkerBuildIdCompatibility(request)
      await logWithFallback('info', 'registered worker build ID', {
        namespace,
        taskQueue,
        buildId,
      })
      return
    } catch (error) {
      if (!(error instanceof ConnectError)) {
        throw error
      }

      const code = error.code ?? Code.Unknown
      if (FEATURE_UNAVAILABLE_CODES.has(code)) {
        await logWithFallback('warn', 'worker versioning API unavailable; continuing without build ID registration', {
          namespace,
          taskQueue,
          buildId,
          code: describeCode(code),
        })
        return
      }

      if (TRANSIENT_CODES.has(code)) {
        if (attempt === MAX_ATTEMPTS) {
          throw error
        }
        await backoff(BACKOFF_BASE_MS * attempt)
        continue
      }

      throw error
    }
  }
}

export async function checkWorkerVersioningCapability(
  workflowService: WorkflowServiceClientLike,
  namespace: string,
  taskQueue: string,
): Promise<WorkerVersioningCapabilityResult> {
  const request = create(GetWorkerBuildIdCompatibilityRequestSchema, {
    namespace,
    taskQueue,
    maxSets: 1,
  })

  try {
    await workflowService.getWorkerBuildIdCompatibility(request)
    return { supported: true }
  } catch (error) {
    if (!(error instanceof ConnectError)) {
      throw error
    }

    const code = error.code ?? Code.Unknown
    if (FEATURE_UNAVAILABLE_CODES.has(code)) {
      return {
        supported: false,
        code,
        reason: `worker versioning API unavailable (${describeCode(code)})`,
      }
    }

    throw error
  }
}
