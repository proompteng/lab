import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  deleteTerminalSessionRecord,
  getTerminalSessionRecord,
  listTerminalSessionRecords,
  type TerminalSessionStatus,
  updateTerminalSessionRecord,
  upsertTerminalSessionRecord,
} from '~/server/terminal-sessions-store'

const SESSION_PREFIX = 'jangar-terminal-'
const WORKTREE_DIR_NAME = '.worktrees'
const LOG_DIR = process.env.JANGAR_TERMINAL_LOG_DIR?.trim() || '/tmp/jangar-terminals'
const DEFAULT_BASE_REF = process.env.JANGAR_TERMINAL_BASE_REF?.trim() || 'origin/main'
const FALLBACK_BASE_REF = 'main'
const MAX_WORKTREE_ATTEMPTS = 6
const SESSION_ID_PATTERN = /^jangar-terminal-[a-z0-9-]+$/
const SESSION_LIST_DELIMITER = '|'
const MAIN_FETCH_ENABLED = (process.env.JANGAR_TERMINAL_FETCH_MAIN ?? 'true') !== 'false'
const TMUX_TIMEOUT_MS = 10_000
const FETCH_TIMEOUT_MS = 30_000
const WORKTREE_TIMEOUT_MS = 60_000
const INPUT_FLUSH_MS = 12
const INPUT_BUFFER_MAX = 2048
const TMUX_TMPDIR =
  process.env.JANGAR_TMUX_TMPDIR?.trim() || process.env.TMUX_TMPDIR?.trim() || process.env.TMPDIR?.trim() || '/tmp'
const TMUX_SOCKET_NAME = process.env.JANGAR_TMUX_SOCKET?.trim() || 'default'

type InputQueueState = {
  buffer: string
  timer: ReturnType<typeof setTimeout> | null
  flushing: boolean
}

const inputQueue = new Map<string, InputQueueState>()

export type TerminalSession = {
  id: string
  label: string
  worktreePath: string | null
  worktreeName: string | null
  createdAt: string | null
  attached: boolean
  status: TerminalSessionStatus
  errorMessage: string | null
  readyAt: string | null
  closedAt: string | null
}

type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type CommandOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  label?: string
}

const isErrno = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === 'object' && error !== null && 'code' in error

const resolveRepoRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const resolveCodexBaseCwd = () => {
  const envCwd = process.env.CODEX_CWD?.trim()
  if (envCwd) return envCwd
  return process.env.NODE_ENV === 'production' ? '/workspace/lab' : resolveRepoRoot()
}

const resolveWorktreeRoot = () => join(resolveCodexBaseCwd(), WORKTREE_DIR_NAME)

const readProcessText = async (stream: ReadableStream | null) => {
  if (!stream) return ''
  return new Response(stream).text()
}

const runCommand = async (args: string[], options: CommandOptions = {}): Promise<CommandResult> => {
  const bunRuntime = (globalThis as { Bun?: typeof Bun }).Bun
  if (bunRuntime) {
    const process = bunRuntime.spawn(args, {
      cwd: options.cwd,
      env: options.env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    let timedOut = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    if (options.timeoutMs && Number.isFinite(options.timeoutMs)) {
      timeout = setTimeout(() => {
        timedOut = true
        try {
          process.kill()
        } catch {
          // ignore
        }
      }, options.timeoutMs)
    }
    const stdoutPromise = readProcessText(process.stdout)
    const stderrPromise = readProcessText(process.stderr)
    const exitCode = await process.exited
    if (timeout) clearTimeout(timeout)
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    if (timedOut) {
      const label = options.label ?? args[0]
      const message = `${label} timed out after ${options.timeoutMs}ms`
      return { exitCode: 124, stdout, stderr: stderr ? `${stderr}\n${message}` : message }
    }
    return { exitCode: exitCode ?? 1, stdout, stderr }
  }

  return new Promise((resolvePromise) => {
    const child = spawn(args[0], args.slice(1), { cwd: options.cwd, env: options.env })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    if (options.timeoutMs && Number.isFinite(options.timeoutMs)) {
      timeout = setTimeout(() => {
        timedOut = true
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
      }, options.timeoutMs)
    }
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      if (timeout) clearTimeout(timeout)
      resolvePromise({ exitCode: 1, stdout: '', stderr: error.message })
    })
    child.on('close', (exitCode) => {
      if (timeout) clearTimeout(timeout)
      if (timedOut) {
        const label = options.label ?? args[0]
        const message = `${label} timed out after ${options.timeoutMs}ms`
        resolvePromise({ exitCode: 124, stdout, stderr: stderr ? `${stderr}\n${message}` : message })
        return
      }
      resolvePromise({ exitCode: exitCode ?? 1, stdout, stderr })
    })
  })
}

