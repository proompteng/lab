import { createHash } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { auditStdout, writeAuditLog } from './audit'
import { defaultAgentsShellConfigFromEnv } from './config'
import { OutputAudit } from './output-audit'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
const fixture = () => {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = []
  const mirror = new OutputAudit('stdout', (event, payload) => {
    events.push({ event, payload })
    return 0
  })
  return { events, mirror, source: new PassThrough(), failure: vi.fn() }
}
describe('bounded output audit', () => {
  it('filters only signed self-audit frames across every boundary without creating a feedback event', () => {
    let own = ''
    vi.spyOn(auditStdout, 'write').mockImplementation((line) => {
      own += line
      return true
    })
    writeAuditLog(defaultAgentsShellConfigFromEnv({ AGENTS_SHELL_AUDIT_LOG_PATH: '' }), 'probe', null, {
      command: 'ordinary',
    })
    for (let split = 0; split <= own.length; split += 1) {
      const { mirror, events, source, failure } = fixture()
      mirror.write(Buffer.from(own.slice(0, split)), source, failure)
      mirror.write(Buffer.from(own.slice(split)), source, failure)
      expect(events).toHaveLength(0)
      mirror.finish()
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        event: 'process_output_finished',
        payload: { selfAuditFramesSuppressed: 1, selfAuditBytesSuppressed: Buffer.byteLength(own), sha256: null },
      })
    }
    const { mirror, events, source, failure } = fixture()
    const lookalike = 'ordinary {"msg":"agents-shell audit","schemaVersion":2,"frameSignature":"fake"}\n'
    mirror.write(Buffer.from(lookalike), source, failure)
    mirror.finish()
    expect(
      events
        .filter((event) => event.event === 'process_output')
        .map((event) => event.payload.text)
        .join(''),
    ).toBe(lookalike)
  })
  it('marks invalid UTF-8 and withholds a misleading text-reconstruction hash', () => {
    const { mirror, events, source, failure } = fixture()
    mirror.write(Buffer.from([255, 10]), source, failure)
    mirror.finish()
    expect(events.at(-1)).toMatchObject({
      event: 'process_output_finished',
      payload: { totalBytes: 2, capturedBytes: 4, encodingLoss: true, sha256: null },
    })
    expect(events[0]?.payload).toMatchObject({ text: '\uFFFD\n', byteStart: 0, byteEnd: 4 })
  })
  it('resumes a paused producer after sink drain and bounds an indefinitely blocked sink', () => {
    vi.useFakeTimers()
    vi.spyOn(process.stdout, 'writableNeedDrain', 'get').mockReturnValue(true)
    const { mirror, events, source, failure } = fixture()
    mirror.write(Buffer.from('ordinary\n'), source, failure)
    expect(source.isPaused()).toBe(true)
    process.stdout.emit('drain')
    expect(source.isPaused()).toBe(false)
    mirror.write(Buffer.from('more\n'), source, failure)
    vi.advanceTimersByTime(10_001)
    expect(failure).toHaveBeenCalledOnce()
    expect(source.isPaused()).toBe(false)
    mirror.finish()
    expect(events.at(-1)?.payload).toMatchObject({
      sinkErrors: 1,
      captureError: 'audit stdout backpressure exceeded 10 seconds; command stopped',
    })
  })
  it('publishes raw credential and Secret content across every UTF-8 byte boundary', () => {
    const text =
      'password=opaque-runtime-secret\nAuthorization: Bearer synthetic-token\n' +
      '{"kind":"Secret","data":{"token":"c3ludGhldGlj"},"stringData":{"password":"raw-secret"}}\nα🙂\n'
    const bytes = Buffer.from(text)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    for (let split = 0; split <= bytes.length; split += 1) {
      const { mirror, events, source, failure } = fixture()
      mirror.write(bytes.subarray(0, split), source, failure)
      mirror.write(bytes.subarray(split), source, failure)
      mirror.finish()
      const chunks = events.filter((event) => event.event === 'process_output')
      expect(chunks.map((event) => event.payload.text).join('')).toBe(text)
      let checkpoint = 0
      for (const [sequence, chunk] of chunks.entries()) {
        expect(chunk.payload).toMatchObject({ sequence, byteStart: checkpoint, maskedValues: 0 })
        checkpoint += Buffer.byteLength(String(chunk.payload.text))
        expect(chunk.payload.byteEnd).toBe(checkpoint)
      }
      expect(events.at(-1)?.payload).toMatchObject({
        totalBytes: bytes.length,
        capturedBytes: bytes.length,
        sha256,
        maskedValues: 0,
        sourceByteCheckpointOnly: false,
        encodingLoss: false,
        captureIncomplete: false,
      })
      expect(failure).not.toHaveBeenCalled()
    }
  })
  it('excludes decoder and unterminated-line pending bytes from published checkpoints', () => {
    const { mirror, events, source, failure } = fixture()
    const emoji = Buffer.from('🙂')
    mirror.write(Buffer.concat([Buffer.from('visible\npending'), emoji.subarray(0, 1)]), source, failure)
    expect(events[0]?.payload).toMatchObject({ text: 'visible\n', byteStart: 0, byteEnd: 8 })
    mirror.write(Buffer.concat([emoji.subarray(1), Buffer.from('\ntrail')]), source, failure)
    expect(events[1]?.payload).toMatchObject({ text: 'pending🙂\n', byteStart: 8, byteEnd: 20 })
    mirror.finish()
    expect(events[2]?.payload).toMatchObject({ text: 'trail', byteStart: 20, byteEnd: 25 })
    expect(events[3]?.payload).toMatchObject({ totalBytes: 25, capturedBytes: 25, encodingLoss: false })
  })
  it('keeps large unterminated credential-shaped output raw without scanner failures', () => {
    const { mirror, events, source, failure } = fixture()
    const text = 'password' + ' '.repeat(140_000) + '=synthetic-secret'
    mirror.write(Buffer.from(text), source, failure)
    mirror.finish()
    expect(
      events
        .filter((event) => event.event === 'process_output')
        .map((event) => event.payload.text)
        .join(''),
    ).toBe(text)
    expect(failure).not.toHaveBeenCalled()
    expect(events.at(-1)?.payload).toMatchObject({
      captureError: null,
      captureIncomplete: false,
      totalBytes: Buffer.byteLength(text),
      capturedBytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'),
    })
  })
})
