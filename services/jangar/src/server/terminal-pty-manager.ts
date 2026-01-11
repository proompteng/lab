import { randomUUID } from 'node:crypto'
import { readFile, readlink } from 'node:fs/promises'
import { hostname } from 'node:os'

import { spawn } from 'node-pty'

const DEFAULT_BUFFER_BYTES = 4 * 1024 * 1024
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000
const OUTPUT_FRAME_TYPE = 1

type TerminalPeer = {
  send: (data: string | Uint8Array) => void
  close: (code?: number, reason?: string) => void
}

type OutputChunk = {
  seq: number
  data: Uint8Array
}

class OutputBuffer {
  private readonly maxBytes: number
  private chunks: OutputChunk[] = []
  private size = 0
  private nextSeq = 1

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(256 * 1024, maxBytes)
  }

  append(data: Uint8Array) {
    const seq = this.nextSeq
    this.nextSeq += 1
    this.chunks.push({ seq, data })
    this.size += data.byteLength
    this.trim()
    return seq
  }

  private trim() {
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift()
      if (!removed) break
      this.size -= removed.data.byteLength
    }
  }

  getStartSeq() {
    return this.chunks[0]?.seq ?? this.nextSeq
  }

  getEndSeq() {
    return this.nextSeq - 1
  }

  getSince(seq: number) {
    return this.chunks.filter((chunk) => chunk.seq > seq)
  }

  getSnapshotText() {
    if (this.chunks.length === 0) return ''
    const bytes = this.chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0)
    const buffer = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of this.chunks) {
      buffer.set(chunk.data, offset)
      offset += chunk.data.byteLength
    }
    return new TextDecoder().decode(buffer)
  }
}

type TerminalConnection = {
  token: string
  peer: TerminalPeer
  lastSeq: number
  closed: boolean
}

type TerminalRuntime = {
  id: string
  worktreeName: string | null
  worktreePath: string
  pty: PtyAdapter
  buffer: OutputBuffer
  connections: Map<string, TerminalConnection>
  idleTimer: ReturnType<typeof setTimeout> | null
  lastActivityAt: number
  closed: boolean
}

type PtyExitEvent = { exitCode: number | null; signal: number | null }

type PtyAdapter = {
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  onData: (listener: (data: string) => void) => void
  onExit: (listener: (event: PtyExitEvent) => void) => void
}