const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' })

const runGit = async (args: string[], cwd?: string, options?: CommandOptions) =>
  runCommand(['git', ...args], { cwd, env: gitEnv(), ...options })

const ensureTmuxTmpDir = async () => {
  await mkdir(TMUX_TMPDIR, { recursive: true })
}

const runTmux = async (args: string[], options: CommandOptions = {}) => {
  await ensureTmuxTmpDir()
  const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR }
  delete env.TMUX
  delete env.TMUX_PANE
  return runCommand(['tmux', '-L', TMUX_SOCKET_NAME, ...args], {
    env,
    timeoutMs: options.timeoutMs ?? TMUX_TIMEOUT_MS,
    label: options.label ?? 'tmux',
  })
}

const ensureLogDir = async () => {
  await mkdir(LOG_DIR, { recursive: true })
}

const ensureLogFile = async (path: string) => {
  await ensureLogDir()
  const handle = await open(path, 'a')
  await handle.close()
}

const clearInputQueue = (sessionId: string) => {
  const state = inputQueue.get(sessionId)
  if (state?.timer) clearTimeout(state.timer)
  inputQueue.delete(sessionId)
}

const flushInputQueue = async (sessionId: string) => {
  const state = inputQueue.get(sessionId)
  if (!state || state.flushing) return
  if (!state.buffer) {
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    return
  }

  state.flushing = true
  const payload = state.buffer
  state.buffer = ''

  try {
    await sendInputToTmux(sessionId, payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to send input to tmux'
    console.warn('[terminals] input flush failed', { sessionId, message })
  } finally {
    state.flushing = false
  }

  if (state.buffer) {
    state.timer = setTimeout(() => {
      state.timer = null
      void flushInputQueue(sessionId)
    }, INPUT_FLUSH_MS)
  }
}

const buildSessionId = (suffix: string) => `${SESSION_PREFIX}${suffix}`

const buildWorktreeName = (suffix: string) => `term-${suffix}`

const buildWorktreePath = (worktreeName: string) => join(resolveWorktreeRoot(), worktreeName)

const normalizeSuffix = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]/g, '-')

const generateSuffix = () => normalizeSuffix(randomUUID().slice(0, 8))

const isSafeWorktreePath = (worktreePath: string | null, worktreeName: string | null) => {
  if (!worktreePath || !worktreeName) return false
  const root = resolveWorktreeRoot()
  const resolved = resolve(worktreePath)
  if (!resolved.startsWith(`${root}${sep}`)) return false
  return resolved.endsWith(`${sep}${worktreeName}`)
}

const shouldSkipGitWorktree = () => {
  if (process.env.NODE_ENV === 'test') return true
  return typeof (globalThis as { Bun?: unknown }).Bun === 'undefined'
}

const ensureBaseRef = async (repoRoot: string) => {
  if (MAIN_FETCH_ENABLED) {
    const fetchResult = await runGit(['fetch', '--no-tags', '--prune', 'origin', 'main'], repoRoot, {
      timeoutMs: FETCH_TIMEOUT_MS,
      label: 'git fetch origin main',
    })
    if (fetchResult.exitCode !== 0) {
      console.warn('[terminals] git fetch origin main failed', fetchResult.stderr.trim())
    }
  }

  const preferred = await runGit(['rev-parse', '--verify', DEFAULT_BASE_REF], repoRoot, {
    timeoutMs: FETCH_TIMEOUT_MS,
    label: 'git rev-parse preferred',
  })
  if (preferred.exitCode === 0) return DEFAULT_BASE_REF

  const fallback = await runGit(['rev-parse', '--verify', FALLBACK_BASE_REF], repoRoot, {
    timeoutMs: FETCH_TIMEOUT_MS,
    label: 'git rev-parse fallback',
  })
  if (fallback.exitCode === 0) return FALLBACK_BASE_REF

  throw new Error('Unable to resolve main ref for terminal worktree. Set JANGAR_TERMINAL_BASE_REF.')
}

