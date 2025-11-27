import { createFileRoute } from '@tanstack/react-router'
import { getAppServer } from '~/lib/app-server'

type ChatRequest = {
  messages?: { role: string; content: string }[]
  model?: string
  stream?: boolean
}

const logRouteHit = (path: string, info?: Record<string, unknown>) => {
  console.info(`[jangar] ${path}`, info ?? '')
}

const appServer = getAppServer(Bun.env.CODEX_BIN ?? 'codex', Bun.env.CODEX_CWD ?? process.cwd())

const buildPrompt = (messages?: ChatRequest['messages']) =>
  (messages ?? [])
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n')

const defaultCodexModel = 'gpt-5.1-codex-max'

const resolveModel = (requested?: string | null) => {
  if (!requested || requested === 'meta-orchestrator') return defaultCodexModel
  return requested
}

const streamSse = async (prompt: string, opts: { model?: string; signal: AbortSignal }): Promise<Response> => {
  const targetModel = resolveModel(opts.model)
  const { stream } = await appServer.runTurnStream({ prompt, model: targetModel })
  const encoder = new TextEncoder()
  const created = Math.floor(Date.now() / 1000)
  const id = `chatcmpl-${crypto.randomUUID()}`
  let sentFirstDelta = false

  const body = new ReadableStream({
    start: async (controller) => {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      const sendDone = () => controller.enqueue(encoder.encode('data: [DONE]\n\n'))

      const abortHandler = () => controller.close()
      opts.signal.addEventListener('abort', abortHandler, { once: true })

      try {
        for await (const delta of stream) {
          const chunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model: targetModel,
            choices: [
              {
                index: 0,
                delta: sentFirstDelta ? { content: delta } : { role: 'assistant' as const, content: delta },
                finish_reason: null,
              },
            ],
          }
          send(chunk)
          sentFirstDelta = true
        }

        const doneChunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: targetModel,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop' as const,
            },
          ],
        }
        send(doneChunk)
        sendDone()
      } catch (error) {
        console.error('[jangar] codex stream error', error)
        controller.error(error)
      } finally {
        controller.close()
      }
    },
  })

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

export const Route = createFileRoute('/v1/chat/completions')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: ChatRequest | null = null
        try {
          body = await request.json()
        } catch {
          // ignore parse errors; return stub anyway
        }

        const model = resolveModel(body?.model)
        logRouteHit('POST /v1/chat/completions', {
          model,
          messageCount: body?.messages?.length ?? 0,
          stream: body?.stream ?? false,
        })
        const prompt = buildPrompt(body?.messages)

        if (body?.stream) {
          try {
            return await streamSse(prompt, { model, signal: request.signal })
          } catch (error) {
            console.error('[jangar] codex app-server stream error', error)
            return new Response(JSON.stringify({ error: 'codex app-server failed', details: `${error}` }), {
              status: 500,
              headers: { 'content-type': 'application/json' },
            })
          }
        }

        try {
          const result = await appServer.runTurn({ prompt, model })
          const responseBody = JSON.stringify({
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant' as const,
                  content: result.text,
                },
                finish_reason: 'stop' as const,
              },
            ],
            usage: null,
          })

          return new Response(responseBody, {
            headers: {
              'content-type': 'application/json',
              'content-length': String(responseBody.length),
            },
          })
        } catch (error) {
          console.error('[jangar] codex app-server error', error)
          return new Response(JSON.stringify({ error: 'codex app-server failed', details: `${error}` }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
      },
    },
  },
})
