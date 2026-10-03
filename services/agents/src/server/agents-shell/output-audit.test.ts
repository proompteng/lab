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
      payload: { totalBytes: 2, capturedBytes: 2, encodingLoss: true, sha256: null },
    })
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
  it('contains scanner capacity failures to a single execution and reports capture failure', () => {
    const { mirror, events, source, failure } = fixture()
    mirror.write(Buffer.from('password' + ' '.repeat(140_000)), source, failure)
    expect(failure).toHaveBeenCalledOnce()
    mirror.finish()
    expect(events.at(-1)?.payload.captureError).toContain('bounded scanner capacity')
    expect(events.at(-1)?.payload.sha256).toBeNull()
  })
})
