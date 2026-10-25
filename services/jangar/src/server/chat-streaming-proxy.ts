import { randomUUID } from 'node:crypto'

import { safeJsonStringify } from './chat-text'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const buildStreamingProxyRequest = async (request: Request): Promise<Request | null> => {
  if (request.method.toUpperCase() !== 'POST') return null

  let body: unknown
  try {
    body = await request.clone().json()
  } catch {
    return null
  }
  if (!isRecord(body)) return null
  if (body.stream === true) return null

  const streamOptions = isRecord(body.stream_options) ? body.stream_options : {}
  const proxiedBody: Record<string, unknown> = {
    ...body,
    stream: true,
    stream_options: {
      ...streamOptions,
      include_usage: true,
    },
  }

  const headers = new Headers(request.headers)
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  return new Request(request.url, {
    method: request.method,
    headers,
    body: safeJsonStringify(proxiedBody),
    signal: request.signal,
  })
}

export const convertSseToChatCompletionResponse = async (response: Response): Promise<Response> => {
  const body = await response.text()
  const frames = parseSseFrames(body)

  const errorFrame = frames.find((frame) => isRecord(frame) && isRecord(frame.error))
  if (isRecord(errorFrame) && isRecord(errorFrame.error)) {
    return new Response(safeJsonStringify({ error: errorFrame.error }), {
      status: response.status,
      headers: {
        'content-type': 'application/json',
      },
    })
  }

  let model = 'unknown'
  let content = ''
  let usage: Record<string, unknown> | null = null

  for (const frame of frames) {
    if (!isRecord(frame)) continue
    const frameModel = frame.model
    if (typeof frameModel === 'string' && frameModel.length > 0) {
      model = frameModel
    }
    if (isRecord(frame.usage)) {
      usage = frame.usage
    }
    const choices = frame.choices
    if (!Array.isArray(choices)) continue
    for (const choice of choices) {
      if (!isRecord(choice)) continue
      if (isRecord(choice.usage)) {
        usage = choice.usage
      }
      const delta = isRecord(choice.delta) ? choice.delta : null
      const message = isRecord(choice.message) ? choice.message : null
      const deltaContent = typeof delta?.content === 'string' ? delta.content : ''
      const messageContent = typeof message?.content === 'string' ? message.content : ''
      if (deltaContent.length > 0) {
        content += deltaContent
      } else if (messageContent.length > 0) {
        content += messageContent
      }
    }
  }

  const payload: Record<string, unknown> = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
  }
  if (usage) {
    payload.usage = usage
  }

  return new Response(safeJsonStringify(payload), {
    status: response.status,
    headers: {
      'content-type': 'application/json',
    },
  })
}

const parseSseFrames = (body: string): unknown[] => {
  const frames: unknown[] = []
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const value = trimmed.slice(5).trim()
    if (!value || value === '[DONE]') continue
    try {
      frames.push(JSON.parse(value))
    } catch {
      continue
    }
  }
  return frames
}
