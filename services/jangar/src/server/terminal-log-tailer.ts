import { watch } from 'node:fs'
import { open as openFile } from 'node:fs/promises'

import { getTerminalLogPath, trimTerminalLogIfNeeded } from './terminals'

const DEFAULT_MIN_POLL_MS = 60
const DEFAULT_MAX_POLL_MS = 1000
const DEFAULT_READ_CHUNK_BYTES = 64 * 1024
const LOG_TRIM_COOLDOWN_MS = 5000

type TailerPeer = {
  send: (payload: unknown) => void
}

type TerminalLogTailerOptions = {
  minPollIntervalMs?: number
  maxPollIntervalMs?: number
  readChunkBytes?: number
  watch?: boolean
}

const encodeBase64 = (value: Uint8Array) => Buffer.from(value).toString('base64')

export class TerminalLogTailer {
  private readonly sessionId: string
  private readonly minPollMs: number
  private readonly maxPollMs: number
  private readonly readChunkBytes: number
  private readonly watchEnabled: boolean
  private peers = new Set<TailerPeer>()
  private handle: Awaited<ReturnType<typeof openFile>> | null = null
  private watcher: ReturnType<typeof watch> | null = null
  private offset = 0
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private pollIntervalMs: number
  private reading = false
  private readQueued = false
  private lastTrimAt = 0
  private logPath: string | null = null

  constructor(sessionId: string, options: TerminalLogTailerOptions = {}) {
    this.sessionId = sessionId
    this.minPollMs = options.minPollIntervalMs ?? DEFAULT_MIN_POLL_MS
    this.maxPollMs = options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_MS
    this.readChunkBytes = options.readChunkBytes ?? DEFAULT_READ_CHUNK_BYTES
    this.watchEnabled = options.watch ?? true
    this.pollIntervalMs = this.minPollMs
  }

  async addPeer(peer: TailerPeer) {
    this.peers.add(peer)
    await this.ensureHandle()
    this.pollIntervalMs = this.minPollMs
    this.ensureWatch()
    this.queueRead(0)
    this.ensurePoll()
  }

  removePeer(peer: TailerPeer) {
    this.peers.delete(peer)
    if (this.peers.size === 0) {
      this.stop()
    }
  }

  async readNow() {
    await this.readOnce()
  }

  getPeerCount() {
    return this.peers.size
  }

  dispose() {
    this.peers.clear()
    this.stop()
  }

  private async ensureHandle() {
    if (this.handle) return
    const logPath = await getTerminalLogPath(this.sessionId)
    this.logPath = logPath
    this.handle = await openFile(logPath, 'r')
    const stats = await this.handle.stat()
    this.offset = stats.size
  }

  private ensureWatch() {
    if (!this.watchEnabled || this.watcher || !this.logPath) return
    try {
      this.watcher = watch(this.logPath, { persistent: false }, () => {
        this.queueRead(0)
      })
      this.watcher.on('error', () => {
        this.watcher?.close()
        this.watcher = null
      })
    } catch {
      this.watcher = null
    }
  }

  private ensurePoll() {
    if (this.pollTimer || this.peers.size === 0) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.readOnce()
    }, this.pollIntervalMs)
  }

  private stop() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    if (this.handle) {
      void this.handle.close().catch(() => {})
      this.handle = null
    }
    this.offset = 0
  }

  private queueRead(delayMs: number) {
    if (this.readQueued || this.peers.size === 0) return
    this.readQueued = true
    setTimeout(() => {
      this.readQueued = false
      void this.readOnce()
    }, delayMs)
  }

  private async readOnce() {
    if (this.reading || this.peers.size === 0) {
      this.ensurePoll()
      return
    }
    this.reading = true
    try {
      await this.ensureHandle()
      if (!this.handle) return

      let stats = await this.handle.stat()
      if (stats.size < this.offset) {
        this.offset = stats.size
      }

      const now = Date.now()
      if (stats.size > 0 && now - this.lastTrimAt > LOG_TRIM_COOLDOWN_MS) {
        const result = await trimTerminalLogIfNeeded(this.sessionId)
        if (result.trimmed) {
          stats = await this.handle.stat()
          this.offset = Math.min(this.offset, stats.size)
        }
        this.lastTrimAt = now
      }

      let bytesSent = 0
      while (stats.size > this.offset) {
        const remaining = stats.size - this.offset
        const chunkSize = Math.min(remaining, this.readChunkBytes)
        const buffer = Buffer.alloc(chunkSize)
        const { bytesRead } = await this.handle.read(buffer, 0, chunkSize, this.offset)
        if (!bytesRead) break
        this.offset += bytesRead
        bytesSent += bytesRead
        this.broadcast({ type: 'output', data: encodeBase64(buffer.subarray(0, bytesRead)) })
      }

      if (bytesSent > 0) {
        this.pollIntervalMs = this.minPollMs
      } else {
        this.pollIntervalMs = Math.min(this.maxPollMs, Math.round(this.pollIntervalMs * 1.4))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to read terminal log.'
      this.broadcast({ type: 'error', message, fatal: false })
      this.pollIntervalMs = Math.min(this.maxPollMs, Math.round(this.pollIntervalMs * 1.6))
    } finally {
      this.reading = false
      this.ensurePoll()
    }
  }

  private broadcast(payload: unknown) {
    for (const peer of this.peers) {
      try {
        peer.send(payload)
      } catch {
        // ignore peer errors
      }
    }
  }
}

export type { TailerPeer, TerminalLogTailerOptions }
