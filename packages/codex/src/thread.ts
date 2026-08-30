import type { CodexExec, CodexExecArgs } from './codex-exec'
import type { CodexOptions, ThreadOptions, TurnOptions } from './options'
import type { ThreadEvent, ThreadItem, Usage } from './types'

export type RunResult = {
  items: ThreadItem[]
  finalResponse: string
  usage: Usage | null
}

export type RunStreamedResult = {
  events: AsyncGenerator<ThreadEvent>
}

export type UserInput = string | Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }>

const toPrompt = (input: UserInput): { prompt: string; images: string[] } => {
  if (typeof input === 'string') {
    return { prompt: input, images: [] }
  }

  const parts: string[] = []
  const images: string[] = []
  input.forEach((entry) => {
    if (entry.type === 'text') {
      parts.push(entry.text)
    } else if (entry.type === 'local_image') {
      images.push(entry.path)
    }
  })

  return { prompt: parts.join('\n\n'), images }
}

export class Thread {
  private exec: CodexExec
  private options: CodexOptions
  private threadOptions: ThreadOptions
  private _id: string | null

  constructor(exec: CodexExec, options: CodexOptions, threadOptions: ThreadOptions, id?: string | null) {
    this.exec = exec
    this.options = options
    this.threadOptions = threadOptions
    this._id = id ?? null
  }

  get id(): string | null {
    return this._id
  }

  runStreamed(input: UserInput, turnOptions: TurnOptions = {}): RunStreamedResult {
    const events = this.runStreamedInternal(input, turnOptions)
    return { events }
  }

  async run(input: UserInput, turnOptions: TurnOptions = {}): Promise<RunResult> {
    const stream = this.runStreamedInternal(input, turnOptions)
    const items: ThreadItem[] = []
    let finalResponse = ''
    let usage: Usage | null = null

    for await (const event of stream) {
      if (event.type === 'item.completed' && event.item) {
        items.push(event.item)
        if (event.item.type === 'agent_message' && typeof event.item.text === 'string') {
          finalResponse = event.item.text
        }
      }

      if (event.type === 'turn.completed' && event.usage) {
        usage = event.usage
      }

      if (event.type === 'turn.failed' && event.error) {
        throw new Error(event.error.message)
      }
    }

    return { items, finalResponse, usage }
  }

  private async *runStreamedInternal(input: UserInput, turnOptions: TurnOptions): AsyncGenerator<ThreadEvent> {
    const { prompt, images } = toPrompt(input)
    const execArgs: CodexExecArgs = {
      input: prompt,
      images,
      threadId: this._id,
    }

    if (this.threadOptions.additionalDirectories !== undefined) {
      execArgs.additionalDirectories = this.threadOptions.additionalDirectories
    }
    if (this.threadOptions.model !== undefined) execArgs.model = this.threadOptions.model
    if (this.threadOptions.sandboxMode !== undefined) execArgs.sandboxMode = this.threadOptions.sandboxMode
    if (this.threadOptions.workingDirectory !== undefined) {
      execArgs.workingDirectory = this.threadOptions.workingDirectory
    }
    if (this.threadOptions.skipGitRepoCheck !== undefined) {
      execArgs.skipGitRepoCheck = this.threadOptions.skipGitRepoCheck
    }
    if (this.threadOptions.modelReasoningEffort !== undefined) {
      execArgs.modelReasoningEffort = this.threadOptions.modelReasoningEffort
    }
    if (this.threadOptions.networkAccessEnabled !== undefined) {
      execArgs.networkAccessEnabled = this.threadOptions.networkAccessEnabled
    }
    if (this.threadOptions.webSearchEnabled !== undefined) {
      execArgs.webSearchEnabled = this.threadOptions.webSearchEnabled
    }
    if (this.threadOptions.approvalPolicy !== undefined) {
      execArgs.approvalPolicy = this.threadOptions.approvalPolicy
    }
    if (this.options.baseUrl !== undefined) execArgs.baseUrl = this.options.baseUrl
    if (this.options.apiKey !== undefined) execArgs.apiKey = this.options.apiKey
    if (this.options.env !== undefined) execArgs.env = this.options.env
    if (turnOptions.signal !== undefined) execArgs.signal = turnOptions.signal

    const generator = this.exec.run(execArgs)

    for await (const line of generator) {
      let parsed: ThreadEvent
      try {
        parsed = JSON.parse(line) as ThreadEvent
      } catch (error) {
        throw new Error(`failed to parse Codex event line: ${line}`, { cause: error })
      }

      if (parsed.type === 'thread.started' && parsed.thread_id) {
        this._id = parsed.thread_id
      }

      yield parsed
    }
  }
}
