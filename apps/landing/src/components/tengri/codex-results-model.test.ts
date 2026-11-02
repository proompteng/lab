import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { codexConversationResults } from './codex-results-model'
import { CodexResults } from './codex-results'
import { WorkspaceFileLinkProvider } from './workspace-file-link'

test('results collect output references and real diffs without treating prompts or plans as completed work', () => {
  const results = codexConversationResults([
    { id: 'prompt', kind: 'user-message', text: 'Create /workspace/missing.md and https://example.test/unmade' },
    { id: 'plan', kind: 'plan', text: 'Write [planned](/workspace/planned.md)' },
    { id: 'command', kind: 'tool-call', text: 'cat /workspace/source.ts' },
    {
      id: 'answer',
      kind: 'assistant-text',
      text: '[Report](/workspace/report.md:12) and [PR](https://github.com/org/repo/pull/4)',
    },
    { id: 'output', kind: 'tool-output', text: '/workspace/chart.png' },
    { id: 'diff', kind: 'file-diff', text: '--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new' },
  ])
  expect(results.references.map((reference) => reference.href)).toEqual([
    '/workspace/report.md:12',
    'https://github.com/org/repo/pull/4',
    '/workspace/chart.png',
  ])
  expect(results.diffs).toHaveLength(1)
  expect(results.references.some((reference) => reference.href === '/workspace/src/main.ts')).toBe(false)
})

test('results deduplicate files and reject unsafe protocols, traversal and credential-bearing links', () => {
  const results = codexConversationResults([
    {
      id: 'answer',
      kind: 'assistant-text',
      text: [
        '[First](/workspace/report.md:12)',
        '[Latest](/workspace/report.md:18)',
        '[bad](javascript:alert)',
        '[outside](/workspace/../secret)',
        '[login](https://user:password@example.test)',
        '[reference]: https://example.test/result',
      ].join('\n'),
    },
  ])
  expect(results.references).toHaveLength(2)
  expect(results.references[0].file?.line).toBe(18)
  expect(results.references.some((reference) => reference.href.includes('password'))).toBe(false)
})

test('results render existing workspace preview controls and external links with an honest empty state', () => {
  const render = (text: string) =>
    renderToString(
      createElement(
        WorkspaceFileLinkProvider,
        { agentId: 'workspace-one' },
        createElement(CodexResults, {
          results: codexConversationResults([{ id: 'answer', kind: 'assistant-text', text }]),
        }),
      ),
    )
  const html = render('[Report](/workspace/report.md) and [PR](https://example.test/pull/1)')
  expect(html).toContain('Preview /workspace/report.md')
  expect(html).toContain('Pin /workspace/report.md')
  expect(html).toContain('target="_blank"')
  expect(html).not.toContain('href="/workspace/')
  expect(render('Nothing to report yet')).toContain('when the agent reports them')
})