const createWorktreeAtPath = async (worktreeName: string, worktreePath: string, baseRef: string, repoRoot: string) => {
  if (existsSync(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`)
  }

  const result = await runGit(
    ['worktree', 'add', '--quiet', '--no-checkout', '--detach', worktreePath, baseRef],
    repoRoot,
    { timeoutMs: WORKTREE_TIMEOUT_MS, label: 'git worktree add' },
  )
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
    throw new Error(detail || 'Unable to add worktree')
  }

  const checkout = await runGit(['checkout', '--detach', '--force', baseRef], worktreePath, {
    timeoutMs: WORKTREE_TIMEOUT_MS,
    label: 'git checkout worktree',
  })
  if (checkout.exitCode !== 0) {
    const detail = [checkout.stdout.trim(), checkout.stderr.trim()].filter(Boolean).join('\n')
    throw new Error(detail || 'Unable to checkout worktree')
  }

  return { worktreeName, worktreePath, baseRef }
}

const createFreshWorktree = async () => {
  const repoRoot = resolveCodexBaseCwd()
  const worktreeRoot = resolveWorktreeRoot()
  await mkdir(worktreeRoot, { recursive: true })

  const baseRef = await ensureBaseRef(repoRoot)

  for (let attempt = 0; attempt < MAX_WORKTREE_ATTEMPTS; attempt += 1) {
    const suffix = generateSuffix()
    const worktreeName = buildWorktreeName(suffix)
    const worktreePath = join(worktreeRoot, worktreeName)

    if (existsSync(worktreePath)) continue

    if (shouldSkipGitWorktree()) {
      await mkdir(worktreePath, { recursive: true })
      return { worktreeName, worktreePath, baseRef }
    }

    try {
      const created = await createWorktreeAtPath(worktreeName, worktreePath, baseRef, repoRoot)
      return created
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.warn('[terminals] git worktree add failed', { worktreeName, detail })
    }
  }

  throw new Error('Unable to allocate a new terminal worktree.')
}

type TmuxSessionInfo = {
  id: string
  worktreePath: string | null
  worktreeName: string | null
  createdAt: string | null
  attached: boolean
}

const parseSessionLine = (line: string): TmuxSessionInfo | null => {
  const [name, createdRaw, attachedRaw, sessionPath] = line.split(SESSION_LIST_DELIMITER)
  if (!name?.startsWith(SESSION_PREFIX)) return null

  const created = Number.parseInt(createdRaw ?? '', 10)
  const createdAt = Number.isFinite(created) ? new Date(created * 1000).toISOString() : null
  const attached = attachedRaw === '1'
  const worktreeRoot = resolveWorktreeRoot()
  const normalizedPath = sessionPath || null
  let worktreeName: string | null = null

  if (normalizedPath?.startsWith(worktreeRoot)) {
    const relativePath = relative(worktreeRoot, normalizedPath)
    const [segment] = relativePath.split(sep)
    worktreeName = segment || null
  }

  return {
    id: name,
    worktreePath: normalizedPath,
    worktreeName,
    createdAt,
    attached,
  }
}

const listTmuxSessions = async (): Promise<TmuxSessionInfo[]> => {
  const result = await runTmux([
    'list-sessions',
    '-F',
    `#{session_name}${SESSION_LIST_DELIMITER}#{session_created}${SESSION_LIST_DELIMITER}#{session_attached}${SESSION_LIST_DELIMITER}#{session_path}`,
  ])
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toLowerCase()
    if (
      stderr.includes('no server running') ||
      stderr.includes('no sessions') ||
      stderr.includes('error connecting') ||
      stderr.includes('failed to connect') ||
      stderr.includes('no such file or directory')
    ) {
      console.info('[terminals] tmux server unavailable', { stderr: result.stderr.trim(), socket: TMUX_SOCKET_NAME })
      return []
    }
    throw new Error(result.stderr.trim() || 'Unable to list tmux sessions')
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseSessionLine(line))
    .filter((item): item is TmuxSessionInfo => Boolean(item))
}

const buildTerminalSession = (input: {
  id: string
  worktreeName: string | null
  worktreePath: string | null
  createdAt: string | null
  attached: boolean
  status: TerminalSessionStatus
  errorMessage: string | null
  readyAt: string | null
  closedAt: string | null
}): TerminalSession => ({
  id: input.id,
  label: input.worktreeName ?? input.id,
  worktreePath: input.worktreePath,
  worktreeName: input.worktreeName,
  createdAt: input.createdAt,
  attached: input.attached,
  status: input.status,
  errorMessage: input.errorMessage,
  readyAt: input.readyAt,
  closedAt: input.closedAt,
})

