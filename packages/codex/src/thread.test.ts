import { describe, expect, it } from 'vitest'

import type { CodexExecArgs } from './codex-exec'
import { Thread } from './thread'

type EventLine = string

class FakeExec {
  lines: EventLine[]
  lastArgs: CodexExecArgs | null

  constructor(lines: EventLine[]) {
    this.lines = lines
    this.lastArgs = null
  }

  async *run(args: CodexExecArgs): AsyncGenerator<string> {
    this.lastArgs = args
    for (const line of this.lines) {
      yield line
    }
  }
}

describe('Thread', () => {
  it('collects final response, items, and usage from streamed events', async () => {
    const exec = new FakeExec([
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'All done' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }),
    ])

    const thread = new Thread(exec as never, {}, { sandboxMode: 'workspace-write' })
    const result = await thread.run('hello world')

    expect(thread.id).toBe('thread-123')
    expect(result.finalResponse).toBe('All done')
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.type).toBe('agent_message')
    expect(result.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 })
  })

  it('passes aggregated text and images through to the executor', async () => {
    const exec = new FakeExec([
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ])

    const thread = new Thread(exec as never, {}, { sandboxMode: 'workspace-write' })
    await thread.run([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
      { type: 'local_image', path: '/tmp/example.png' },
    ])

    expect(exec.lastArgs?.input).toBe('first\n\nsecond')
    expect(exec.lastArgs?.images).toEqual(['/tmp/example.png'])
  })

  it('throws when a turn fails event is received', async () => {
    const exec = new FakeExec([JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } })])

    const thread = new Thread(exec as never, {}, { sandboxMode: 'workspace-write' })

    await expect(() => thread.run('trigger failure')).rejects.toThrow('boom')
  })
})
