#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import * as grpc from '@grpc/grpc-js'
import { loadSync } from '@grpc/proto-loader'
import YAML from 'yaml'

const EXIT_VALIDATION = 2
const EXIT_RUNTIME = 4
const EXIT_UNKNOWN = 5

const DEFAULT_NAMESPACE = 'agents'
const DEFAULT_ADDRESS = '127.0.0.1:50051'

type Config = {
  namespace?: string
  address?: string
  token?: string
  tls?: boolean
}

type GlobalFlags = {
  namespace?: string
  address?: string
  token?: string
  output?: string
  tls?: boolean
}

type RuntimeEntry = { key: string; value: string }

type AgentctlPackage = {
  AgentctlService: grpc.ServiceClientConstructor
}

const getVersion = () => {
  const env = process.env.AGENTCTL_VERSION?.trim()
  if (env) return env
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('../package.json') as { version?: string }
    if (pkg?.version) return pkg.version
  } catch {
    // ignore
  }
  return 'dev'
}

const usage = (version: string) =>
  `
agentctl ${version}

Usage:
  agentctl version
  agentctl config view|set --namespace <ns> [--address <addr>] [--token <token>]
  agentctl completion <shell>

  agentctl agent get <name>
  agentctl agent list
  agentctl agent apply -f <file>
  agentctl agent delete <name>

  agentctl impl get <name>
  agentctl impl list
  agentctl impl create --text <text> [--summary <text>] [--source provider=github,externalId=...,url=...]
  agentctl impl apply -f <file>
  agentctl impl delete <name>

  agentctl source list
  agentctl source get <name>
  agentctl source apply -f <file>
  agentctl source delete <name>

  agentctl memory list
  agentctl memory get <name>
  agentctl memory apply -f <file>
  agentctl memory delete <name>

  agentctl run submit --agent <name> --impl <name> --runtime <type> [flags]
  agentctl run apply -f <file>
  agentctl run get <name>
  agentctl run list
  agentctl run logs <name> [--follow]
  agentctl run cancel <name>

Global flags:
  --namespace <ns>
  --address <host:port>
  --token <token>
  --output <yaml|json|table>
  --tls

Run submit flags:
  --workload-image <image>
  --cpu <value>
  --memory <value>
  --memory-ref <name>
  --param key=value
  --runtime-config key=value
  --idempotency-key <value>
  --wait
`.trim()

const parseBoolean = (raw: string | undefined) => {
  if (!raw) return undefined
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 't', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'f', 'no', 'n', 'off'].includes(normalized)) return false
  return undefined
}

const resolveConfigPath = () => {
  const base = process.env.XDG_CONFIG_HOME?.trim() || resolve(homedir(), '.config')
  return resolve(base, 'agentctl', 'config.json')
}

const loadConfig = async (): Promise<Config> => {
  const path = resolveConfigPath()
  if (!existsSync(path)) return {}
  const raw = await readFile(path, 'utf8')
  try {
    return JSON.parse(raw) as Config
  } catch {
    return {}
  }
}

const saveConfig = async (config: Config) => {
  const path = resolveConfigPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

const parseGlobalFlags = (argv: string[]) => {
  const flags: GlobalFlags = {}
  const rest: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === '--namespace' || arg === '-n') {
      flags.namespace = argv[++i]
      continue
    }
    if (arg === '--address') {
      flags.address = argv[++i]
      continue
    }
    if (arg === '--token') {
      flags.token = argv[++i]
      continue
    }
    if (arg === '--output' || arg === '-o') {
      flags.output = argv[++i]
      continue
    }
    if (arg === '--tls') {
      flags.tls = true
      continue
    }
    rest.push(arg)
  }
  return { flags, rest }
}

const resolveNamespace = (flags: GlobalFlags, config: Config) =>
  flags.namespace || process.env.AGENTCTL_NAMESPACE || config.namespace || DEFAULT_NAMESPACE

const resolveAddress = (flags: GlobalFlags, config: Config) =>
  flags.address || process.env.AGENTCTL_ADDRESS || process.env.JANGAR_GRPC_ADDRESS || config.address || DEFAULT_ADDRESS

const resolveToken = (flags: GlobalFlags, config: Config) =>
  flags.token || process.env.AGENTCTL_TOKEN || process.env.JANGAR_GRPC_TOKEN || config.token

