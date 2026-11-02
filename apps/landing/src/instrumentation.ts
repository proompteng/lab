import type { Instrumentation } from 'next'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initializeObservability } = await import('./lib/observability/server')
    initializeObservability()
  }
}

export const onRequestError: Instrumentation.onRequestError = async (error) => {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { reportServerError } = await import('./lib/observability/server')
    reportServerError(error, 'next.request')
  }
}
