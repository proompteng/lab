import { createCipheriv, createDecipheriv, randomBytes, type CipherGCMTypes } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

import { create, fromBinary, toBinary } from '@bufbuild/protobuf'

import { type Payload, PayloadSchema } from '../../proto/temporal/api/common/v1/message_pb'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const METADATA_ENCODING_KEY = 'encoding'
const METADATA_CODEC_KEY = 'codec'
const METADATA_KEY_ID = 'encryption-key-id'

const GZIP_ENCODING = 'binary/gzip'
const AES_GCM_ENCODING = 'binary/encrypted+aes-gcm'
const AES_NONCE_BYTES = 12
const AES_TAG_BYTES = 16

export type PayloadCodecName = 'gzip' | 'aes-gcm'

export interface PayloadCodec {
  readonly name: PayloadCodecName | string
  encode(payloads: Payload[]): Promise<Payload[]>
  decode(payloads: Payload[]): Promise<Payload[]>
}

export interface GzipPayloadCodecConfig {
  name: 'gzip'
  order?: number
  enabled?: boolean
}

export interface AesGcmPayloadCodecConfig {
  name: 'aes-gcm'
  key: string | Uint8Array
  keyId?: string
  order?: number
  enabled?: boolean
}

export type PayloadCodecConfig = GzipPayloadCodecConfig | AesGcmPayloadCodecConfig

export class PayloadCodecConfigurationError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'PayloadCodecConfigurationError'
  }
}

export class PayloadCodecError extends Error {
  constructor(
    readonly codec: string,
    readonly direction: 'encode' | 'decode',
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'PayloadCodecError'
  }
}

const isEncoding = (payload: Payload | undefined, encoding: string): boolean => {
  if (!payload?.metadata) return false
  const raw = payload.metadata[METADATA_ENCODING_KEY]
  if (!raw) return false
  try {
    return textDecoder.decode(raw) === encoding
  } catch {
    return false
  }
}

const encodeMetadata = (encoding: string, extra?: Record<string, string | undefined>): Record<string, Uint8Array> => {
  const base: Record<string, Uint8Array> = { [METADATA_ENCODING_KEY]: textEncoder.encode(encoding) }
  const extras = extra ?? {}
  for (const [key, value] of Object.entries(extras)) {
    if (value !== undefined) {
      base[key] = textEncoder.encode(value)
    }
  }
  return base
}

export const createGzipCodec = (): PayloadCodec => ({
  name: 'gzip',
  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => {
      const compressed = gzipSync(toBinary(PayloadSchema, payload))
      return create(PayloadSchema, {
        metadata: encodeMetadata(GZIP_ENCODING, { [METADATA_CODEC_KEY]: 'gzip' }),
        data: compressed,
      })
    })
  },
  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => {
      if (!isEncoding(payload, GZIP_ENCODING)) {
        return payload
      }
      if (!payload.data) {
        throw new PayloadCodecError('gzip', 'decode', 'gzip payload is missing data')
      }
      const inflated = gunzipSync(payload.data)
      return fromBinary(PayloadSchema, inflated)
    })
  },
})

const coerceKeyBuffer = (key: string | Uint8Array): Buffer => {
  if (typeof key === 'string') {
    const trimmed = key.trim()
    if (!trimmed) {
      throw new PayloadCodecConfigurationError('AES-GCM key must be non-empty')
    }
    try {
      return Buffer.from(trimmed, 'base64')
    } catch {
      const hexBuffer = Buffer.from(trimmed.replace(/^0x/, ''), 'hex')
      if (hexBuffer.byteLength === 0) {
        throw new PayloadCodecConfigurationError('AES-GCM key must be valid base64 or hex')
      }
      return hexBuffer
    }
  }
  if (key.byteLength === 0) {
    throw new PayloadCodecConfigurationError('AES-GCM key must be non-empty')
  }
  return Buffer.from(key)
}

const assertAesKeySize = (key: Buffer) => {
  if (![16, 24, 32].includes(key.byteLength)) {
    throw new PayloadCodecConfigurationError('AES-GCM key must be 128, 192, or 256 bits', {
      bytes: key.byteLength,
    })
  }
}

export interface AesGcmCodecOptions {
  key: string | Uint8Array
  keyId?: string
}

export const createAesGcmCodec = (options: AesGcmCodecOptions): PayloadCodec => {
  const key = coerceKeyBuffer(options.key)
  assertAesKeySize(key)
  const keyId = options.keyId ?? 'default'
  const algorithm = `aes-${key.byteLength * 8}-gcm` as CipherGCMTypes

  return {
    name: 'aes-gcm',
    async encode(payloads: Payload[]): Promise<Payload[]> {
      return payloads.map((payload) => {
        const nonce = randomBytes(AES_NONCE_BYTES)
        const cipher = createCipheriv(algorithm, key, nonce)
        const ciphertext = Buffer.concat([cipher.update(toBinary(PayloadSchema, payload)), cipher.final()])
        const tag = cipher.getAuthTag()
        const data = new Uint8Array(Buffer.concat([nonce, tag, ciphertext]))
        return create(PayloadSchema, {
          metadata: encodeMetadata(AES_GCM_ENCODING, {
            [METADATA_CODEC_KEY]: 'aes-gcm',
            [METADATA_KEY_ID]: keyId,
          }),
          data,
        })
      })
    },
    async decode(payloads: Payload[]): Promise<Payload[]> {
      return payloads.map((payload) => {
        if (!isEncoding(payload, AES_GCM_ENCODING)) {
          return payload
        }
        const data = payload.data ? Buffer.from(payload.data) : undefined
        if (!data || data.byteLength <= AES_NONCE_BYTES + AES_TAG_BYTES) {
          throw new PayloadCodecError('aes-gcm', 'decode', 'encrypted payload missing nonce/tag/data')
        }
        const nonce = data.subarray(0, AES_NONCE_BYTES)
        const tag = data.subarray(AES_NONCE_BYTES, AES_NONCE_BYTES + AES_TAG_BYTES)
        const ciphertext = data.subarray(AES_NONCE_BYTES + AES_TAG_BYTES)
        const decipher = createDecipheriv(algorithm, key, nonce)
        decipher.setAuthTag(tag)
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
        return fromBinary(PayloadSchema, plaintext)
      })
    },
  }
}

const byOrder = (a: PayloadCodecConfig, b: PayloadCodecConfig) => (a.order ?? 0) - (b.order ?? 0)

export const buildCodecsFromConfig = (configs: readonly PayloadCodecConfig[] | undefined): PayloadCodec[] => {
  if (!configs || configs.length === 0) {
    return []
  }
  const enabled = configs.filter((config) => config.enabled ?? true).sort(byOrder)
  const codecs: PayloadCodec[] = []

  for (const config of enabled) {
    if (config.name === 'gzip') {
      codecs.push(createGzipCodec())
      continue
    }
    if (config.name === 'aes-gcm') {
      codecs.push(
        createAesGcmCodec({
          key: config.key,
          keyId: config.keyId,
        }),
      )
    }
  }

  return codecs
}
