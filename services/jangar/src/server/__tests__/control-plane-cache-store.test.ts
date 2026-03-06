import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbMocks = vi.hoisted(() => ({
  createKyselyDb: vi.fn(),
  getDb: vi.fn(),
  resolveStoreDb: vi.fn((options: { url?: string; createDb?: (url: string) => unknown } = {}) => {
    const url = options.url ?? process.env.DATABASE_URL ?? null
    if (!url) return { db: null, shared: false, url: null }
    if (!options.createDb && (options.url == null || options.url === process.env.DATABASE_URL)) {
      return { db: dbMocks.getDb(), shared: true, url }
    }
    return {
      db: (options.createDb ?? dbMocks.createKyselyDb)(url),
      shared: false,
      url,
    }
  }),
}))

const migrationsMocks = vi.hoisted(() => ({
  ensureMigrations: vi.fn(() => Promise.resolve()),
}))

vi.mock('~/server/db', () => dbMocks)
vi.mock('~/server/kysely-migrations', () => migrationsMocks)

import { createControlPlaneCacheStore } from '../control-plane-cache-store'

describe('control plane cache store', () => {
  const previousDatabaseUrl = process.env.DATABASE_URL

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://jangar:secret@db.example:5432/jangar'
    dbMocks.createKyselyDb.mockReset()
    dbMocks.getDb.mockReset()
    migrationsMocks.ensureMigrations.mockClear()
  })

  afterEach(() => {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl
    }
  })

  it('reuses the shared process db when using the default DATABASE_URL', async () => {
    const destroy = vi.fn(async () => undefined)
    const sharedDb = { destroy } as unknown

    dbMocks.getDb.mockReturnValue(sharedDb)

    const store = createControlPlaneCacheStore()
    await store.ready
    await store.close()

    expect(dbMocks.getDb).toHaveBeenCalledTimes(1)
    expect(dbMocks.createKyselyDb).not.toHaveBeenCalled()
    expect(migrationsMocks.ensureMigrations).toHaveBeenCalledWith(sharedDb)
    expect(destroy).not.toHaveBeenCalled()
  })

  it('creates and destroys a dedicated db when a custom url is provided', async () => {
    const destroy = vi.fn(async () => undefined)
    const dedicatedDb = { destroy } as unknown

    dbMocks.createKyselyDb.mockReturnValue(dedicatedDb)

    const store = createControlPlaneCacheStore({
      url: 'postgresql://jangar:secret@other-db.example:5432/jangar',
    })
    await store.ready
    await store.close()

    expect(dbMocks.getDb).not.toHaveBeenCalled()
    expect(dbMocks.createKyselyDb).toHaveBeenCalledWith('postgresql://jangar:secret@other-db.example:5432/jangar')
    expect(migrationsMocks.ensureMigrations).toHaveBeenCalledWith(dedicatedDb)
    expect(destroy).toHaveBeenCalledTimes(1)
  })
})
