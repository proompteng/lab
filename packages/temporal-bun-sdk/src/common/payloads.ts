// Payload serialization for @proompteng/temporal-bun-sdk
import type { PayloadCodec, TemporalPayload } from '../types'

export type { TemporalPayload, PayloadCodec }

export class JsonPayloadCodec implements PayloadCodec {
  encode(value: unknown): TemporalPayload {
    try {
      const json = JSON.stringify(value, (_key, val) => {
        // Handle special types
        if (val instanceof Date) {
          return { __temporal_date: val.toISOString() }
        }
        if (typeof val === 'bigint') {
          return { __temporal_bigint: val.toString() }
        }
        if (val instanceof ArrayBuffer) {
          return { __temporal_arraybuffer: Array.from(new Uint8Array(val)) }
        }
        return val
      })

      const data = new TextEncoder().encode(json)

      return {
        metadata: {
          encoding: 'json/plain',
        },
        data: data,
      }
    } catch (error) {
      throw new Error(`Failed to encode payload: ${error}`)
    }
  }

  decode(payload: TemporalPayload): unknown {
    try {
      const json = new TextDecoder().decode(payload.data)
      const parsed = JSON.parse(json, (_key, val) => {
        // Handle special types
        if (val && typeof val === 'object') {
          if (val.__temporal_date) {
            return new Date(val.__temporal_date)
          }
          if (val.__temporal_bigint) {
            return BigInt(val.__temporal_bigint)
          }
          if (val.__temporal_arraybuffer) {
            return new Uint8Array(val.__temporal_arraybuffer).buffer
          }
        }
        return val
      })

      return parsed
    } catch (error) {
      throw new Error(`Failed to decode payload: ${error}`)
    }
  }
}

export class BinaryPayloadCodec implements PayloadCodec {
  encode(value: unknown): TemporalPayload {
    try {
      // For binary codec, we expect the value to already be a Uint8Array or ArrayBuffer
      let data: Uint8Array

      if (value instanceof Uint8Array) {
        data = value
      } else if (value instanceof ArrayBuffer) {
        data = new Uint8Array(value)
      } else {
        // Fallback to JSON encoding
        const json = JSON.stringify(value)
        data = new TextEncoder().encode(json)
      }

      return {
        metadata: {
          encoding: 'binary/plain',
        },
        data: data,
      }
    } catch (error) {
      throw new Error(`Failed to encode binary payload: ${error}`)
    }
  }

  decode(payload: TemporalPayload): unknown {
    try {
      // For binary codec, return the raw data
      return payload.data
    } catch (error) {
      throw new Error(`Failed to decode binary payload: ${error}`)
    }
  }
}

// Default payload codec
export const defaultPayloadCodec = new JsonPayloadCodec()

// Helper functions
export function encodePayload(value: unknown, codec: PayloadCodec = defaultPayloadCodec): TemporalPayload {
  return codec.encode(value)
}

export function decodePayload(payload: TemporalPayload, codec: PayloadCodec = defaultPayloadCodec): unknown {
  return codec.decode(payload)
}

export function encodePayloads(values: unknown[], codec: PayloadCodec = defaultPayloadCodec): TemporalPayload[] {
  return values.map((value) => encodePayload(value, codec))
}

export function decodePayloads(payloads: TemporalPayload[], codec: PayloadCodec = defaultPayloadCodec): unknown[] {
  return payloads.map((payload) => decodePayload(payload, codec))
}
