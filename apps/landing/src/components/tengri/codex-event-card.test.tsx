import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

import { CodexLogin } from './agent-chat'
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

  test('renders an authoritative failed-turn message as an alert', () => {
    const html = renderToString(createElement(CodexEventCard, { kind: 'error', text: 'The turn failed' }))

    expect(html).toContain('role="alert"')
    expect(html).toContain('The turn failed')
  })

  test('lets a pending device login be restarted', () => {
    const html = renderToString(
      createElement(CodexLogin, {
        busy: false,
        error: '',
        login: {
          loginId: 'login-1',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-1234',
          expiresAt: '2026-08-27T14:15:00Z',
        },
        onRefresh: () => undefined,
        onStart: () => undefined,
      }),
    )

    expect(html).toContain('Restart device login')
  })
})
