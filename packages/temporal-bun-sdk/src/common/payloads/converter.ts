import {
  DefaultFailureConverter,
  DefaultPayloadConverter,
  type FailureConverter,
  type LoadedDataConverter,
  type PayloadCodec,
  type PayloadConverter,
} from '@temporalio/common'
import {
  decodeArrayFromPayloads,
  decodeMapFromPayloads,
  encodeMapToPayloads,
  encodeToPayloads,
} from '@temporalio/common/lib/internal-non-workflow/codec-helpers'
import type { temporal } from '@temporalio/proto'

import { jsonToPayload, payloadToJson } from './json-codec'

export type Payload = temporal.api.common.v1.IPayload
export type Payloads = temporal.api.common.v1.IPayloads
export type PayloadMap = Record<string, Payload>
export type DataConverter = LoadedDataConverter

export interface CreateDataConverterOptions {
  payloadConverter?: PayloadConverter
  failureConverter?: FailureConverter
  payloadCodecs?: PayloadCodec[]
}

export const createDataConverter = (options: CreateDataConverterOptions = {}): DataConverter => ({
  payloadConverter: options.payloadConverter ?? new DefaultPayloadConverter(),
  failureConverter: options.failureConverter ?? new DefaultFailureConverter(),
  payloadCodecs: [...(options.payloadCodecs ?? [])],
})

export const createDefaultDataConverter = (): DataConverter => createDataConverter()

export const encodeValuesToPayloads = async (
  converter: DataConverter,
  values: unknown[],
): Promise<Payload[] | undefined> => {
  if (values.length === 0) {
    return undefined
  }
  return await encodeToPayloads(converter, ...values)
}

export const decodePayloadsToValues = async (
  converter: DataConverter,
  payloads: Payload[] | null | undefined,
): Promise<unknown[]> => {
  if (!payloads || payloads.length === 0) {
    return []
  }
  return await decodeArrayFromPayloads(converter, payloads)
}

export const encodeMapValuesToPayloads = async (
  converter: DataConverter,
  map: Record<string, unknown> | undefined,
): Promise<PayloadMap | undefined> => {
  if (map === undefined) {
    return undefined
  }
  if (Object.keys(map).length === 0) {
    return {}
  }
  return await encodeMapToPayloads(converter, map)
}

export const decodePayloadMapToValues = async (
  converter: DataConverter,
  map: PayloadMap | null | undefined,
): Promise<Record<string, unknown> | undefined> => {
  if (map === undefined) {
    return undefined
  }
  if (map === null) {
    return undefined
  }
  if (Object.keys(map).length === 0) {
    return {}
  }
  return await decodeMapFromPayloads(converter, map)
}

export const payloadsToJson = (payloads: Payload[] | undefined): unknown[] => {
  if (!payloads || payloads.length === 0) {
    return []
  }
  return payloads.map((payload) => payloadToJson(payload))
}

export const jsonToPayloads = (values: unknown[] | null | undefined): Payload[] => {
  if (!values || values.length === 0) {
    return []
  }
  return values.map((value) => jsonToPayload(value))
}

export const payloadMapToJson = (map: PayloadMap | undefined): Record<string, unknown> | undefined => {
  if (map === undefined) {
    return undefined
  }
  const entries = Object.entries(map)
  if (entries.length === 0) {
    return {}
  }
  return Object.fromEntries(entries.map(([key, payload]) => [key, payloadToJson(payload)]))
}

export const jsonToPayloadMap = (map: Record<string, unknown> | null | undefined): PayloadMap | undefined => {
  if (map === undefined || map === null) {
    return undefined
  }
  const entries = Object.entries(map)
  if (entries.length === 0) {
    return {}
  }
  return Object.fromEntries(entries.map(([key, value]) => [key, jsonToPayload(value)]))
}

export const encodeValuesToJson = async (converter: DataConverter, values: unknown[]): Promise<unknown[]> => {
  const payloads = await encodeValuesToPayloads(converter, values)
  return payloadsToJson(payloads)
}

export const decodeJsonToValues = async (converter: DataConverter, values: unknown[]): Promise<unknown[]> => {
  const payloads = jsonToPayloads(values)
  return await decodePayloadsToValues(converter, payloads)
}

export const encodeMapToJson = async (
  converter: DataConverter,
  map: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined> => {
  const payloadMap = await encodeMapValuesToPayloads(converter, map)
  return payloadMapToJson(payloadMap)
}

export const decodeJsonToMap = async (
  converter: DataConverter,
  map: Record<string, unknown> | null | undefined,
): Promise<Record<string, unknown> | undefined> => {
  const payloadMap = jsonToPayloadMap(map)
  if (payloadMap === undefined) {
    return undefined
  }
  return await decodePayloadMapToValues(converter, payloadMap)
}
