import { describe, expect, it, vi } from 'vitest'

const { fakeManager, store, record } = vi.hoisted(() => {
  const record = {
    id: 'jangar-terminal-test-1',
    status: 'ready',
    worktreeName: 'codex-test',
    worktreePath: '/tmp/codex-test',
    tmuxSocket: null,
    errorMessage: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    readyAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    closedAt: null,
    metadata: { reconnectToken: 'reconnect-token-1' },
  }

  const fakeManager = {
    getSession: vi.fn(() => null),
    startSession: vi.fn(() => ({ id: record.id })),
  }

  const store = {
    getTerminalSessionRecord: vi.fn(async () => record),
    updateTerminalSessionRecord: vi.fn(async (_id: string, updates: Record<string, unknown>) => ({
      ...record,
      ...updates,
      metadata: { ...record.metadata, ...((updates.metadata as Record<string, unknown>) ?? {}) },
    })),
    listTerminalSessionRecords: vi.fn(async () => [record]),
    upsertTerminalSessionRecord: vi.fn(async () => record),
    deleteTerminalSessionRecord: vi.fn(async () => record),
  }

  return { fakeManager, store, record }
})

vi.mock('~/server/terminal-pty-manager', () => ({
  getTerminalPtyManager: () => fakeManager,
  resetTerminalPtyManager: () => {
    fakeManager.getSession.mockReset()
    fakeManager.startSession.mockReset()
  },
}))

vi.mock('~/server/terminal-sessions-store', () => ({
  getTerminalSessionRecord: store.getTerminalSessionRecord,
  updateTerminalSessionRecord: store.updateTerminalSessionRecord,
  listTerminalSessionRecords: store.listTerminalSessionRecords,
  upsertTerminalSessionRecord: store.upsertTerminalSessionRecord,
  deleteTerminalSessionRecord: store.deleteTerminalSessionRecord,
}))

vi.mock('~/server/terminal-backend', () => ({
  isTerminalBackendProxyEnabled: () => false,
  fetchTerminalBackend: vi.fn(),
  fetchTerminalBackendJson: vi.fn(),
}))

describe('ensureTerminalSessionExists', () => {
  it('recreates missing runtime after restart', async () => {
    fakeManager.getSession.mockReturnValueOnce(null)
    const { ensureTerminalSessionExists } = await import('../terminals')

    const ok = await ensureTerminalSessionExists(record.id)

    expect(ok).toBe(true)
    expect(fakeManager.startSession).toHaveBeenCalledWith({
      sessionId: record.id,
      worktreePath: record.worktreePath,
      worktreeName: record.worktreeName,
    })
  })
})