const reconcileRecordStatus = async (
  record: {
    id: string
    status: TerminalSessionStatus
    errorMessage: string | null
    readyAt: string | null
    closedAt: string | null
    worktreeName: string | null
    worktreePath: string | null
    createdAt: string
    updatedAt: string
    metadata: Record<string, unknown>
  },
  tmuxSession: TmuxSessionInfo | null,
) => {
  if (tmuxSession && record.status !== 'ready') {
    const readyAt = record.readyAt ?? new Date().toISOString()
    const updated = await updateTerminalSessionRecord(record.id, {
      status: 'ready',
      worktreeName: record.worktreeName,
      worktreePath: record.worktreePath,
      tmuxSocket: TMUX_SOCKET_NAME,
      errorMessage: null,
      readyAt,
      closedAt: null,
      metadata: record.metadata,
    })
    return updated ?? record
  }

  if (!tmuxSession && record.status === 'ready') {
    const updated = await updateTerminalSessionRecord(record.id, {
      status: 'closed',
      worktreeName: record.worktreeName,
      worktreePath: record.worktreePath,
      tmuxSocket: TMUX_SOCKET_NAME,
      errorMessage: record.errorMessage ?? 'tmux session missing',
      readyAt: record.readyAt,
      closedAt: record.closedAt ?? new Date().toISOString(),
      metadata: record.metadata,
    })
    return updated ?? record
  }

  if (!tmuxSession && record.status === 'error' && record.readyAt) {
    const updated = await updateTerminalSessionRecord(record.id, {
      status: 'closed',
      worktreeName: record.worktreeName,
      worktreePath: record.worktreePath,
      tmuxSocket: TMUX_SOCKET_NAME,
      errorMessage: record.errorMessage ?? 'tmux session missing',
      readyAt: record.readyAt,
      closedAt: record.closedAt ?? new Date().toISOString(),
      metadata: record.metadata,
    })
    return updated ?? record
  }

  return record
}

export const listTerminalSessions = async (options: { includeClosed?: boolean } = {}): Promise<TerminalSession[]> => {
  const [tmuxSessions, records] = await Promise.all([listTmuxSessions(), listTerminalSessionRecords()])
  const tmuxMap = new Map(tmuxSessions.map((session) => [session.id, session]))
  const recordIds = new Set(records.map((record) => record.id))
  const sessions: TerminalSession[] = []

  for (const record of records) {
    const tmuxSession = tmuxMap.get(record.id) ?? null
    const reconciled = await reconcileRecordStatus(record, tmuxSession)
    const attached = tmuxSession?.attached ?? false
    const createdAt = reconciled.createdAt ?? tmuxSession?.createdAt ?? null
    sessions.push(
      buildTerminalSession({
        id: reconciled.id,
        worktreeName: reconciled.worktreeName ?? tmuxSession?.worktreeName ?? null,
        worktreePath: reconciled.worktreePath ?? tmuxSession?.worktreePath ?? null,
        createdAt,
        attached,
        status: reconciled.status,
        errorMessage: reconciled.errorMessage,
        readyAt: reconciled.readyAt,
        closedAt: reconciled.closedAt,
      }),
    )
  }

  for (const tmuxSession of tmuxSessions) {
    if (recordIds.has(tmuxSession.id)) continue
    sessions.push(
      buildTerminalSession({
        id: tmuxSession.id,
        worktreeName: tmuxSession.worktreeName,
        worktreePath: tmuxSession.worktreePath,
        createdAt: tmuxSession.createdAt,
        attached: tmuxSession.attached,
        status: 'ready',
        errorMessage: null,
        readyAt: tmuxSession.createdAt,
        closedAt: null,
      }),
    )
  }

  const ordered = sessions.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  if (options.includeClosed) return ordered
  return ordered.filter((session) => session.status !== 'closed')
}

