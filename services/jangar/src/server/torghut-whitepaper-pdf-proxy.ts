const WHITEPAPER_SOURCE_MAX_REDIRECTS = 5
const DEFAULT_WHITEPAPER_SOURCE_HOSTS = new Set(['github.com'])

type WhitepaperPdfSource = 'bucket' | 'source_url'

const resolveWhitepaperSourceAllowedHosts = (env: Record<string, string | undefined> = process.env) =>
  new Set(
    (env.JANGAR_WHITEPAPER_SOURCE_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  )

const isAllowedWhitepaperSourceHost = (hostname: string, env: Record<string, string | undefined> = process.env) => {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '')
  return (
    DEFAULT_WHITEPAPER_SOURCE_HOSTS.has(normalized) ||
    normalized.endsWith('.githubusercontent.com') ||
    resolveWhitepaperSourceAllowedHosts(env).has(normalized)
  )
}

const resolveTrustedWhitepaperSourceUrl = (
  rawUrl: string | URL,
  baseUrl?: URL,
  env: Record<string, string | undefined> = process.env,
): URL | null => {
  try {
    const url = rawUrl instanceof URL ? new URL(rawUrl) : baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl)
    if (url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    if (url.port && url.port !== '443') return null
    if (!isAllowedWhitepaperSourceHost(url.hostname, env)) return null
    return url
  } catch {
    return null
  }
}

const formatPdfResponse = (
  upstream: Response,
  {
    fileName,
    source,
  }: {
    fileName: string | null
    source: WhitepaperPdfSource
  },
) => {
  if (!upstream.ok || !upstream.body) return null
  const contentType = upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/pdf') return null

  const safeName = (fileName ?? 'whitepaper.pdf').replace(/[^a-zA-Z0-9._-]+/g, '_')
  const headers = new Headers()
  headers.set('content-type', 'application/pdf')
  headers.set('cache-control', 'private, max-age=60')
  headers.set('content-disposition', `inline; filename="${safeName}"`)
  headers.set('x-whitepaper-pdf-source', source)

  const contentLength = upstream.headers.get('content-length')
  if (contentLength) headers.set('content-length', contentLength)

  return new Response(upstream.body, {
    status: 200,
    headers,
  })
}

export const fetchWhitepaperPdfFromUrl = async (
  url: string,
  {
    fileName,
    source,
  }: {
    fileName: string | null
    source: WhitepaperPdfSource
  },
) => {
  try {
    if (source === 'source_url') {
      let currentUrl = resolveTrustedWhitepaperSourceUrl(url)
      if (!currentUrl) return null

      for (let redirectCount = 0; redirectCount <= WHITEPAPER_SOURCE_MAX_REDIRECTS; redirectCount += 1) {
        const upstream = await fetch(currentUrl, { redirect: 'manual' })
        if (upstream.status >= 300 && upstream.status < 400) {
          if (redirectCount === WHITEPAPER_SOURCE_MAX_REDIRECTS) return null
          const location = upstream.headers.get('location')
          if (!location) return null
          currentUrl = resolveTrustedWhitepaperSourceUrl(location, currentUrl)
          if (!currentUrl) return null
          continue
        }
        return formatPdfResponse(upstream, { fileName, source })
      }
      return null
    }

    return formatPdfResponse(await fetch(url), { fileName, source })
  } catch {
    return null
  }
}
