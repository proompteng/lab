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
})
