import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'

import { isOwnAuditFrame } from './audit'

// One instance per execution/stream. Signed self-log frames are counted rather than recursively re-exported.
export class OutputAudit {
  private readonly decoder = new StringDecoder('utf8')
  private readonly validator = new TextDecoder('utf-8', { fatal: true })
  private encodingLoss = false
  private lineBuffer = ''
  private selfAuditFrames = 0
  private selfAuditBytes = 0
  private sequence = 0
  private byteOffset = 0
  private publishedBytes = 0
  private receivedBytes = 0
  private finished = false
  private failed = false
  private readonly hash = createHash('sha256')
  private pauseTimer: ReturnType<typeof setTimeout> | null = null
  private resume: (() => void) | null = null
  sinkErrors = 0
  captureError: string | null = null

  constructor(
    private readonly stream: 'stdout' | 'stderr',
    private readonly emit: (event: string, payload: Record<string, unknown>) => number,
  ) {}

  write(chunk: Buffer, source: Readable, onFailure: () => void) {
    this.receivedBytes += chunk.length
    this.hash.update(chunk)
    try {
      this.validator.decode(chunk, { stream: true })
    } catch {
      this.encodingLoss = true
    }
    if (this.failed) return
    try {
      this.publish(this.filterSelfFrames(this.decoder.write(chunk)))
    } catch {
      this.failed = true
      this.captureError = 'output audit publication failed; output capture stopped'
      this.sinkErrors += 1
      onFailure()
      return
    }
    if (process.stdout.writableNeedDrain && !this.resume) {
      source.pause()
      this.resume = () => {
        if (this.pauseTimer) clearTimeout(this.pauseTimer)
        this.pauseTimer = null
        if (this.resume) process.stdout.off('drain', this.resume)
        this.resume = null
        source.resume()
      }
      process.stdout.once('drain', this.resume)
      this.pauseTimer = setTimeout(() => {
        this.captureError = 'audit stdout backpressure exceeded 10 seconds; command stopped'
        this.sinkErrors += 1
        onFailure()
        this.resume?.()
      }, 10_000)
    }
  }

  private filterSelfFrames(text: string, final = false) {
    this.lineBuffer += text
    let output = ''
    while (this.lineBuffer.length) {
      const newline = this.lineBuffer.indexOf('\n')
      if (newline < 0 && !final && this.lineBuffer.length <= 32_768) break
      let end = newline >= 0 ? newline + 1 : final ? this.lineBuffer.length : 32_768
      if (end < this.lineBuffer.length && /[\uD800-\uDBFF]/.test(this.lineBuffer[end - 1])) end -= 1
      const line = this.lineBuffer.slice(0, end)
      this.lineBuffer = this.lineBuffer.slice(end)
      if (isOwnAuditFrame(line)) {
        this.selfAuditFrames += 1
        this.selfAuditBytes += Buffer.byteLength(line)
      } else output += line
    }
    return output
  }

  private publish(text: string) {
    if (!text) return
    this.publishedBytes += Buffer.byteLength(text)
    const byteEnd = this.publishedBytes + this.selfAuditBytes
    this.sinkErrors += this.emit('process_output', {
      stream: this.stream,
      sequence: this.sequence++,
      byteStart: this.byteOffset,
      byteEnd,
      text,
      encodingLoss: this.encodingLoss,
      selfAuditBytesSuppressed: this.selfAuditBytes,
      maskedValues: 0,
      sourceByteCheckpointOnly: false,
    })
    this.byteOffset = byteEnd
  }

  finish(captureError: string | null = null) {
    if (this.finished) return
    this.finished = true
    this.resume?.()
    this.captureError ??= captureError
    try {
      this.validator.decode()
    } catch {
      this.encodingLoss = true
    }
    if (!this.failed) {
      try {
        this.publish(this.filterSelfFrames(this.decoder.end(), true))
      } catch {
        this.failed = true
        this.sinkErrors += 1
        this.captureError = 'output audit publication failed; output capture stopped'
      }
    }
    this.sinkErrors += this.emit('process_output_finished', {
      stream: this.stream,
      chunks: this.sequence,
      totalBytes: this.receivedBytes,
      capturedBytes: this.publishedBytes + this.selfAuditBytes,
      selfAuditFramesSuppressed: this.selfAuditFrames,
      selfAuditBytesSuppressed: this.selfAuditBytes,
      encodingLoss: this.encodingLoss,
      sha256: !this.failed && !this.encodingLoss && this.selfAuditFrames === 0 ? this.hash.digest('hex') : null,
      maskedValues: 0,
      sourceByteCheckpointOnly: false,
      sinkErrors: this.sinkErrors,
      captureError: this.captureError,
      captureIncomplete: this.failed || this.captureError !== null || this.sinkErrors > 0,
    })
  }
}
