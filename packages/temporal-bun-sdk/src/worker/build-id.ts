import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'

import { sleep } from '../common/sleep'
import type {
  UpdateWorkerBuildIdCompatibilityRequest,
  UpdateWorkerBuildIdCompatibilityResponse,
} from '../proto/temporal/api/workflowservice/v1/request_response_pb'
import { UpdateWorkerBuildIdCompatibilityRequestSchema } from '../proto/temporal/api/workflowservice/v1/request_response_pb'

const MAX_ATTEMPTS = 3
const BACKOFF_BASE_MS = 250
const TRANSIENT_CODES = new Set([Code.Unavailable, Code.DeadlineExceeded, Code.Aborted, Code.Internal])
const FEATURE_UNAVAILABLE_CODES = new Set([Code.Unimplemented, Code.FailedPrecondition])

export interface RegisterWorkerBuildIdCompatibilityOptions {
  sleep?(millis: number): Promise<void>
}

interface WorkflowServiceClientLike {
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

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await workflowService.updateWorkerBuildIdCompatibility(request)
      console.info(`[temporal-bun-sdk] registered worker build ID ${buildId} for ${namespace}/${taskQueue}`)
      return
    } catch (error) {
      if (!(error instanceof ConnectError)) {
        throw error
      }

      const code = error.code ?? Code.UNKNOWN
      if (FEATURE_UNAVAILABLE_CODES.has(code)) {
        console.warn(
          `[temporal-bun-sdk] worker versioning API unavailable for ${namespace}/${taskQueue} (${describeCode(code)}); continuing without build ID registration. scripts/start-temporal-cli.ts uses the Temporal CLI, which does not yet expose UpdateWorkerBuildIdCompatibility, so this warning is expected when you run TEMPORAL_INTEGRATION_TESTS=1 against the bundled CLI.`,
        )
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
