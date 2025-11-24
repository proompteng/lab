import { runMigrations } from './db'
import { startTemporalWorker } from './runtime/temporal-worker'

try {
  console.info('[worker] running database migrations…')
  await runMigrations()
  console.info('[worker] migrations up to date')
} catch (error) {
  console.error('[worker] migration failed', error)
  process.exit(1)
}

const { runPromise } = await startTemporalWorker()

await runPromise