type SpawnPtyOptions = {
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

const isBunRuntime = Boolean((globalThis as { Bun?: typeof Bun }).Bun)

const spawnScriptPty = (shell: string, options: SpawnPtyOptions): PtyAdapter => {
  const bunRuntime = (globalThis as { Bun?: typeof Bun }).Bun
  if (!bunRuntime) {
    throw new Error('Bun runtime is required for script-based PTY fallback.')
  }

  const env = {
    ...options.env,
    COLUMNS: String(options.cols),
    LINES: String(options.rows),
  }

  const proc = bunRuntime.spawn(['script', '-qfc', `${shell} -l`, '/dev/null'], {
    cwd: options.cwd,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(event: PtyExitEvent) => void>()
  const encoder = new TextEncoder()

  const readStream = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value || value.length === 0) continue
        const text = decoder.decode(value, { stream: true })
        if (!text) continue
        for (const listener of dataListeners) listener(text)
      }
      const tail = decoder.decode()
      if (tail) {
        for (const listener of dataListeners) listener(tail)
      }
    } catch {
      // ignore
    }
  }

  void readStream(proc.stdout)
  void readStream(proc.stderr)

  proc.exited
    .then((exitCode) => {
      for (const listener of exitListeners) {
        listener({ exitCode: exitCode ?? null, signal: null })
      }
    })
    .catch(() => {})

  let ttyPath: string | null = null
  let pendingResize: { cols: number; rows: number } | null = { cols: options.cols, rows: options.rows }
  let ttyResolve: Promise<string | null> | null = null

  const resolveTtyPath = async () => {
    if (!proc.pid) return null
    try {
      const children = await readFile(`/proc/${proc.pid}/task/${proc.pid}/children`, 'utf8')
      const childPid = Number.parseInt(children.trim().split(/\s+/)[0] ?? '', 10)
      if (!Number.isFinite(childPid)) return null
      const link = await readlink(`/proc/${childPid}/fd/0`)
      const tty = link.trim()
      return tty.startsWith('/dev/') ? tty : null
    } catch {
      return null
    }
  }

  const ensureTtyPath = async () => {
    if (ttyPath) return ttyPath
    if (!ttyResolve) {
      ttyResolve = resolveTtyPath()
        .then((resolved) => {
          ttyPath = resolved
          return resolved
        })
        .finally(() => {
          ttyResolve = null
        })
    }
    return ttyResolve
  }

  const applyResize = (cols: number, rows: number) => {
    const safeCols = Math.max(20, Math.min(400, Math.round(cols)))
    const safeRows = Math.max(6, Math.min(200, Math.round(rows)))
    if (!ttyPath) {
      pendingResize = { cols: safeCols, rows: safeRows }
      void ensureTtyPath().then((resolved) => {
        if (!resolved || !pendingResize) return
        applyResize(pendingResize.cols, pendingResize.rows)
        pendingResize = null
      })
      return
    }
    bunRuntime.spawn(['stty', '-F', ttyPath, 'cols', `${safeCols}`, 'rows', `${safeRows}`], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
  }

  setTimeout(() => {
    void ensureTtyPath().then((resolved) => {
      if (!resolved || !pendingResize) return
      applyResize(pendingResize.cols, pendingResize.rows)
      pendingResize = null
    })
  }, 100)

  return {
    write: (data) => {
      if (!proc.stdin) return
      try {
        proc.stdin.write(encoder.encode(data))
      } catch {
        // ignore
      }
    },
    resize: (cols, rows) => applyResize(cols, rows),
    kill: () => {
      try {
        proc.kill()
      } catch {
        // ignore
      }
    },
    onData: (listener) => {
      dataListeners.add(listener)
    },
    onExit: (listener) => {
      exitListeners.add(listener)
    },
  }
}

const spawnPty = (shell: string, options: SpawnPtyOptions): PtyAdapter => {
  if (isBunRuntime) {
    return spawnScriptPty(shell, options)
  }
  const pty = spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cwd: options.cwd,
    env: options.env,
    cols: options.cols,
    rows: options.rows,
  })
  return {
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: () => pty.kill(),
    onData: (listener) => {
      pty.onData(listener)
    },
    onExit: (listener) => {
      pty.onExit((event) => {
        listener({ exitCode: event.exitCode ?? null, signal: event.signal ?? null })
      })
    },
  }
}

export type TerminalManagerOptions = {
  bufferBytes?: number
  idleTimeoutMs?: number
  instanceId?: string
  onExit?: (sessionId: string, detail: { exitCode: number | null; signal: number | null }) => void
}

export class TerminalPtyManager {
  private readonly bufferBytes: number
  private readonly idleTimeoutMs: number
  private readonly instanceId: string
  private readonly onExit?: TerminalManagerOptions['onExit']
  private readonly sessions = new Map<string, TerminalRuntime>()

  constructor(options: TerminalManagerOptions = {}) {
    this.bufferBytes = options.bufferBytes ?? DEFAULT_BUFFER_BYTES
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.instanceId = options.instanceId ?? hostname()
    this.onExit = options.onExit
  }

  getInstanceId() {
    return this.instanceId
  }

  getSession(sessionId: string) {
    return this.sessions.get(sessionId) ?? null
  }

