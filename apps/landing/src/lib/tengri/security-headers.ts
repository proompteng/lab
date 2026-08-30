export type BrowserSecurityPolicyOptions = {
  convexUrl?: string
  development: boolean
  previewFrameSource?: string
  tengriPublicUrl?: string
}

type SecurityPolicyEnvironment = Readonly<Record<string, string | undefined>>

const DEFAULT_TENGRI_PUBLIC_URL = 'https://tengri.proompteng.ai'
const DEFAULT_CONVEX_URL = 'https://convex.proompteng.ai'
const CLOUDFLARE_BEACON_SCRIPT_ORIGIN = 'https://static.cloudflareinsights.com'
const CLOUDFLARE_BEACON_REPORT_ORIGIN = 'https://cloudflareinsights.com'
// CSP cannot express the current `tengri-{session}` label prefix. Deployments with a dedicated
// preview DNS zone should override this with a narrower wildcard such as https://*.preview.example.com.
const DEFAULT_TENGRI_PREVIEW_FRAME_SOURCE = 'https://*.proompteng.ai'

export function buildRuntimeContentSecurityPolicy(environment: SecurityPolicyEnvironment = process.env): string {
  return buildContentSecurityPolicy({
    convexUrl: environment.NEXT_PUBLIC_CONVEX_URL,
    development: environment.NODE_ENV !== 'production',
    previewFrameSource: environment.TENGRI_PREVIEW_FRAME_SOURCE,
    tengriPublicUrl: environment.TENGRI_PUBLIC_URL,
  })
}

export function buildContentSecurityPolicy(options: BrowserSecurityPolicyOptions): string {
  const scriptSource = options.development
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ${CLOUDFLARE_BEACON_SCRIPT_ORIGIN}`
  const gatewayOrigin = configuredOrigin(options.tengriPublicUrl, DEFAULT_TENGRI_PUBLIC_URL, options.development)
  const convexOrigin = configuredOrigin(options.convexUrl, DEFAULT_CONVEX_URL, options.development)
  const previewFrameSource = configuredFrameSource(
    options.previewFrameSource,
    DEFAULT_TENGRI_PREVIEW_FRAME_SOURCE,
    options.development,
  )
  const connections = ["'self'"]
  if (gatewayOrigin) connections.push(gatewayOrigin, websocketOrigin(gatewayOrigin))
  if (convexOrigin) connections.push(convexOrigin, websocketOrigin(convexOrigin))
  if (options.development) {
    connections.push('http://localhost:*', 'http://127.0.0.1:*', 'ws://localhost:*', 'ws://127.0.0.1:*')
  } else {
    connections.push(CLOUDFLARE_BEACON_REPORT_ORIGIN)
  }
  const frames = ["'self'"]
  if (gatewayOrigin) frames.push(gatewayOrigin)
  if (previewFrameSource) frames.push(previewFrameSource)
  if (options.development) frames.push('http://localhost:*', 'http://127.0.0.1:*', 'http://*.localhost:*')

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self' https://github.com",
    scriptSource,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://avatars.githubusercontent.com",
    `connect-src ${uniqueSources(connections).join(' ')}`,
    `frame-src ${uniqueSources(frames).join(' ')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    ...(options.development ? [] : ['upgrade-insecure-requests']),
  ].join('; ')
}

function configuredOrigin(value: string | undefined, fallback: string, development: boolean): string | null {
  const configured = value?.trim()
  return normalizeOrigin(configured || fallback, development)
}

function configuredFrameSource(value: string | undefined, fallback: string, development: boolean): string | null {
  const configured = value?.trim()
  return normalizeFrameSource(configured || fallback, development)
}

function normalizeOrigin(value: string | undefined, development: boolean): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && !(development && url.protocol === 'http:')) return null
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

function normalizeFrameSource(value: string | undefined, development: boolean): string | null {
  const source = value?.trim()
  if (!source || source.includes(';') || hasCspControlCharacter(source)) {
    return null
  }
  const match = /^(https?):\/\/(\*\.)?([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?$/iu.exec(source)
  if (!match) return null
  if (match[1] !== 'https' && !(development && match[1] === 'http')) return null
  return source
}

function hasCspControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 32 || code === 127) return true
  }
  return false
}

function websocketOrigin(origin: string): string {
  return origin.replace(/^http/u, 'ws')
}

function uniqueSources(sources: string[]): string[] {
  return [...new Set(sources)]
}
