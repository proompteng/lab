import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'

import { isOwnAuditFrame } from './audit'
import { CredentialMasker, credentialValuesFromEnv } from './credential-masker'
import {
  maskKubernetesSecretText,
  SECRET_DOCUMENT_BYTE_BUDGET,
  type SecretCaptureMode,
} from './kubernetes-secret-masker'

// One instance per execution/stream. Signed self-log frames are counted rather than recursively re-exported.
export class OutputAudit {
  private readonly decoder = new StringDecoder('utf8')
  private readonly validator = new TextDecoder('utf-8', { fatal: true })
  private encodingLoss = false
  private readonly masker: CredentialMasker
  private lineBuffer = ''
  private selfAuditFrames = 0
  private selfAuditBytes = 0
  private sequence = 0
  private byteOffset = 0
  private receivedBytes = 0
  private finished = false
  private failed = false
  private readonly hash = createHash('sha256')
  private secretChunks: string[] = []
  private structuralMaskedValues = 0
  private pauseTimer: ReturnType<typeof setTimeout> | null = null
  private resume: (() => void) | null = null
  sinkErrors = 0
  captureError: string | null = null

  constructor(
    private readonly stream: 'stdout' | 'stderr',
    private readonly emit: (event: string, payload: Record<string, unknown>) => number,
    private readonly secretSource: SecretCaptureMode | null = null,
    credentialValues: string[] = [],
  ) {
    this.masker = new CredentialMasker([...credentialValuesFromEnv(), ...credentialValues])
  }

  write(chunk: Buffer, source: Readable, onFailure: () => void) {
    this.receivedBytes += chunk.length
    this.hash.update(chunk)
    try {
      this.validator.decode(chunk, { stream: true })
    } catch {
      this.encodingLoss = true
    }
    if (this.failed) return
    if (this.secretSource === 'projection' && chunk.length > 0) {
      this.failed = true
      this.captureError = 'Secret output projection omitted from centralized capture; original MCP output unchanged'
      this.sinkErrors += 1
      return
    }
    try {
      const decoded = this.decoder.write(chunk)
      if (this.secretSource) {
        if (this.receivedBytes > SECRET_DOCUMENT_BYTE_BUDGET) throw new Error('Secret document byte budget exceeded')
        this.secretChunks.push(decoded)
      } else this.publish(this.masker.write(this.filterSelfFrames(decoded)))
    } catch {
      this.failed = true
      this.captureError = this.secretSource
        ? 'Secret output exceeded bounded structural capture; output capture stopped'
        : 'credential context exceeded bounded scanner capacity; output capture stopped'
      this.sinkErrors += 1
      if (this.secretSource) this.secretChunks = []
      else onFailure()
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
    const byteEnd =
      this.encodingLoss || this.secretSource ? this.receivedBytes : this.masker.consumedBytes + this.selfAuditBytes
    if (!text) return
    this.sinkErrors += this.emit('process_output', {
      stream: this.stream,
      sequence: this.sequence++,
      byteStart: this.byteOffset,
      byteEnd,
      text,
      encodingLoss: this.encodingLoss,
      selfAuditBytesSuppressed: this.selfAuditBytes,
      maskedValues: this.masker.maskedValues + this.structuralMaskedValues,
      sourceByteCheckpointOnly: this.secretSource !== null,
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
        if (this.secretSource) {
          this.secretChunks.push(this.decoder.end())
          const masked = maskKubernetesSecretText(
            this.secretChunks.join(''),
            this.secretSource,
            this.stream === 'stderr',
          )
          this.structuralMaskedValues = masked.maskedValues
          for (let offset = 0; offset < masked.text.length; ) {
            let end = Math.min(masked.text.length, offset + 16_384)
            if (end < masked.text.length && /[\uD800-\uDBFF]/.test(masked.text[end - 1])) end -= 1
            this.publish(this.masker.write(masked.text.slice(offset, end)))
            offset = end
          }
          this.publish(this.masker.write('', true))
        } else this.publish(this.masker.write(this.filterSelfFrames(this.decoder.end(), true), true))
      } catch {
        this.failed = true
        this.sinkErrors += 1
        this.captureError =
          this.secretSource === 'projection'
            ? 'Secret output projection omitted from centralized capture; original MCP output unchanged'
            : 'Secret or credential output could not be safely captured within structural bounds'
      }
    }
    this.secretChunks = []
    this.sinkErrors += this.emit('process_output_finished', {
      stream: this.stream,
      chunks: this.sequence,
      totalBytes: this.receivedBytes,
      capturedBytes: this.failed ? this.byteOffset : this.receivedBytes,
      selfAuditFramesSuppressed: this.selfAuditFrames,
      selfAuditBytesSuppressed: this.selfAuditBytes,
      encodingLoss: this.encodingLoss,
      sha256:
        this.masker.maskedValues + this.structuralMaskedValues === 0 &&
        !this.failed &&
        !this.encodingLoss &&
        this.selfAuditFrames === 0
          ? this.hash.digest('hex')
          : null,
      maskedValues: this.masker.maskedValues + this.structuralMaskedValues,
      sourceByteCheckpointOnly: this.secretSource !== null,
      sinkErrors: this.sinkErrors,
      captureError: this.captureError,
      captureIncomplete: this.failed || this.captureError !== null || this.sinkErrors > 0,
    })
  }
}
