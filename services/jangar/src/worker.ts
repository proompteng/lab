import { startTemporalWorker } from './workers/temporal-worker'

const { runPromise } = await startTemporalWorker()

await runPromise
