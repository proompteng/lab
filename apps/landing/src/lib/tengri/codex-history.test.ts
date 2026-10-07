import { expect, test } from 'bun:test'
import { readCodexHistory, type CodexHistoryPage } from './codex-history'

const metadata: CodexHistoryPage = {
  type: 'page',
  part: 'thread',
  eventSequence: 10,
  rawJson: JSON.stringify({ thread: { id: 'thread-one', historyMode: 'paginated', turns: [] }, model: 'gpt-6.1-sol' }),
}
const items = (data: unknown[], cursor: string | null, sequence = 20): CodexHistoryPage => ({
  type: 'page',
  part: 'items',
  eventSequence: sequence,
  rawJson: JSON.stringify({ data, nextCursor: cursor }),
})
const turns = (data: unknown[], cursor: string | null = null): CodexHistoryPage => ({
  type: 'page',
  part: 'turns',
  eventSequence: 30,
  rawJson: JSON.stringify({ data, nextCursor: cursor }),
})
const item = (id: string, text = id, turnId = 'turn-one') => ({ turnId, item: { id, type: 'agentMessage', text } })
const turn = (id = 'turn-one', status = 'completed') => ({ id, status, items: [], itemsView: 'notLoaded' })

function response(records: unknown[], complete = true, suffix = '') {
  const body =
    records.map((record) => JSON.stringify(record) + '\n').join('') + (complete ? '{"type":"complete"}\n' : '') + suffix
  return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } })
}
function read(input: Response, signal?: AbortSignal) {
  return readCodexHistory(input, 'thread-one', signal, (record) => new Error(String(record.error)))
}

test('restores more than 10 MiB across bounded pages without losing items, empty turns, or event cursors', async () => {
  const text = 'x'.repeat(6 * 1024 * 1024)
  const restored = await read(
    response([
      metadata,
      items([item('first', text)], 'items-2', 20),
      items([item('second', text)], null, 25),
      turns([turn(), turn('empty-active', 'inProgress')]),
    ]),
  )
  expect(restored.eventSequence).toBe(10)
  expect(restored.itemEventSequences).toEqual({ first: 20, second: 25 })
  const snapshot = JSON.parse(restored.rawJson)
  expect(restored.rawJson.length).toBeGreaterThan(10 * 1024 * 1024)
  expect(snapshot.model).toBe('gpt-6.1-sol')
  expect(snapshot.thread.turns[0].items).toEqual([item('first', text).item, item('second', text).item])
  expect(snapshot.thread.turns[1]).toMatchObject({
    id: 'empty-active',
    status: 'inProgress',
    items: [],
    itemsView: 'full',
  })
})

test('decodes fragmented UTF-8 and NDJSON records', async () => {
  const body = await response([metadata, items([item('unicode', '世界 🌍')], null), turns([turn()])]).arrayBuffer()
  const bytes = new Uint8Array(body)
  let offset = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + 7))
      offset = Math.min(offset + 7, bytes.length)
    },
  })
  const restored = await read(new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } }))
  expect(JSON.parse(restored.rawJson).thread.turns[0].items[0].text).toBe('世界 🌍')
})

test('rejects incomplete, corrupt, mismatched, and out-of-order streams without returning partial history', async () => {
  for (const input of [
    response([metadata, items([], null), turns([])], false),
    response([metadata, items([], null), turns([])], true, '{'),
    response([metadata, items([], 'more'), turns([])]),
    response([metadata, turns([])]),
    response([metadata, items([item('orphan', 'text', 'missing-turn')], null), turns([])]),
    response([metadata, items([item('duplicate'), item('duplicate')], null), turns([turn()])]),
    response([metadata, items([], null, 9), turns([])]),
    response([metadata, items([], null), turns([turn(), turn()])]),
    response([metadata, items([], null), turns([turn('turn-one', 'unknown')])]),
    response([{ ...metadata, rawJson: '{"thread":{"id":"another-thread","historyMode":"paginated","turns":[]}}' }]),
    response([metadata, metadata]),
    response([metadata, items([], 'same'), items([], 'same')]),
    response([metadata, items([], null), turns([]), { type: 'complete' }, metadata]),
  ]) {
    await expect(read(input)).rejects.toThrow()
  }
})

test('propagates a midstream authorization denial and cancels a pending reader on abort', async () => {
  await expect(
    read(response([metadata, { type: 'error', status: 403, error: 'Tengri request is not permitted' }], false)),
  ).rejects.toThrow('Tengri request is not permitted')
  let cancelled = false
  const caller = new AbortController()
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
  })
  const pending = read(new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } }), caller.signal)
  caller.abort(new DOMException('Caller stopped waiting', 'AbortError'))
  await expect(pending).rejects.toThrow('Caller stopped waiting')
  expect(cancelled).toBe(true)
})

test('supports the current native legacy-history format through the same streaming RPC', async () => {
  const snapshot = {
    thread: {
      id: 'thread-one',
      historyMode: 'legacy',
      turns: [{ id: 'turn-one', status: 'completed', items: [item('one').item] }],
    },
  }
  expect(await read(response([{ ...metadata, rawJson: JSON.stringify(snapshot) }]))).toEqual({
    id: 'thread-one',
    rawJson: JSON.stringify(snapshot),
    eventSequence: 10,
    itemEventSequences: {},
  })
})
