import { defineEventHandler } from 'h3'
import serverEntry from 'virtual:tanstack-start-server-entry'

const toRequest = (event: any) => {
  if (event?.web?.request instanceof Request) {
    return event.web.request
  }
  if (event?.req instanceof Request) {
    return event.req
  }
  if (event?.node?.req) {
    const nodeReq = event.node.req
    const headers = nodeReq.headers ?? {}
    const proto = headers['x-forwarded-proto'] ?? 'http'
    const host = headers['x-forwarded-host'] ?? headers.host ?? 'localhost'
    const url = nodeReq.url ?? '/'
    const absoluteUrl = url.startsWith('http') ? url : `${proto}://${host}${url}`
    return new Request(absoluteUrl, {
      method: nodeReq.method,
      headers,
    })
  }
  const url = event?.url ?? event?.path ?? '/'
  return new Request(url, {
    method: event?.method ?? 'GET',
    headers: event?.headers ?? undefined,
  })
}

export default defineEventHandler((event) => {
  const request = toRequest(event)
  return serverEntry.fetch(request)
})
