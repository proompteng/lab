import { Buffer } from 'node:buffer'

import type { temporal } from '@temporalio/proto'

type Payload = temporal.api.common.v1.IPayload

const JSON_ENCODING = 'json/plain'
const ENCODING_METADATA_KEY = 'encoding'
const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

export const PAYLOAD_TUNNEL_FIELD = '__temporal_bun_payload__'
const PAYLOAD_TUNNEL_VERSION = 1

export interface PayloadTunnelEnvelope {
  readonly v: number
  readonly metadata: Record<string, string>
  readonly data?: string
}

const base64Encode = (value: Uint8Array | null | undefined): string | undefined => {
  if (value == null) {
    return undefined
  }
  if (value.byteLength === 0) {
    return ''
  }
  return Buffer.from(value).toString('base64')
}

const base64Decode = (value: string | undefined): Uint8Array | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (value.length === 0) {
    return new Uint8Array(0)
  }
  const buffer = Buffer.from(value, 'base64')
  return Uint8Array.from(buffer)
}

const readMetadataEncoding = (payload: Payload | null | undefined): string | undefined => {
  const metadata = payload?.metadata ?? undefined
  if (!metadata) return undefined
  const raw = metadata[ENCODING_METADATA_KEY] ?? undefined
  if (!raw) return undefined
  try {
    return textDecoder.decode(raw)
  } catch {
    return undefined
  }
}

const tryParseJson = (payload: Payload): unknown | undefined => {
  const buffer = payload.data ?? undefined
  if (!buffer) {
    return null
  }

  let jsonString: string
  try {
    jsonString = textDecoder.decode(buffer)
  } catch {
    return undefined
  }

  try {
    return JSON.parse(jsonString)
  } catch {
    return undefined
  }
}

const buildTunnelMetadata = (
  metadata: Record<string, Uint8Array | null> | null | undefined,
): Record<string, string> => {
  if (!metadata) {
    return {}
  }
  const entries = Object.entries(metadata)
  if (entries.length === 0) {
    return {}
  }
  const result: Record<string, string> = {}
  for (const [key, value] of entries) {
    const encoded = base64Encode(value ?? undefined)
    if (encoded !== undefined) {
      result[key] = encoded
    }
  }
  return result
}

const buildTunnelPayload = (payload: Payload): Record<typeof PAYLOAD_TUNNEL_FIELD, PayloadTunnelEnvelope> => {
  const metadata = buildTunnelMetadata(payload.metadata)
  const data = base64Encode(payload.data ?? undefined)
  const envelope: PayloadTunnelEnvelope = {
    v: PAYLOAD_TUNNEL_VERSION,
    metadata,
    ...(data !== undefined ? { data } : {}),
  }
  return { [PAYLOAD_TUNNEL_FIELD]: envelope }
}

const tunnelToPayload = (envelope: PayloadTunnelEnvelope): Payload => {
  const metadataEntries = Object.entries(envelope.metadata ?? {})
  const metadata =
    metadataEntries.length === 0
      ? undefined
      : Object.fromEntries(
          metadataEntries.map(([key, value]) => {
            const decoded = base64Decode(value)
            return decoded === undefined ? [key, undefined] : [key, decoded]
          }),
        )

  const decodedData = base64Decode(envelope.data)

  return {
    ...(metadata ? { metadata } : {}),
    ...(decodedData !== undefined ? { data: decodedData } : {}),
  }
}

const isTunnelEnvelope = (value: unknown): value is Record<typeof PAYLOAD_TUNNEL_FIELD, PayloadTunnelEnvelope> => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!(PAYLOAD_TUNNEL_FIELD in value)) {
    return false
  }
  const payload = (value as Record<string, unknown>)[PAYLOAD_TUNNEL_FIELD]
  if (typeof payload !== 'object' || payload === null) {
    return false
  }
  const envelope = payload as PayloadTunnelEnvelope & Record<string, unknown>
  if (envelope.v !== PAYLOAD_TUNNEL_VERSION || typeof envelope.metadata !== 'object' || envelope.metadata === null) {
    return false
  }
  if (envelope.data !== undefined && typeof envelope.data !== 'string') {
    return false
  }
  return true
}

export const payloadToJson = (payload: Payload | null | undefined): unknown => {
  if (!payload) {
    return null
  }

  const encoding = readMetadataEncoding(payload)
  if (encoding === JSON_ENCODING) {
    const parsed = tryParseJson(payload)
    if (parsed !== undefined) {
      return parsed
    }
  }

  return buildTunnelPayload(payload)
}

export const jsonToPayload = (value: unknown): Payload => {
  if (isTunnelEnvelope(value)) {
    return tunnelToPayload(value[PAYLOAD_TUNNEL_FIELD])
  }

  const jsonString = JSON.stringify(value)
  const dataBytes = textEncoder.encode(jsonString ?? 'null')
  const metadata: Record<string, Uint8Array> = {
    [ENCODING_METADATA_KEY]: textEncoder.encode(JSON_ENCODING),
  }

  return {
    metadata,
    data: dataBytes,
  }
}
