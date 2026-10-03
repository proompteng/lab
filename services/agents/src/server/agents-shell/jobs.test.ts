import { describe, expect, it, vi } from 'vitest'
import { appendTail, outputFromOffset, ShellJobStore, tail, type ShellJob } from './jobs'

describe('shell output pages', () => {
  it('returns every retained byte exactly once in forward pages', () => {
    const output = tail()
    const expected = 'start\n' + 'abc雪😀\n'.repeat(30_000) + 'end\n'
    appendTail(output, Buffer.from(expected), 1_000_000)
    let offset = 0
    let actual = ''
    do {
      const page = outputFromOffset(output, offset, 20_000)
      expect(page.startOffset).toBe(offset)
      expect(page.nextOffset).toBeGreaterThan(offset)
      actual += page.text
      if (page.nextOffset === offset) expect(page.hasMore).toBe(false)
      offset = page.nextOffset
    } while (offset < output.totalBytes)
    expect(actual).toBe(expected)
  })
  it('holds partial live UTF-8 code points until their bytes arrive', () => {
    const output = tail()
    let actual = ''
    let offset = 0
    for (const byte of Buffer.from('😀雪')) {
      appendTail(output, Buffer.from([byte]), 1024)
      const page = outputFromOffset(output, offset, 1024, 'utf8', false)
      actual += page.text
      if (page.nextOffset === offset) expect(page.hasMore).toBe(false)
      offset = page.nextOffset
    }
    expect(actual).toBe('😀雪')
    expect(offset).toBe(7)
  })
  it('provides exact arbitrary bytes as base64 and reports evicted prefixes', () => {
    const output = tail()
    appendTail(output, Buffer.from([0, 255, 128, 2, 3]), 4)
    const page = outputFromOffset(output, 0, 2, 'base64')
    expect(Buffer.from(page.text, 'base64')).toEqual(Buffer.from([255, 128]))
    expect(page).toMatchObject({
      retentionStartByte: 1,
      startOffset: 1,
      nextOffset: 3,
      hasMore: true,
      truncatedBeforeOffset: true,
    })
  })
  it('keeps a bounded ring across concurrent streams, wraps and eviction without concatenation', () => {
    const streams = Array.from({ length: 4 }, () => tail())
    const expected = streams.map(() => [] as Buffer[])
    const capacity = 64 * 1024
    const concat = vi.spyOn(Buffer, 'concat')
    let calls = 0
    for (let iteration = 0; iteration < 1000; iteration += 1) {
      for (let stream = 0; stream < streams.length; stream += 1) {
        const chunk = Buffer.alloc(317 + (iteration % 23), (iteration + stream) % 256)
        expected[stream].push(chunk)
        const before = concat.mock.calls.length
        appendTail(streams[stream], chunk, capacity)
        calls += concat.mock.calls.length - before
        expect(streams[stream].storage.length).toBeLessThanOrEqual(capacity)
      }
    }
    expect(calls).toBe(0)
    concat.mockRestore()
    for (let stream = 0; stream < streams.length; stream += 1) {
      const output = streams[stream]
      const page = outputFromOffset(output, 0, capacity, 'base64')
      expect(Buffer.from(page.text, 'base64')).toEqual(Buffer.concat(expected[stream]).subarray(-capacity))
      expect(page.retentionStartByte).toBe(output.totalBytes - capacity)
      expect(page.nextOffset).toBe(output.totalBytes)
      expect(page.truncatedBeforeOffset).toBe(true)
    }
  })

  it('copies incoming bytes only after reaching capacity and pages Unicode over the wrap', () => {
    const output = tail()
    const capacity = 257
    const source = Buffer.from('雪😀abc'.repeat(1000))
    for (let i = 0; i < source.length; i += 19) appendTail(output, source.subarray(i, i + 19), capacity)
    const storage = output.storage
    let actual = ''
    let offset = source.length - capacity
    let firstOffset = offset
    for (let pageIndex = 0; offset < source.length; pageIndex += 1) {
      const page = outputFromOffset(output, offset, 31)
      if (pageIndex === 0) firstOffset = page.startOffset
      expect(page.nextOffset).toBeGreaterThan(offset)
      actual += page.text
      offset = page.nextOffset
    }
    expect(actual).toBe(source.subarray(firstOffset).toString('utf8'))
    appendTail(output, Buffer.from('end'), capacity)
    expect(output.storage).toBe(storage)
    expect(Buffer.from(outputFromOffset(output, null, capacity, 'base64').text, 'base64')).toEqual(
      Buffer.concat([source, Buffer.from('end')]).subarray(-capacity),
    )
  })

  it('handles growth, reduced budgets, oversized chunks and zero retention exactly', () => {
    const output = tail()
    appendTail(output, Buffer.from('abcdef'), 16)
    appendTail(output, Buffer.from('gh'), 4)
    expect(outputFromOffset(output, 0, 10).text).toBe('efgh')
    appendTail(output, Buffer.from('0123456789'), 4)
    expect(outputFromOffset(output, 0, 10).text).toBe('6789')
    appendTail(output, Buffer.from('ignored'), 0)
    expect(output.length).toBe(0)
    expect(output.storage.length).toBe(0)
    expect(outputFromOffset(output, 0, 10).text).toBe('')
  })

  it('bounds completed job history without evicting live jobs', () => {
    const store = new ShellJobStore()
    const job = (id: string, live = false) =>
      ({ id, finishedAt: live ? null : new Date().toISOString(), stdout: tail(), stderr: tail() }) as ShellJob
    store.set('live', job('live', true))
    for (let i = 0; i < 100; i += 1) store.set(String(i), job(String(i)))
    expect(store.size).toBe(64)
    expect(store.get('live')).toBeDefined()
    expect(store.get('0')).toBeUndefined()
    expect(store.get('99')).toBeDefined()
  })
})
