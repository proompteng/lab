import { Socket } from 'node:net'

export interface TemporalAddress {
  host: string
  port: number
}

export const parseTemporalAddress = (raw: string): TemporalAddress => {
  if (!raw) {
    return { host: '127.0.0.1', port: 7233 }
  }

  try {
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      const url = new URL(raw)
      return {
        host: url.hostname || '127.0.0.1',
        port: url.port ? Number(url.port) : raw.startsWith('https://') ? 443 : 80,
      }
    }
  } catch (_error) {
    // fall through to host:port parsing below if URL parsing fails
  }

  const [hostPart, portPart] = raw.split(':')
  const host = hostPart || '127.0.0.1'
  const port = portPart ? Number(portPart) : 7233
  return { host, port }
}

export const isTemporalServerAvailable = async (rawAddress: string, timeoutMs = 1_000): Promise<boolean> => {
  const { host, port } = parseTemporalAddress(rawAddress)
  if (!host || !Number.isFinite(port)) {
    return false
  }

  return await new Promise((resolve) => {
    const socket = new Socket()
    let settled = false

    const complete = (result: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs, () => complete(false))
    socket.once('error', () => complete(false))
    socket.connect(port, host, () => complete(true))
  })
}
