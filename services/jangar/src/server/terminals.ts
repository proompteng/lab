import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LOCK_RETRY_ATTEMPTS,
  LOCK_RETRY_DELAY_MS,
  LOCK_STALE_MS,
  runGitWithLockRecovery,
} from '~/server/git-lock-recovery'
import { withWorktreeLock } from '~/server/git-worktree-lock'
import {
  fetchTerminalBackend,
  fetchTerminalBackendJson,
  isTerminalBackendProxyEnabled,
} from '~/server/terminal-backend'
import { getTerminalPtyManager } from '~/server/terminal-pty-manager'
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
const DEFAULT_BASE_REF = process.env.JANGAR_TERMINAL_BASE_REF?.trim() || 'origin/main'
const FALLBACK_BASE_REF = 'main'
const MAX_WORKTREE_ATTEMPTS = 6
const SESSION_ID_PATTERN = /^jangar-terminal-[a-z0-9-]+$/
const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const MAIN_FETCH_ENABLED = (process.env.JANGAR_TERMINAL_FETCH_MAIN ?? 'true') !== 'false'
const FETCH_TIMEOUT_MS = 30_000
const WORKTREE_TIMEOUT_MS = parseNumber(process.env.JANGAR_TERMINAL_WORKTREE_TIMEOUT_MS, 180_000)
const REUSE_REFRESH_TIMEOUT_MS = 15_000
const DEFER_WORKTREE_CHECKOUT = (process.env.JANGAR_TERMINAL_DEFER_CHECKOUT ?? 'true') !== 'false'
const DEFAULT_BUFFER_BYTES = 4 * 1024 * 1024
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000

const bufferBytes = parseNumber(process.env.JANGAR_TERMINAL_BUFFER_BYTES, DEFAULT_BUFFER_BYTES)
const idleTimeoutMs = parseNumber(process.env.JANGAR_TERMINAL_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS)
const publicTerminalUrl = process.env.JANGAR_TERMINAL_PUBLIC_URL?.trim() || null

const resolveRepoRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const resolveCodexBaseCwd = () => {
  const envCwd = process.env.CODEX_CWD?.trim()
  if (envCwd) return envCwd
  return process.env.NODE_ENV === 'production' ? '/workspace/lab' : resolveRepoRoot()
}

const resolveWorktreeRoot = () => join(resolveCodexBaseCwd(), WORKTREE_DIR_NAME)

const runGitWithRecovery = async (
  args: string[],
  cwd: string,
  options: CommandOptions & { worktreeName?: string; worktreePath?: string },
) =>
  runGitWithLockRecovery((gitArgs, gitCwd) => runGit(gitArgs, gitCwd, options), args, cwd, {
    repoRoot: resolveCodexBaseCwd(),
    worktreeName: options.worktreeName ?? null,
    worktreePath: options.worktreePath ?? null,
    label: options.label,
    staleMs: LOCK_STALE_MS,
    attempts: LOCK_RETRY_ATTEMPTS,
    delayMs: LOCK_RETRY_DELAY_MS,
  })

const readProcessText = async (stream: ReadableStream<Uint8Array> | null, signal?: AbortSignal) => {
  if (!stream) return ''
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let result = ''
  const onAbort = () => {
    void reader.cancel()
  }
  if (signal) {
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value || value.length === 0) continue
      result += decoder.decode(value, { stream: true })
    }
  } catch {
    // ignore
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
    result += decoder.decode()
  }
  return result
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
    const abortController = new AbortController()
    const stdoutPromise = readProcessText(process.stdout, abortController.signal)
    const stderrPromise = readProcessText(process.stderr, abortController.signal)
    const exitPromise = process.exited.then((exitCode) => {
      abortController.abort()
      return exitCode ?? 1
    })

    let exitCode: number | null
    if (options.timeoutMs && Number.isFinite(options.timeoutMs)) {
      exitCode = await Promise.race([
        exitPromise,
        new Promise<number | null>((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true
            try {
              process.kill('SIGKILL')
            } catch {
              // ignore
            }
            abortController.abort()
            resolve(null)
          }, options.timeoutMs)
        }),
      ])
    } else {
      exitCode = await exitPromise
    }

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

