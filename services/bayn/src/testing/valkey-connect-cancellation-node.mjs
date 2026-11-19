import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { createClient } from 'redis'

const mode = process.argv[2]
const tls = mode !== 'handshake-reconnect'
const reconnect = mode === 'tls-reconnect' || mode === 'handshake-reconnect'
const accepted = [Promise.withResolvers(), Promise.withResolvers()]
const closed = [Promise.withResolvers(), Promise.withResolvers()]
const firstCommand = Promise.withResolvers()
const sockets = new Set()
const external = new AbortController()
let connections = 0
let closedConnections = 0
let readyEvents = 0
const bounded = async (promise, label) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded the cancellation grace period`)), 1000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
const server = createServer((socket) => {
  const index = connections++
  sockets.add(socket)
  socket.on('error', () => {})
  socket.once('close', () => {
    sockets.delete(socket)
    closedConnections++
    closed[index]?.resolve()
  })
  accepted[index]?.resolve()
  if (tls) {
    // Accept TCP but never answer the TLS ClientHello.
    socket.resume()
    return
  }
  let buffer = ''
  socket.on('data', (data) => {
    if (index === 0) {
      firstCommand.resolve()
      return
    }
    buffer += data.toString()
    while (buffer.length > 0) {
      const head = buffer.indexOf('\r\n')
      if (head < 0) return
      const count = Number(buffer.slice(1, head))
      const args = []
      let offset = head + 2
      for (let argument = 0; argument < count; argument++) {
        const end = buffer.indexOf('\r\n', offset)
        if (end < 0) return
        const length = Number(buffer.slice(offset + 1, end))
        if (buffer.length < end + 2 + length + 2) return
        args.push(buffer.slice(end + 2, end + 2 + length))
        offset = end + 2 + length + 2
      }
      buffer = buffer.slice(offset)
      socket.write(args[0] === 'GET' ? '$-1\r\n' : '+OK\r\n')
    }
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert(address !== null && typeof address !== 'string')
const client = createClient({
  RESP: 2,
  disableOfflineQueue: true,
  socket: {
    host: '127.0.0.1',
    port: address.port,
    ...(tls ? { tls: true, servername: 'localhost' } : {}),
    ...(mode === 'external-abort' ? { signal: external.signal } : {}),
    connectTimeout: 5000,
    reconnectStrategy: false,
  },
})
client.on('error', () => {})
client.on('ready', () => readyEvents++)
const outcome = () =>
  client.connect().then(
    () => 'connected',
    () => 'cancelled',
  )
try {
  const first = outcome()
  await bounded(accepted[0].promise, 'first connection')
  if (!tls) await bounded(firstCommand.promise, 'first handshake')
  if (mode === 'external-abort') external.abort()
  else if (mode === 'tls-close') await bounded(client.close(), 'scope close')
  else client.destroy()
  const second = reconnect ? outcome() : undefined
  if (reconnect) await bounded(accepted[1].promise, 'second connection')
  assert.equal(await bounded(first, 'cancelled connect promise'), 'cancelled')
  await bounded(closed[0].promise, 'cancelled socket close')
  assert.equal(closedConnections, 1)
  if (reconnect) {
    assert.equal(client.isOpen, true, 'the cancelled attempt cannot close the new connection')
    if (!tls) {
      assert.equal(await bounded(second, 'replacement handshake'), 'connected')
      assert.equal(await bounded(client.get('bayn:fixture'), 'replacement GET'), null)
      assert.equal(client.isReady, true)
      assert.equal(readyEvents, 1)
    }
    client.destroy()
    if (tls) assert.equal(await bounded(second, 'second cancellation'), 'cancelled')
    await bounded(closed[1].promise, 'second socket close')
  } else {
    assert.equal(client.isOpen, false)
    assert.equal(client.isReady, false)
  }
  assert.equal(readyEvents, tls ? 0 : 1)
  assert.equal(closedConnections, connections)
  process.stdout.write(JSON.stringify({ mode, connections, closedConnections, readyEvents }))
} finally {
  client.destroy()
  for (const socket of sockets) socket.destroy()
  await new Promise((resolve) => server.close(resolve))
}
