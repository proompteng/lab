import { expect, test } from 'bun:test'
import http2 from 'node:http2'

import { ExportResultCode } from '../src/core'
import { OTLPTraceExporter } from '../src/exporter-trace-otlp-http'
import { type SpanData, SpanKind } from '../src/sdk-trace'

const span: SpanData = {
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  name: 'retry-preserves-span',
  kind: SpanKind.INTERNAL,
  startTimeUnixNano: '1',
  endTimeUnixNano: '2',
  attributes: {},
  resourceAttributes: { 'service.name': 'froussard' },
  scope: { name: 'retry-regression' },
}

const receiveExports = async (
  statuses: readonly string[],
  run: (url: string, requests: Buffer[], timeouts: string[]) => Promise<void>,
) => {
  const server = http2.createServer()
  const sessions = new Set<http2.ServerHttp2Session>()
  const requests: Buffer[] = []
  const timeouts: string[] = []
  server.on('session', (session) => {
    sessions.add(session)
    session.once('close', () => sessions.delete(session))
  })
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    stream.on('end', () => {
      requests.push(Buffer.concat(chunks))
      timeouts.push(String(headers['grpc-timeout']))
      const status = statuses[Math.min(requests.length - 1, statuses.length - 1)]
      if (status === 'hang') return
      stream.respond({
        ':status': 200,
        'content-type': 'application/grpc',
        'grpc-status': status,
        'grpc-message': status === '0' ? '' : 'records have timed out before they were able to be produced',
      })
      stream.end(Buffer.from([0, 0, 0, 0, 0]))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('Receiver has no TCP address')
  try {
    await run(`http://127.0.0.1:${address.port}`, requests, timeouts)
  } finally {
    for (const session of sessions) session.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const exportSpan = (url: string, timeoutMillis: number) =>
  new Promise<{ code: ExportResultCode; error?: Error }>((resolve) => {
    new OTLPTraceExporter({ url, protocol: 'grpc', timeoutMillis }).export([span], resolve)
  })

test.each(['1', '4', '10', '11', '14', '15'])(
  'retries gRPC status %s with the identical trace payload',
  async (status) => {
    await receiveExports([status, '0'], async (url, requests, timeouts) => {
      const result = await exportSpan(url, 4000)
      expect(result.code).toBe(ExportResultCode.SUCCESS)
      expect(requests).toHaveLength(2)
      expect(requests[1]).toEqual(requests[0])
      expect(Number.parseInt(timeouts[1] ?? '')).toBeLessThan(Number.parseInt(timeouts[0] ?? ''))
    })
  },
)

test.each(['3', '7', '8', '16'])('does not retry permanent gRPC status %s', async (status) => {
  await receiveExports([status, '0'], async (url, requests) => {
    const result = await exportSpan(url, 4000)
    expect(result.code).toBe(ExportResultCode.FAILED)
    expect(result.error?.message).toContain(`export failed: ${status}`)
    expect(requests).toHaveLength(1)
  })
})

test('does not begin a retry that exceeds the remaining export budget', async () => {
  await receiveExports(['14'], async (url, requests) => {
    const started = performance.now()
    const result = await exportSpan(url, 50)
    expect(result.code).toBe(ExportResultCode.FAILED)
    expect(requests).toHaveLength(1)
    expect(performance.now() - started).toBeLessThan(500)
  })
})

test('cancels a receiver that does not finish within the export budget', async () => {
  await receiveExports(['hang'], async (url, requests) => {
    const result = await exportSpan(url, 50)
    expect(result.code).toBe(ExportResultCode.FAILED)
    expect(result.error?.message).toContain('timed out')
    expect(requests).toHaveLength(1)
  })
})
