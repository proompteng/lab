import { connect } from 'node:net'

import type { GrpcStatus } from '~/server/control-plane-status'
import { resolveGrpcRuntimeConfig } from './runtime-tooling-config'

const DEFAULT_GRPC_PORT = 50051
const DEFAULT_GRPC_HEALTH_TIMEOUT_MS = 750

type ParsedBooleanFlag = {
  value: boolean
  valid: boolean
}

const parseBooleanFlag = (value: string): ParsedBooleanFlag => {
  if (!value) {
    return { value: false, valid: true }
  }

  const normalized = value.toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return { value: true, valid: true }
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return { value: false, valid: true }
  }
  return { value: false, valid: false }
}

const parseGrpcPort = (portInput: string, fallback: number): number | null => {
  const trimmed = portInput.trim()
  if (!trimmed) {
    return fallback
  }

  if (!/^\d+$/.test(trimmed)) {
    return null
  }

  const port = Number.parseInt(trimmed, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null
  }
  return port
}

const parseGrpcTimeoutMs = (): number => resolveGrpcRuntimeConfig(process.env).healthTimeoutMs

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
  if (!/^\d+$/.test(portToken)) {
    return null
  }
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
  const grpcConfig = resolveGrpcRuntimeConfig(process.env)
  const parsedEnabled = parseBooleanFlag(grpcConfig.enabledRaw)
  if (!parsedEnabled.valid) {
    return {
      enabled: false,
      address: '',
      status: 'degraded',
      message: `invalid JANGAR_GRPC_ENABLED value ${JSON.stringify(grpcConfig.enabledRaw).trim()}`,
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

  const host = grpcConfig.host

  const addressOverride = grpcConfig.address
  if (!addressOverride) {
    const resolvedPort = parseGrpcPort(grpcConfig.port, DEFAULT_GRPC_PORT)
    if (resolvedPort === null) {
      return {
        enabled: true,
        address: '',
        status: 'degraded',
        message: `invalid JANGAR_GRPC_PORT value ${JSON.stringify(grpcConfig.port).trim()}`,
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
