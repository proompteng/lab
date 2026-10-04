import type { Writable } from 'node:stream'

type AuditStream = Pick<Writable, 'on' | 'once' | 'off'>
export type AuditSinkStatus = {
  pendingBytes: number
  pendingFrames: number
  rejectedFrames: number
  failedWrites: number
  stalled: boolean
}

// One finite queue for every event family, including large tool inputs/results after a child exits.
export class BoundedAuditWriter {
  private queue: Array<{ line: string; bytes: number; ticket: number } | undefined> = []
  private nextTicket = 0
  private flushedTicket = 0
  private blockedTicket = 0
  private head = 0
  private pendingBytes = 0
  private blocked = false
  private expired = false
  private failed = false
  private rejectedFrames = 0
  private failedWrites = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly waiters = new Set<{
    through: number
    resolve: (status: AuditSinkStatus & { flushed: boolean }) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(
    private readonly stream: AuditStream,
    private readonly writeLine: (line: string) => boolean,
    private readonly maxPendingBytes = 16 * 1024 * 1024,
    private readonly timeoutMs = 10_000,
  ) {
    stream.on('error', () => this.fail())
  }

  status(): AuditSinkStatus {
    return {
      pendingBytes: this.pendingBytes,
      pendingFrames: this.queue.length - this.head,
      rejectedFrames: this.rejectedFrames,
      failedWrites: this.failedWrites,
      stalled: this.expired || this.failed,
    }
  }

  enqueue(lines: string[]) {
    const before = this.rejectedFrames + this.failedWrites
    const entries = lines.map((line) => ({ line, bytes: Buffer.byteLength(line) }))
    const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    if (this.failed || this.expired || this.pendingBytes + bytes > this.maxPendingBytes) {
      this.rejectedFrames += entries.length
      return entries.length
    }
    for (const entry of entries) this.queue.push({ ...entry, ticket: ++this.nextTicket })
    this.pendingBytes += bytes
    this.pump()
    return this.rejectedFrames + this.failedWrites - before
  }

  flush(): Promise<AuditSinkStatus & { flushed: boolean }> {
    const through = this.nextTicket
    if (this.failed || this.expired || this.flushedTicket >= through)
      return Promise.resolve({ ...this.status(), flushed: !this.failed && !this.expired })
    return new Promise((resolve) => {
      const waiter = {
        through,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          resolve({ ...this.status(), flushed: false })
        }, this.timeoutMs),
      }
      this.waiters.add(waiter)
    })
  }

  private settle() {
    for (const waiter of this.waiters) {
      if (!this.failed && !this.expired && this.flushedTicket < waiter.through) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(waiter)
      waiter.resolve({ ...this.status(), flushed: !this.failed && !this.expired })
    }
  }

  private discardPending() {
    this.rejectedFrames += this.queue.length - this.head
    this.queue = []
    this.head = 0
    this.pendingBytes = 0
  }

  private fail() {
    this.failed = true
    this.failedWrites += 1
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.stream.off('drain', this.drain)
    this.discardPending()
    this.settle()
  }

  private readonly drain = () => {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.blocked = false
    this.expired = false
    this.flushedTicket = this.blockedTicket
    this.settle()
    this.pump()
  }

  private pump() {
    if (this.blocked || this.failed) return
    while (this.head < this.queue.length) {
      const entry = this.queue[this.head]!
      this.queue[this.head++] = undefined
      this.pendingBytes -= entry.bytes
      let accepted: boolean
      try {
        accepted = this.writeLine(entry.line)
      } catch {
        this.fail()
        return
      }
      if (!accepted) {
        this.blocked = true
        this.blockedTicket = entry.ticket
        this.stream.once('drain', this.drain)
        this.timer = setTimeout(() => {
          this.expired = true
          this.failedWrites += 1
          this.discardPending()
          this.settle()
          // Stay blocked until a real drain: repeated calls must not keep filling the Writable buffer.
        }, this.timeoutMs)
        break
      }
      this.flushedTicket = entry.ticket
      this.settle()
    }
    if (this.head === this.queue.length) {
      this.queue = []
      this.head = 0
    } else if (this.head > 1024) {
      this.queue = this.queue.slice(this.head)
      this.head = 0
    }
    if (!this.blocked) this.settle()
  }
}
