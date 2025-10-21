const decoder = new TextDecoder()

export enum TemporalBridgeErrorCode {
  Ok = 0,
  InvalidArgument = 1,
  NotFound = 2,
  AlreadyClosed = 3,
  NoMemory = 4,
  Internal = 5,
}

export interface TemporalBridgeErrorInit {
  readonly code: number
  readonly message: string
  readonly where: string
  readonly raw: string
  readonly cause?: unknown
}

export class TemporalBridgeError extends Error {
  readonly code: TemporalBridgeErrorCode
  readonly where: string
  readonly raw: string
  readonly cause?: unknown

  constructor(init: TemporalBridgeErrorInit) {
    super(init.message)
    this.name = 'TemporalBridgeError'
    this.code = toBridgeErrorCode(init.code)
    this.where = init.where
    this.raw = init.raw
    if (init.cause !== undefined) {
      ;(this as { cause?: unknown }).cause = init.cause
    }
    this.cause = init.cause
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

interface TemporalBridgeErrorPayload {
  code?: unknown
  message?: unknown
  msg?: unknown
  where?: unknown
  source?: unknown
}

export interface BuildBridgeErrorOptions {
  readonly status: number
  readonly where: string
  readonly buffer: Uint8Array | null
  readonly cause?: unknown
  readonly fallbackMessage?: string
}

export function buildTemporalBridgeError(options: BuildBridgeErrorOptions): TemporalBridgeError {
  const { status, where, buffer, cause, fallbackMessage } = options
  if (buffer && buffer.length > 0) {
    const raw = decoder.decode(buffer)
    try {
      const parsed = JSON.parse(raw) as TemporalBridgeErrorPayload
      const decoded = decodePayload(parsed)
      if (decoded) {
        return new TemporalBridgeError({
          code: decoded.code,
          message: decoded.message,
          where: decoded.where,
          raw,
          cause,
        })
      }

      return new TemporalBridgeError({
        code: status,
        message: fallbackMessage ?? `Native error ${status} at ${where}`,
        where,
        raw,
        cause,
      })
    } catch (error) {
      return new TemporalBridgeError({
        code: status,
        message: fallbackMessage ?? `Native error ${status} at ${where}`,
        where,
        raw,
        cause: cause ?? error,
      })
    }
  }

  return new TemporalBridgeError({
    code: status,
    message: fallbackMessage ?? `Native error ${status} at ${where}`,
    where,
    raw: buffer ? decoder.decode(buffer) : '',
    cause,
  })
}

function decodePayload(
  payload: TemporalBridgeErrorPayload,
): { code: number; message: string; where: string } | undefined {
  const code = typeof payload.code === 'number' ? payload.code : Number(payload.code)
  const messageField =
    typeof payload.message === 'string' ? payload.message : typeof payload.msg === 'string' ? payload.msg : undefined
  const whereField =
    typeof payload.where === 'string' ? payload.where : typeof payload.source === 'string' ? payload.source : undefined

  if (Number.isFinite(code) && messageField && whereField) {
    return { code, message: messageField, where: whereField }
  }

  return undefined
}

function toBridgeErrorCode(code: number): TemporalBridgeErrorCode {
  if (code in TemporalBridgeErrorCode) {
    return code as TemporalBridgeErrorCode
  }
  return TemporalBridgeErrorCode.Internal
}
