import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

const source = 'a'.repeat(40)
const continuous = [
  'bayn.valkey.get',
  'bayn.valkey.put',
  'bayn.valkey.set',
  'bayn.valkey.replica-ack',
  'bayn.broker.observation.materialization',
  'bayn.broker.observation.fence',
  'bayn.broker.observation.capture',
  'bayn.broker.observation.publish',
]
const conditional = [
  'bayn.postgres.writer-fence',
  'bayn.postgres.commit',
  'bayn.reconciliation.persist',
  'bayn.postgres.generation-settlement',
]

test.each(['dormant recovery', 'quiet logs', 'missing publication'] as const)(
  'rollout verification distinguishes %s',
  async (mode) => {
    const stages =
      mode === 'missing publication'
        ? continuous.filter((stage) => stage !== 'bayn.valkey.put')
        : mode === 'dormant recovery'
          ? continuous
          : [...continuous, ...conditional]
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === '/api/search') return Response.json({ traces: [{ traceID: 'b'.repeat(32) }] })
        if (url.pathname === '/loki/api/v1/query_range')
          return Response.json({ status: 'success', data: { result: mode === 'quiet logs' ? [] : [{ stream: {} }] } })
        if (url.pathname === '/prometheus/api/v1/rules')
          return Response.json({
            data: {
              groups: [
                {
                  name: 'bayn-cache-performance.rules',
                  rules: Array.from({ length: 8 }, (_, index) => ({
                    name: `rule-${index}`,
                    health: 'ok',
                    state: 'inactive',
                  })),
                },
              ],
            },
          })
        const query = url.searchParams.get('query') ?? ''
        let rows: Array<{ metric: Record<string, string>; value: [number, string] }>
        if (query.includes('heartbeat_timestamp'))
          rows = ['bayn', 'bayn-execution-controller'].flatMap((service) =>
            [0, 1].map((instance) => ({
              metric: { service, instance: String(instance), source_revision: source },
              value: [0, String(Date.now() / 1000 - 2)],
            })),
          )
        else if (query.includes('duration_seconds'))
          rows = stages.map((stage) => ({ metric: { stage, le: '+Inf' }, value: [0, '10'] }))
        else
          rows = Array.from({ length: query.startsWith('up{') || query.startsWith('redis_up{') ? 2 : 1 }, () => ({
            metric: {},
            value: [0, '1'],
          }))
        return Response.json({ status: 'success', data: { result: rows } })
      },
    })
    try {
      const endpoint = `http://127.0.0.1:${server.port}`
      const child = Bun.spawn(
        [
          'python3',
          fileURLToPath(new URL('../../../../../services/bayn/tools/verify-cache-observability.py', import.meta.url)),
          '--source',
          source,
          '--mimir',
          endpoint,
          '--loki',
          endpoint,
          '--tempo',
          endpoint,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (mode === 'missing publication') {
        expect(exitCode).not.toBe(0)
        expect(stderr).toContain("missing operation histograms: ['bayn.valkey.put']")
        return
      }
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
      const report = JSON.parse(stdout)
      if (mode === 'dormant recovery')
        expect(report.conditionalOperationCounts['bayn.postgres.generation-settlement']).toBeNull()
      else expect(report.valkeyLogCollection).toEqual({ state: 'NOT_OBSERVED', streams: 0, windowHours: 48 })
    } finally {
      await server.stop(true)
    }
  },
)
