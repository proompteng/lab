import { Buffer } from 'node:buffer'

const toUint8Array = (value: ArrayBuffer | ArrayBufferView): Uint8Array => {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

const isPrintableAscii = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code > 0x7e) {
      return false
    }
  }
  return true
}

export const normalizeMetadataHeaders = (headers: Record<string, unknown>): Record<string, string> => {
  const normalized: Record<string, string> = {}
  const seen = new Set<string>()

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const trimmedKey = rawKey.trim()
    if (trimmedKey.length === 0) {
      throw new Error('Header keys must be non-empty strings')
    }
    if (trimmedKey !== rawKey) {
      throw new Error(`Header key '${rawKey}' must not include leading or trailing whitespace`)
    }

    const normalizedKey = trimmedKey.toLowerCase()
    if (seen.has(normalizedKey)) {
      throw new Error(`Header key '${normalizedKey}' is duplicated (case-insensitive match)`)
    }
    seen.add(normalizedKey)

    const isBinaryKey = normalizedKey.endsWith('-bin')

    if (typeof rawValue === 'string') {
      const trimmedValue = rawValue.trim()
      if (trimmedValue.length === 0) {
        throw new Error(`Header '${normalizedKey}' values must be non-empty strings`)
      }

      if (isBinaryKey) {
        normalized[normalizedKey] = Buffer.from(trimmedValue, 'utf8').toString('base64')
        continue
      }

      if (!isPrintableAscii(trimmedValue)) {
        throw new Error(
          `Header '${normalizedKey}' values must contain printable ASCII characters; append '-bin' for binary metadata`,
        )
      }

      normalized[normalizedKey] = trimmedValue
      continue
    }

    const isArrayBuffer = rawValue instanceof ArrayBuffer
    const isArrayBufferView =
      !isArrayBuffer && typeof rawValue === 'object' && rawValue !== null && ArrayBuffer.isView(rawValue)

    if (!isArrayBuffer && !isArrayBufferView) {
      throw new Error(`Header '${normalizedKey}' values must be strings or byte arrays`)
    }

    if (!isBinaryKey) {
      throw new Error(`Header '${normalizedKey}' accepts string values only; append '-bin' to use binary metadata`)
    }

    const bytes = toUint8Array(rawValue as ArrayBuffer | ArrayBufferView)
    if (bytes.byteLength === 0) {
      throw new Error(`Header '${normalizedKey}' values must be non-empty byte arrays`)
    }

    normalized[normalizedKey] = Buffer.from(bytes).toString('base64')
  }

  return normalized
}

export const createDefaultHeaders = (apiKey?: string): Record<string, string> => {
  if (!apiKey) {
    return {}
  }
  return normalizeMetadataHeaders({
    Authorization: `Bearer ${apiKey}`,
  })
}

export const mergeHeaders = (current: Record<string, string>, next: Record<string, string>): Record<string, string> => {
  return { ...current, ...next }
}
