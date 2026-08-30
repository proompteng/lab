export const createMigrationRunner = (runMigrations: () => Promise<void>) => {
  let migrationsPromise: Promise<void> | null = null

  return async () => {
    if (!migrationsPromise) {
      const pending = runMigrations()
      migrationsPromise = pending
      pending.catch(() => {
        if (migrationsPromise === pending) migrationsPromise = null
      })
    }

    await migrationsPromise
  }
}
