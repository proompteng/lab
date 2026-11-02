import type { TengriCodexEventKind } from '@/lib/tengri/types'
import { parseWorkspaceFileLink, type WorkspaceFileTarget } from './workspace-file-link-model'

export type CodexResultSource = { id: string; kind: TengriCodexEventKind; text: string }
export type CodexResultReference = { href: string; label: string; file: WorkspaceFileTarget | null }

export function codexConversationResults(items: readonly CodexResultSource[]) {
  const references = new Map<string, CodexResultReference>()
  const diffs: CodexResultSource[] = []
  const add = (href: string, label: string) => {
    const file = parseWorkspaceFileLink(href)
    if (file) {
      references.set(file.path, { href, label: label || file.path.split('/').at(-1) || file.path, file })
      return
    }
    try {
      const url = new URL(href)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return
      references.set(url.href, { href: url.href, label: label || url.hostname, file: null })
    } catch {
      // Relative paths have no proven working directory; retain them in the recorded diff only.
    }
  }
  for (const item of items) {
    if (item.kind === 'file-diff' && item.text.trim()) {
      diffs.push(item)
      for (const match of item.text.matchAll(
        /^(?:\+\+\+ |--- |\*\*\* (?:Add|Update|Delete) File: )?(\/workspace\/[^\n\r\t]+)$/gm,
      ))
        add(match[1], '')
    }
    if (item.kind !== 'assistant-text' && item.kind !== 'tool-output') continue
    // Only output references are collected: an input prompt or planned command is not a result.
    for (const match of item.text.matchAll(/!?\[([^\]\n]*)\]\(<?([^\s<>]+?)>?(?:\s+"[^"\n]*")?\)/g))
      add(match[2], match[1])
    for (const match of item.text.matchAll(/^\[([^\]\n]+)\]:\s*<?([^\s<>]+)>?/gm)) add(match[2], match[1])
    for (const match of item.text.matchAll(/(?:^|[\s`])((?:https?:\/\/|\/workspace\/)[^\s`<>\[\]"']+)/g))
      add(match[1].replace(/[.,;!?)]+$/, ''), '')
  }
  return { references: [...references.values()], diffs }
}
