const OUTPUT_FRAME_TYPE = 1
const MAX_UINT32 = 0xffff_ffff
const RFC_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const SESSION_ID = /^[A-Za-z0-9_-]{16,128}$/

export type TerminalOutputFrame = {
  sequence: number
  payload: Uint8Array
}

export type TerminalControlFrame =
  | { type: 'error'; message: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'pong' }
  | { type: 'ready'; token: string; bufferStart: number; bufferEnd: number }
  | { type: 'reset'; reason: string; bufferStart: number; bufferEnd: number }

export type TerminalResumeState = {
  agentId: string
  sessionId: string
  reconnectToken: string
  sequence: number
}

export function terminalResumeStorageKey(agentId: string, windowId: string): string {
  return `tengri:terminal:${encodeURIComponent(agentId)}:${encodeURIComponent(windowId)}`
}

export function normalizeTerminalSize(columns: number, rows: number): { columns: number; rows: number } {
  return {
    columns: clampInteger(columns, 120, 20, 400),
    rows: clampInteger(rows, 32, 6, 200),
  }
}

export function buildTerminalWebSocketUrl(
  rawUrl: string,
  options: { reconnectToken: string; sequence: number; columns: number; rows: number },
): string {
  const url = new URL(rawUrl)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') throw new Error('Terminal endpoint is invalid')
  if (url.username || url.password || url.hash) throw new Error('Terminal endpoint is invalid')
  if (url.protocol === 'ws:' && !isLoopbackHost(url.hostname)) {
    throw new Error('Terminal endpoint must use a secure WebSocket')
  }
  if (options.reconnectToken && !isReconnectToken(options.reconnectToken)) {
    throw new Error('Terminal reconnect token is invalid')
  }
  const size = normalizeTerminalSize(options.columns, options.rows)
  url.searchParams.delete('reconnect')
  url.searchParams.delete('since')
  url.searchParams.set('cols', String(size.columns))
  url.searchParams.set('rows', String(size.rows))
  if (options.reconnectToken) url.searchParams.set('reconnect', options.reconnectToken)
  if (isUint32(options.sequence) && options.sequence > 0) url.searchParams.set('since', String(options.sequence))
  return url.toString()
}

export function terminalTicketProtocol(ticket: string): string {
  const protocol = `tengri.ticket.${ticket}`
  if (ticket.length < 16 || ticket.length > 2_048 || !RFC_TOKEN.test(protocol)) {
    throw new Error('Terminal ticket is invalid')
  }
  return protocol
}

export function parseTerminalOutputFrame(value: ArrayBuffer | Uint8Array): TerminalOutputFrame | null {
  const frame = value instanceof Uint8Array ? value : new Uint8Array(value)
  if (frame.byteLength < 6 || frame[0] !== OUTPUT_FRAME_TYPE) return null
  const sequence = new DataView(frame.buffer, frame.byteOffset + 1, 4).getUint32(0, false)
  if (sequence === 0) return null
  return { sequence, payload: frame.subarray(5) }
}

export function parseTerminalControlFrame(value: string): TerminalControlFrame | null {
  let candidate: unknown
  try {
    candidate = JSON.parse(value)
  } catch {
    return null
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const control = candidate as Record<string, unknown>
  if (control.type === 'pong') return { type: 'pong' }
  if (control.type === 'error') return { type: 'error', message: terminalPlainText(control.message) }
  if (control.type === 'exit') {
    return { type: 'exit', exitCode: Number.isInteger(control.exitCode) ? Number(control.exitCode) : -1 }
  }
  if (control.type === 'ready') {
    if (typeof control.token !== 'string' || !isReconnectToken(control.token)) return null
    return {
      type: 'ready',
      token: control.token,
      bufferStart: uint32OrZero(control.bufferStart),
      bufferEnd: uint32OrZero(control.bufferEnd),
    }
  }
  if (control.type === 'reset') {
    return {
      type: 'reset',
      reason: terminalPlainText(control.reason),
      bufferStart: uint32OrZero(control.bufferStart),
      bufferEnd: uint32OrZero(control.bufferEnd),
    }
  }
  return null
}

export function parseTerminalResumeState(value: string | null, agentId: string): TerminalResumeState | null {
  if (!value) return null
  let candidate: unknown
  try {
    candidate = JSON.parse(value)
  } catch {
    return null
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const state = candidate as Record<string, unknown>
  if (state.agentId !== agentId || typeof state.sessionId !== 'string' || !SESSION_ID.test(state.sessionId)) return null
  if (typeof state.reconnectToken !== 'string' || (state.reconnectToken && !isReconnectToken(state.reconnectToken))) {
    return null
  }
  if (!isUint32(state.sequence)) return null
  return {
    agentId,
    sessionId: state.sessionId,
    reconnectToken: state.reconnectToken,
    sequence: state.sequence,
  }
}

export function terminalReconnectDelay(attempt: number): number {
  return Math.min(8_000, 400 * 2 ** Math.min(Math.max(0, Math.floor(attempt)), 5))
}

export function terminalPlainText(value: unknown): string {
  if (typeof value !== 'string') return ''
  let result = ''
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    result += codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ? ' ' : character
  }
  return result.trim().slice(0, 512)
}

export function safelyDisposeTerminal(
  terminal: { dispose(): void } | null,
  logger: Pick<typeof console, 'warn'> = console,
): void {
  if (!terminal) return
  try {
    terminal.dispose()
  } catch (cause) {
    logger.warn('[tengri-terminal] terminal dispose failed', cause)
  }
}

function isReconnectToken(value: string): boolean {
  return value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value)
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost')
}

function clampInteger(value: number, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

function isUint32(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= MAX_UINT32
}

function uint32OrZero(value: unknown): number {
  return isUint32(value) ? value : 0
}
