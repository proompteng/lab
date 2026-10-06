import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

import { CodexLogin } from './agent-chat'
import { CodexEventCard } from './codex-event-card'

describe('Codex event rows', () => {
  test('recognizes Mermaid fences while retaining source for server rendering and loading', () => {
    const html = renderToString(
      createElement(CodexEventCard, {
        kind: 'assistant-text',
        text: '```mermaid\nflowchart LR\nA --> B\n```',
      }),
    )
    expect(html).toContain('Rendering diagram…')
    expect(html).toContain('language-mermaid')
    expect(html).toContain('A --&gt; B')
    expect(html).not.toContain('aria-label="Mermaid diagram"')
  })

  test('preserves ordinary code, inline code and escaped markup', () => {
    const html = renderToString(
      createElement(CodexEventCard, {
        kind: 'assistant-text',
        text: '`mermaid`\n\n```sh\necho hello\n```\n\n```\nflowchart LR\nA --> B\n```\n\n<script>alert(1)</script>',
      }),
    )
    expect(html).toContain('language-sh')
    expect(html.match(/aria-label="Copy code block"/g)).toHaveLength(2)
    expect(html).not.toContain('Rendering diagram')
    expect(html).not.toContain('<script>')
  })

  test('describes searches and other tool calls as activity', () => {
    for (const text of ['Web search: Codex app screenshots', 'MCP tool: list_resources', 'View image: preview.png']) {
      const html = renderToString(createElement(CodexEventCard, { kind: 'tool-call', text }))
      expect(html).toContain('aria-label="Codex activity"')
      expect(html).not.toContain('>Command<')
    }
  })

  test('keeps user and assistant message roles accessible', () => {
    const userHtml = renderToString(createElement(CodexEventCard, { kind: 'user-message', text: 'Build the page' }))
    const assistantHtml = renderToString(
      createElement(CodexEventCard, { kind: 'assistant-text', text: 'I will inspect the current layout first.' }),
    )

    expect(userHtml).toContain('aria-label="Your message"')
    expect(assistantHtml).toContain('aria-label="Codex response"')
    expect(userHtml).not.toContain('<svg')
    expect(assistantHtml).not.toContain('<svg')
    expect(assistantHtml).not.toContain('rounded-2xl')
  })

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

  test('renders structured command approval choices explicitly', () => {
    const html = renderToString(
      createElement(CodexEventCard, {
        approvalDecisions: ['approve-exec-policy-amendment', 'approve-network-policy-amendment', 'deny'],
        approvalId: 'approval-1',
        kind: 'approval',
        onResolveApproval: () => undefined,
        text: 'Proposed command and network policy changes',
      }),
    )

    expect(html).toContain('Apply command policy')
    expect(html).toContain('Apply network policy')
    expect(html).toContain('Deny')
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
