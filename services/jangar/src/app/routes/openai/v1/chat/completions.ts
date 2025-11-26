import { createFileRoute } from '@tanstack/react-router'

type ChatRequest = {
  messages?: { role: string; content: string }[]
  model?: string
}

const stubResponse = (model?: string) => ({
  id: `chatcmpl-${crypto.randomUUID()}`,
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: model ?? 'meta-orchestrator',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant' as const,
        content: 'Proxy not yet implemented; this is a stub response.',
      },
      finish_reason: 'stop' as const,
    },
  ],
  usage: { prompt_tokens: 0, completion_tokens: 8, total_tokens: 8 },
})

export const Route = createFileRoute('/openai/v1/chat/completions')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: ChatRequest | null = null
        try {
          body = await request.json()
        } catch {
          // ignore parse errors; return stub anyway
        }

        const responseBody = JSON.stringify(stubResponse(body?.model))
        return new Response(responseBody, {
          headers: {
            'content-type': 'application/json',
            'content-length': String(responseBody.length),
          },
        })
      },
    },
  },
})
