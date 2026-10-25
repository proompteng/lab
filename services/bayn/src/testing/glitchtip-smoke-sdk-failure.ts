import { mock } from 'bun:test'

mock.module('@sentry/node', () => ({
  init: () => undefined,
  getClient: () => ({ getDsn: () => ({}) }),
  setTag: () => undefined,
  addEventProcessor: () => undefined,
  onUncaughtExceptionIntegration: () => ({}),
  onUnhandledRejectionIntegration: () => ({}),
  withScope: () => {
    throw new Error('Synthetic SDK adapter failure')
  },
  flush: async () => true,
}))
