import { normalizePreviewGatewayOrigin } from '@/lib/tengri/preview-origin'

const PREVIEW_TICKET_PATTERN = /^[A-Za-z0-9_-]{16,128}\.[A-Za-z0-9_-]{16,128}$/

export function safePreviewLaunchUrl(value: string, previewGatewayOrigin: string) {
  try {
    const url = new URL(value)
    const trustedGatewayOrigin = normalizePreviewGatewayOrigin(previewGatewayOrigin)
    const ticket = url.hash.slice(1)
    if (
      !trustedGatewayOrigin ||
      url.origin !== trustedGatewayOrigin ||
      url.username ||
      url.password ||
      url.pathname !== '/v1/preview/open' ||
      url.search ||
      !PREVIEW_TICKET_PATTERN.test(ticket)
    ) {
      return ''
    }
    return url.toString()
  } catch {
    return ''
  }
}

export function safePreviewSessionOrigin(value: string, sessionId: string) {
  try {
    const url = new URL(value)
    const expectedLabel = `tengri-${sessionId}.`
    const localHttp = url.protocol === 'http:' && url.hostname.endsWith('.localhost')
    if (
      (!localHttp && url.protocol !== 'https:') ||
      !url.hostname.startsWith(expectedLabel) ||
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
