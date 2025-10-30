import {
  decodeOptionalFailureToOptionalError,
  decodeFailure as upstreamDecodeFailure,
  encodeErrorToFailure as upstreamEncodeErrorToFailure,
  encodeFailure as upstreamEncodeFailure,
} from '@temporalio/common/lib/internal-non-workflow/codec-helpers'
import type { temporal } from '@temporalio/proto'

import type { DataConverter } from './converter'

export type Failure = temporal.api.failure.v1.IFailure

export const encodeErrorToFailure = async (converter: DataConverter, error: unknown): Promise<Failure> =>
  upstreamEncodeErrorToFailure(converter, error)

export const encodeFailurePayloads = async (converter: DataConverter, failure: Failure): Promise<Failure> =>
  upstreamEncodeFailure(converter.payloadCodecs, failure)

export const decodeFailurePayloads = async (
  converter: DataConverter,
  failure: Failure | null | undefined,
): Promise<Failure | null | undefined> => {
  if (failure == null) {
    return failure
  }
  return await upstreamDecodeFailure(converter.payloadCodecs, failure)
}

export const failureToError = async (
  converter: DataConverter,
  failure: Failure | null | undefined,
): Promise<Error | undefined> => decodeOptionalFailureToOptionalError(converter, failure)