export const getTerminalSession = async (sessionId: string): Promise<TerminalSession | null> => {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null
  const [tmuxSessions, record] = await Promise.all([listTmuxSessions(), getTerminalSessionRecord(sessionId)])
  const tmuxSession = tmuxSessions.find((session) => session.id === sessionId) ?? null
  if (record) {
    const reconciled = await reconcileRecordStatus(record, tmuxSession)
    return buildTerminalSession({
      id: reconciled.id,
      worktreeName: reconciled.worktreeName ?? tmuxSession?.worktreeName ?? null,
      worktreePath: reconciled.worktreePath ?? tmuxSession?.worktreePath ?? null,
      createdAt: reconciled.createdAt ?? tmuxSession?.createdAt ?? null,
      attached: tmuxSession?.attached ?? false,
      status: reconciled.status,
      errorMessage: reconciled.errorMessage,
      readyAt: reconciled.readyAt,
      closedAt: reconciled.closedAt,
    })
  }
  if (!tmuxSession) return null
  return buildTerminalSession({
    id: tmuxSession.id,
    worktreeName: tmuxSession.worktreeName,
    worktreePath: tmuxSession.worktreePath,
    createdAt: tmuxSession.createdAt,
    attached: tmuxSession.attached,
    status: 'ready',
    errorMessage: null,
    readyAt: tmuxSession.createdAt,
    closedAt: null,
  })
}

type PlannedSession = {
  sessionId: string
  worktreeName: string
  worktreePath: string
}

const allocateTerminalSession = async (): Promise<PlannedSession> => {
  for (let attempt = 0; attempt < MAX_WORKTREE_ATTEMPTS; attempt += 1) {
    const suffix = generateSuffix()
    const worktreeName = buildWorktreeName(suffix)
    const sessionId = buildSessionId(worktreeName)
    const worktreePath = buildWorktreePath(worktreeName)
    if (existsSync(worktreePath)) continue
    const existing = await getTerminalSessionRecord(sessionId)
    if (existing) continue
    return { sessionId, worktreeName, worktreePath }
  }
  throw new Error('Unable to allocate a new terminal session id.')
}

const startTmuxSession = async (sessionId: string, worktreeName: string, worktreePath: string, baseRef: string) => {
  console.info('[terminals] creating tmux session', {
    sessionId,
    worktreePath,
    baseRef,
    tmuxTmpDir: TMUX_TMPDIR,
    tmuxSocket: TMUX_SOCKET_NAME,
  })

  const tmuxCreate = await runTmux(['new-session', '-d', '-s', sessionId, '-c', worktreePath], {
    label: 'tmux new-session',
  })
  if (tmuxCreate.exitCode !== 0) {
    const detail = [tmuxCreate.stdout.trim(), tmuxCreate.stderr.trim()].filter(Boolean).join('\n')
    console.warn('[terminals] tmux new-session failed', { sessionId, detail })
    throw new Error(detail || 'Unable to start tmux session')
  }

  await runTmux(['set-environment', '-t', sessionId, 'JANGAR_WORKTREE_NAME', worktreeName], {
    label: 'tmux set-environment worktree name',
  })
  await runTmux(['set-environment', '-t', sessionId, 'JANGAR_WORKTREE_PATH', worktreePath], {
    label: 'tmux set-environment worktree path',
  })

  await ensureTerminalLogPipe(sessionId)

  console.info('[terminals] tmux session ready', { sessionId, worktreePath })
}

const recordSessionStatus = async (
  sessionId: string,
  status: TerminalSessionStatus,
  details: {
    worktreeName?: string | null
    worktreePath?: string | null
    errorMessage?: string | null
    readyAt?: string | null
    closedAt?: string | null
    metadata?: Record<string, unknown>
  } = {},
) => {
  const record = await upsertTerminalSessionRecord({
    id: sessionId,
    status,
    worktreeName: details.worktreeName ?? null,
    worktreePath: details.worktreePath ?? null,
    tmuxSocket: TMUX_SOCKET_NAME,
    errorMessage: details.errorMessage ?? null,
    readyAt: details.readyAt ?? null,
    closedAt: details.closedAt ?? null,
    metadata: details.metadata ?? {},
  })
  if (record) {
    console.info('[terminals] session status updated', {
      sessionId,
      status: record.status,
      worktreePath: record.worktreePath,
    })
  }
  return record
}

export const markTerminalSessionError = async (sessionId: string, message: string) => {
  const record = await getTerminalSessionRecord(sessionId)
  if (!record || record.status === 'closed') return null
  return updateTerminalSessionRecord(sessionId, {
    status: 'error',
    worktreeName: record.worktreeName,
    worktreePath: record.worktreePath,
    tmuxSocket: TMUX_SOCKET_NAME,
    errorMessage: message,
    readyAt: record.readyAt,
    closedAt: record.closedAt,
    metadata: record.metadata,
  })
}

