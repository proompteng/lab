import { create } from '@bufbuild/protobuf'
import { Effect } from 'effect'

import type { Logger } from '../../observability/logger'
import type { Counter, MetricsRegistry } from '../../observability/metrics'
import { type Payload, PayloadsSchema } from '../../proto/temporal/api/common/v1/message_pb'
import {
  ApplicationFailureInfoSchema,
  type Failure,
  FailureSchema,
} from '../../proto/temporal/api/failure/v1/message_pb'
import { type PayloadCodec, PayloadCodecError } from './codecs'
import {
  jsonToPayload,
  jsonToPayloadMap,
  jsonToPayloads,
  payloadMapToJson,
  payloadsToJson,
  payloadToJson,
} from './json-codec'

export type PayloadMap = Record<string, Payload>

export interface PayloadConverter {
  toPayload(value: unknown): Promise<Payload>
  fromPayload(payload: Payload | null | undefined): Promise<unknown>
  toPayloads(values: unknown[]): Promise<Payload[] | undefined>
  fromPayloads(payloads: Payload[] | null | undefined): Promise<unknown[]>
  toPayloadMap(map: Record<string, unknown> | undefined): Promise<PayloadMap | undefined>
  fromPayloadMap(map: PayloadMap | null | undefined): Promise<Record<string, unknown> | undefined>
}

export interface FailureConverter {
  readonly name?: string
  errorToFailure(error: unknown, converter: DataConverter): Promise<Failure>
  failureToError(failure: Failure | null | undefined, converter: DataConverter): Promise<Error | undefined>
  encodeFailure?(failure: Failure, converter: DataConverter): Promise<Failure>
  decodeFailure?(failure: Failure | null | undefined, converter: DataConverter): Promise<Failure | null | undefined>
}

export interface DataConverter extends PayloadConverter {
  readonly payloadCodecs: readonly PayloadCodec[]
  readonly failureConverter: FailureConverter
  encodePayloads(payloads: Payload[] | null | undefined): Promise<Payload[] | undefined>
  decodePayloads(payloads: Payload[] | null | undefined): Promise<Payload[]>
  encodeFailurePayloads(failure: Failure): Promise<Failure>
  decodeFailurePayloads(failure: Failure | null | undefined): Promise<Failure | null | undefined>
  errorToFailure(error: unknown): Promise<Failure>
  failureToError(failure: Failure | null | undefined): Promise<Error | undefined>
}

class JsonPayloadConverter implements PayloadConverter {
  async toPayload(value: unknown): Promise<Payload> {
    return jsonToPayload(value)
  }

  async fromPayload(payload: Payload | null | undefined): Promise<unknown> {
    return payloadToJson(payload)
  }

  async toPayloads(values: unknown[]): Promise<Payload[] | undefined> {
    if (!values || values.length === 0) {
      return undefined
    }
    return jsonToPayloads(values)
  }

  async fromPayloads(payloads: Payload[] | null | undefined): Promise<unknown[]> {
    if (!payloads || payloads.length === 0) {
      return []
    }
    return payloadsToJson(payloads)
  }

  async toPayloadMap(map: Record<string, unknown> | undefined): Promise<PayloadMap | undefined> {
    return jsonToPayloadMap(map)
  }

  async fromPayloadMap(map: PayloadMap | null | undefined): Promise<Record<string, unknown> | undefined> {
    return payloadMapToJson(map)
  }
}

const FAILURE_SOURCE = 'temporal-bun-sdk'

export class TemporalFailureError extends Error {
  readonly failure: Failure
  readonly failureType: string
  readonly nonRetryable: boolean
  readonly details?: unknown[]

  constructor(params: {
    message: string
    failure: Failure
    failureType: string
    nonRetryable: boolean
    details?: unknown[]
    cause?: Error
    stack?: string
  }) {
    super(params.message)
    this.name = params.failureType || 'TemporalFailure'
    this.failure = params.failure
    this.failureType = params.failureType
    this.nonRetryable = params.nonRetryable
    this.details = params.details
    if (params.cause) {
      ;(this as { cause?: Error }).cause = params.cause
    }
    if (params.stack) {
      this.stack = params.stack
    }
  }
}

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

const isNonRetryableError = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && (error as { nonRetryable?: boolean }).nonRetryable === true)

