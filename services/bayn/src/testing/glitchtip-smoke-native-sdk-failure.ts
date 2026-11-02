import { mock } from 'bun:test'
import { NativeArrivalCaptureError } from '../market-data/streaming/native-arrival'

let tags: Record<string, string> = {}
const processors: ((event: { tags: Record<string, string> }) => unknown)[] = []
const setTag = (key: string, value: string) => {
  tags[key] = value
}

mock.module('@sentry/node', () => ({
  init: () => undefined,
  getClient: () => ({ getDsn: () => ({}) }),
  setTag,
  addEventProcessor: (processor: (event: { tags: Record<string, string> }) => unknown) => processors.push(processor),
  onUncaughtExceptionIntegration: () => ({}),
  onUnhandledRejectionIntegration: () => ({}),
  withScope: (run: (scope: { setTag: typeof setTag }) => void) => {
    const previous = tags
    tags = { ...tags }
    try {
      run({ setTag })
    } finally {
      tags = previous
    }
  },
  captureException: (error: unknown) => {
    if (error instanceof NativeArrivalCaptureError) throw new Error('Synthetic native arrival SDK failure')
    for (const processor of processors) processor({ tags: { ...tags } })
    return 'a'.repeat(32)
  },
  flush: async () => true,
}))
