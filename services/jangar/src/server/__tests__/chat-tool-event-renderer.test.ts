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
    expect(content).toContain('/bin/bash -lc echo hi')
    expect(content.split('/bin/bash -lc echo hi').length - 1).toBe(1)
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
})