const provisionTerminalSession = async ({ sessionId, worktreeName, worktreePath }: PlannedSession) => {
  try {
    const repoRoot = resolveCodexBaseCwd()
    const baseRef = await ensureBaseRef(repoRoot)
    await mkdir(resolveWorktreeRoot(), { recursive: true })
    await createWorktreeAtPath(worktreeName, worktreePath, baseRef, repoRoot)
    await startTmuxSession(sessionId, worktreeName, worktreePath, baseRef)
    await recordSessionStatus(sessionId, 'ready', {
      worktreeName,
      worktreePath,
      errorMessage: null,
      readyAt: new Date().toISOString(),
      closedAt: null,
      metadata: { baseRef },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[terminals] session provisioning failed', { sessionId, message })
    await recordSessionStatus(sessionId, 'error', {
      worktreeName,
      worktreePath,
      errorMessage: message,
    })
  }
}

const createTerminalSessionImmediate = async (): Promise<TerminalSession> => {
  const { worktreeName, worktreePath, baseRef } = await createFreshWorktree()
  const sessionId = buildSessionId(worktreeName)
  await startTmuxSession(sessionId, worktreeName, worktreePath, baseRef)
  const record = await recordSessionStatus(sessionId, 'ready', {
    worktreeName,
    worktreePath,
    readyAt: new Date().toISOString(),
    metadata: { baseRef },
  })
  return buildTerminalSession({
    id: sessionId,
    worktreeName,
    worktreePath,
    createdAt: record?.createdAt ?? new Date().toISOString(),
    attached: false,
    status: record?.status ?? 'ready',
    errorMessage: record?.errorMessage ?? null,
    readyAt: record?.readyAt ?? new Date().toISOString(),
    closedAt: record?.closedAt ?? null,
  })
}

export const createTerminalSession = async (): Promise<TerminalSession> => {
  const planned = await allocateTerminalSession()
  const record = await recordSessionStatus(planned.sessionId, 'creating', {
    worktreeName: planned.worktreeName,
    worktreePath: planned.worktreePath,
  })

  if (!record) {
    return createTerminalSessionImmediate()
  }

  queueMicrotask(() => {
    console.info('[terminals] provisioning queued', { sessionId: planned.sessionId })
    void provisionTerminalSession(planned)
  })

  return buildTerminalSession({
    id: record.id,
    worktreeName: record.worktreeName,
    worktreePath: record.worktreePath,
    createdAt: record.createdAt,
    attached: false,
    status: record.status,
    errorMessage: record.errorMessage,
    readyAt: record.readyAt,
    closedAt: record.closedAt,
  })
}

export const ensureTerminalLogPipe = async (sessionId: string): Promise<string> => {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid terminal session id')
  const logPath = join(LOG_DIR, `${sessionId}.log`)
  await ensureLogFile(logPath)
  const pipeCommand = `cat >> ${logPath}`
  const result = await runTmux(['pipe-pane', '-t', sessionId, pipeCommand], {
    label: 'tmux pipe-pane',
  })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || 'Unable to attach tmux log pipe')
  }
  return logPath
}

export const captureTerminalSnapshot = async (sessionId: string, lines = 2000): Promise<string> => {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid terminal session id')
  const result = await runTmux(['capture-pane', '-ep', '-S', `-${lines}`, '-t', sessionId])
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || 'Unable to capture tmux pane')
  }
  return result.stdout
}

export const ensureTerminalSessionExists = async (sessionId: string): Promise<boolean> => {
  if (!SESSION_ID_PATTERN.test(sessionId)) return false
  const record = await getTerminalSessionRecord(sessionId)
  if (record && record.status === 'creating') return false
  const result = await runTmux(['has-session', '-t', sessionId], { label: 'tmux has-session' })
  if (result.exitCode === 0) return true
  const stderr = result.stderr.toLowerCase()
  if (stderr.includes('error connecting') || stderr.includes('failed to connect')) {
    console.warn('[terminals] tmux has-session failed', { sessionId, stderr: result.stderr.trim() })
  }
  if (record && record.status === 'ready') {
    await updateTerminalSessionRecord(sessionId, {
      status: 'error',
      worktreeName: record.worktreeName,
      worktreePath: record.worktreePath,
      tmuxSocket: TMUX_SOCKET_NAME,
      errorMessage: record.errorMessage ?? 'tmux session missing',
      readyAt: record.readyAt,
      closedAt: record.closedAt ?? new Date().toISOString(),
      metadata: record.metadata,
    })
  }
  return false
}

