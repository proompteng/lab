import { create } from '@bufbuild/protobuf'
import {
  ApplicationFailureInfoSchema,
  type Failure,
  FailureSchema,
} from '../../proto/temporal/api/failure/v1/message_pb'
import type { DataConverter } from './converter'

const FAILURE_SOURCE = 'temporal-bun-sdk'

const normalizeError = (error: unknown): { name: string; message: string; stack?: string } => {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message || error.toString(),
      stack: error.stack,
    }
  }

  if (typeof error === 'string') {
    return { name: 'Error', message: error }
  }

  try {
    return { name: 'Error', message: JSON.stringify(error) }
  } catch {
    return { name: 'Error', message: String(error) }
  }
}

export const encodeErrorToFailure = async (_converter: DataConverter, error: unknown): Promise<Failure> => {
  const normalized = normalizeError(error)
  const nonRetryable = isNonRetryableError(error)
  return create(FailureSchema, {
    message: normalized.message,
    source: FAILURE_SOURCE,
    stackTrace: normalized.stack ?? '',
    failureInfo: {
      case: 'applicationFailureInfo',
      value: create(ApplicationFailureInfoSchema, {
        type: normalized.name,
        nonRetryable,
      }),
    },
  })
}

export const encodeFailurePayloads = async (_converter: DataConverter, failure: Failure): Promise<Failure> => failure

export const decodeFailurePayloads = async (
  _converter: DataConverter,
  failure: Failure | null | undefined,
): Promise<Failure | null | undefined> => failure

export const failureToError = async (
  _converter: DataConverter,
  failure: Failure | null | undefined,
): Promise<Error | undefined> => {
  if (!failure) {
    return undefined
  }

  const error = new Error(failure.message || 'Temporal workflow failed')
  error.name =
    failure.failureInfo?.case === 'applicationFailureInfo' ? failure.failureInfo.value.type || error.name : error.name
  if (failure.stackTrace) {
    error.stack = failure.stackTrace
  }
  return error
}

const isNonRetryableError = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && (error as { nonRetryable?: boolean }).nonRetryable === true)
