import { startTemporalWorker } from './runtime/temporal-worker'

const { runPromise } = await startTemporalWorker()

await runPromise
