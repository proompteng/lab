import type { ErrorEvent } from '@sentry/browser'

const allowedTags = new Set(['service', 'operation', 'status', 'code', 'trace_id'])

export function sanitizeErrorEvent(event: ErrorEvent): ErrorEvent {
  delete event.user
  delete event.request
  delete event.extra
  delete event.breadcrumbs
  delete event.contexts
  delete event.transaction
  delete event.server_name
  delete event.threads
  delete event.logentry
  delete event.fingerprint
  event.message = 'Application operation failed; inspect the correlated trace'
  event.tags = Object.fromEntries(Object.entries(event.tags ?? {}).filter(([key]) => allowedTags.has(key)))
  for (const exception of event.exception?.values ?? []) {
    exception.value = 'Runtime message withheld'
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars
      delete frame.context_line
      delete frame.pre_context
      delete frame.post_context
      if (frame.filename) frame.filename = frame.filename.split(/[?#]/, 1)[0]
    }
  }
  return event
}

export function glitchTipDsn(value: string | undefined) {
  if (!value) return undefined
  const url = new URL(value)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== 'glitchtip-web.glitchtip.svc.cluster.local' ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[a-f0-9]{32}$/.test(url.username) ||
    !/^\/[1-9][0-9]*$/.test(url.pathname)
  )
    throw new Error('Invalid internal GlitchTip DSN')
  return url
}

export function browserErrorConfig() {
  const internal = glitchTipDsn(process.env.SENTRY_BROWSER_DSN)
  if (!internal) return undefined
  const publicDsn = new URL(internal)
  publicDsn.protocol = 'https:'
  publicDsn.host = 'proompteng.ai'
  return {
    dsn: publicDsn.toString(),
    release: process.env.APP_SOURCE_REVISION || 'development',
    environment: 'production',
  }
}
