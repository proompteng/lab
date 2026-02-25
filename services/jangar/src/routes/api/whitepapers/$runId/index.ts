import { createFileRoute } from '@tanstack/react-router'
import { resolveTorghutDb } from '~/server/torghut-trading-db'
import { approveTorghutWhitepaperForImplementation, getTorghutWhitepaperDetail } from '~/server/torghut-whitepapers'

export const Route = createFileRoute('/api/whitepapers/$runId/')({
  server: {
    handlers: {
      GET: async ({ params }) => getWhitepaperDetailHandler(params.runId),
      POST: async ({ params, request }) => approveWhitepaperImplementationHandler(params.runId, request),
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) => {
  const body = JSON.stringify(payload)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    },
  })
}

export const getWhitepaperDetailHandler = async (runIdRaw: string) => {
  const torghut = resolveTorghutDb()
  if (!torghut.ok) return jsonResponse({ ok: false, disabled: true, message: torghut.message }, 503)

  const runId = runIdRaw.trim()
  if (!runId) return jsonResponse({ ok: false, message: 'run id is required' }, 400)

  try {
    const item = await getTorghutWhitepaperDetail({ pool: torghut.pool, runId })
    if (!item) return jsonResponse({ ok: false, message: 'whitepaper run not found' }, 404)

    return jsonResponse({ ok: true, item })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load whitepaper run'
    return jsonResponse({ ok: false, message }, 500)
  }
}

const parseBody = async (request: Request): Promise<Record<string, unknown>> => {
  try {
    const payload = (await request.json()) as unknown
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {}
    return payload as Record<string, unknown>
  } catch {
    return {}
  }
}

const readString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

export const approveWhitepaperImplementationHandler = async (runIdRaw: string, request: Request) => {
  const runId = runIdRaw.trim()
  if (!runId) return jsonResponse({ ok: false, message: 'run id is required' }, 400)

  const body = await parseBody(request)
  const approvedBy = readString(body.approvedBy ?? body.approved_by)
  const approvalReason = readString(body.approvalReason ?? body.approval_reason)
  const targetScope = readString(body.targetScope ?? body.target_scope) || null
  const repository = readString(body.repository) || null
  const base = readString(body.base) || null
  const head = readString(body.head) || null
  const rolloutProfileRaw = readString(body.rolloutProfile ?? body.rollout_profile)
  const rolloutProfile =
    rolloutProfileRaw === 'manual' || rolloutProfileRaw === 'assisted' || rolloutProfileRaw === 'automatic'
      ? rolloutProfileRaw
      : null

  if (!approvedBy) return jsonResponse({ ok: false, message: 'approvedBy is required' }, 400)
  if (!approvalReason) return jsonResponse({ ok: false, message: 'approvalReason is required' }, 400)

  try {
    const result = await approveTorghutWhitepaperForImplementation({
      runId,
      approvedBy,
      approvalReason,
      targetScope,
      repository,
      base,
      head,
      rolloutProfile,
    })
    return jsonResponse({ ok: true, result }, 200)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to approve whitepaper for implementation'
    if (message.includes('whitepaper_approval_failed:404:')) {
      return jsonResponse({ ok: false, message }, 404)
    }
    if (message.includes('whitepaper_approval_failed:400:')) {
      return jsonResponse({ ok: false, message }, 400)
    }
    return jsonResponse({ ok: false, message }, 502)
  }
}
