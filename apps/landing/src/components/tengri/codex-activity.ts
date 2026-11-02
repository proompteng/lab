import type { TengriCodexEventKind } from '@/lib/tengri/types'

export function groupCodexActivity<T extends { id: string; kind: TengriCodexEventKind }>(items: readonly T[]) {
  const groups: { id: string; activity: boolean; items: T[] }[] = []
  for (const item of items) {
    const activity = item.kind === 'tool-call' || item.kind === 'tool-output' || item.kind === 'file-diff'
    const previous = groups.at(-1)
    if (activity && previous?.activity) previous.items.push(item)
    else groups.push({ id: item.id, activity, items: [item] })
  }
  return groups
}

export function codexActivityTitle(kind: TengriCodexEventKind, text: string) {
  const firstLine = text.trim().split('\n')[0]
  const github = /^(?:codex_apps\/)?github[._]([a-z_]+)(?: · (.*))?$/.exec(firstLine)
  if (github) {
    const action = github[1].replaceAll('_', ' ')
    return {
      text: `GitHub · ${action[0].toUpperCase()}${action.slice(1)}${github[2] ? ` · ${github[2]}` : ''}`,
      icon: 'tool' as const,
    }
  }
  if (kind !== 'tool-call')
    return { text: firstLine.replace(/^[✓✔]\s+/, '') || 'Command output', icon: 'terminal' as const }
  const shell = /^(?:\/bin\/)?(?:bash|sh|zsh) -[a-z]*c (['"])(.*)\1$/.exec(firstLine)
  const command = shell?.[2] ?? firstLine
  const read = /^cat\s+(?:--\s+)?([^\s;&|]+)$/.exec(command)
  if (read)
    return {
      text: `Read ${read[1]
        .replace(/^['"]|['"]$/g, '')
        .split('/')
        .at(-1)}`,
      icon: 'file' as const,
    }
  if (/^(?:rg|grep|find)\s/.test(command)) return { text: `Searched ${command}`, icon: 'search' as const }
  if (shell || /^(?:pwd|git|ls|cat|sed|bun|npm|cargo|go|python3?|curl)\b/.test(command)) {
    return { text: `Ran ${command}`, icon: 'terminal' as const }
  }
  return { text: command || 'Used a tool', icon: 'tool' as const }
}
