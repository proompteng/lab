import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'

const [certificate, key] = process.argv.slice(2)
const targetPort = (host) => {
  if (host === 'desktop.tengri.localhost:3443') return 3143
  if (host === 'gateway.tengri.localhost:3443') return 33082
  if (/^tengri-[a-z0-9]{24}\.tengri\.localhost:3443$/.test(host ?? '')) return 33083
  return null
}
const options = (request, port) => ({
  hostname: '127.0.0.1',
  port,
  method: request.method,
  path: request.url,
  headers: request.headers,
})
const server = https.createServer({ cert: readFileSync(certificate), key: readFileSync(key) }, (request, response) => {
  const port = targetPort(request.headers.host)
  if (!port) {
    response.writeHead(404).end()
    return
  }
  const upstream = http.request(options(request, port), (remote) => {
    response.writeHead(remote.statusCode, remote.headers)
    remote.pipe(response)
  })
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502)
    response.end()
  })
  request.on('aborted', () => upstream.destroy())
  request.pipe(upstream)
})
server.on('upgrade', (request, socket, head) => {
  const port = targetPort(request.headers.host)
  if (!port) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
    return
  }
  const upstream = http.request(options(request, port))
  upstream.on('upgrade', (response, remote, remoteHead) => {
    socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`)
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      socket.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`)
    }
    socket.write('\r\n')
    if (remoteHead.length) socket.write(remoteHead)
    if (head.length) remote.write(head)
    socket.on('error', () => remote.destroy())
    remote.on('error', () => socket.destroy())
    socket.on('close', () => remote.destroy())
    remote.on('close', () => socket.destroy())
    socket.pipe(remote).pipe(socket)
  })
  upstream.on('response', (response) => {
    socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\n\r\n`)
    response.resume()
  })
  upstream.on('error', () => socket.destroy())
  upstream.end()
})
server.listen(3443, '127.0.0.1')
