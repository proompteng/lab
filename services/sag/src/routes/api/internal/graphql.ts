import { createFileRoute } from '@tanstack/react-router'
import { loadGatewayState } from '~/server/persistence'

export const Route = createFileRoute('/api/internal/graphql')({
  server: {
    handlers: {
      POST: async ({ request }: SagServerRouteArgs) => {
        const body = (await request.json().catch(() => ({}))) as { query?: string }
        const state = await loadGatewayState()
        const query = body.query ?? ''
        const includeEvents = query.length === 0 || query.includes('events')
        const includeTasks = query.length === 0 || query.includes('tasks')
        return jsonResponse({
          data: {
            tasks: includeTasks
              ? state.tasks.slice(0, 25).map((task) => ({
                  id: task.id,
                  status: task.status,
                  decision: task.decision,
                  requestedBy: task.requestedBy,
                  createdAt: task.createdAt,
                }))
              : undefined,
            events: includeEvents
              ? state.events.slice(0, 50).map((event) => ({
                  id: event.id,
                  taskId: event.taskId,
                  connector: event.connector,
                  operation: event.operation,
                  status: event.status,
                  timestamp: event.timestamp,
                }))
              : undefined,
            connectorCalls: state.connectorCalls.slice(0, 50).map((call) => ({
              id: call.id,
              taskId: call.taskId,
              connector: call.connector,
              operation: call.operation,
              status: call.status,
              durationMs: call.durationMs,
            })),
          },
        })
      },
      GET: async () => jsonResponse({ ok: false, error: 'POST required' }, 405),
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
