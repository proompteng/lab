import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
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
import { resolveTerminalsConfig } from '~/server/terminals-config'
import {
  buildTerminalSessionId,
  buildTerminalWorktreeName,
  buildTerminalWorktreePath,
  createFreshTerminalWorktree,
  createTerminalWorktreeAtPath,
  isCleanReusableTerminalWorktree,
  isSafeTerminalWorktreePath,
  queueTerminalWorktreeCheckout,
  refreshTerminalWorktree,
  removeTerminalWorktree,
  resolveCodexBaseCwd,
  resolveTerminalBaseRef,
  terminalWorktreeMaxAttempts,
} from '~/server/terminal-worktrees'

const terminalsConfig = resolveTerminalsConfig()
const SESSION_ID_PATTERN = /^jangar-terminal-[a-z0-9-]+$/

const bufferBytes = terminalsConfig.bufferBytes
const idleTimeoutMs = terminalsConfig.idleTimeoutMs
const publicTerminalUrl = terminalsConfig.publicTerminalUrl

const findReusableSession = async (): Promise<PlannedSession | null> => {
  const records = await listTerminalSessionRecords()
  const manager = getManager()
  const candidates = records.filter((record) => {
    if (record.status !== 'closed' && record.status !== 'error') return false
    if (!record.worktreeName || !record.worktreePath) return false
    if (!isSafeTerminalWorktreePath(record.worktreePath, record.worktreeName)) return false
    if (!existsSync(record.worktreePath)) return false
    if (manager?.getSession(record.id)) return false
    return true
  })
  if (candidates.length === 0) return null

  for (const record of candidates) {
    if (!record.worktreePath || !record.worktreeName) continue
    const worktreePath = record.worktreePath
    const worktreeName = record.worktreeName
    const reusable = await isCleanReusableTerminalWorktree(worktreePath)
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

const buildManager = () => {
  if (isTerminalBackendProxyEnabled()) return null
  return getTerminalPtyManager({
    bufferBytes,
    idleTimeoutMs,
    instanceId: terminalsConfig.backendId ?? undefined,
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
    const baseRef = plannedBaseRef ?? (await resolveTerminalBaseRef(repoRoot))
    if (!reuseExisting || !existsSync(worktreePath)) {
      await createTerminalWorktreeAtPath(worktreeName, worktreePath, baseRef, repoRoot)
    } else {
      await refreshTerminalWorktree(worktreePath, baseRef, worktreeName, sessionId)
    }
    getManager()?.startSession({ sessionId, worktreePath, worktreeName })
    queueTerminalWorktreeCheckout(worktreePath, baseRef, sessionId, worktreeName)
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
  const { worktreeName, worktreePath, baseRef } = await createFreshTerminalWorktree()
  const sessionId = buildTerminalSessionId(worktreeName)
  getManager()?.startSession({ sessionId, worktreePath, worktreeName })
  queueTerminalWorktreeCheckout(worktreePath, baseRef, sessionId, worktreeName)
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
  for (let attempt = 0; attempt < terminalWorktreeMaxAttempts; attempt += 1) {
    const suffix = randomUUID().slice(0, 8)
    const worktreeName = buildTerminalWorktreeName(suffix)
    const sessionId = buildTerminalSessionId(worktreeName)
    const worktreePath = buildTerminalWorktreePath(worktreeName)
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

  if (record?.worktreePath && isSafeTerminalWorktreePath(record.worktreePath, record.worktreeName)) {
    await removeTerminalWorktree(record.worktreePath, record.worktreeName, sessionId)
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
