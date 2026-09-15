const MAX_ORIGIN_LENGTH = 2_048

export function normalizePreviewGatewayOrigin(value: string): string {
  const candidate = value.trim()
  if (!candidate || candidate.length > MAX_ORIGIN_LENGTH) return ''

  try {
    const url = new URL(candidate)
    const localDevelopment = url.protocol === 'http:' && url.hostname.toLowerCase() === 'localhost'
    if (
      (!localDevelopment && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return ''
    }
    return url.origin
  } catch {
    return ''
  }
}
