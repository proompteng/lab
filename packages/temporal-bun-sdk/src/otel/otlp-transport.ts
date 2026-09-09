import http2 from 'node:http2'

import { diag } from './diag'

type FetchTimeout = { signal?: AbortSignal; cancel: () => void }

export type OtlpProtocol = 'http/json' | 'http/protobuf' | 'grpc'

export type OtlpTransportConfig = {
  url: string
  headers?: Record<string, string>
  timeoutMillis?: number
}

const createTimeoutSignal = (timeoutMillis?: number): FetchTimeout => {
  if (!timeoutMillis) {
    return { cancel: () => {} }
  }
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMillis)
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timeoutId),
  }
}

const normalizeHeaders = (headers?: Record<string, string>): Record<string, string> => {
  if (!headers) {
    return {}
  }
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!key || key.startsWith(':')) {
      continue
    }
    normalized[key.toLowerCase()] = value
  }
  return normalized
}

const buildGrpcFrame = (payload: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(5 + payload.length)
  frame[0] = 0
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  view.setUint32(1, payload.length)
  frame.set(payload, 5)
  return frame
}

const formatGrpcTimeout = (timeoutMillis?: number): string | undefined => {
  if (!timeoutMillis) {
    return undefined
  }
  const clamped = Math.max(1, Math.floor(timeoutMillis))
  return `${clamped}m`
}

export const sendOtlpHttp = async (
  config: OtlpTransportConfig,
  body: string | Uint8Array,
  contentType: string,
  label: string,
): Promise<void> => {
  const fetchFn = globalThis.fetch
  if (typeof fetchFn !== 'function') {
    throw new Error('fetch is not available in this runtime')
  }
  const resolvedBody: BodyInit =
    typeof body === 'string'
      ? body
      : (() => {
          const buffer = new ArrayBuffer(body.byteLength)
          new Uint8Array(buffer).set(body)
          return buffer
        })()
  const { signal, cancel } = createTimeoutSignal(config.timeoutMillis)
  try {
    const response = await fetchFn(config.url, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        ...normalizeHeaders(config.headers),
      },
      body: resolvedBody,
      signal,
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`OTLP ${label} export failed: ${response.status} ${response.statusText} ${text}`.trim())
    }
  } catch (error) {
    diag.error(`otlp ${label} export failed`, error)
    throw error
  } finally {
    cancel()
  }
}

export const sendOtlpGrpc = async (
  config: OtlpTransportConfig,
  payload: Uint8Array,
  path: string,
  label: string,
): Promise<void> => {
  const url = new URL(config.url)
  const authority = url.host
  const client = http2.connect(url.origin)
  const timeoutHeader = formatGrpcTimeout(config.timeoutMillis)
  const headers = normalizeHeaders(config.headers)
  const requestHeaders: http2.OutgoingHttpHeaders = {
    ':method': 'POST',
    ':path': path,
    ':authority': authority,
    'content-type': 'application/grpc',
    te: 'trailers',
    ...headers,
  }
  if (timeoutHeader) {
    requestHeaders['grpc-timeout'] = timeoutHeader
  }

  const frame = buildGrpcFrame(payload)

  return new Promise((resolve, reject) => {
    let responseStatus: number | undefined
    let grpcStatus: string | undefined
    let grpcMessage: string | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
      try {
        client.close()
      } catch {}
    }

    const fail = (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      diag.error(`otlp ${label} export failed`, error)
      reject(error)
    }

    const succeed = () => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve()
    }

    if (config.timeoutMillis) {
      timeoutId = setTimeout(() => {
        fail(new Error(`OTLP ${label} gRPC export timed out`))
        try {
          client.destroy()
        } catch {}
      }, config.timeoutMillis)
    }

    client.on('error', (error) => {
      fail(error instanceof Error ? error : new Error(String(error)))
    })

    const request = client.request(requestHeaders)
    request.on('response', (headers) => {
      const status = headers[':status']
      if (typeof status === 'number') {
        responseStatus = status
      } else if (typeof status === 'string') {
        responseStatus = Number.parseInt(status, 10)
      }
      const headerStatus = headers['grpc-status']
      if (typeof headerStatus === 'string') {
        grpcStatus = headerStatus
      }
      const headerMessage = headers['grpc-message']
      if (typeof headerMessage === 'string') {
        grpcMessage = headerMessage
      }
    })
    request.on('trailers', (trailers) => {
      const trailerStatus = trailers['grpc-status']
      if (typeof trailerStatus === 'string') {
        grpcStatus = trailerStatus
      }
      const trailerMessage = trailers['grpc-message']
      if (typeof trailerMessage === 'string') {
        grpcMessage = trailerMessage
      }
    })
    request.on('error', (error) => {
      fail(error instanceof Error ? error : new Error(String(error)))
    })
    request.on('data', () => {})
    request.on('end', () => {
      if (responseStatus && responseStatus !== 200) {
        fail(new Error(`OTLP ${label} gRPC export failed: HTTP ${responseStatus}`))
        return
      }
      if (grpcStatus && grpcStatus !== '0') {
        let message = grpcMessage ?? 'unknown gRPC error'
        if (grpcMessage) {
          try {
            message = decodeURIComponent(grpcMessage)
          } catch {}
        }
        fail(new Error(`OTLP ${label} gRPC export failed: ${grpcStatus} ${message}`))
        return
      }
      succeed()
    })

    request.end(frame)
  })
}