const extractErrorDetails = (error: unknown): unknown[] | undefined => {
  if (!error || typeof error !== 'object') return undefined
  const details = (error as { details?: unknown }).details
  if (Array.isArray(details)) {
    return details
  }
  return undefined
}

class DefaultFailureConverter implements FailureConverter {
  readonly name = 'default'

  async errorToFailure(error: unknown, converter: DataConverter): Promise<Failure> {
    const normalized = normalizeError(error)
    const nonRetryable = isNonRetryableError(error)
    const detailValues = extractErrorDetails(error)
    const detailPayloads =
      detailValues && detailValues.length > 0 ? await converter.toPayloads(detailValues) : undefined
    const cause =
      error && typeof error === 'object' && 'cause' in error && (error as { cause?: unknown }).cause
        ? await this.errorToFailure((error as { cause?: unknown }).cause, converter)
        : undefined

    return create(FailureSchema, {
      message: normalized.message,
      source: FAILURE_SOURCE,
      stackTrace: normalized.stack ?? '',
      cause,
      failureInfo: {
        case: 'applicationFailureInfo',
        value: create(ApplicationFailureInfoSchema, {
          type: normalized.name,
          nonRetryable,
          details:
            detailPayloads && detailPayloads.length > 0
              ? create(PayloadsSchema, { payloads: detailPayloads })
              : undefined,
        }),
      },
    })
  }

  async encodeFailure(failure: Failure, converter: DataConverter): Promise<Failure> {
    const cause = failure.cause ? await this.encodeFailure(failure.cause, converter) : undefined

    // Failure details coming from errorToFailure are already encoded through the
    // payload codec pipeline. Re-encoding here would wrap them a second time and
    // leave failureToError with only one decode pass, resulting in still-encoded
    // payload blobs. Preserve existing detail payloads as-is.
    const failureInfo =
      failure.failureInfo?.case === 'applicationFailureInfo'
        ? {
            case: 'applicationFailureInfo' as const,
            value: create(ApplicationFailureInfoSchema, {
              ...failure.failureInfo.value,
              details: failure.failureInfo.value.details,
            }),
          }
        : failure.failureInfo

    return create(FailureSchema, {
      ...failure,
      cause,
      failureInfo,
    })
  }

  async decodeFailure(
    failure: Failure | null | undefined,
    converter: DataConverter,
  ): Promise<Failure | null | undefined> {
    if (!failure) {
      return failure
    }
    const cause = failure.cause ? await this.decodeFailure(failure.cause, converter) : undefined
    const applicationDetails =
      failure.failureInfo?.case === 'applicationFailureInfo' ? failure.failureInfo.value.details?.payloads : undefined
    const decodedDetails =
      applicationDetails && applicationDetails.length > 0
        ? await converter.decodePayloads(applicationDetails)
        : applicationDetails

    const failureInfo =
      failure.failureInfo?.case === 'applicationFailureInfo'
        ? {
            case: 'applicationFailureInfo' as const,
            value: create(ApplicationFailureInfoSchema, {
              ...failure.failureInfo.value,
              ...(decodedDetails && decodedDetails.length > 0
                ? { details: create(PayloadsSchema, { payloads: decodedDetails }) }
                : { details: undefined }),
            }),
          }
        : failure.failureInfo

    return create(FailureSchema, { ...failure, cause: cause ?? undefined, failureInfo })
  }

  async failureToError(failure: Failure | null | undefined, converter: DataConverter): Promise<Error | undefined> {
    if (!failure) {
      return undefined
    }
    const detailsPayloads =
      failure.failureInfo?.case === 'applicationFailureInfo' ? failure.failureInfo.value.details?.payloads : undefined
    const details = detailsPayloads && detailsPayloads.length > 0 ? await converter.fromPayloads(detailsPayloads) : []
    const cause = failure.cause ? await this.failureToError(failure.cause, converter) : undefined
    const failureType =
      failure.failureInfo?.case === 'applicationFailureInfo'
        ? failure.failureInfo.value.type || 'ApplicationFailure'
        : 'TemporalFailure'
    const error = new TemporalFailureError({
      message: failure.message || 'Temporal workflow failed',
      failure,
      failureType,
      nonRetryable:
        failure.failureInfo?.case === 'applicationFailureInfo'
          ? Boolean(failure.failureInfo.value.nonRetryable)
          : false,
      details: details.length > 0 ? details : undefined,
      cause: cause as Error | undefined,
      stack: failure.stackTrace,
    })
    return error
  }
}

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return String(error)
}

