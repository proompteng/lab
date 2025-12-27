import { createFileRoute } from '@tanstack/react-router'
import { resolveClickHouseClient } from '~/server/clickhouse'
import { parseTaRangeParams } from '~/server/torghut-ta'

export const Route = createFileRoute('/api/torghut/ta/bars')({
  server: {
    handlers: {
      GET: async ({ request }) => getBarsHandler(request),
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

export const getBarsHandler = async (request: Request) => {
  const url = new URL(request.url)
  const parsed = parseTaRangeParams(url)
  if (!parsed.ok) return errorResponse(parsed.message, 400)

  const clientResult = resolveClickHouseClient()
  if (!clientResult.ok) return errorResponse(clientResult.message, 503)

  const { symbol, from, to, limit } = parsed.value

  const query = `
    SELECT *
    FROM ta_microbars
    WHERE symbol = {symbol:String}
      AND event_ts >= {from:DateTime64(3)}
      AND event_ts <= {to:DateTime64(3)}
    ORDER BY event_ts ASC
    LIMIT {limit:UInt32}
  `

  try {
    const items = await clientResult.client.queryJson(query, {
      symbol,
      from,
      to,
      limit,
    })

    return jsonResponse({ ok: true, symbol, items })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ClickHouse query failed'
    return errorResponse(message, 500)
  }
}
