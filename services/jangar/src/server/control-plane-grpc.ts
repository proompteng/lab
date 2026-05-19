import { connect } from 'node:net'

export type GrpcStatus = {
  enabled: boolean
  address: string
  status: 'disabled' | 'healthy' | 'degraded'
  message: string
}

type RuntimeEnvValue = {
  name: string
  value: string
}

type ParsedBooleanFlag = {
  value: boolean
  valid: boolean
}

const DEFAULT_GRPC_PORT = 50051
const DEFAULT_GRPC_HEALTH_TIMEOUT_MS = 750

const readRuntimeEnv = (canonicalName: string, jangarName: string): RuntimeEnvValue => {
  const canonicalValue = process.env[canonicalName]?.trim()
  if (canonicalValue) return { name: canonicalName, value: canonicalValue }

  const jangarValue = process.env[jangarName]?.trim()
  if (jangarValue) return { name: jangarName, value: jangarValue }

  return { name: canonicalName, value: '' }
}

const parseBooleanFlag = (value: string): ParsedBooleanFlag => {
  if (!value) return { value: false, valid: true }

  const normalized = value.toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return { value: true, valid: true }
  if (['0', 'false', 'no', 'off'].includes(normalized)) return { value: false, valid: true }
  return { value: false, valid: false }
}

const parseGrpcPort = (portInput: string, fallback: number): number | null => {
  const trimmed = portInput.trim()
  if (!trimmed) return fallback
  if (!/^\d+$/.test(trimmed)) return null

  const port = Number.parseInt(trimmed, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

const parseGrpcTimeoutMs = () => {
  const raw = process.env.AGENTS_GRPC_HEALTH_TIMEOUT_MS ?? process.env.JANGAR_GRPC_HEALTH_TIMEOUT_MS
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_GRPC_HEALTH_TIMEOUT_MS
}

const parseGrpcAddress = (addressInput: string) => {
  const address = addressInput.trim()
  if (!address) return null

  const bracketMatch = /^\[(.+)]:(\d+)$/.exec(address)
  if (bracketMatch && bracketMatch.length >= 3) {
    const port = Number.parseInt(bracketMatch[2], 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return { host: bracketMatch[1], port, address }
  }

  const separatorIndex = address.lastIndexOf(':')
  if (separatorIndex < 1 || separatorIndex === address.length - 1) return null

  const host = address.slice(0, separatorIndex)
  const portToken = address.slice(separatorIndex + 1).trim()
  if (!/^\d+$/.test(portToken)) return null

  const port = Number.parseInt(portToken, 10)
  if (!host || !Number.isFinite(port) || port < 1 || port > 65535) return null
  return { host, port, address }
}

const checkGrpcEndpointReachability = async (host: string, port: number, timeoutMs: number): Promise<string> => {
  return await new Promise<string>((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs }, () => {
      socket.end()
      resolve('')
    })

    socket.on('error', (error) => {
      resolve(error instanceof Error ? error.message : String(error))
    })
    socket.on('timeout', () => {
      socket.destroy()
      resolve(`timeout after ${timeoutMs}ms`)
    })
  })
}

export const resolveGrpcStatus = async (): Promise<GrpcStatus> => {
  const enabledEnv = readRuntimeEnv('AGENTS_GRPC_ENABLED', 'JANGAR_GRPC_ENABLED')
  const parsedEnabled = parseBooleanFlag(enabledEnv.value)
  if (!parsedEnabled.valid) {
    return {
      enabled: false,
      address: '',
      status: 'degraded',
      message: `invalid ${enabledEnv.name} value ${JSON.stringify(enabledEnv.value).trim()}`,
    }
  }

  if (!parsedEnabled.value) {
    return {
      enabled: false,
      address: '',
      status: 'disabled',
      message: 'gRPC disabled',
    }
  }

  const host = readRuntimeEnv('AGENTS_GRPC_HOST', 'JANGAR_GRPC_HOST').value || '127.0.0.1'
  const addressOverride = readRuntimeEnv('AGENTS_GRPC_ADDRESS', 'JANGAR_GRPC_ADDRESS').value
  if (!addressOverride) {
    const portEnv = readRuntimeEnv('AGENTS_GRPC_PORT', 'JANGAR_GRPC_PORT')
    const resolvedPort = parseGrpcPort(portEnv.value, DEFAULT_GRPC_PORT)
    if (resolvedPort === null) {
      return {
        enabled: true,
        address: '',
        status: 'degraded',
        message: `invalid ${portEnv.name} value ${JSON.stringify(portEnv.value).trim()}`,
      }
    }

    const parsedAddress = parseGrpcAddress(`${host}:${resolvedPort}`)
    if (!parsedAddress) {
      return {
        enabled: true,
        address: `${host}:${resolvedPort}`,
        status: 'degraded',
        message: `invalid gRPC address ${JSON.stringify(`${host}:${resolvedPort}`)}`,
      }
    }

    const reachabilityError = await checkGrpcEndpointReachability(
      parsedAddress.host,
      parsedAddress.port,
      parseGrpcTimeoutMs(),
    )
    if (reachabilityError) {
      return {
        enabled: true,
        address: parsedAddress.address,
        status: 'degraded',
        message: `gRPC endpoint not reachable (${reachabilityError})`,
      }
    }

    return {
      enabled: true,
      address: parsedAddress.address,
      status: 'healthy',
      message: '',
    }
  }

  const parsedAddress = parseGrpcAddress(addressOverride)
  if (!parsedAddress) {
    return {
      enabled: true,
      address: addressOverride,
      status: 'degraded',
      message: `invalid gRPC address ${JSON.stringify(addressOverride)}`,
    }
  }

  const reachabilityError = await checkGrpcEndpointReachability(
    parsedAddress.host,
    parsedAddress.port,
    parseGrpcTimeoutMs(),
  )
  if (reachabilityError) {
    return {
      enabled: true,
      address: parsedAddress.address,
      status: 'degraded',
      message: `gRPC endpoint not reachable (${reachabilityError})`,
    }
  }

  return {
    enabled: true,
    address: parsedAddress.address,
    status: 'healthy',
    message: '',
  }
}
