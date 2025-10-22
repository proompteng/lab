import { TextDecoder } from 'node:util'

export interface NativeErrorPayload {
  code: number
  msg: string
  where: string
  raw?: string
}

export interface TemporalBridgeErrorInit extends NativeErrorPayload {
  raw?: string
}

const textDecoder = new TextDecoder()
const FALLBACK_CODE = 1

export class TemporalBridgeError extends Error {
  readonly code: number
  readonly where?: string
  readonly raw: string

  constructor(input: TemporalBridgeErrorInit | string) {
    const payload = typeof input === 'string' ? parseFallback(input) : normalizePayload(input)
    super(payload.msg ?? 'Temporal bridge error')
    this.name = 'TemporalBridgeError'
    this.code = payload.code
    this.where = payload.where
    this.raw = payload.raw ?? payload.msg ?? 'Temporal bridge error'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

function parseFallback(message: string): NativeErrorPayload {
  return { code: FALLBACK_CODE, msg: message, where: 'unknown', raw: message }
}

function normalizePayload(payload: NativeErrorPayload): NativeErrorPayload {
  return {
    code: typeof payload.code === 'number' ? payload.code : FALLBACK_CODE,
    msg: payload.msg ?? 'Temporal bridge error',
    where: payload.where ?? 'unknown',
    raw: payload.raw ?? payload.msg,
  }
}

export function decodeNativeError(buffer: Uint8Array): NativeErrorPayload {
  let raw = ''
  try {
    raw = textDecoder.decode(buffer)
  } catch (error) {
    const fallback = String(error)
    return { code: FALLBACK_CODE, msg: fallback, where: 'decodeNativeError', raw: fallback }
  }

  try {
    const parsed = JSON.parse(raw) as Partial<NativeErrorPayload>
    if (typeof parsed.code !== 'number' || typeof parsed.msg !== 'string' || typeof parsed.where !== 'string') {
      return { code: FALLBACK_CODE, msg: raw || 'Native error payload missing fields', where: 'decodeNativeError', raw }
    }
    return { code: parsed.code, msg: parsed.msg, where: parsed.where, raw }
  } catch {
    return { code: FALLBACK_CODE, msg: raw || 'Native error payload not valid JSON', where: 'decodeNativeError', raw }
  }
}

export function toTemporalBridgeError(payload: NativeErrorPayload | string): TemporalBridgeError {
  return new TemporalBridgeError(payload)
}
