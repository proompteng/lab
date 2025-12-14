import { Context } from 'effect'

import type { ToolEvent } from './chat-tool-event'

export type ToolRenderAction =
  | { type: 'openCommandFence' }
  | { type: 'closeCommandFence' }
  | { type: 'emitContent'; content: string }

export type ToolRenderer = {
  onToolEvent: (event: ToolEvent) => ToolRenderAction[]
}

export type ChatToolEventRendererService = {
  create: () => ToolRenderer
}

export class ChatToolEventRenderer extends Context.Tag('ChatToolEventRenderer')<
  ChatToolEventRenderer,
  ChatToolEventRendererService
>() {}

const truncateLines = (text: string, maxLines: number) => {
  const lines = text.split(/\r?\n/)
  if (lines.length <= maxLines) return text
  return [...lines.slice(0, maxLines), '...', ''].join('\n')
}

const renderFileChanges = (rawChanges: unknown, maxDiffLines = 5) => {
  if (!Array.isArray(rawChanges)) return undefined

  const rendered = rawChanges
    .map((change) => {
      if (!change || typeof change !== 'object') return null
      const obj = change as { path?: unknown; diff?: unknown }
      const path = typeof obj.path === 'string' && obj.path.length > 0 ? obj.path : 'unknown-file'
      const diffText = typeof obj.diff === 'string' ? obj.diff : ''
      const lines = diffText.split(/\r?\n/)
      const truncated = lines.length > maxDiffLines ? [...lines.slice(0, maxDiffLines), '…'] : lines
      const body = truncated.join('\n')
      return `\n\`\`\`bash\n${path}\n${body}\n\`\`\`\n`
    })
    .filter(Boolean)

  if (rendered.length === 0) return undefined
  if (rendered.length === 1) return rendered[0] as string
  return rendered.join('\n\n')
}

type ToolState = {
  id: string
  index: number
  toolKind: string
  title?: string
  lastContent?: string
  lastStatus?: string
  hasCommandOutput?: boolean
}

const pickAggregatedOutput = (data: unknown): string | undefined => {
  if (!data || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  const candidate =
    (typeof record.aggregatedOutput === 'string' ? record.aggregatedOutput : undefined) ??
    (typeof record.output === 'string' ? record.output : undefined) ??
    (typeof record.stdout === 'string' ? record.stdout : undefined) ??
    (typeof record.stderr === 'string' ? record.stderr : undefined)
  return candidate && candidate.length > 0 ? candidate : undefined
}

const createToolRenderer = (): ToolRenderer => {
  const toolStates = new Map<string, ToolState>()
  let nextToolIndex = 0

  const getToolState = (event: ToolEvent): ToolState => {
    const toolId = event.id
    const existing = toolStates.get(toolId)
    if (existing) {
      if (!existing.title && event.title) existing.title = event.title
      return existing
    }

    const toolState: ToolState = {
      id: toolId,
      index: nextToolIndex++,
      toolKind: event.toolKind,
      title: event.title,
    }
    toolStates.set(toolId, toolState)
    return toolState
  }

  const formatToolArguments = (toolState: ToolState, event: ToolEvent) => {
    const payload: Record<string, unknown> = {
      tool: toolState.toolKind,
    }

    if (toolState.title) payload.title = toolState.title
    const status = event.status
    if (status) payload.status = status
    const detail = event.detail
    if (event.delta) payload.output = event.delta

    const isCommandLocationDetail = toolState.toolKind === 'command' && detail && status === 'started'

    if (detail && !isCommandLocationDetail) payload.detail = detail

    return payload
  }

  const formatToolContent = (toolState: ToolState, payload: Record<string, unknown>) => {
    const output = typeof payload.output === 'string' ? payload.output : undefined
    const detail = typeof payload.detail === 'string' ? payload.detail : undefined
    const title = typeof payload.title === 'string' ? payload.title : undefined
    const status = typeof payload.status === 'string' ? payload.status : undefined

    // Skip empty completions; this prevents an extra blank chunk when a command finishes without output.
    if (status === 'completed' && toolState.toolKind === 'command' && !output && !detail) return ''

    if (output && output.length > 0) return truncateLines(output, 5)
    if (detail && detail.length > 0) return truncateLines(detail, 5)
    if (title && title.length > 0) return title
    return toolState.toolKind
  }

  return {
    onToolEvent: (event: ToolEvent) => {
      const toolState = getToolState(event)
      const actions: ToolRenderAction[] = []
      const argsPayload = formatToolArguments(toolState, event)

      if (toolState.toolKind === 'file') {
        actions.push({ type: 'closeCommandFence' })
        const status = event.status

        // Skip the start event to avoid duplicated summaries like "1 change(s)1 change(s)".
        if (status === 'started') {
          toolState.lastStatus = status
          return actions
        }

        const content = renderFileChanges(event.changes) ?? formatToolContent(toolState, argsPayload)
        if (!content) {
          toolState.lastStatus = status
          return actions
        }

        // Avoid re-emitting identical apply_patch summaries across delta/completed events.
        if (content === toolState.lastContent && status === toolState.lastStatus) {
          return actions
        }

        toolState.lastContent = content
        toolState.lastStatus = status
        actions.push({ type: 'emitContent', content })
        return actions
      }

      if (toolState.toolKind === 'webSearch') {
        actions.push({ type: 'closeCommandFence' })
        // Emit the attempted search term plainly, wrapped in backticks so UIs like
        // OpenWebUI render it as a code span without extra prefixes/suffixes.
        if (event.status !== 'completed') {
          const query =
            (typeof toolState.title === 'string' && toolState.title.length > 0 ? toolState.title : undefined) ??
            (typeof argsPayload.detail === 'string' && argsPayload.detail.length > 0 ? argsPayload.detail : undefined)
          if (query) actions.push({ type: 'emitContent', content: `\`${query}\`` })
        }
        return actions
      }

      if (toolState.toolKind === 'command') {
        actions.push({ type: 'openCommandFence' })
        const status = event.status

        const eventTitle = event.title
        const isCommandInputDelta = eventTitle === 'command input'

        const aggregatedOutput = pickAggregatedOutput(event.data)

        if (status === 'completed' && !toolState.hasCommandOutput && aggregatedOutput) {
          argsPayload.output = aggregatedOutput
          toolState.hasCommandOutput = true
        }

        if (
          status === 'delta' &&
          !isCommandInputDelta &&
          !toolState.hasCommandOutput &&
          ((typeof argsPayload.output === 'string' && argsPayload.output.length > 0) ||
            (typeof argsPayload.detail === 'string' && argsPayload.detail.length > 0))
        ) {
          toolState.hasCommandOutput = true
        }

        let content = formatToolContent(toolState, argsPayload)
        // Ensure the initial command line is followed by a newline so subsequent output starts on a new line.
        if (status === 'started' && content.length > 0 && !content.endsWith('\n')) {
          content = `${content}\n\n`
        }
        if (content.length > 0) actions.push({ type: 'emitContent', content })
        return actions
      }

      actions.push({ type: 'closeCommandFence' })
      actions.push({ type: 'emitContent', content: formatToolContent(toolState, argsPayload) })
      return actions
    },
  }
}

export const chatToolEventRendererLive: ChatToolEventRendererService = {
  create: () => createToolRenderer(),
}
