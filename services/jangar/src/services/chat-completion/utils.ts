import type { ToolDelta } from './types'

export const createSafeEnqueuer = (
  controller: Pick<ReadableStreamDefaultController<Uint8Array>, 'enqueue' | 'close'>,
) => {
  let controllerClosed = false
  const safeEnqueue = (chunk: Uint8Array) => {
    if (controllerClosed) return
    try {
      controller.enqueue(chunk)
    } catch (error) {
      controllerClosed = true
      console.warn('[jangar] stream enqueue after close', error)
    }
  }
  const closeIfOpen = () => {
    if (controllerClosed) return
    controllerClosed = true
    try {
      controller.close()
    } catch (error) {
      console.warn('[jangar] failed to close controller', error)
    }
  }
  const isClosed = () => controllerClosed
  return { safeEnqueue, closeIfOpen, isClosed }
}

export const stripAnsi = (value: string) => {
  const esc = String.fromCharCode(27)
  return value.replace(new RegExp(`${esc}[[0-9;]*[mK]`, 'g'), '')
}

export const formatToolDelta = (delta: ToolDelta): string => {
  const detail = delta.detail ? stripAnsi(delta.detail) : ''

  if (delta.toolKind === 'command' && delta.status === 'delta' && detail) {
    return detail.trim().length ? `\n\n\`\`\`ts\n${detail}\n\`\`\`\n` : detail
  }

  if (delta.status === 'delta' && detail) return detail

  const statusLabel = delta.status === 'delta' ? '' : ` [${delta.status}]`
  let kind = 'search'
  if (delta.toolKind === 'command') kind = 'cmd'
  else if (delta.toolKind === 'file') kind = 'file'
  else if (delta.toolKind === 'mcp') kind = 'tool'

  const suffix = detail ? ` — ${detail}` : ''

  if (delta.toolKind === 'command') {
    const rawStatus = statusLabel ? statusLabel.trim().replace(/\[|\]/g, '') : delta.status
    const normalizedStatus = rawStatus === 'started' ? 'start' : rawStatus === 'completed' ? 'end' : rawStatus
    const rendered = `[${normalizedStatus}] ${stripAnsi(delta.title)}${detail ? ` in ${detail}` : ''}`
    return `\n\`\`\`bash\n${rendered}\n\`\`\`\n`
  }

  const title = stripAnsi(delta.title)
  return `\n(${kind}${statusLabel}) ${title}${suffix}\n`
}

const normalizeContent = (content: unknown) => (typeof content === 'string' ? content : JSON.stringify(content))

export const buildPrompt = (messages?: { role: string; content: unknown }[]) =>
  (messages ?? []).map((m) => `${m.role}: ${normalizeContent(m.content)}`).join('\n')

export const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4))

export const deriveChatId = (body: { chat_id?: string }) => body.chat_id

export const buildUsagePayload = (turnId: string, usage?: Record<string, unknown> | null) => {
  const payload: Record<string, unknown> = { turnId, capturedAt: Date.now() }
  if (!usage) return payload
  if ('input_tokens' in usage) payload.totalInputTokens = (usage as { input_tokens?: number }).input_tokens
  if ('cached_input_tokens' in usage)
    payload.cachedInputTokens = (usage as { cached_input_tokens?: number }).cached_input_tokens
  if ('output_tokens' in usage) payload.outputTokens = (usage as { output_tokens?: number }).output_tokens
  if ('reasoning_output_tokens' in usage)
    payload.reasoningOutputTokens = (usage as { reasoning_output_tokens?: number }).reasoning_output_tokens
  if ('total_tokens' in usage) payload.totalTokens = (usage as { total_tokens?: number }).total_tokens
  return payload
}
