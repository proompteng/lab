import { Buffer } from 'node:buffer'

import { z } from 'zod'

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

export const metadataHeadersSchema = z
  .record(
    z.union([
      z.string(),
      z.instanceof(ArrayBuffer),
      z.custom<ArrayBufferView>(
        (value) => typeof value === 'object' && value !== null && ArrayBuffer.isView(value),
        'Header values must be strings or byte arrays',
      ),
    ]),
  )
  .transform((headers, ctx) => {
    const normalized: Record<string, string> = {}
    const seen = new Set<string>()

    for (const [rawKey, rawValue] of Object.entries(headers)) {
      const trimmedKey = rawKey.trim()
      if (trimmedKey.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Header keys must be non-empty strings',
          path: [rawKey],
        })
        continue
      }

      if (trimmedKey !== rawKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Header keys must not include leading or trailing whitespace',
          path: [rawKey],
        })
      }

      const normalizedKey = trimmedKey.toLowerCase()
      if (seen.has(normalizedKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Header key '${normalizedKey}' is duplicated (case-insensitive match)`,
          path: [rawKey],
        })
        continue
      }
      seen.add(normalizedKey)

      const isBinaryKey = normalizedKey.endsWith('-bin')

      if (typeof rawValue === 'string') {
        const trimmedValue = rawValue.trim()
        if (trimmedValue.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Header values must be non-empty strings',
            path: [rawKey],
          })
          continue
        }

        if (isBinaryKey) {
          normalized[normalizedKey] = Buffer.from(trimmedValue, 'utf8').toString('base64')
          continue
        }

        if (!isPrintableAscii(trimmedValue)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Header '${normalizedKey}' values must contain printable ASCII characters; use '-bin' for binary metadata`,
            path: [rawKey],
          })
          continue
        }

        normalized[normalizedKey] = trimmedValue
        continue
      }

      const isArrayBuffer = rawValue instanceof ArrayBuffer
      const isArrayBufferView = !isArrayBuffer && ArrayBuffer.isView(rawValue)

      if (!isArrayBuffer && !isArrayBufferView) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Header values must be strings or byte arrays',
          path: [rawKey],
        })
        continue
      }

      if (!isBinaryKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Header '${normalizedKey}' accepts string values only; append '-bin' to use binary metadata`,
          path: [rawKey],
        })
        continue
      }

      const bytes = toUint8Array(rawValue as ArrayBuffer | ArrayBufferView)
      if (bytes.byteLength === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Header values must be non-empty byte arrays',
          path: [rawKey],
        })
        continue
      }

      normalized[normalizedKey] = Buffer.from(bytes).toString('base64')
    }

    return normalized
  })
