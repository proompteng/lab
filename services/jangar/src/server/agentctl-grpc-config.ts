type EnvSource = Record<string, string | undefined>

const DEFAULT_GRPC_PORT = 50051
const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on'])

export type AgentctlGrpcConfig = {
  enabled: boolean
  authToken: string | null
  host: string
  port: number
  address: string
  protoPathOverride: string | null
  version: string
  buildSha: string
  buildTime: string
  agentsControllerEnabled: boolean
}

const parsePort = (value: string | undefined) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GRPC_PORT
}

export const resolveAgentctlGrpcConfig = (env: EnvSource = process.env): AgentctlGrpcConfig => {
  const host = env.JANGAR_GRPC_HOST?.trim() || '127.0.0.1'
  const port = parsePort(env.JANGAR_GRPC_PORT)
  return {
    enabled: ENABLED_VALUES.has((env.JANGAR_GRPC_ENABLED ?? '').trim().toLowerCase()),
    authToken: env.JANGAR_GRPC_TOKEN?.trim() || null,
    host,
    port,
    address: env.JANGAR_GRPC_ADDRESS?.trim() || `${host}:${port}`,
    protoPathOverride: env.JANGAR_GRPC_PROTO_PATH?.trim() || null,
    version: env.JANGAR_VERSION ?? 'dev',
    buildSha: env.JANGAR_BUILD_SHA ?? '',
    buildTime: env.JANGAR_BUILD_TIME ?? '',
    agentsControllerEnabled: env.JANGAR_AGENTS_CONTROLLER_ENABLED === '1',
  }
}

export const validateAgentctlGrpcConfig = (env: EnvSource = process.env) => {
  resolveAgentctlGrpcConfig(env)
}

export const __private = {
  parsePort,
}
