import { describe, expect, it, vi } from 'vitest'

import { createMigrationRunner } from './migration-runner'

describe('createMigrationRunner', () => {
  it('shares one in-flight migration attempt', async () => {
    let resolveMigration: (() => void) | undefined
    const runMigrations = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveMigration = resolve
        }),
    )
    const ensureMigrations = createMigrationRunner(runMigrations)

    const first = ensureMigrations()
    const second = ensureMigrations()
    expect(runMigrations).toHaveBeenCalledTimes(1)

    resolveMigration?.()
    await Promise.all([first, second])
  })

  it('retries after a transient migration failure', async () => {
    const runMigrations = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce()
    const ensureMigrations = createMigrationRunner(runMigrations)

    await expect(ensureMigrations()).rejects.toThrow('database unavailable')
    await expect(ensureMigrations()).resolves.toBeUndefined()
    expect(runMigrations).toHaveBeenCalledTimes(2)
  })
})
