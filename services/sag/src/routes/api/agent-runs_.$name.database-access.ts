import { createFileRoute } from '@tanstack/react-router'
import { buildSnapshot, requestDatabaseAccessApproval, resolveActorFromRequest } from '~/server/gateway'
import { listSagDatabaseTables, loadGatewayState, saveGatewayState } from '~/server/persistence'

export const Route = createFileRoute('/api/agent-runs_/$name/database-access')({
  server: {
    handlers: {
      GET: async ({ params }: SagServerRouteArgs & { params: { name: string } }) => {
        const state = await loadGatewayState()
        const target = `agents/${params.name}:sag.database.tables`
        const approval = state.approvals.find(
          (item) => item.action === 'database.list_tables' && item.target === target,
        )
        const tables = approval?.status === 'approved' ? await listSagDatabaseTables() : []
        return jsonResponse({ ok: true, approval, tables, snapshot: buildSnapshot(state) })
      },
      POST: async ({ request, params }: SagServerRouteArgs & { params: { name: string } }) => {
        const actor = resolveActorFromRequest(request)
        const state = await loadGatewayState()
        const approval = requestDatabaseAccessApproval(state, {
          actorId: actor.id,
          namespace: 'agents',
          runName: params.name,
        })
        await saveGatewayState(state)
        const tables = approval.status === 'approved' ? await listSagDatabaseTables() : []
        return jsonResponse(
          { ok: true, approval, tables, snapshot: buildSnapshot(state) },
          approval.status === 'pending' ? 201 : 200,
        )
      },
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
