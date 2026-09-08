export class CodeWriteEchoTracker {
  private readonly pending = new Map<string, Map<string, number>>()
  private readonly recent = new Map<string, Set<string>>()

  begin(path: string, content: string) {
    const contents = this.pending.get(path) ?? new Map<string, number>()
    contents.set(content, (contents.get(content) ?? 0) + 1)
    this.pending.set(path, contents)
  }

  finish(path: string, content: string) {
    const contents = this.pending.get(path)
    const count = contents?.get(content)
    if (!contents || !count) return
    if (count === 1) contents.delete(content)
    else contents.set(content, count - 1)
    if (!contents.size) this.pending.delete(path)
  }

  remember(path: string, content: string) {
    this.recent.set(path, new Set([content]))
  }

  forget(path: string, content: string) {
    const contents = this.recent.get(path)
    if (!contents) return
    contents.delete(content)
    if (!contents.size) this.recent.delete(path)
  }

  matches(path: string, content: string) {
    return Boolean(this.pending.get(path)?.has(content) || this.recent.get(path)?.has(content))
  }

  clearPath(path: string) {
    this.pending.delete(path)
    this.recent.delete(path)
  }

  clear() {
    this.pending.clear()
    this.recent.clear()
  }
}