const sanitizeMetricName = (codec: string) => codec.replace(/[^a-zA-Z0-9_]/g, '_')

class CodecMetrics {
  readonly #registry?: MetricsRegistry
  readonly #counters = new Map<string, Counter>()

  constructor(registry?: MetricsRegistry) {
    this.#registry = registry
  }

  async #resolveCounter(name: string, description: string): Promise<Counter | undefined> {
    if (!this.#registry) {
      return undefined
    }
    const cached = this.#counters.get(name)
    if (cached) return cached
    const counter = await Effect.runPromise(this.#registry.counter(name, description))
    this.#counters.set(name, counter)
    return counter
  }

  async record(codec: string, direction: 'encode' | 'decode', success: boolean): Promise<void> {
    if (!this.#registry) return
    const base = sanitizeMetricName(codec)
    const counterName = `temporal_payload_codec_${direction}_total_${base}`
    const counter = await this.#resolveCounter(counterName, `Payload codec ${direction} (${codec})`)
    if (counter) {
      await Effect.runPromise(counter.inc())
    }
    if (!success) {
      const errorName = `temporal_payload_codec_errors_total_${base}`
      const errorCounter = await this.#resolveCounter(errorName, `Payload codec failures (${codec})`)
      if (errorCounter) {
        await Effect.runPromise(errorCounter.inc())
      }
    }
  }
}

export interface DataConverterOptions {
  payloadConverter?: PayloadConverter
  payloadCodecs?: readonly PayloadCodec[]
  failureConverter?: FailureConverter
  metricsRegistry?: MetricsRegistry
  logger?: Logger
}

class CodecDataConverter implements DataConverter {
  readonly payloadCodecs: readonly PayloadCodec[]
  readonly failureConverter: FailureConverter
  readonly #payloadConverter: PayloadConverter
  readonly #metrics: CodecMetrics
  readonly #logger?: Logger

  constructor(options: DataConverterOptions) {
    this.#payloadConverter = options.payloadConverter ?? new JsonPayloadConverter()
    this.payloadCodecs = options.payloadCodecs ?? []
    this.failureConverter = options.failureConverter ?? new DefaultFailureConverter()
    this.#metrics = new CodecMetrics(options.metricsRegistry)
    this.#logger = options.logger
  }

  async toPayload(value: unknown): Promise<Payload> {
    const payload = await this.#payloadConverter.toPayload(value)
    const encoded = await this.encodePayloads([payload])
    return encoded?.[0] ?? payload
  }

  async fromPayload(payload: Payload | null | undefined): Promise<unknown> {
    if (!payload) return null
    const decoded = await this.decodePayloads([payload])
    return this.#payloadConverter.fromPayload(decoded[0])
  }

  async toPayloads(values: unknown[]): Promise<Payload[] | undefined> {
    const payloads = await this.#payloadConverter.toPayloads(values)
    return this.encodePayloads(payloads)
  }

  async fromPayloads(payloads: Payload[] | null | undefined): Promise<unknown[]> {
    if (!payloads || payloads.length === 0) {
      return []
    }
    const decoded = await this.decodePayloads(payloads)
    return this.#payloadConverter.fromPayloads(decoded)
  }

  async toPayloadMap(map: Record<string, unknown> | undefined): Promise<PayloadMap | undefined> {
    const payloadMap = await this.#payloadConverter.toPayloadMap(map)
    if (!payloadMap) return undefined
    const entries = Object.entries(payloadMap)
    if (entries.length === 0) {
      return payloadMap
    }
    const encodedEntries = await Promise.all(
      entries.map(async ([key, payload]) => {
        const [encoded] = (await this.encodePayloads([payload])) ?? [payload]
        return [key, encoded] as const
      }),
    )
    return Object.fromEntries(encodedEntries)
  }

  async fromPayloadMap(map: PayloadMap | null | undefined): Promise<Record<string, unknown> | undefined> {
    if (!map) return undefined
    const entries = Object.entries(map)
    if (entries.length === 0) return {}
    const decodedEntries = await Promise.all(
      entries.map(async ([key, payload]) => {
        const [decoded] = await this.decodePayloads([payload])
        const value = await this.#payloadConverter.fromPayload(decoded)
        return [key, value] as const
      }),
    )
    return Object.fromEntries(decodedEntries)
  }

