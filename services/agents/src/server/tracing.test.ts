import { describe, expect, it, vi } from 'vitest'

import { createAgentRunLifecycleRecorder } from './tracing'

const run = {
  name: 'run-test',
  namespace: 'agents',
  runtime: 'job',
  outcome: 'Failed' as const,
  model: 'gpt-6.2-sol',
  effort: 'max',
  startTime: 1_790_000_000_000,
  endTime: 1_790_000_030_000,
}

describe('Agents lifecycle tracing', () => {
  it('is opt-in', () => {
    expect(createAgentRunLifecycleRecorder({})(run)).toBeUndefined()
  })

  it('exports an OTLP protobuf span to the trace path and returns its correlation ID', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
    try {
      const record = createAgentRunLifecycleRecorder({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://tempo.example:4318/',
        AGENTS_SERVER_PROFILE: 'agents-controllers',
      })
      expect(record(run)).toMatch(/^[a-f0-9]{32}$/)
      expect(fetcher).toHaveBeenCalledOnce()
      const [url, request] = fetcher.mock.calls[0]!
      expect(url).toBe('http://tempo.example:4318/v1/traces')
      expect(request).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/x-protobuf' } })
      const wire = Buffer.from(request?.body as ArrayBuffer)
      for (const text of ['agents.agentrun.lifecycle', 'agents-controllers', 'run-test', 'Failed', 'gpt-6.2-sol']) {
        expect(wire.includes(text)).toBe(true)
      }
    } finally {
      fetcher.mockRestore()
    }
  })
})