const generateSuffix = () => randomUUID().slice(0, 8)

const buildWorktreeName = (suffix: string) => `codex-${suffix}`

const buildSessionId = (worktreeName: string) => `${SESSION_PREFIX}${worktreeName}`

const buildWorktreePath = (worktreeName: string) => join(resolveWorktreeRoot(), worktreeName)

const queueWorktreeCheckout = (
  worktreePath: string,
  baseRef: string,
  sessionId?: string,
  worktreeName?: string | null,
) => {
  if (!DEFER_WORKTREE_CHECKOUT) return
  queueMicrotask(() => {
    void withWorktreeLock(async () => {
      const result = await runGitWithRecovery(['checkout', '--detach', '--force', baseRef], worktreePath, {
        timeoutMs: WORKTREE_TIMEOUT_MS,
        label: 'git checkout',
        worktreeName: worktreeName ?? undefined,
        worktreePath,
      })
      if (result.exitCode === 0) return
      console.warn('[terminals] deferred checkout failed', {
        sessionId,
        stderr: result.stderr.trim(),
      })
    })
  })
}

const isCleanReusableWorktree = async (worktreePath: string) => {
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], worktreePath, {
    timeoutMs: FETCH_TIMEOUT_MS,
    label: 'git worktree probe',
  })
  if (inside.exitCode !== 0) return false

  const statusResult = await runGit(['status', '--porcelain'], worktreePath, {
    timeoutMs: FETCH_TIMEOUT_MS,
    label: 'git worktree status',
  })
  if (statusResult.exitCode !== 0) return false
  return statusResult.stdout.trim().length === 0
}

const findReusableSession = async (): Promise<PlannedSession | null> => {
  const records = await listTerminalSessionRecords()
  const manager = getManager()
  const candidates = records.filter((record) => {
    if (record.status !== 'closed' && record.status !== 'error') return false
    if (!record.worktreeName || !record.worktreePath) return false
    if (!isSafeWorktreePath(record.worktreePath, record.worktreeName)) return false
    if (!existsSync(record.worktreePath)) return false
    if (manager?.getSession(record.id)) return false
    return true
  })
  if (candidates.length === 0) return null

  for (const record of candidates) {
    if (!record.worktreePath || !record.worktreeName) continue
    const worktreePath = record.worktreePath
    const worktreeName = record.worktreeName
    const reusable = await isCleanReusableWorktree(worktreePath)
    if (!reusable) continue
    return {
      sessionId: record.id,
      worktreeName,
      worktreePath,
      reuseExisting: true,
    }
  }

  return null
}

const ensureBaseRef = async (repoRoot: string) => {
  const [primary, fallback] = await Promise.all([
    runGit(['rev-parse', '--verify', DEFAULT_BASE_REF], repoRoot, { timeoutMs: FETCH_TIMEOUT_MS }),
    runGit(['rev-parse', '--verify', FALLBACK_BASE_REF], repoRoot, { timeoutMs: FETCH_TIMEOUT_MS }),
  ])
  if (primary.exitCode === 0) return DEFAULT_BASE_REF
  if (fallback.exitCode === 0) return FALLBACK_BASE_REF

  if (!MAIN_FETCH_ENABLED) {
    throw new Error(`Unable to resolve base ref: ${DEFAULT_BASE_REF}`)
  }

  const fetchResult = await runGit(['fetch', '--all', '--prune'], repoRoot, {
    timeoutMs: FETCH_TIMEOUT_MS,
    label: 'git fetch',
  })
  if (fetchResult.exitCode !== 0) {
    throw new Error(fetchResult.stderr.trim() || 'Unable to fetch base ref')
  }

  const afterFetch = await runGit(['rev-parse', '--verify', DEFAULT_BASE_REF], repoRoot, {
    timeoutMs: FETCH_TIMEOUT_MS,
  })
  if (afterFetch.exitCode === 0) return DEFAULT_BASE_REF

  const fallbackAfter = await runGit(['rev-parse', '--verify', FALLBACK_BASE_REF], repoRoot, {
    timeoutMs: FETCH_TIMEOUT_MS,
  })
  if (fallbackAfter.exitCode === 0) return FALLBACK_BASE_REF

  throw new Error(`Unable to resolve base ref: ${DEFAULT_BASE_REF}`)
}

