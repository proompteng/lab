import { createFileRoute } from '@tanstack/react-router'

import { buildQuantAccountWitness } from '~/server/torghut-quant-account-witness'
import { parseQuantAccount, parseQuantStrategyId, parseQuantWindow } from '~/server/torghut-quant-http'
import { getQuantLatestStoreStatus, listLatestQuantPipelineHealth } from '~/server/torghut-quant-metrics-store'

export const Route = createFileRoute('/api/torghut/trading/control-plane/quant/account-witness')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getQuantAccountWitnessHandler(request),
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

const parseAccountAliases = (url: URL) => {
  const repeated = url.searchParams.getAll('account_alias')
  const commaSeparated = (url.searchParams.get('account_aliases') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return [...repeated, ...commaSeparated]
}

const parseTimeoutMs = (url: URL) => {
  const raw = url.searchParams.get('timeout_ms') ?? process.env.JANGAR_QUANT_ACCOUNT_WITNESS_TIMEOUT_MS
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

export const getQuantAccountWitnessHandler = async (request: Request) => {
  const url = new URL(request.url)
  const strategyIdParam = url.searchParams.get('strategy_id') ?? url.searchParams.get('strategyId')
  const strategyIdResult = strategyIdParam ? parseQuantStrategyId(url) : { ok: true as const, value: undefined }
  if (!strategyIdResult.ok) return jsonResponse({ ok: false, message: strategyIdResult.message }, 400)

  const account = parseQuantAccount(url).value
  if (!account) return jsonResponse({ ok: false, message: 'Missing required query param: account' }, 400)

  const windowResult = parseQuantWindow(url)
  if (!windowResult.ok) return jsonResponse({ ok: false, message: windowResult.message }, 400)

  try {
    const witness = await buildQuantAccountWitness({
      strategyId: strategyIdResult.value,
      account,
      accountAliases: parseAccountAliases(url),
      window: windowResult.value,
      timeoutMs: parseTimeoutMs(url),
      getLatestStoreStatus: getQuantLatestStoreStatus,
      listLatestPipelineHealth: listLatestQuantPipelineHealth,
    })

    return jsonResponse({ ok: true, witness })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Quant account witness failed'
    return jsonResponse({ ok: false, message }, 503)
  }
}