const resolveTls = (flags: GlobalFlags, config: Config) => {
  if (flags.tls !== undefined) return flags.tls
  const env = parseBoolean(process.env.AGENTCTL_TLS)
  if (env !== undefined) return env
  return config.tls ?? false
}

const resolveProtoPath = () => {
  const envPath = process.env.AGENTCTL_PROTO_PATH?.trim()
  if (envPath && existsSync(envPath)) return envPath

  const moduleDir = resolve(fileURLToPath(import.meta.url), '..')
  const packageRoot = resolve(moduleDir, '..')

  const candidates = [
    resolve(packageRoot, 'proto/proompteng/jangar/v1/agentctl.proto'),
    resolve(packageRoot, '../../proto/proompteng/jangar/v1/agentctl.proto'),
    resolve(process.cwd(), 'proto/proompteng/jangar/v1/agentctl.proto'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const loadAgentctlPackage = (): AgentctlPackage => {
  const protoPath = resolveProtoPath()
  if (!protoPath) {
    throw new Error('agentctl proto not found; set AGENTCTL_PROTO_PATH')
  }

  const packageDefinition = loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  })

  const loaded = grpc.loadPackageDefinition(packageDefinition) as {
    proompteng?: { jangar?: { v1?: AgentctlPackage } }
  }

  const pkg = loaded.proompteng?.jangar?.v1
  if (!pkg?.AgentctlService) {
    throw new Error('agentctl proto missing AgentctlService definition')
  }
  return pkg
}

const resolveCredentials = async (tlsEnabled: boolean) => {
  if (!tlsEnabled) return grpc.credentials.createInsecure()

  const caPath = process.env.AGENTCTL_CA_CERT
  const certPath = process.env.AGENTCTL_CLIENT_CERT
  const keyPath = process.env.AGENTCTL_CLIENT_KEY

  const rootCert = caPath ? await readFile(caPath) : undefined
  const clientCert = certPath ? await readFile(certPath) : undefined
  const clientKey = keyPath ? await readFile(keyPath) : undefined

  return grpc.credentials.createSsl(rootCert, clientKey, clientCert)
}

const createClient = async (address: string, tlsEnabled: boolean) => {
  const pkg = loadAgentctlPackage()
  const creds = await resolveCredentials(tlsEnabled)
  return new pkg.AgentctlService(address, creds) as grpc.Client
}

const createMetadata = (token?: string) => {
  const metadata = new grpc.Metadata()
  if (token) {
    metadata.add('authorization', `Bearer ${token}`)
  }
  return metadata
}

const callUnary = <Response>(
  client: grpc.Client,
  method: string,
  request: Record<string, unknown>,
  metadata: grpc.Metadata,
): Promise<Response> =>
  new Promise((resolve, reject) => {
    const fn = (client as unknown as Record<string, (...args: unknown[]) => void>)[method]
    if (!fn) {
      reject(new Error(`Unknown RPC method ${method}`))
      return
    }
    fn.call(client, request, metadata, (error: grpc.ServiceError | null, response: Response) => {
      if (error) {
        reject(error)
      } else {
        resolve(response)
      }
    })
  })

const parseOutput = (value: string | undefined) => value ?? 'table'

const parseJson = (value: string) => {
  if (!value) return null
  return JSON.parse(value) as Record<string, unknown>
}

const formatAge = (timestamp?: string) => {
  if (!timestamp) return ''
  const created = Date.parse(timestamp)
  if (Number.isNaN(created)) return ''
  const diffMs = Date.now() - created
  const seconds = Math.max(0, Math.floor(diffMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

const toRow = (resource: Record<string, unknown>) => {
  const metadata = (resource.metadata ?? {}) as Record<string, unknown>
  const status = (resource.status ?? {}) as Record<string, unknown>
  const conditions = Array.isArray(status.conditions) ? status.conditions : []
  const ready = conditions.find((item) => (item as { type?: string }).type === 'Ready') as
    | { status?: string }
    | undefined
  const phase = status.phase ?? ready?.status ?? ''
  return {
    name: metadata.name ?? metadata.generateName ?? '',
    namespace: metadata.namespace ?? '',
    kind: resource.kind ?? '',
    age: formatAge(typeof metadata.creationTimestamp === 'string' ? metadata.creationTimestamp : undefined),
    status: typeof phase === 'string' ? phase : '',
  }
}

const outputResource = (resource: Record<string, unknown>, output: string) => {
  if (output === 'json') {
    console.log(JSON.stringify(resource, null, 2))
    return
  }
  if (output === 'yaml') {
    console.log(YAML.stringify(resource))
    return
  }
  console.table([toRow(resource)])
}

const outputList = (resource: Record<string, unknown>, output: string) => {
  if (output === 'json') {
    console.log(JSON.stringify(resource, null, 2))
    return
  }
  if (output === 'yaml') {
    console.log(YAML.stringify(resource))
    return
  }
  const items = Array.isArray(resource.items) ? (resource.items as Record<string, unknown>[]) : []
  console.table(items.map(toRow))
}

const parseKeyValueList = (values: string[]) => {
  const output: RuntimeEntry[] = []
  for (const item of values) {
    const [key, ...rest] = item.split('=')
    if (!key) continue
    output.push({ key, value: rest.join('=') })
  }
  return output
}

const parseSource = (raw?: string) => {
  if (!raw) return undefined
  const fields = raw.split(',').map((entry) => entry.trim())
  const source: Record<string, string> = {}
  for (const field of fields) {
    const [key, ...rest] = field.split('=')
    if (!key) continue
    source[key] = rest.join('=')
  }
  if (!source.provider) return undefined
  if (!source.externalId && source.external_id) {
    source.externalId = source.external_id
  }
  return source
}

const handleCompletion = (shell: string) => {
  if (shell === 'bash' || shell === 'zsh') {
    console.log(`# ${shell} completion for agentctl
_agentctl_complete() {
  COMPREPLY=()
  local cur="${COMP_WORDS[COMP_CWORD]}"
  local cmds="version config completion agent impl source memory run"
  COMPREPLY=( $(compgen -W "$cmds" -- "$cur") )
}
complete -F _agentctl_complete agentctl
`)
    return 0
  }
  if (shell === 'fish') {
    console.log('complete -c agentctl -f -a "version config completion agent impl source memory run"')
    return 0
  }
  console.error(`Unsupported shell: ${shell}`)
  return EXIT_VALIDATION
}

const waitForRunCompletion = async (
  client: grpc.Client,
  metadata: grpc.Metadata,
  name: string,
  namespace: string,
  output: string,
) => {
  const deadline = Date.now() + 60 * 60 * 1000
  while (Date.now() < deadline) {
    const response = await callUnary<{ json: string }>(client, 'GetAgentRun', { name, namespace }, metadata)
    const resource = parseJson(response.json)
    if (resource) {
      const status = (resource.status ?? {}) as Record<string, unknown>
      const phase = typeof status.phase === 'string' ? status.phase : ''
      if (['Succeeded', 'Failed', 'Cancelled'].includes(phase)) {
        console.log(`AgentRun ${name} ${phase}`)
        if (output !== 'table') {
          outputResource(resource, output)
        }
        return 0
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  console.error('Timed out waiting for AgentRun completion')
  return EXIT_RUNTIME
}

const readFileContent = async (file: string) => {
  const content = await readFile(file, 'utf8')
  if (!content.trim()) throw new Error(`File ${file} is empty`)
  return content
}

const main = async () => {
  const version = getVersion()
  try {
    const { flags, rest } = parseGlobalFlags(process.argv.slice(2))
    const [command, subcommand, ...args] = rest

    if (!command || command === 'help' || command === '--help' || command === '-h') {
      console.log(usage(version))
      return 0
    }

    const config = await loadConfig()
    const output = parseOutput(flags.output)

    if (command === 'config') {
      if (subcommand === 'view') {
        console.log(JSON.stringify(config, null, 2))
        return 0
      }
      if (subcommand === 'set') {
        const next: Config = { ...config }
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === '--namespace' || args[i] === '-n') {
            next.namespace = args[++i]
          }
          if (args[i] === '--address') {
            next.address = args[++i]
          }
          if (args[i] === '--token') {
            next.token = args[++i]
          }
        }
        if (!next.namespace && !next.address && !next.token) {
          throw new Error('config set requires at least one of --namespace, --address, or --token')
        }
        await saveConfig(next)
        console.log(`Updated ${resolveConfigPath()}`)
        return 0
      }
    }

    if (command === 'completion') {
      const shell = subcommand ?? ''
      return handleCompletion(shell)
    }

    const address = resolveAddress(flags, config)
    const namespace = resolveNamespace(flags, config)
    const token = resolveToken(flags, config)
    const tlsEnabled = resolveTls(flags, config)
    const metadata = createMetadata(token)
    const client = await createClient(address, tlsEnabled)

    if (command === 'version') {
      const response = await callUnary<{ version: string; build_sha?: string; build_time?: string }>(
        client,
        'GetServerInfo',
        {},
        metadata,
      )
      console.log(`agentctl ${version}`)
      console.log(`server ${response.version}`)
      if (response.build_sha) {
        console.log(`build ${response.build_sha}${response.build_time ? ` (${response.build_time})` : ''}`)
      }
      return 0
    }

    if (command === 'agent' || command === 'impl' || command === 'source' || command === 'memory') {
      const resourceMap: Record<string, { list: string; get: string; apply: string; del: string; create?: string }> = {
        agent: {
          list: 'ListAgents',
          get: 'GetAgent',
          apply: 'ApplyAgent',
          del: 'DeleteAgent',
        },
        impl: {
          list: 'ListImplementationSpecs',
          get: 'GetImplementationSpec',
          apply: 'ApplyImplementationSpec',
          del: 'DeleteImplementationSpec',
          create: 'CreateImplementationSpec',
        },
        source: {
          list: 'ListImplementationSources',
          get: 'GetImplementationSource',
          apply: 'ApplyImplementationSource',
          del: 'DeleteImplementationSource',
        },
        memory: {
          list: 'ListMemories',
          get: 'GetMemory',
          apply: 'ApplyMemory',
          del: 'DeleteMemory',
        },
      }

      const rpc = resourceMap[command]
      if (subcommand === 'get') {
        const response = await callUnary<{ json: string }>(client, rpc.get, { name: args[0], namespace }, metadata)
        const resource = parseJson(response.json)
        if (resource) outputResource(resource, output)
        return 0
      }
      if (subcommand === 'list') {
        const response = await callUnary<{ json: string }>(client, rpc.list, { namespace }, metadata)
        const resource = parseJson(response.json)
        if (resource) outputList(resource, output)
        return 0
      }
      if (subcommand === 'apply') {
        const fileIndex = args.indexOf('-f')
        const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined
        if (!file) {
          throw new Error('apply requires -f <file>')
        }
        const manifest = await readFileContent(file)
        const response = await callUnary<{ json: string }>(
          client,
          rpc.apply,
          { namespace, manifest_yaml: manifest },
          metadata,
        )
        const resource = parseJson(response.json)
        if (resource) outputResource(resource, output)
        return 0
      }
      if (subcommand === 'delete') {
        const response = await callUnary<{ ok: boolean; message?: string }>(
          client,
          rpc.del,
          { name: args[0], namespace },
          metadata,
        )
        console.log(response.message ?? 'deleted')
        return 0
      }
      if (command === 'impl' && subcommand === 'create') {
        let text = ''
        let summary: string | undefined
        let source: Record<string, string> | undefined
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === '--text') text = args[++i]
          if (args[i] === '--summary') summary = args[++i]
          if (args[i] === '--source') source = parseSource(args[++i])
        }
        if (!text) {
          throw new Error('--text is required')
        }
        const response = await callUnary<{ json: string }>(
          client,
          rpc.create ?? 'CreateImplementationSpec',
          {
            namespace,
            text,
            summary: summary ?? '',
            source: source
              ? {
                  provider: source.provider,
                  external_id: source.externalId ?? '',
                  url: source.url ?? '',
                }
              : undefined,
          },
          metadata,
        )
        const resource = parseJson(response.json)
        if (resource) outputResource(resource, output)
        return 0
      }
    }

    if (command === 'run') {
      if (subcommand === 'submit') {
        const params: Record<string, string[]> = { param: [], runtimeConfig: [] }
        const options: Record<string, string> = {}

        for (let i = 0; i < args.length; i += 1) {
          const arg = args[i]
          if (!arg) continue
          if (arg === '--agent' || arg === '--impl' || arg === '--runtime' || arg === '--workload-image') {
            options[arg.slice(2)] = args[++i]
            continue
          }
          if (arg === '--cpu' || arg === '--memory' || arg === '--idempotency-key' || arg === '--memory-ref') {
            options[arg.slice(2)] = args[++i]
            continue
          }
          if (arg === '--param') {
            params.param.push(args[++i])
            continue
          }
          if (arg === '--runtime-config') {
            params.runtimeConfig.push(args[++i])
            continue
          }
          if (arg === '--wait') {
            options.wait = 'true'
          }
        }

        if (!options.agent || !options.impl || !options.runtime) {
          throw new Error('--agent, --impl, and --runtime are required')
        }

        const response = await callUnary<{
          resource_json: string
          record_json: string
          idempotent?: boolean
        }>(
          client,
          'SubmitAgentRun',
          {
            namespace,
            agent_name: options.agent,
            implementation_name: options.impl,
            runtime_type: options.runtime,
            runtime_config: parseKeyValueList(params.runtimeConfig),
            parameters: parseKeyValueList(params.param),
            idempotency_key: options['idempotency-key'] ?? '',
            workload: {
              image: options['workload-image'] ?? '',
              cpu: options.cpu ?? '',
              memory: options.memory ?? '',
            },
            memory_ref: options['memory-ref'] ?? '',
          },
          metadata,
        )

        if (response.resource_json) {
          const resource = parseJson(response.resource_json)
          if (resource) outputResource(resource, output)

          const runName = ((resource.metadata ?? {}) as { name?: string }).name
          if (options.wait === 'true' && runName) {
            return await waitForRunCompletion(client, metadata, runName, namespace, output)
          }
        }
        return 0
      }
      if (subcommand === 'apply') {
        const fileIndex = args.indexOf('-f')
        const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined
        if (!file) {
          throw new Error('apply requires -f <file>')
        }
        const manifest = await readFileContent(file)
        const response = await callUnary<{ json: string }>(
          client,
          'ApplyAgentRun',
          { namespace, manifest_yaml: manifest },
          metadata,
        )
        const resource = parseJson(response.json)
        if (resource) outputResource(resource, output)
        return 0
      }
      if (subcommand === 'get') {
        const response = await callUnary<{ json: string }>(
          client,
          'GetAgentRun',
          { name: args[0], namespace },
          metadata,
        )
        const resource = parseJson(response.json)
        if (resource) outputResource(resource, output)
        return 0
      }
      if (subcommand === 'list') {
        const response = await callUnary<{ json: string }>(client, 'ListAgentRuns', { namespace }, metadata)
        const resource = parseJson(response.json)
        if (resource) outputList(resource, output)
        return 0
      }
      if (subcommand === 'logs') {
        const stream = (client as unknown as Record<string, (...args: unknown[]) => grpc.ClientReadableStream<unknown>>)
          .StreamAgentRunLogs
        if (!stream) throw new Error('StreamAgentRunLogs not available')
        const follow = args.includes('--follow')
        const call = stream.call(client, { name: args[0], namespace, follow }, metadata)
        call.on('data', (entry: { stream?: string; message?: string }) => {
          const message = entry.message ?? ''
          if (entry.stream === 'stderr') {
            process.stderr.write(message)
          } else {
            process.stdout.write(message)
          }
        })
        await new Promise<void>((resolve, reject) => {
          call.on('end', () => resolve())
          call.on('error', (error) => reject(error))
        })
        return 0
      }
      if (subcommand === 'cancel') {
        const response = await callUnary<{ ok: boolean; message?: string }>(
          client,
          'CancelAgentRun',
          { name: args[0], namespace },
          metadata,
        )
        console.log(response.message ?? 'cancelled')
        return 0
      }
    }

    console.error('Unknown command')
    console.log(usage(version))
    return EXIT_VALIDATION
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    if (error && typeof error === 'object' && 'code' in error) {
      const code = (error as grpc.ServiceError).code
      if (code === grpc.status.INVALID_ARGUMENT) return EXIT_VALIDATION
      if (code === grpc.status.FAILED_PRECONDITION || code === grpc.status.NOT_FOUND) return EXIT_RUNTIME
    }
    return EXIT_UNKNOWN
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code))
}
