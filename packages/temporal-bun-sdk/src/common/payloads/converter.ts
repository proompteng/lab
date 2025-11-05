import type { Payload } from '../../proto/temporal/api/common/v1/message_pb'

import {
  jsonToPayload,
  jsonToPayloadMap,
  jsonToPayloads,
  payloadMapToJson,
  payloadsToJson,
  payloadToJson,
} from './json-codec'

export type PayloadMap = Record<string, Payload>

export interface DataConverter {
  toPayload(value: unknown): Promise<Payload>
  fromPayload(payload: Payload | null | undefined): Promise<unknown>
  toPayloads(values: unknown[]): Promise<Payload[] | undefined>
  fromPayloads(payloads: Payload[] | null | undefined): Promise<unknown[]>
  toPayloadMap(map: Record<string, unknown> | undefined): Promise<PayloadMap | undefined>
  fromPayloadMap(map: PayloadMap | null | undefined): Promise<Record<string, unknown> | undefined>
}

class JsonDataConverter implements DataConverter {
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

export const createDefaultDataConverter = (): DataConverter => new JsonDataConverter()

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
