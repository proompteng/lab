import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import * as grpc from '@grpc/grpc-js'
import { fromJSON } from '@grpc/proto-loader'
import * as protobuf from 'protobufjs'

import { EMBEDDED_AGENTCTL_PROTO } from '../src/embedded-proto'

const DEFAULT_TIMEOUT_MS = 10_000

type Options = {
  binaryPath?: string
  server?: string
  timeoutMs: number
  useMock: boolean
}

const usage = () => {
  console.log(`Usage: bun run scripts/validate-binary.ts [options]

Options:
  --server <addr>   gRPC server address (defaults to AGENTCTL_VALIDATE_SERVER or a mock server)
  --mock            start a local mock gRPC server instead of using --server
  --binary <path>   agentctl binary path (default: dist/agentctl or AGENTCTL_BINARY)
  --timeout <ms>    timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
`)
}

const parseArgs = (argv: string[]): Options => {
  const options: Options = { timeoutMs: DEFAULT_TIMEOUT_MS, useMock: false }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === '--server') {
      options.server = argv[++i]
      continue
    }
    if (arg === '--mock') {
      options.useMock = true
      continue
    }
    if (arg === '--binary') {
      options.binaryPath = argv[++i]
      continue
    }
    if (arg === '--timeout') {
      const value = Number(argv[++i])
      if (Number.isNaN(value) || value <= 0) {
        throw new Error('--timeout must be a positive number')
      }
      options.timeoutMs = value
      continue
    }
    if (arg === '--help' || arg === '-h') {
      usage()
      throw new Error('help requested')
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

const resolveBinary = (override?: string) => {
  if (override) return override
  const env = process.env.AGENTCTL_BINARY?.trim()
  if (env) return env
  return resolve(process.cwd(), 'dist', 'agentctl')
}

type AgentctlServiceDefinition = grpc.ServiceClientConstructor & { service?: grpc.ServiceDefinition }

const loadAgentctlServiceDefinition = (): grpc.ServiceDefinition => {
  const root = protobuf.parse(EMBEDDED_AGENTCTL_PROTO, { keepCase: true }).root
  const packageDefinition = fromJSON(root.toJSON(), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  })

  const loaded = grpc.loadPackageDefinition(packageDefinition) as {
    proompteng?: { jangar?: { v1?: { AgentctlService: AgentctlServiceDefinition } } }
  }

  const service = loaded.proompteng?.jangar?.v1?.AgentctlService
  const definition = service?.service
  if (!definition) {
    throw new Error('agentctl proto missing AgentctlService definition')
  }
  return definition
}

const startMockServer = async () => {
  const server = new grpc.Server()
  server.addService(loadAgentctlServiceDefinition(), {
    GetServerInfo: (_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      callback(null, {
        version: '0.0.0-test',
        build_sha: 'mock',
        build_time: new Date().toISOString(),
        service: 'mock',
      })
    },
  })

  const address = await new Promise<string>((resolveAddress, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error)
        return
      }
      resolveAddress(`127.0.0.1:${port}`)
    })
  })

  return {
    address,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.tryShutdown((error) => {
          if (error) {
            reject(error)
            return
          }
          resolveClose()
        })
      }),
  }
}

const main = async () => {
  const options = parseArgs(Bun.argv.slice(2))
  const envServer = process.env.AGENTCTL_VALIDATE_SERVER?.trim()
  const useMock = options.useMock || (!options.server && !envServer)
  if (options.useMock && options.server) {
    throw new Error('--mock cannot be combined with --server')
  }
  const mockServer = useMock ? await startMockServer() : null
  const server = options.server ?? envServer ?? mockServer?.address
  const binaryPath = resolveBinary(options.binaryPath)

  if (!server) {
    throw new Error('No gRPC server address resolved')
  }

  if (!existsSync(binaryPath)) {
    throw new Error(`agentctl binary not found at ${binaryPath}; run bun run build:bin first`)
  }

  let stdout = ''
  let stderr = ''
  let exitCode = 1

  try {
    const proc = Bun.spawn([binaryPath, 'version', '--server', server], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const timeout = setTimeout(() => {
      proc.kill()
    }, options.timeoutMs)

    ;[stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    clearTimeout(timeout)
  } finally {
    if (mockServer) {
      await mockServer.close()
    }
  }

  if (exitCode !== 0) {
    throw new Error(`agentctl failed with exit code ${exitCode}\n${stderr || stdout}`)
  }

  const output = `${stdout}${stderr}`.trim()
  if (!output.toLowerCase().includes('agentctl') || !output.toLowerCase().includes('server')) {
    throw new Error(`agentctl version output missing server info:\n${output}`)
  }

  console.log('agentctl compiled binary validated')
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
