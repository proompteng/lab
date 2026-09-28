import type { Failure } from '../../proto/temporal/api/failure/v1/message_pb'
import {
  type DataConverter,
  decodeFailurePayloads,
  encodeErrorToFailure,
  encodeFailurePayloads,
  failureToError,
  TemporalFailureError,
} from './converter'

export { encodeErrorToFailure, encodeFailurePayloads, decodeFailurePayloads, failureToError }

export type { DataConverter, Failure }
export { TemporalFailureError }
