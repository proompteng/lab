import { createFileRoute } from '@tanstack/react-router'
import { resolveClickHouseClient } from '~/server/clickhouse'
import { parseTaLatestParams } from '~/server/torghut-ta'

export const Route = createFileRoute('/api/torghut/ta/latest')({
  server: {
    handlers: {
      GET: async ({ request }) => getLatestHandler(request),
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

const errorResponse = (message: string, status = 500) => jsonResponse({ ok: false, message, error: message }, status)

export const getLatestHandler = async (request: Request) => {
  const url = new URL(request.url)
  const parsed = parseTaLatestParams(url)
  if (!parsed.ok) return errorResponse(parsed.message, 400)

  const clientResult = resolveClickHouseClient()
  if (!clientResult.ok) return errorResponse(clientResult.message, 503)

  const { symbol } = parsed.value

  const barsQuery = `
    SELECT *
    FROM ta_microbars
    WHERE symbol = {symbol:String}
    ORDER BY event_ts DESC
    LIMIT 1
  `

  const signalsQuery = `
    SELECT *
    FROM ta_signals
    WHERE symbol = {symbol:String}
    ORDER BY event_ts DESC
    LIMIT 1
  `

  try {
    const [bars, signals] = await Promise.all([
      clientResult.client.queryJson(barsQuery, { symbol }),
      clientResult.client.queryJson(signalsQuery, { symbol }),
    ])

    return jsonResponse({
      ok: true,
      symbol,
      bars: bars[0] ?? null,
      signals: signals[0] ?? null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ClickHouse query failed'
    return errorResponse(message, 500)
  }
}
