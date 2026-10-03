import { describe, expect, it } from 'vitest'
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
