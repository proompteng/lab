import { Context } from 'effect'

import { safeJsonStringify } from './chat-text'
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
  return [...lines.slice(0, maxLines), '…', ''].join('\n')
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

const wrapInCodeFence = (content: string, language = 'text') => {
  if (content.includes('```')) return content
  const trimmed = content.trimEnd()
  if (!trimmed) return ''
  return `\n\`\`\`${language}\n${trimmed}\n\`\`\`\n`
}

const stringifyMcpPayload = (payload: Record<string, unknown>) => {
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return safeJsonStringify(payload)
  }
}

const renderMcpJsonBlock = (value: unknown, maxLines: number) => {
  const raw = stringifyMcpPayload({ value })
  const body = raw.replace(/^\{\n\s*"value":\s*/u, '').replace(/\n\}$/u, '')
  const truncated = truncateLines(body, maxLines)
  return wrapInCodeFence(truncated, 'json')
}

const renderMcpTextBlock = (value: string, maxLines: number) => {
  const truncated = truncateLines(value, maxLines)
  return wrapInCodeFence(truncated, 'text')
}

const renderMcpPayload = (payload: Record<string, unknown>, maxLines = 12) => {
  const tool = typeof payload.tool === 'string' ? payload.tool : 'mcp'
  const status = typeof payload.status === 'string' ? payload.status : undefined
  const detail = typeof payload.detail === 'string' ? payload.detail : undefined
  const output = typeof payload.output === 'string' ? payload.output : undefined
  const args = payload.arguments
  const result = payload.result
  const error = payload.error

  const sections: string[] = [`\n**MCP tool**: \`${tool}\``]
  if (status) sections.push(`**Status**: \`${status}\``)
  if (detail) sections.push(`**Detail**\n${renderMcpTextBlock(detail, 4)}`)
  if (output) sections.push(`**Output**\n${renderMcpTextBlock(output, maxLines)}`)
  if (args !== undefined) sections.push(`**Arguments**\n${renderMcpJsonBlock(args, maxLines)}`)
  if (result !== undefined) sections.push(`**Result**\n${renderMcpJsonBlock(result, maxLines)}`)
  if (error !== undefined) sections.push(`**Error**\n${renderMcpJsonBlock(error, maxLines)}`)

  return `${sections.filter(Boolean).join('\n')}\n`
}

const stripShellPrefix = (value: string) => {
  const trimmed = value.trim()
  const match = trimmed.match(/^(?:\/(?:usr\/)?bin\/(?:ba|z)sh|(?:ba|z)sh)\s+-lc\s+([\s\S]+)$/u)
  if (!match) return value
  let command = match[1]?.trim() ?? ''
  if (
    command.length >= 2 &&
    ((command.startsWith("'") && command.endsWith("'")) || (command.startsWith('"') && command.endsWith('"')))
  ) {
    const quote = command[0]
    command = command.slice(1, -1)
    if (quote === '"') {
      command = command.replace(/\\"/g, '"')
    } else if (quote === "'") {
      command = command.replace(/\\'/g, "'")
    }
  }
  return command
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
    const rawTitle = typeof payload.title === 'string' ? payload.title : undefined
    const title = rawTitle && toolState.toolKind === 'command' ? stripShellPrefix(rawTitle) : rawTitle
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

        const renderedChanges = renderFileChanges(event.changes)
        const content = renderedChanges ?? wrapInCodeFence(formatToolContent(toolState, argsPayload))
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

      if (toolState.toolKind === 'mcp') {
        actions.push({ type: 'closeCommandFence' })
        const status = event.status
        const payload: Record<string, unknown> = {
          tool: toolState.title ?? toolState.toolKind,
        }

        if (status) payload.status = status
        if (event.detail) payload.detail = event.detail
        if (event.delta) payload.output = event.delta

        if (event.data && typeof event.data === 'object') {
          const data = event.data as Record<string, unknown>
          if ('arguments' in data) payload.arguments = data.arguments
          if ('result' in data) payload.result = data.result
          if ('error' in data) payload.error = data.error
        }

        const content = renderMcpPayload(payload)
        if (!content) {
          toolState.lastStatus = status
          return actions
        }

        if (content === toolState.lastContent && status === toolState.lastStatus) {
          return actions
        }

        toolState.lastContent = content
        toolState.lastStatus = status
        actions.push({ type: 'emitContent', content })
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

        if (content.length > 0) {
          // Avoid re-emitting identical command frames when upstream sends duplicated tool events.
          if (content === toolState.lastContent && status === toolState.lastStatus) {
            return actions
          }
          toolState.lastContent = content
          toolState.lastStatus = status
          actions.push({ type: 'emitContent', content })
        } else {
          toolState.lastStatus = status
        }
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
