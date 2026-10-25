import * as Sentry from '@sentry/browser'
import { sanitizeErrorEvent } from './lib/observability/errors'

void fetch('/api/telemetry/config', { credentials: 'same-origin', cache: 'no-store' })
  .then(async (response) => {
    if (!response.ok) throw new Error('Error tracking configuration unavailable')
    const config: { dsn?: string; release?: string; environment?: string } = await response.json()
    if (!config.dsn) return
    Sentry.init({
      ...config,
      tunnel: '/api/telemetry/errors',
      maxBreadcrumbs: 0,
      defaultIntegrations: false,
      integrations: [
        Sentry.globalHandlersIntegration(),
        Sentry.browserApiErrorsIntegration(),
        Sentry.dedupeIntegration(),
      ],
      beforeSend: sanitizeErrorEvent,
    })
    Sentry.setTag('service', 'tengri-browser')
  })
  .catch(() => console.warn('Tengri error tracking initialization failed'))
