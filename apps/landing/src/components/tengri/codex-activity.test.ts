import { expect, test } from 'bun:test'
import { codexActivityTitle, groupCodexActivity } from './codex-activity'

test('groups adjacent tools without moving messages, approvals, or errors', () => {
  const groups = groupCodexActivity([
    { id: 'intro', kind: 'assistant-text' },
    { id: 'read', kind: 'tool-call' },
    { id: 'output', kind: 'tool-output' },
    { id: 'approval', kind: 'approval' },
    { id: 'edit', kind: 'file-diff' },
    { id: 'error', kind: 'error' },
    { id: 'answer', kind: 'assistant-text' },
    { id: 'user', kind: 'user-message' },
  ])
  expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([
    ['intro'],
    ['read', 'output'],
    ['approval'],
    ['edit'],
    ['error'],
    ['answer'],
    ['user'],
  ])
  expect(groups.map((group) => group.activity)).toEqual([false, true, false, true, false, false, false])
})

test('labels commands from actual content while preserving unknown tool names and output', () => {
  expect(codexActivityTitle('tool-call', "/bin/bash -lc 'cat /workspace/AGENTS.md'")).toEqual({
    text: 'Read AGENTS.md',
    icon: 'file',
  })
  expect(codexActivityTitle('tool-call', 'cat file && git status').text).toBe('Ran cat file && git status')
  expect(codexActivityTitle('tool-call', 'rg -n leadership services/tengri').icon).toBe('search')
  expect(codexActivityTitle('tool-call', 'browser/open').text).toBe('browser/open')
  expect(codexActivityTitle('tool-output', 'for (const failure of [\n  ...\n]')).toEqual({
    text: 'for (const failure of [',
    icon: 'terminal',
  })
})

test('GitHub activity labels identify both the action and its target', () => {
  expect(codexActivityTitle('tool-call', 'codex_apps/github.create_branch · codex/ui').text).toBe(
    'GitHub · Create branch · codex/ui',
  )
})

test('keeps status glyphs in expanded output while using plain summary labels', () => {
  expect(codexActivityTitle('tool-output', '✓ Terminal resize\n✓ Window drag').text).toBe('Terminal resize')
  expect(codexActivityTitle('tool-output', '✔ Completed').text).toBe('Completed')
})