  async encodePayloads(payloads: Payload[] | null | undefined): Promise<Payload[] | undefined> {
    if (!payloads || payloads.length === 0) {
      return payloads ?? undefined
    }
    let current = payloads
    for (const codec of this.payloadCodecs) {
      try {
        current = await codec.encode(current)
        await this.#metrics.record(codec.name, 'encode', true)
      } catch (error) {
        await this.#metrics.record(codec.name, 'encode', false)
        await this.#logCodecError(codec.name, 'encode', error)
        if (error instanceof PayloadCodecError) {
          throw error
        }
        throw new PayloadCodecError(codec.name, 'encode', describeError(error), error)
      }
    }
    return current
  }

  async decodePayloads(payloads: Payload[] | null | undefined): Promise<Payload[]> {
    if (!payloads || payloads.length === 0) {
      return []
    }
    let current = payloads
    for (const codec of [...this.payloadCodecs].reverse()) {
      try {
        current = await codec.decode(current)
        await this.#metrics.record(codec.name, 'decode', true)
      } catch (error) {
        await this.#metrics.record(codec.name, 'decode', false)
        await this.#logCodecError(codec.name, 'decode', error)
        if (error instanceof PayloadCodecError) {
          throw error
        }
        throw new PayloadCodecError(codec.name, 'decode', describeError(error), error)
      }
    }
    return current
  }

  async errorToFailure(error: unknown): Promise<Failure> {
    return this.failureConverter.errorToFailure(error, this)
  }

  async failureToError(failure: Failure | null | undefined): Promise<Error | undefined> {
    return this.failureConverter.failureToError(failure, this)
  }

  async encodeFailurePayloads(failure: Failure): Promise<Failure> {
    if (this.failureConverter.encodeFailure) {
      return this.failureConverter.encodeFailure(failure, this)
    }
    return failure
  }

  async decodeFailurePayloads(failure: Failure | null | undefined): Promise<Failure | null | undefined> {
    if (!failure) {
      return failure
    }
    if (this.failureConverter.decodeFailure) {
      return this.failureConverter.decodeFailure(failure, this)
    }
    return failure
  }

  async #logCodecError(codec: string, direction: 'encode' | 'decode', error: unknown): Promise<void> {
    if (!this.#logger) {
      return
    }
    try {
      await Effect.runPromise(
        this.#logger.log('error', 'payload codec failure', {
          codec,
          direction,
          error: describeError(error),
        }),
      )
    } catch {
      // swallow logging failures
    }
  }
}

export const createDefaultDataConverter = (options: DataConverterOptions = {}): DataConverter =>
  new CodecDataConverter(options)

export const encodeValuesToPayloads = async (
  converter: DataConverter,
  values: unknown[],
): Promise<Payload[] | undefined> => converter.toPayloads(values)

export const decodePayloadsToValues = async (
  converter: DataConverter,
  payloads: Payload[] | null | undefined,
): Promise<unknown[]> => converter.fromPayloads(payloads)

export const encodeMapValuesToPayloads = async (
  converter: DataConverter,
  map: Record<string, unknown> | undefined,
): Promise<PayloadMap | undefined> => converter.toPayloadMap(map)

export const decodePayloadMapToValues = async (
  converter: DataConverter,
  map: PayloadMap | null | undefined,
): Promise<Record<string, unknown> | undefined> => converter.fromPayloadMap(map)

export const encodeErrorToFailure = async (converter: DataConverter, error: unknown): Promise<Failure> =>
  converter.errorToFailure(error)

export const encodeFailurePayloads = async (converter: DataConverter, failure: Failure): Promise<Failure> =>
  converter.encodeFailurePayloads(failure)

export const decodeFailurePayloads = async (
  converter: DataConverter,
  failure: Failure | null | undefined,
): Promise<Failure | null | undefined> => converter.decodeFailurePayloads(failure)

export const failureToError = async (
  converter: DataConverter,
  failure: Failure | null | undefined,
): Promise<Error | undefined> => converter.failureToError(failure)

export const createJsonPayloadConverter = (): PayloadConverter => new JsonPayloadConverter()

export { buildCodecsFromConfig } from './codecs'