export const terminateTerminalSession = async (sessionId: string) => {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid terminal session id')
  const record = await getTerminalSessionRecord(sessionId)
  const hasSession = await runTmux(['has-session', '-t', sessionId], { label: 'tmux has-session' })

  if (hasSession.exitCode === 0) {
    const killResult = await runTmux(['kill-session', '-t', sessionId], { label: 'tmux kill-session' })
    if (killResult.exitCode !== 0) {
      const detail = [killResult.stdout.trim(), killResult.stderr.trim()].filter(Boolean).join('\n')
      throw new Error(detail || 'Unable to terminate tmux session')
    }
  }

  clearInputQueue(sessionId)

  await upsertTerminalSessionRecord({
    id: sessionId,
    status: 'closed',
    worktreeName: record?.worktreeName ?? null,
    worktreePath: record?.worktreePath ?? null,
    tmuxSocket: TMUX_SOCKET_NAME,
    errorMessage: null,
    readyAt: record?.readyAt ?? null,
    closedAt: new Date().toISOString(),
    metadata: record?.metadata ?? {},
  })
}

export const deleteTerminalSession = async (sessionId: string) => {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid terminal session id')

  const record = await getTerminalSessionRecord(sessionId)
  const hasSession = await runTmux(['has-session', '-t', sessionId], { label: 'tmux has-session' })
  if (hasSession.exitCode === 0) {
    throw new Error('Session is still running. Terminate it before deleting.')
  }

  if (record?.worktreePath && isSafeWorktreePath(record.worktreePath, record.worktreeName)) {
    const repoRoot = resolveCodexBaseCwd()
    const removeResult = await runGit(['worktree', 'remove', '--force', record.worktreePath], repoRoot, {
      timeoutMs: WORKTREE_TIMEOUT_MS,
      label: 'git worktree remove',
    })
    if (removeResult.exitCode !== 0) {
      console.warn('[terminals] git worktree remove failed', {
        sessionId,
        stderr: removeResult.stderr.trim(),
      })
      await rm(record.worktreePath, { recursive: true, force: true })
    }
  }

  await rm(join(LOG_DIR, `${sessionId}.log`), { force: true })
  await deleteTerminalSessionRecord(sessionId)
  clearInputQueue(sessionId)
}

const sendInputToTmux = async (sessionId: string, input: string) => {
  if (!input) return
  const result = await runTmux(['send-keys', '-t', sessionId, '-l', '--', input], { label: 'tmux send-keys' })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || 'Unable to send input to tmux')
  }
}

export const sendTerminalInput = async (sessionId: string, input: string) => {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid terminal session id')
  await sendInputToTmux(sessionId, input)
}

export const queueTerminalInput = (sessionId: string, input: string) => {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid terminal session id')
  if (!input) return
  const state = inputQueue.get(sessionId) ?? { buffer: '', timer: null, flushing: false }
  state.buffer += input
  inputQueue.set(sessionId, state)

  if (state.buffer.length >= INPUT_BUFFER_MAX) {
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    void flushInputQueue(sessionId)
    return
  }

  if (!state.timer) {
    state.timer = setTimeout(() => {
      state.timer = null
      void flushInputQueue(sessionId)
    }, INPUT_FLUSH_MS)
  }
}

export const resizeTerminalSession = async (sessionId: string, cols: number, rows: number) => {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid terminal session id')
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
  const safeCols = Math.max(20, Math.min(400, Math.round(cols)))
  const safeRows = Math.max(6, Math.min(200, Math.round(rows)))
  await runTmux(['resize-window', '-t', sessionId, '-x', `${safeCols}`, '-y', `${safeRows}`], {
    label: 'tmux resize-window',
  })
}

export const getTerminalLogPath = async (sessionId: string) => {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid terminal session id')
  const logPath = join(LOG_DIR, `${sessionId}.log`)
  const existing = await stat(logPath).catch((error) => {
    if (isErrno(error) && error.code === 'ENOENT') return null
    throw error
  })
  if (!existing) {
    await ensureLogFile(logPath)
  }
  return logPath
}

export const formatSessionId = (raw: string) => raw.trim()

export const isTerminalSessionId = (raw: string) => SESSION_ID_PATTERN.test(raw.trim())
