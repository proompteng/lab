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

const readAgentsEnv = (env: EnvSource, agentsName: string, legacyJangarName?: string) =>
  env[agentsName]?.trim() || (legacyJangarName ? env[legacyJangarName]?.trim() : undefined)

const parsePort = (value: string | undefined) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GRPC_PORT
}

export const resolveAgentctlGrpcConfig = (env: EnvSource = process.env): AgentctlGrpcConfig => {
  const host = readAgentsEnv(env, 'AGENTS_GRPC_HOST', 'JANGAR_GRPC_HOST') || '127.0.0.1'
  const port = parsePort(readAgentsEnv(env, 'AGENTS_GRPC_PORT', 'JANGAR_GRPC_PORT'))
  return {
    enabled: ENABLED_VALUES.has((readAgentsEnv(env, 'AGENTS_GRPC_ENABLED', 'JANGAR_GRPC_ENABLED') ?? '').toLowerCase()),
    authToken: readAgentsEnv(env, 'AGENTS_GRPC_TOKEN', 'JANGAR_GRPC_TOKEN') || null,
    host,
    port,
    address: readAgentsEnv(env, 'AGENTS_GRPC_ADDRESS', 'JANGAR_GRPC_ADDRESS') || `${host}:${port}`,
    protoPathOverride: readAgentsEnv(env, 'AGENTS_GRPC_PROTO_PATH', 'JANGAR_GRPC_PROTO_PATH') || null,
    version: readAgentsEnv(env, 'AGENTS_VERSION', 'JANGAR_VERSION') ?? 'dev',
    buildSha: readAgentsEnv(env, 'AGENTS_COMMIT', 'JANGAR_BUILD_SHA') ?? '',
    buildTime: readAgentsEnv(env, 'AGENTS_BUILD_TIME', 'JANGAR_BUILD_TIME') ?? '',
    agentsControllerEnabled:
      readAgentsEnv(env, 'AGENTS_AGENTS_CONTROLLER_ENABLED', 'JANGAR_AGENTS_CONTROLLER_ENABLED') === '1' ||
      readAgentsEnv(env, 'AGENTS_SERVER_PROFILE', 'JANGAR_SERVER_PROFILE') === 'agents-controllers',
  }
}

export const validateAgentctlGrpcConfig = (env: EnvSource = process.env) => {
  resolveAgentctlGrpcConfig(env)
}

export const __private = {
  parsePort,
}
