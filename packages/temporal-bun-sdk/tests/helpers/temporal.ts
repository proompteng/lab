import net from 'node:net'

const DEFAULT_TEMPORAL_PORT = 7233

export const resolveTemporalAddress = (address: string): { host: string; port: number; url: string } => {
  if (!address) {
    return { host: '127.0.0.1', port: DEFAULT_TEMPORAL_PORT, url: 'http://127.0.0.1:7233' }
  }

  const hasScheme = address.includes('://')
  const url = new URL(hasScheme ? address : `http://${address}`)
  const port = url.port ? Number(url.port) : DEFAULT_TEMPORAL_PORT

  return { host: url.hostname, port, url: hasScheme ? address : url.toString().replace(/\/$/, '') }
}

export const isTemporalServerReachable = async (
  address: string,
  options: { timeoutMs?: number } = {},
): Promise<boolean> => {
  const { host, port } = resolveTemporalAddress(address)
  const timeoutMs = options.timeoutMs ?? 1_000

  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port })

    const finalize = (result: boolean) => {
      socket.removeAllListeners()
      if (!socket.destroyed) {
        socket.destroy()
      }
      resolve(result)
    }

    socket.on('connect', () => finalize(true))
    socket.on('error', () => finalize(false))
    socket.setTimeout(timeoutMs, () => finalize(false))
  })
}
