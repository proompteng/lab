import { describe, expect, it } from 'vitest'

import type { CodexExecArgs } from './codex-exec'
import { Codex } from './codex'
import { Thread } from './thread'

class FakeExec {
  lines: string[]
  lastArgs: CodexExecArgs | null = null

  constructor(lines: string[]) {
    this.lines = lines
  }

  async *run(args: CodexExecArgs): AsyncGenerator<string> {
    this.lastArgs = args
    for (const line of this.lines) {
      yield line
    }
  }
}

describe('Thread.run', () => {
  it('emits items, final text, and usage', async () => {
    const exec = new FakeExec([
      JSON.stringify({ type: 'thread.started', thread_id: 't-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Hello there' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 7 } }),
    ])

    const thread = new Thread(exec as never, {}, { sandboxMode: 'workspace-write' })
    const result = await thread.run('hi')

    expect(thread.id).toBe('t-1')
    expect(result.finalResponse).toBe('Hello there')
    expect(result.items).toHaveLength(1)
    expect(result.usage?.output_tokens).toBe(7)
  })

  it('throws when a turn failed event arrives', async () => {
    const exec = new FakeExec([JSON.stringify({ type: 'turn.failed', error: { message: 'nope' } })])
    const thread = new Thread(exec as never, {}, { sandboxMode: 'workspace-write' })

    await expect(thread.run('boom')).rejects.toThrow('nope')
  })
})

describe('Codex option plumbing', () => {
  it('passes baseUrl, apiKey, and env through to the executor', async () => {
    const exec = new FakeExec([
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ])

    const options = { baseUrl: 'http://localhost/v1', apiKey: 'secret', env: { EXTRA: 'yes' } }
    const thread = new Thread(exec as never, options, { sandboxMode: 'workspace-write' })
    await thread.run('ping')

    expect(exec.lastArgs?.baseUrl).toBe('http://localhost/v1')
    expect(exec.lastArgs?.apiKey).toBe('secret')
    expect(exec.lastArgs?.env?.EXTRA).toBe('yes')
  })
})
