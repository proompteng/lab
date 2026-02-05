import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { DEFAULT_ADDRESS, DEFAULT_NAMESPACE, normalizeOutput } from './legacy'

export type OutputFormat = 'json' | 'table' | 'yaml' | 'yaml-stream' | 'text' | 'wide'

export type Config = {
  namespace?: string
  address?: string
  token?: string
  tls?: boolean
  kubeconfig?: string
  context?: string
}

export type GlobalFlags = {
  namespace?: string
  address?: string
  token?: string
  output?: OutputFormat
  tls?: boolean
  kube?: boolean
  grpc?: boolean
  kubeconfig?: string
  context?: string
  yes?: boolean
  noInput?: boolean
  color?: boolean
  pager?: boolean
}

export type TransportMode = 'grpc' | 'kube'

export type ResolvedConfig = {
  namespace: string
  mode: TransportMode
  address: string
  token?: string
  tls: boolean
  kubeconfig?: string
  context?: string
  output: OutputFormat
}

export type ResolvedConfigResult = {
  resolved: ResolvedConfig
  warnings: string[]
}

const parseBoolean = (raw: string | undefined) => {
  if (!raw) return undefined
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 't', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'f', 'no', 'n', 'off'].includes(normalized)) return false
  return undefined
}

export const resolveConfigPath = () => {
  const base = process.env.XDG_CONFIG_HOME?.trim() || resolve(homedir(), '.config')
  return resolve(base, 'agentctl', 'config.json')
}

export const loadConfig = async (): Promise<Config> => {
  const path = resolveConfigPath()
  if (!existsSync(path)) return {}
  const raw = await readFile(path, 'utf8')
  try {
    return JSON.parse(raw) as Config
  } catch {
    return {}
  }
}

export const saveConfig = async (config: Config) => {
  const path = resolveConfigPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  try {
    await chmod(path, 0o600)
  } catch {
    // best-effort
  }
}

export const resolveMode = (flags: GlobalFlags, _config: Config): TransportMode => {
  if (flags.kube) return 'kube'
  if (flags.grpc) return 'grpc'
  const envMode = process.env.AGENTCTL_MODE?.trim().toLowerCase()
  if (envMode === 'kube' || envMode === 'grpc') return envMode
  return 'kube'
}

const resolveExplicitAddress = (flags: GlobalFlags, config: Config) =>
  flags.address ||
  process.env.AGENTCTL_SERVER ||
  process.env.AGENTCTL_ADDRESS ||
  process.env.JANGAR_GRPC_ADDRESS ||
  config.address ||
  ''

export const resolveConfig = (flags: GlobalFlags, config: Config): ResolvedConfigResult => {
  const namespace = flags.namespace || process.env.AGENTCTL_NAMESPACE || config.namespace || DEFAULT_NAMESPACE
  const mode = resolveMode(flags, config)
  const explicitAddress = resolveExplicitAddress(flags, config)
  const address = explicitAddress || DEFAULT_ADDRESS
  const token = flags.token || process.env.AGENTCTL_TOKEN || process.env.JANGAR_GRPC_TOKEN || config.token
  const tls = flags.tls !== undefined ? flags.tls : (parseBoolean(process.env.AGENTCTL_TLS) ?? config.tls ?? false)
  const kubeconfig = flags.kubeconfig || process.env.AGENTCTL_KUBECONFIG || config.kubeconfig
  const context = flags.context || process.env.AGENTCTL_CONTEXT || config.context
  const output = normalizeOutput(flags.output) as OutputFormat

  const warnings: string[] = []
  if (mode === 'kube' && explicitAddress) {
    warnings.push('gRPC address configured; use --grpc to enable gRPC mode.')
  }

  return {
    resolved: {
      namespace,
      mode,
      address,
      token,
      tls,
      kubeconfig,
      context,
      output,
    },
    warnings,
  }
}
