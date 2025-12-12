export interface StreamChatCompletionsFromJangarParams {
  baseUrl: string
  chatId: string
  prompt: string
  model?: string
  fetchImpl?: typeof fetch
  onUsage?: (usage: unknown) => void
  signal?: AbortSignal
}

interface JangarSseDeltaPayload {
  choices?: Array<{
    delta?: {
      content?: unknown
    }
  }>
  usage?: unknown
}

const parseAllowedJson = (value: string): JangarSseDeltaPayload | undefined => {
  try {
    return JSON.parse(value) as JangarSseDeltaPayload
  } catch {
    return undefined
  }
}

export async function* streamChatCompletionsFromJangar({
  baseUrl,
  chatId,
  prompt,
  model = process.env.CODEX_MODEL ?? 'gpt-5.1-codex-max',
  fetchImpl = fetch,
  onUsage,
  signal,
}: StreamChatCompletionsFromJangarParams): AsyncIterable<string> {
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-openwebui-chat-id': chatId,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Jangar request failed (${response.status}): ${text || response.statusText}`)
  }

  if (!response.body) {
    throw new Error('Jangar response body missing (expected SSE stream)')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let usage: unknown

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.trimEnd()
        if (!line.startsWith('data: ')) {
          continue
        }

        const payload = line.slice('data: '.length).trim()
        if (!payload) {
          continue
        }
        if (payload === '[DONE]') {
          if (onUsage && usage !== undefined) {
            onUsage(usage)
          }
          return
        }

        const parsed = parseAllowedJson(payload)
        if (!parsed) {
          continue
        }

        if (parsed.usage !== undefined) {
          usage = parsed.usage
        }

        const delta = parsed.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta.length > 0) {
          yield delta
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (onUsage && usage !== undefined) {
    onUsage(usage)
  }
}
