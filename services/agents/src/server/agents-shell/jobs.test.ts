import { ChildProcess, type ChildProcessByStdio } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { jsonTextResult } from './results'
import { REPLY_META_RESERVE_BYTES } from './constants'
import { describe, expect, it, vi } from 'vitest'
import {
  appendTail,
  outputFromOffset,
  ShellJobStore,
  tail,
  decodeOutputCursor,
  encodeOutputCursor,
  readJobOutput,
  listJobMetadata,
  type CompletedShellJob,
  type RunningShellJob,
} from './jobs'

const completedJob = (id: string): CompletedShellJob => ({
  kind: 'completed',
  id,
  ownerSubject: 'owner',
  sessionId: null,
  taskId: id,
  agentId: null,
  requestKey: id,
  requestId: null,
  toolCallId: null,
  commandPreview: 'printf output',
  commandHash: 'a'.repeat(64),
  cwd: '/workspace',
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  status: 'exited',
  exitCode: 0,
  signal: null,
  stdout: tail(),
  stderr: tail(),
  outputCaptureError: null,
  auditErrors: 0,
})
const runningJob = (id: string): RunningShellJob => {
  const { status: _status, exitCode: _exitCode, signal: _signal, ...identity } = completedJob(id)
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdio: ChildProcessByStdio<null, PassThrough, PassThrough>['stdio'] = [null, stdout, stderr, null, null]
  return {
    ...identity,
    kind: 'running',
    finishedAt: null,
    termination: null,
    timeout: null,
    process: Object.assign(new ChildProcess(), { stdin: null, stdout, stderr, stdio }),
  }
}

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

  it('retains a long job receipt after newer jobs finish and output history is full', () => {
    const store = new ShellJobStore()
    const long = runningJob('live')
    store.set('live', long)
    for (let i = 0; i < 100; i += 1) store.set(String(i), completedJob(String(i)))
    expect(store.get('live')).toBeDefined()
    store.set('live', completedJob('live'))
    store.set('next', completedJob('next'))
    expect(store.get('live')).toBeDefined()
    expect(store.get('0')).toBeDefined()
    expect(store.get('99')).toBeDefined()
  })

  it('evicts output independently and expires receipts one hour after completion', () => {
    vi.useFakeTimers()
    try {
      const store = new ShellJobStore()
      for (let i = 0; i < 100; i += 1) {
        const stdout = tail()
        appendTail(stdout, Buffer.from('retained-output'), 1024)
        store.set(String(i), { ...completedJob(String(i)), stdout })
      }
      const first = store.get('0')
      expect(first).toBeDefined()
      expect(first?.stdout.totalBytes).toBe(15)
      expect(first?.stdout.storage.length).toBe(0)
      expect(first?.stdout.truncated).toBe(true)
      expect(store.get('99')?.stdout.length).toBe(15)
      vi.advanceTimersByTime(60 * 60 * 1000)
      expect(store.get('0')).toBeUndefined()
      expect(store.get('99')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('execution receipts and bounded replies', () => {
  it.each(['utf8', 'base64'] as const)(
    'pages both streams within the whole reply budget using %s',
    (outputEncoding) => {
      const job = completedJob('pages')
      const expected = Buffer.from('\u0000\n"雪😀'.repeat(3000))
      appendTail(job.stdout, expected, expected.length)
      appendTail(job.stderr, expected, expected.length)
      let cursor = { jobId: job.id, stdoutOffset: 0, stderrOffset: 0, outputEncoding }
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      while (cursor.stdoutOffset < expected.length || cursor.stderrOffset < expected.length) {
        const page = readJobOutput(job, cursor, 8192)
        expect(Buffer.byteLength(JSON.stringify(jsonTextResult(page))) + REPLY_META_RESERVE_BYTES).toBeLessThanOrEqual(
          8192,
        )
        expect(page.stdoutNextOffset + page.stderrNextOffset).toBeGreaterThan(cursor.stdoutOffset + cursor.stderrOffset)
        stdout.push(Buffer.from(page.stdout, outputEncoding))
        stderr.push(Buffer.from(page.stderr, outputEncoding))
        cursor = decodeOutputCursor(page.cursor, job.id)
      }
      expect(Buffer.concat(stdout)).toEqual(expected)
      expect(Buffer.concat(stderr)).toEqual(expected)
    },
  )

  it('rejects malformed, mismatched and future output cursors', () => {
    const job = completedJob('owned')
    const cursor = { jobId: job.id, stdoutOffset: 0, stderrOffset: 0, outputEncoding: 'utf8' as const }
    expect(() => decodeOutputCursor('invalid', job.id)).toThrow('invalid output cursor')
    expect(() => decodeOutputCursor(encodeOutputCursor(cursor), 'other')).toThrow('does not match')
    expect(() => decodeOutputCursor(encodeOutputCursor({ ...cursor, stdoutOffset: -1 }), job.id)).toThrow(
      'invalid offsets',
    )
    expect(() => readJobOutput(job, { ...cursor, stdoutOffset: 1 }, 8192)).toThrow('beyond produced bytes')
  })

  it('returns the receipt and an explicit output gap after buffer eviction', () => {
    const job = completedJob('expired-output')
    appendTail(job.stdout, Buffer.from('gone'), 0)
    const page = readJobOutput(job, { jobId: job.id, stdoutOffset: 0, stderrOffset: 0, outputEncoding: 'utf8' }, 4096)
    expect(page).toMatchObject({
      state: 'exited',
      ok: true,
      stdout: '',
      stdoutBytes: 4,
      stdoutStartOffset: 4,
      stdoutNextOffset: 4,
      stdoutTruncated: true,
    })
  })

  it('paginates metadata within 8 KiB without command bodies or output', () => {
    const jobs = Array.from({ length: 150 }, (_, i) => {
      const job = completedJob(String(i).padStart(4, '0'))
      appendTail(job.stdout, Buffer.from('large output'.repeat(1000)), 64_000)
      return job
    })
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = listJobMetadata(jobs, cursor, 100)
      expect(Buffer.byteLength(JSON.stringify(jsonTextResult(page))) + REPLY_META_RESERVE_BYTES).toBeLessThanOrEqual(
        8192,
      )
      for (const job of page.jobs) {
        expect(job).not.toHaveProperty('stdout')
        expect(job).not.toHaveProperty('stderr')
        expect(job).not.toHaveProperty('command')
        seen.push(job.jobId)
      }
      cursor = page.cursor ?? undefined
    } while (cursor)
    expect(new Set(seen).size).toBe(jobs.length)
    expect(seen).toHaveLength(jobs.length)
  })

  it('enforces the aggregate memory budget while protecting live buffers and receipts', () => {
    const store = new ShellJobStore()
    const live = runningJob('live')
    appendTail(live.stdout, Buffer.alloc(4 * 1024 * 1024), 4 * 1024 * 1024)
    store.set(live.id, live)
    for (let i = 0; i < 20; i += 1) {
      const job = completedJob(String(i))
      appendTail(job.stdout, Buffer.alloc(4 * 1024 * 1024), 4 * 1024 * 1024)
      store.set(job.id, job)
    }
    expect(store.size).toBe(21)
    expect(store.get('live')?.stdout.length).toBe(4 * 1024 * 1024)
    const bytes = Array.from(store.values()).reduce(
      (sum, job) => sum + job.stdout.storage.length + job.stderr.storage.length,
      0,
    )
    expect(bytes).toBeLessThanOrEqual(64 * 1024 * 1024)
    expect(store.get('0')?.stdout.storage.length).toBe(0)
  })
})
