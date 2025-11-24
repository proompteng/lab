const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body, null, 2), {
    headers: { 'content-type': 'application/json' },
    ...init,
  })

const notImplemented = (hint: string) => json({ error: 'Not implemented', hint }, { status: 501 })

export const startServer = () => {
  const port = Number(Bun.env.PORT ?? 8080)

  return Bun.serve({
    port,
    fetch: async (request) => {
      const url = new URL(request.url)

      if (url.pathname === '/healthz') {
        return new Response('ok')
      }

      if (request.method === 'POST' && url.pathname === '/orchestrations') {
        // TODO(jng-060a): start workflow + persist orchestration
        return notImplemented('create orchestration')
      }

      if (request.method === 'GET' && url.pathname.startsWith('/orchestrations/')) {
        // TODO(jng-060a): fetch orchestration state (DB + workflow query)
        return notImplemented('get orchestration state')
      }

      if (url.pathname === '/v1/models') {
        // TODO(jng-060b): return meta-orchestrator model
        return json({ data: [] })
      }

      if (url.pathname === '/v1/chat/completions') {
        // TODO(jng-060b): proxy to codex app-server and stream OpenAI deltas
        return notImplemented('openai proxy')
      }

      return new Response('not found', { status: 404 })
    },
  })
}

// Start immediately when executed as entrypoint
startServer()