const createWorktreeAtPath = async (worktreeName: string, worktreePath: string, baseRef: string, repoRoot: string) =>
  withWorktreeLock(async () => {
    const args = ['worktree', 'add', '--detach', '--force']
    if (DEFER_WORKTREE_CHECKOUT) {
      args.push('--no-checkout')
    }
    args.push(worktreePath, baseRef)
    const result = await runGitWithRecovery(args, repoRoot, {
      timeoutMs: WORKTREE_TIMEOUT_MS,
      label: 'git worktree add',
      worktreeName,
      worktreePath,
    })
    if (result.exitCode !== 0) {
      const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
      await runGitWithRecovery(['worktree', 'remove', '--force', worktreePath], repoRoot, {
        timeoutMs: WORKTREE_TIMEOUT_MS,
        label: 'git worktree remove',
        worktreeName,
        worktreePath,
      }).catch(() => {})
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {})
      throw new Error(detail || 'Unable to create worktree')
    }

    await runGit(['config', 'user.name', 'Jangar Terminal'], worktreePath)
    await runGit(['config', 'user.email', 'terminal@jangar.local'], worktreePath)

    return { worktreeName, worktreePath }
  })

const createFreshWorktree = async () => {
  const repoRoot = resolveCodexBaseCwd()
  const baseRef = await ensureBaseRef(repoRoot)
  await mkdir(resolveWorktreeRoot(), { recursive: true })

  for (let attempt = 0; attempt < MAX_WORKTREE_ATTEMPTS; attempt += 1) {
    const suffix = generateSuffix()
    const worktreeName = buildWorktreeName(suffix)
    const worktreePath = buildWorktreePath(worktreeName)
    if (existsSync(worktreePath)) continue
    try {
      await createWorktreeAtPath(worktreeName, worktreePath, baseRef, repoRoot)
      return { worktreeName, worktreePath, baseRef }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.warn('[terminals] worktree create failed', { worktreeName, detail })
    }
  }

  throw new Error('Unable to allocate a new terminal worktree.')
}

const isSafeWorktreePath = (worktreePath: string, worktreeName: string | null) => {
  if (!worktreeName) return false
  const root = resolveWorktreeRoot()
  const rel = relative(root, worktreePath)
  if (!rel || rel.startsWith('..') || rel.includes('..') || rel.includes(`..${sep}`)) return false
  return rel === worktreeName
}

const buildManager = () => {
  if (isTerminalBackendProxyEnabled()) return null
  return getTerminalPtyManager({
    bufferBytes,
    idleTimeoutMs,
    instanceId: process.env.JANGAR_TERMINAL_BACKEND_ID ?? undefined,
    onExit: async (sessionId, detail) => {
      const record = await getTerminalSessionRecord(sessionId)
      if (!record) return
      const message = detail.exitCode === 0 ? null : `Session exited (code ${detail.exitCode ?? 'unknown'})`
      await updateTerminalSessionRecord(sessionId, {
        status: 'closed',
        worktreeName: record.worktreeName,
        worktreePath: record.worktreePath,
        tmuxSocket: record.tmuxSocket,
        errorMessage: message,
        readyAt: record.readyAt,
        closedAt: new Date().toISOString(),
        metadata: record.metadata,
      })
    },
  })
}

const getManager = () => buildManager()

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
  terminalUrl: string | null
  backendId: string | null
  reconnectToken: string | null
}

type PlannedSession = {
  sessionId: string
  worktreeName: string
  worktreePath: string
  reuseExisting?: boolean
  baseRef?: string
}

const getMetadataValue = (metadata: Record<string, unknown> | null | undefined, key: string) => {
  if (!metadata || typeof metadata !== 'object') return null
  const value = metadata[key]
  return typeof value === 'string' ? value : null
}

