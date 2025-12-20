import { describe, expect, it } from 'vitest'

import type { ToolEvent } from '~/server/chat-tool-event'
import { chatToolEventRendererLive } from '~/server/chat-tool-event-renderer'

const collectEmittedContent = (events: ToolEvent[]) => {
  const renderer = chatToolEventRendererLive.create()
  return events
    .flatMap((event) => renderer.onToolEvent(event))
    .flatMap((action) => (action.type === 'emitContent' ? [action.content] : []))
    .join('')
}

describe('chat tool event renderer', () => {
  it('does not duplicate command start frames', () => {
    const started: ToolEvent = {
      id: 'tool-1',
      toolKind: 'command',
      status: 'started',
      title: '/bin/bash -lc echo hi',
    }

    const content = collectEmittedContent([started, started])
    expect(content).toContain('echo hi')
    expect(content.split('echo hi').length - 1).toBe(1)
  })

  it('strips zsh prefixes from command titles', () => {
    const started: ToolEvent = {
      id: 'tool-4',
      toolKind: 'command',
      status: 'started',
      title: '/bin/zsh -lc "rg -n \\"jangar\\""',
    }

    const content = collectEmittedContent([started])
    expect(content).toContain('rg -n "jangar"')
    expect(content).not.toContain('/bin/zsh -lc')
  })

  it('wraps file tool summaries in a code fence', () => {
    const completed: ToolEvent = {
      id: 'tool-2',
      toolKind: 'file',
      status: 'completed',
      title: 'file changes',
      detail: 'Success. Updated the following files:\nM services/jangar/src/server/chat.ts',
    }

    const content = collectEmittedContent([completed])
    expect(content).toContain('```text')
    expect(content).toContain('Success. Updated the following files:')
  })

  it('keeps diff-formatted file changes fenced as bash', () => {
    const completed: ToolEvent = {
      id: 'tool-3',
      toolKind: 'file',
      status: 'completed',
      title: 'file changes',
      changes: [
        {
          path: 'services/jangar/src/server/chat.ts',
          diff: '-old\n+new\n',
        },
      ],
    }

    const content = collectEmittedContent([completed])
    expect(content).toContain('```bash')
    expect(content).not.toContain('```text')
  })

  it('renders mcp tool calls as plain text json', () => {
    const completed: ToolEvent = {
      id: 'tool-mcp',
      toolKind: 'mcp',
      status: 'completed',
      title: 'memories:retrieve',
      data: {
        arguments: { query: 'hello' },
        result: { ok: true, memories: [{ id: '1', content: 'hi' }] },
      },
    }

    const content = collectEmittedContent([completed])
    expect(content).toContain('**MCP tool**')
    expect(content).toContain('`memories:retrieve`')
    expect(content).toContain('**Arguments**')
    expect(content).toContain('"query": "hello"')
    expect(content).toContain('**Result**')
    expect(content).toContain('"ok": true')
  })
})
