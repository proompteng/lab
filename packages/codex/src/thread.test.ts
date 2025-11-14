import { describe, expect, it, vi } from 'vitest'

import type { CodexExecArgs } from './codex-exec'
import type { CodexOptions, ThreadOptions } from './options'
import { Thread } from './thread'

const createThread = (events: string[], options?: ThreadOptions, codexOptions?: CodexOptions) => {
  const calls: CodexExecArgs[] = []
  const exec = {
    run: vi.fn(async function* (args: CodexExecArgs) {
      calls.push(args)
      for (const event of events) {
        yield event
      }
    }),
  }

  const thread = new Thread(exec as never, codexOptions ?? {}, options ?? {})
  return { thread, calls, exec }
}

describe('Thread', () => {
  it('collects agent messages and usage when running a turn', async () => {
    const events = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thr_abc' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hello world' } }),
      JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 42 } }),
    ]

    const { thread, calls } = createThread(events, { workingDirectory: '/tmp/workspace' })
    const result = await thread.run('Describe the repo')

    expect(thread.id).toBe('thr_abc')
    expect(result.finalResponse).toBe('hello world')
    expect(result.usage?.output_tokens).toBe(42)
    expect(calls[0]?.workingDirectory).toBe('/tmp/workspace')
  })

  it('streams events and updates thread id lazily', async () => {
    const events = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thr_stream' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first chunk' } }),
    ]

    const { thread } = createThread(events)
    const streamed: string[] = []

    for await (const event of thread.runStreamed('Ping').events) {
      streamed.push(event.type)
    }

    expect(streamed).toEqual(['thread.started', 'item.completed'])
    expect(thread.id).toBe('thr_stream')
  })
})
