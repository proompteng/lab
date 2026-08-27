import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

import { CodexEventCard } from './codex-event-card'

describe('Codex approval card', () => {
  test('renders only decisions advertised by the approval request', () => {
    const html = renderToString(
      createElement(CodexEventCard, {
        approvalDecisions: ['approve-once', 'deny'],
        approvalId: 'approval-1',
        kind: 'approval',
        onResolveApproval: () => undefined,
        text: 'Run the command?',
      }),
    )

    expect(html).toContain('Approve once')
    expect(html).toContain('Deny')
    expect(html).not.toContain('Approve for session')
  })
})
