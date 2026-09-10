import type { WorkerConcurrencyOptions } from './runtime'

export interface WorkerTuner {
  readonly name?: string
  readonly initial?: WorkerConcurrencyOptions
  readonly subscribe?: (listener: (options: WorkerConcurrencyOptions) => void) => () => void
}

export const createStaticWorkerTuner = (options: WorkerConcurrencyOptions): WorkerTuner => ({
  name: 'static',
  initial: options,
})
