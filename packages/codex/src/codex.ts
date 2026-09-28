import { CodexExec } from './codex-exec'
import type { CodexOptions, ThreadOptions } from './options'
import { Thread } from './thread'

const defaultOptions: ThreadOptions = {
  sandboxMode: 'workspace-write',
}

export class Codex {
  private exec: CodexExec
  private options: CodexOptions

  constructor(options: CodexOptions = {}) {
    this.exec = new CodexExec(options.codexPathOverride)
    this.options = options
  }

  startThread(options: ThreadOptions = {}): Thread {
    return new Thread(this.exec, this.options, { ...defaultOptions, ...options })
  }

  resumeThread(id: string, options: ThreadOptions = {}): Thread {
    return new Thread(this.exec, this.options, { ...defaultOptions, ...options }, id)
  }
}