  listSessions() {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      attached: session.connections.size > 0,
      connectionCount: session.connections.size,
      lastActivityAt: session.lastActivityAt,
    }))
  }

  startSession(input: { sessionId: string; worktreePath: string; worktreeName?: string | null }) {
    const existing = this.sessions.get(input.sessionId)
    if (existing && !existing.closed) return existing
    const shell = process.env.SHELL || '/bin/bash'
    const baseEnv = Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => typeof value === 'string'),
    ) as Record<string, string>
    const env: Record<string, string> = {
      ...baseEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      JANGAR_TERMINAL_SESSION: input.sessionId,
      JANGAR_WORKTREE_NAME: input.worktreeName ?? '',
      JANGAR_WORKTREE_PATH: input.worktreePath,
    }
    const pty = spawnPty(shell, {
      cwd: input.worktreePath,
      env,
      cols: 120,
      rows: 32,
    })
    const runtime: TerminalRuntime = {
      id: input.sessionId,
      worktreeName: input.worktreeName ?? null,
      worktreePath: input.worktreePath,
      pty,
      buffer: new OutputBuffer(this.bufferBytes),
      connections: new Map(),
      idleTimer: null,
      lastActivityAt: Date.now(),
      closed: false,
    }
    this.sessions.set(input.sessionId, runtime)
    this.bindRuntime(runtime)
    return runtime
  }

  attach(
    sessionId: string,
    peer: TerminalPeer,
    input: { token?: string | null; since?: number; cols?: number; rows?: number },
  ) {
    const session = this.sessions.get(sessionId)
    if (!session || session.closed) {
      throw new Error('Session not found')
    }
    const token = input.token ?? randomUUID()
    const lastSeq = Number.isFinite(input.since) && (input.since as number) > 0 ? (input.since as number) : 0
    const existing = session.connections.get(token)
    if (existing) {
      existing.closed = true
      try {
        existing.peer.close(1000, 'Reconnected')
      } catch {
        // ignore
      }
    }
    const connection: TerminalConnection = {
      token,
      peer,
      lastSeq,
      closed: false,
    }
    session.connections.set(token, connection)
    this.bumpActivity(session)
    this.cancelIdleTimer(session)
    this.sendControl(peer, {
      type: 'ready',
      sessionId,
      token,
      bufferStart: session.buffer.getStartSeq(),
      bufferEnd: session.buffer.getEndSeq(),
    })
    this.sendBufferedOutput(session, connection)
    if (Number.isFinite(input.cols) && Number.isFinite(input.rows)) {
      this.resize(sessionId, Math.round(input.cols ?? 0), Math.round(input.rows ?? 0))
    }
    return connection
  }

  detach(sessionId: string, token: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const existing = session.connections.get(token)
    if (!existing) return
    existing.closed = true
    session.connections.delete(token)
    if (session.connections.size === 0) {
      this.scheduleIdleTimer(session)
    }
  }

  handleInput(sessionId: string, input: Uint8Array) {
    const session = this.sessions.get(sessionId)
    if (!session || session.closed) return
    this.bumpActivity(session)
    if (input.byteLength === 0) return
    const text = new TextDecoder().decode(input)
    session.pty.write(text)
  }

  resize(sessionId: string, cols: number, rows: number) {
    const session = this.sessions.get(sessionId)
    if (!session || session.closed) return
    const safeCols = Math.max(20, Math.min(400, Math.round(cols)))
    const safeRows = Math.max(6, Math.min(200, Math.round(rows)))
    if (!Number.isFinite(safeCols) || !Number.isFinite(safeRows)) return
    try {
      session.pty.resize(safeCols, safeRows)
    } catch {
      // ignore
    }
  }

  terminate(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session || session.closed) return
    session.closed = true
    this.cancelIdleTimer(session)
    for (const connection of session.connections.values()) {
      if (connection.closed) continue
      connection.closed = true
      try {
        connection.peer.close(1000, 'Session closed')
      } catch {
        // ignore
      }
    }
    session.connections.clear()
    try {
      session.pty.kill()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  getSnapshot(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session || session.closed) return null
    return session.buffer.getSnapshotText()
  }

  private bindRuntime(session: TerminalRuntime) {
    session.pty.onData((data) => {
      if (session.closed) return
      const bytes = new TextEncoder().encode(data)
      const seq = session.buffer.append(bytes)
      this.broadcastOutput(session, seq, bytes)
      this.bumpActivity(session)
    })
    session.pty.onExit((event) => {
      if (session.closed) return
      session.closed = true
      this.cancelIdleTimer(session)
      for (const connection of session.connections.values()) {
        if (connection.closed) continue
        connection.closed = true
        this.sendControl(connection.peer, {
          type: 'exit',
          exitCode: event.exitCode ?? null,
          signal: event.signal ?? null,
        })
        try {
          connection.peer.close(1000, 'Session exited')
        } catch {
          // ignore
        }
      }
      session.connections.clear()
      this.sessions.delete(session.id)
      if (this.onExit) {
        this.onExit(session.id, { exitCode: event.exitCode ?? null, signal: event.signal ?? null })
      }
    })
  }

  private broadcastOutput(session: TerminalRuntime, seq: number, data: Uint8Array) {
    if (session.connections.size === 0) return
    const frame = new Uint8Array(5 + data.byteLength)
    frame[0] = OUTPUT_FRAME_TYPE
    frame[1] = (seq >>> 24) & 0xff
    frame[2] = (seq >>> 16) & 0xff
    frame[3] = (seq >>> 8) & 0xff
    frame[4] = seq & 0xff
    frame.set(data, 5)
    for (const connection of session.connections.values()) {
      if (connection.closed) continue
      try {
        connection.peer.send(frame)
        connection.lastSeq = seq
      } catch {
        connection.closed = true
      }
    }
  }

  private sendBufferedOutput(session: TerminalRuntime, connection: TerminalConnection) {
    const bufferStart = session.buffer.getStartSeq()
    if (connection.lastSeq > 0 && connection.lastSeq < bufferStart) {
      this.sendControl(connection.peer, {
        type: 'reset',
        reason: 'buffer_miss',
        bufferStart,
        bufferEnd: session.buffer.getEndSeq(),
      })
      connection.lastSeq = 0
    }
    const chunks = session.buffer.getSince(connection.lastSeq)
    for (const chunk of chunks) {
      if (connection.closed) break
      const frame = new Uint8Array(5 + chunk.data.byteLength)
      frame[0] = OUTPUT_FRAME_TYPE
      frame[1] = (chunk.seq >>> 24) & 0xff
      frame[2] = (chunk.seq >>> 16) & 0xff
      frame[3] = (chunk.seq >>> 8) & 0xff
      frame[4] = chunk.seq & 0xff
      frame.set(chunk.data, 5)
      try {
        connection.peer.send(frame)
        connection.lastSeq = chunk.seq
      } catch {
        connection.closed = true
        break
      }
    }
  }

  private sendControl(peer: TerminalPeer, payload: Record<string, unknown>) {
    peer.send(JSON.stringify(payload))
  }

  private bumpActivity(session: TerminalRuntime) {
    session.lastActivityAt = Date.now()
  }

  private cancelIdleTimer(session: TerminalRuntime) {
    if (!session.idleTimer) return
    clearTimeout(session.idleTimer)
    session.idleTimer = null
  }

  private scheduleIdleTimer(session: TerminalRuntime) {
    if (this.idleTimeoutMs <= 0) return
    this.cancelIdleTimer(session)
    session.idleTimer = setTimeout(() => {
      if (session.connections.size > 0) return
      this.terminate(session.id)
    }, this.idleTimeoutMs)
  }
}

let manager: TerminalPtyManager | null = null

export const getTerminalPtyManager = (options: TerminalManagerOptions = {}) => {
  if (!manager) {
    manager = new TerminalPtyManager(options)
  }
  return manager
}

export const resetTerminalPtyManager = () => {
  manager = null
}
