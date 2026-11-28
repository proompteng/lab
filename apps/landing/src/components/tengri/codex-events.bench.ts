import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TengriCodexEvent } from '@/lib/tengri/types'
import { appendCodexEvent, type CodexBufferedEvent } from './codex-events'

// Compare the actual old/new reducer modules, not a reimplementation:
// git show <base>:apps/landing/src/components/tengri/codex-events.ts > /tmp/codex-events-before.ts
// bun apps/landing/src/components/tengri/codex-events.bench.ts /tmp/codex-events-before.ts
// This measures synthetic reducer CPU only, not rendering, network, or guest latency.
const baselinePath = process.argv[2]
if (!baselinePath) throw new Error('Pass the baseline codex-events.ts file as the first argument')
const baseline = (await import(pathToFileURL(resolve(baselinePath)).href)) as {
  appendCodexEvent: typeof appendCodexEvent
}
const base: TengriCodexEvent = {
  sequence: 1,
  kind: 'assistant-text',
  method: 'item/agentMessage/delta',
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId: 'item-1',
  text: '',
  approvalId: '',
  rawJson: '{}',
}
const scenarios = [
  { name: 'growing-ascii', count: 4096, text: 'synthetic assistant text chunk.  ', initial: [] },
  { name: 'growing-unicode', count: 4096, text: '漢字😀 synthetic delta  ', initial: [] },
  {
    name: 'full-buffer-500',
    count: 2048,
    text: 'synthetic text. ',
    initial: Array.from({ length: 499 }, (_, index) => ({
      ...base,
      sequence: index + 1,
      method: 'item/completed',
      itemId: 'previous-' + index,
      text: 'Completed synthetic item',
    })),
  },
  { name: 'cross-byte-cap', count: 1024, text: '漢'.repeat(1024), initial: [] },
]
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
const snapshot = (events: CodexBufferedEvent[]) =>
  events.map(({ textSegments, ...event }) => {
    const segments = []
    for (let segment = textSegments; segment; segment = segment.previous) {
      const { previous: _, ...value } = segment
      segments.push(value)
    }
    return { ...event, segments }
  })

console.log(JSON.stringify({ runtime: process.versions, baseline: resolve(baselinePath), warmups: 3, samples: 9 }))
for (const scenario of scenarios) {
  const events = Array.from({ length: scenario.count }, (_, index) => ({
    ...base,
    sequence: index + 501,
    text: scenario.text,
  }))
  const run = (append: typeof appendCodexEvent) => {
    let current: CodexBufferedEvent[] = scenario.initial
    const start = performance.now()
    for (const event of events) current = append(current, event)
    const elapsed = performance.now() - start
    return { elapsed, result: snapshot(current) }
  }
  const before: number[] = []
  const after: number[] = []
  for (let index = 0; index < 12; index++) {
    const left = run(index % 2 ? appendCodexEvent : baseline.appendCodexEvent)
    const right = run(index % 2 ? baseline.appendCodexEvent : appendCodexEvent)
    assert.deepEqual(left.result, right.result)
    if (index >= 3) {
      before.push(index % 2 ? right.elapsed : left.elapsed)
      after.push(index % 2 ? left.elapsed : right.elapsed)
    }
  }
  console.log(
    JSON.stringify({
      scenario: scenario.name,
      events: events.length,
      baselineMedianMs: median(before),
      currentMedianMs: median(after),
      speedup: median(before) / median(after),
    }),
  )
}