const ensureReconnectToken = async (record: {
  id: string
  status: TerminalSessionStatus
  worktreeName: string | null
  worktreePath: string | null
  tmuxSocket: string | null
  errorMessage: string | null
  readyAt: string | null
  closedAt: string | null
  metadata: Record<string, unknown>
}) => {
  const existing = getMetadataValue(record.metadata, 'reconnectToken')
  if (existing) return existing
  const token = randomUUID()
  const updated = await updateTerminalSessionRecord(record.id, {
    status: record.status,
    worktreeName: record.worktreeName,
    worktreePath: record.worktreePath,
    tmuxSocket: record.tmuxSocket,
    errorMessage: record.errorMessage,
    readyAt: record.readyAt,
    closedAt: record.closedAt,
    metadata: { ...record.metadata, reconnectToken: token },
  })
  return getMetadataValue(updated?.metadata, 'reconnectToken') ?? token
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
  terminalUrl: string | null
  backendId: string | null
  reconnectToken: string | null
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
  terminalUrl: input.terminalUrl,
  backendId: input.backendId,
  reconnectToken: input.reconnectToken,
})

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
  },
) => {
  const existing = await getTerminalSessionRecord(sessionId)
  const existingMetadata = existing?.metadata ?? {}
  const mergedMetadata = {
    ...existingMetadata,
    ...details.metadata,
  }
  if (!getMetadataValue(mergedMetadata, 'reconnectToken')) {
    mergedMetadata.reconnectToken = getMetadataValue(existingMetadata, 'reconnectToken') ?? randomUUID()
  }
  const record = await upsertTerminalSessionRecord({
    id: sessionId,
    status,
    worktreeName: details.worktreeName ?? null,
    worktreePath: details.worktreePath ?? null,
    tmuxSocket: null,
    errorMessage: details.errorMessage ?? null,
    readyAt: details.readyAt ?? null,
    closedAt: details.closedAt ?? null,
    metadata: mergedMetadata,
  })
  if (record) {
    console.info('[terminals] session status updated', {
      sessionId,
      status: record.status,
      worktreePath: record.worktreePath,
      errorMessage: record.errorMessage,
      closedAt: record.closedAt,
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
    tmuxSocket: record.tmuxSocket,
    errorMessage: message,
    readyAt: record.readyAt,
    closedAt: record.closedAt,
    metadata: record.metadata,
  })
}

const resolveBackendMetadata = () => ({
  backendUrl: publicTerminalUrl,
  backendId: getManager()?.getInstanceId() ?? null,
})

const provisionTerminalSession = async ({
  sessionId,
  worktreeName,
  worktreePath,
  reuseExisting,
  baseRef: plannedBaseRef,
}: PlannedSession) => {
  try {
    const repoRoot = resolveCodexBaseCwd()
    const baseRef = plannedBaseRef ?? (await ensureBaseRef(repoRoot))
    await mkdir(resolveWorktreeRoot(), { recursive: true })
    if (!reuseExisting || !existsSync(worktreePath)) {
      await createWorktreeAtPath(worktreeName, worktreePath, baseRef, repoRoot)
    } else if (!DEFER_WORKTREE_CHECKOUT) {
      const refreshResult = await withWorktreeLock(() =>
        runGitWithRecovery(['checkout', '--detach', '--force', baseRef], worktreePath, {
          timeoutMs: REUSE_REFRESH_TIMEOUT_MS,
          label: 'git checkout',
          worktreeName,
          worktreePath,
        }),
      )
      if (refreshResult.exitCode !== 0) {
        console.warn('[terminals] worktree refresh failed', {
          sessionId,
          stderr: refreshResult.stderr.trim(),
        })
      }
    }
    getManager()?.startSession({ sessionId, worktreePath, worktreeName })
    queueWorktreeCheckout(worktreePath, baseRef, sessionId, worktreeName)
    await recordSessionStatus(sessionId, 'ready', {
      worktreeName,
      worktreePath,
      errorMessage: null,
      readyAt: new Date().toISOString(),
      closedAt: null,
      metadata: { baseRef, ...resolveBackendMetadata() },
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
  getManager()?.startSession({ sessionId, worktreePath, worktreeName })
  queueWorktreeCheckout(worktreePath, baseRef, sessionId, worktreeName)
  const record = await recordSessionStatus(sessionId, 'ready', {
    worktreeName,
    worktreePath,
    readyAt: new Date().toISOString(),
    metadata: { baseRef, ...resolveBackendMetadata() },
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
    terminalUrl: publicTerminalUrl,
    backendId: getManager()?.getInstanceId() ?? null,
    reconnectToken: getMetadataValue(record?.metadata, 'reconnectToken'),
  })
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

export const createTerminalSession = async (): Promise<TerminalSession> => {
  if (isTerminalBackendProxyEnabled()) {
    const payload = await fetchTerminalBackendJson<{ ok: boolean; session: TerminalSession; message?: string }>(
      'api/terminals?create=1',
    )
    if (!payload.ok) {
      throw new Error(payload.message ?? 'Unable to create terminal session')
    }
    return payload.session
  }

  const reusable = await findReusableSession()
  const planned = reusable ?? (await allocateTerminalSession())
  const record = await recordSessionStatus(planned.sessionId, 'creating', {
    worktreeName: planned.worktreeName,
    worktreePath: planned.worktreePath,
    errorMessage: null,
    readyAt: null,
    closedAt: null,
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
    terminalUrl: getMetadataValue(record.metadata, 'backendUrl') ?? publicTerminalUrl,
    backendId: getMetadataValue(record.metadata, 'backendId'),
    reconnectToken: getMetadataValue(record.metadata, 'reconnectToken'),
  })
}

export const listTerminalSessions = async (options: { includeClosed?: boolean } = {}): Promise<TerminalSession[]> => {
  if (isTerminalBackendProxyEnabled()) {
    const query = options.includeClosed ? '?includeClosed=1' : ''
    const payload = await fetchTerminalBackendJson<{
      ok: boolean
      sessions: TerminalSession[]
      message?: string
    }>(`api/terminals${query}`)
    if (!payload.ok) {
      throw new Error(payload.message ?? 'Unable to list terminal sessions')
    }
    return payload.sessions
  }

  const records = await listTerminalSessionRecords()
  const activeSessions = getManager()?.listSessions() ?? []
  const activeMap = new Map(activeSessions.map((session) => [session.id, session]))
  const sessions: TerminalSession[] = []

  for (const record of records) {
    const active = activeMap.get(record.id) ?? null
    let status = record.status
    if (active && status !== 'ready') {
      const updated = await updateTerminalSessionRecord(record.id, {
        status: 'ready',
        worktreeName: record.worktreeName,
        worktreePath: record.worktreePath,
        tmuxSocket: record.tmuxSocket,
        errorMessage: null,
        readyAt: record.readyAt ?? new Date().toISOString(),
        closedAt: null,
        metadata: record.metadata,
      })
      status = updated?.status ?? status
    }
    if (!active && status === 'ready' && getManager()) {
      const fallbackPath = record.worktreePath ?? resolveCodexBaseCwd()
      if (!existsSync(fallbackPath)) {
        const updated = await updateTerminalSessionRecord(record.id, {
          status: 'closed',
          worktreeName: record.worktreeName,
          worktreePath: record.worktreePath,
          tmuxSocket: record.tmuxSocket,
          errorMessage: record.errorMessage ?? `worktree missing: ${fallbackPath}`,
          readyAt: record.readyAt,
          closedAt: record.closedAt ?? new Date().toISOString(),
          metadata: record.metadata,
        })
        status = updated?.status ?? status
      } else {
        try {
          const rebuilt = getManager()?.startSession({
            sessionId: record.id,
            worktreePath: fallbackPath,
            worktreeName: record.worktreeName ?? undefined,
          })
          if (!rebuilt) {
            const updated = await updateTerminalSessionRecord(record.id, {
              status: 'closed',
              worktreeName: record.worktreeName,
              worktreePath: record.worktreePath,
              tmuxSocket: record.tmuxSocket,
              errorMessage: record.errorMessage ?? 'terminal session missing',
              readyAt: record.readyAt,
              closedAt: record.closedAt ?? new Date().toISOString(),
              metadata: record.metadata,
            })
            status = updated?.status ?? status
          } else {
            status = 'ready'
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'terminal session missing'
          const updated = await updateTerminalSessionRecord(record.id, {
            status: 'closed',
            worktreeName: record.worktreeName,
            worktreePath: record.worktreePath,
            tmuxSocket: record.tmuxSocket,
            errorMessage: record.errorMessage ?? message,
            readyAt: record.readyAt,
            closedAt: record.closedAt ?? new Date().toISOString(),
            metadata: record.metadata,
          })
          status = updated?.status ?? status
        }
      }
    }

    const reconnectToken = await ensureReconnectToken(record)

    sessions.push(
      buildTerminalSession({
        id: record.id,
        worktreeName: record.worktreeName,
        worktreePath: record.worktreePath,
        createdAt: record.createdAt,
        attached: active?.attached ?? false,
        status,
        errorMessage: record.errorMessage,
        readyAt: record.readyAt,
        closedAt: record.closedAt,
        terminalUrl: getMetadataValue(record.metadata, 'backendUrl') ?? publicTerminalUrl,
        backendId: getMetadataValue(record.metadata, 'backendId'),
        reconnectToken,
      }),
    )
  }

  const ordered = sessions.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  if (options.includeClosed) return ordered
  return ordered.filter((session) => session.status !== 'closed')
}

export const getTerminalSession = async (sessionId: string): Promise<TerminalSession | null> => {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null
  if (isTerminalBackendProxyEnabled()) {
    const payload = await fetchTerminalBackendJson<{
      ok: boolean
      session?: TerminalSession
      message?: string
    }>(`api/terminals/${encodeURIComponent(sessionId)}`)
    if (!payload.ok) {
      throw new Error(payload.message ?? 'Unable to load terminal session')
    }
    return payload.session ?? null
  }
  const record = await getTerminalSessionRecord(sessionId)
  if (!record) return null
  const manager = getManager()
  let active = manager?.getSession(sessionId) ?? null
  let reconciled = record
  let status = record.status

  if (active && status !== 'ready') {
    const updated = await updateTerminalSessionRecord(record.id, {
      status: 'ready',
      worktreeName: record.worktreeName,
      worktreePath: record.worktreePath,
      tmuxSocket: record.tmuxSocket,
      errorMessage: null,
      readyAt: record.readyAt ?? new Date().toISOString(),
      closedAt: null,
      metadata: record.metadata,
    })
    reconciled = updated ?? reconciled
    status = reconciled.status
  }

  if (!active && status === 'ready' && manager) {
    const rebuilt = manager.startSession({
      sessionId: record.id,
      worktreePath: record.worktreePath ?? resolveCodexBaseCwd(),
      worktreeName: record.worktreeName ?? undefined,
    })
    if (!rebuilt) {
      const updated = await updateTerminalSessionRecord(record.id, {
        status: 'closed',
        worktreeName: record.worktreeName,
        worktreePath: record.worktreePath,
        tmuxSocket: record.tmuxSocket,
        errorMessage: record.errorMessage ?? 'terminal session missing',
        readyAt: record.readyAt,
        closedAt: record.closedAt ?? new Date().toISOString(),
        metadata: record.metadata,
      })
      reconciled = updated ?? reconciled
      status = reconciled.status
    } else {
      active = rebuilt
      status = 'ready'
    }
  }

  const attached = active ? active.connections.size > 0 : false
  const reconnectToken = await ensureReconnectToken(reconciled)
  return buildTerminalSession({
    id: reconciled.id,
    worktreeName: reconciled.worktreeName,
    worktreePath: reconciled.worktreePath,
    createdAt: reconciled.createdAt,
    attached,
    status,
    errorMessage: reconciled.errorMessage,
    readyAt: reconciled.readyAt,
    closedAt: reconciled.closedAt,
    terminalUrl: getMetadataValue(reconciled.metadata, 'backendUrl') ?? publicTerminalUrl,
    backendId: getMetadataValue(reconciled.metadata, 'backendId'),
    reconnectToken,
  })
}

export const ensureTerminalSessionExists = async (sessionId: string): Promise<boolean> => {
  if (!SESSION_ID_PATTERN.test(sessionId)) return false
  const record = await getTerminalSessionRecord(sessionId)
  if (record && record.status === 'creating') return false
  const manager = getManager()
  if (!manager) return false
  const runtime = manager.getSession(sessionId)
  if (runtime) return true
  if (record && record.status === 'ready') {
    const worktreePath = record.worktreePath ?? resolveCodexBaseCwd()
    try {
      manager.startSession({ sessionId, worktreePath, worktreeName: record.worktreeName ?? undefined })
      return true
    } catch (error) {
      await updateTerminalSessionRecord(sessionId, {
        status: 'error',
        worktreeName: record.worktreeName,
        worktreePath: record.worktreePath,
        tmuxSocket: record.tmuxSocket,
        errorMessage: record.errorMessage ?? (error instanceof Error ? error.message : 'terminal session missing'),
        readyAt: record.readyAt,
        closedAt: record.closedAt ?? new Date().toISOString(),
        metadata: record.metadata,
      })
    }
  }
  return false
}

export const terminateTerminalSession = async (sessionId: string) => {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid terminal session id')
  if (isTerminalBackendProxyEnabled()) {
    const response = await fetchTerminalBackend(`api/terminals/${encodeURIComponent(sessionId)}/terminate`, {
      method: 'POST',
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: string } | null
      throw new Error(payload?.message ?? 'Unable to terminate terminal session')
    }
    return
  }
  const record = await getTerminalSessionRecord(sessionId)
  getManager()?.terminate(sessionId)
  await upsertTerminalSessionRecord({
    id: sessionId,
    status: 'closed',
    worktreeName: record?.worktreeName ?? null,
    worktreePath: record?.worktreePath ?? null,
    tmuxSocket: record?.tmuxSocket ?? null,
    errorMessage: null,
    readyAt: record?.readyAt ?? null,
    closedAt: new Date().toISOString(),
    metadata: record?.metadata ?? {},
  })
}

export const deleteTerminalSession = async (sessionId: string) => {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid terminal session id')
  if (isTerminalBackendProxyEnabled()) {
    const response = await fetchTerminalBackend(`api/terminals/${encodeURIComponent(sessionId)}/delete`, {
      method: 'POST',
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: string } | null
      throw new Error(payload?.message ?? 'Unable to delete terminal session')
    }
    return
  }

  const record = await getTerminalSessionRecord(sessionId)
  const runtime = getManager()?.getSession(sessionId)
  if (runtime) {
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

  await deleteTerminalSessionRecord(sessionId)
}

export const sendTerminalInput = async (sessionId: string, input: string) => {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid terminal session id')
  if (isTerminalBackendProxyEnabled()) {
    const response = await fetchTerminalBackend(`api/terminals/${encodeURIComponent(sessionId)}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: Buffer.from(input, 'utf8').toString('base64') }),
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: string } | null
      throw new Error(payload?.message ?? 'Unable to send terminal input')
    }
    return
  }
  const runtime = getManager()?.getSession(sessionId)
  if (!runtime) throw new Error('Session not found')
  getManager()?.handleInput(sessionId, new TextEncoder().encode(input))
}

export const resizeTerminalSession = async (sessionId: string, cols: number, rows: number) => {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid terminal session id')
  if (isTerminalBackendProxyEnabled()) {
    const response = await fetchTerminalBackend(`api/terminals/${encodeURIComponent(sessionId)}/resize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols, rows }),
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: string } | null
      throw new Error(payload?.message ?? 'Unable to resize terminal session')
    }
    return
  }
  getManager()?.resize(sessionId, cols, rows)
}

export const getTerminalSnapshot = async (sessionId: string) => {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid terminal session id')
  return getManager()?.getSnapshot(sessionId) ?? ''
}

export const getTerminalRuntime = (sessionId: string) => getManager()?.getSession(sessionId) ?? null

export const formatSessionId = (raw: string) => raw.trim()

export const isTerminalSessionId = (raw: string) => SESSION_ID_PATTERN.test(raw.trim())
