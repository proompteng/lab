import { serve } from 'inngest/bun'
import { getConfig } from './config'
import { functions, inngest } from './inngest'

const config = getConfig()

process.env.INNGEST_SIGNING_KEY = config.signingKey
process.env.INNGEST_EVENT_KEY = config.eventKey
process.env.INNGEST_BASE_URL = config.baseUrl

const inngestHandler = serve({ client: inngest, functions })

type TriggerPayload = {
  message?: string
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  })

const parseTriggerPayload = async (request: Request): Promise<TriggerPayload> => {
  try {
    const payload = (await request.json()) as TriggerPayload
    return payload ?? {}
  } catch {
    return {}
  }
}

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === '/api/inngest') {
      return inngestHandler(request)
    }

    if (url.pathname === '/healthz') {
      return json({
        status: 'ok',
        appId: config.appId,
        baseUrl: config.baseUrl,
      })
    }

    if (url.pathname === '/trigger' && request.method === 'POST') {
      const payload = await parseTriggerPayload(request)
      const message =
        typeof payload.message === 'string' && payload.message.trim().length > 0 ? payload.message : 'Mend!'
      const eventResult = await inngest.send({
        name: 'khoshut/workflow.requested',
        data: {
          message,
        },
      })

      return json({
        status: 'queued',
        event: eventResult,
        message,
      })
    }

    return json({ error: 'Not found' }, 404)
  },
})

console.log(`Khoshut service listening on http://${config.host}:${server.port}`)
console.log(`Inngest endpoint: http://${config.host}:${server.port}/api/inngest`)
