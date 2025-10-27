#!/usr/bin/env bun

import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { cwd, exit } from 'node:process'
import type { TemporalConfig } from '../config'
import { loadTemporalConfig } from '../config'
import type { NativeClient } from '../internal/core-bridge/native'

type CommandHandler = (args: string[], flags: Record<string, string | boolean>) => Promise<void>

const commands: Record<string, CommandHandler> = {
  init: handleInit,
  check: handleCheck,
  'docker-build': handleDockerBuild,
  help: async () => {
    printHelp()
  },
}

export const main = async () => {
  const [command = 'help', ...rest] = process.argv.slice(2)
  const { args, flags } = parseArgs(rest)
  const handler = commands[command]

  if (!handler) {
    console.error(`Unknown command "${command}".`)
    printHelp()
    exit(1)
    return
  }

  try {
    await handler(args, flags)
  } catch (error) {
    console.error((error as Error).message ?? error)
    exit(1)
  }
}

export function parseArgs(argv: string[]) {
  const args: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (!value.startsWith('-')) {
      args.push(value)
      continue
    }

    const flag = value.replace(/^-+/, '')
    const next = argv[i + 1]

    if (next && !next.startsWith('-')) {
      flags[flag] = next
      i++
    } else {
      flags[flag] = true
    }
  }

  return { args, flags }
}

type NativeBridge = typeof import('../internal/core-bridge/native').native
let cachedNativeBridge: NativeBridge | undefined

const loadNativeBridge = async (): Promise<NativeBridge> => {
  if (!cachedNativeBridge) {
    const module = await import('../internal/core-bridge/native')
    cachedNativeBridge = module.native
  }
  return cachedNativeBridge
}

type CheckDeps = {
  loadConfig?: typeof loadTemporalConfig
  nativeBridge?: NativeBridge
  log?: (message: string) => void
}

export const formatTemporalAddress = (address: string, hasTls: boolean): string => {
  if (/^[a-z]+:\/\//i.test(address)) {
    return address
  }
  return `${hasTls ? 'https' : 'http'}://${address}`
}

export async function handleCheck(
  args: string[],
  flags: Record<string, string | boolean>,
  deps: CheckDeps = {},
): Promise<void> {
  const loadConfig = deps.loadConfig ?? loadTemporalConfig
  const log = deps.log ?? console.log
  const nativeBridge = deps.nativeBridge ?? (await loadNativeBridge())

  const config = await loadConfig()
  if (config.allowInsecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  }

  const namespaceFlag = typeof flags.namespace === 'string' ? flags.namespace.trim() : ''
  const namespaceArg = args[0]?.trim()
  const namespace = namespaceFlag || namespaceArg || config.namespace

  const hasProtocol = /^[a-z]+:\/\//i.test(config.address)
  const shouldUseTls = Boolean(config.tls || config.allowInsecureTls)
  const address = hasProtocol ? config.address : formatTemporalAddress(config.address, shouldUseTls)

  const runtime = nativeBridge.createRuntime({})
  let client: NativeClient | undefined

  try {
    const clientConfig: Record<string, unknown> = {
      address,
      namespace,
      identity: config.workerIdentity,
      allowInsecureTls: config.allowInsecureTls,
    }

    if (config.apiKey) {
      clientConfig.apiKey = config.apiKey
    }

    if (config.tls) {
      clientConfig.tls = serializeTlsConfig(config.tls)
    }

    client = await nativeBridge.createClient(runtime, clientConfig)

    const describePayload = await nativeBridge.describeNamespace(client, namespace)
    log(
      [
        `Temporal connection successful.`,
        `  Address:    ${address}`,
        `  Namespace:  ${namespace}`,
        `  Payload:    ${describePayload.byteLength} bytes (DescribeNamespace)`,
      ].join('\n'),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to reach Temporal at ${config.address}: ${message}`)
  } finally {
    if (client) {
      nativeBridge.clientShutdown(client)
    }
    nativeBridge.runtimeShutdown(runtime)
  }
}

const serializeTlsConfig = (tls: NonNullable<TemporalConfig['tls']>) => {
  const serialized: Record<string, unknown> = {}
  if (tls.serverRootCACertificate) {
    serialized.serverRootCACertificate = tls.serverRootCACertificate.toString('base64')
  }
  if (tls.serverNameOverride) {
    serialized.serverNameOverride = tls.serverNameOverride
  }
  if (tls.clientCertPair) {
    serialized.clientCertPair = {
      crt: tls.clientCertPair.crt.toString('base64'),
      key: tls.clientCertPair.key.toString('base64'),
    }
  }
  return serialized
}

async function handleInit(args: string[], flags: Record<string, string | boolean>) {
  const target = args[0] ? resolve(cwd(), args[0]) : cwd()
  const projectName = inferPackageName(target)
  const force = Boolean(flags.force)

  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true })
  }

  console.log(`Scaffolding Temporal worker project in ${target}`)

  for (const template of projectTemplates(projectName)) {
    const filePath = join(target, template.path)
    const dir = dirname(filePath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }
    if (existsSync(filePath) && !force) {
      console.warn(`Skipping existing file: ${template.path} (use --force to overwrite)`)
      continue
    }

    await writeFile(filePath, template.contents, 'utf8')
    console.log(`Created ${template.path}`)
  }

  console.log('\nNext steps:')
  console.log(`  cd ${target}`)
  console.log('  bun install')
  console.log('  bun run dev   # runs the worker locally')
  console.log('  bun run docker:build --tag my-worker:latest')
}

async function handleDockerBuild(_args: string[], flags: Record<string, string | boolean>) {
  const tag = (flags.tag as string) ?? 'temporal-worker:latest'
  const context = resolve(cwd(), (flags.context as string) ?? '.')
  const dockerfile = resolve(cwd(), (flags.file as string) ?? 'Dockerfile')

  const buildArgs = ['build', '-t', tag, '-f', dockerfile, context]
  console.log(`Running docker ${buildArgs.join(' ')}`)

  const process = Bun.spawn(['docker', ...buildArgs], {
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const exitCode = await process.exited
  if (exitCode !== 0) {
    throw new Error(`docker build exited with code ${exitCode}`)
  }
}

function printHelp() {
  console.log(`temporal-bun <command> [options]

Commands:
  init [directory]        Scaffold a new Temporal worker project
  check [namespace]       Verify Temporal connectivity using the native bridge
  docker-build            Build a Docker image for the current project
  help                    Show this help message

Options:
  --force                 Overwrite existing files during init
  --namespace <name>      Target namespace for the check command (default from env/config)
  --tag <name>            Image tag for docker-build (default: temporal-worker:latest)
  --context <path>        Build context for docker-build (default: .)
  --file <path>           Dockerfile path for docker-build (default: ./Dockerfile)
`)
}

export function inferPackageName(dir: string): string {
  const base = basename(resolve(dir))
  return (
    base
      .replace(/[^a-z0-9-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'temporal-worker'
  )
}

export type Template = {
  path: string
  contents: string
}

export function projectTemplates(name: string): Template[] {
  return [
    {
      path: 'package.json',
      contents: JSON.stringify(
        {
          name,
          version: '0.1.0',
          private: true,
          type: 'module',
          scripts: {
            dev: 'bun run src/worker.ts',
            'worker:start': 'bun run src/worker.ts',
            'docker:build': 'bun run scripts/build-docker.ts --tag temporal-worker:latest',
          },
          dependencies: {
            '@proompteng/temporal-bun-sdk': '^0.1.0',
          },
          devDependencies: {
            'bun-types': '^1.1.20',
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'bunfig.toml',
      contents: `[install]
peer = true
`,
    },
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            module: 'esnext',
            target: 'es2022',
            moduleResolution: 'bundler',
            strict: true,
            noEmit: true,
          },
          include: ['src'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/activities/index.ts',
      contents: `export type Activities = {
  echo(input: { message: string }): Promise<string>
  sleep(milliseconds: number): Promise<void>
}

export const echo: Activities['echo'] = async ({ message }) => {
  return message
}

export const sleep: Activities['sleep'] = async (milliseconds) => {
  await Bun.sleep(milliseconds)
}
`,
    },
    {
      path: 'src/workflows/hello-workflow.ts',
      contents: `import { proxyActivities } from '@proompteng/temporal-bun-sdk/workflow'
import type { Activities } from '../activities/index.ts'

const activities = proxyActivities<Activities>({
  startToCloseTimeout: '1 minute',
})

export async function helloWorkflow(name: string): Promise<string> {
  await activities.sleep(10)
  return await activities.echo({ message: \`Hello, \${name}!\` })
}
`,
    },
    {
      path: 'src/workflows/index.ts',
      contents: `export * from './hello-workflow.ts'
`,
    },
    {
      path: 'src/worker.ts',
      contents: `import { fileURLToPath } from 'node:url'
import { createWorker } from '@proompteng/temporal-bun-sdk/worker'
import * as activities from './activities/index.ts'

const main = async () => {
  const { worker } = await createWorker({
    activities,
    workflowsPath: fileURLToPath(new URL('./workflows/index.ts', import.meta.url)),
  })

  const shutdown = async (signal: string) => {
    console.log(\`Received \${signal}. Shutting down worker…\`)
    await worker.shutdown()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await worker.run()
}

await main().catch((error) => {
  console.error('Worker crashed:', error)
  process.exit(1)
})
`,
    },
    {
      path: 'scripts/build-docker.ts',
      contents: `#!/usr/bin/env bun

const { args, flags } = parseArgs(process.argv.slice(2))
const tag = (flags.tag as string) ?? 'temporal-worker:latest'
const dockerfile = (flags.file as string) ?? 'Dockerfile'
const context = (flags.context as string) ?? '.'

const buildArgs = ['build', '-t', tag, '-f', dockerfile, context]
console.log(\`docker \${buildArgs.join(' ')}\`)

const proc = Bun.spawn(['docker', ...buildArgs], {
  stdout: 'inherit',
  stderr: 'inherit',
})

const exitCode = await proc.exited
if (exitCode !== 0) {
  throw new Error(\`docker build exited with code \${exitCode}\`)
}

function parseArgs(argv: string[]) {
  const args: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (!value.startsWith('-')) {
      args.push(value)
      continue
    }
    const flag = value.replace(/^-+/, '')
    const next = argv[i + 1]
    if (next && !next.startsWith('-')) {
      flags[flag] = next
      i++
    } else {
      flags[flag] = true
    }
  }
  return { args, flags }
}
`,
    },
    {
      path: 'Dockerfile',
      contents: `# syntax=docker/dockerfile:1.6

FROM oven/bun:1.1.20
WORKDIR /app

COPY package.json bunfig.toml tsconfig.json ./
RUN bun install --production

COPY src ./src

CMD ["bun", "run", "src/worker.ts"]
`,
    },
    {
      path: '.dockerignore',
      contents: `node_modules
tmp
dist
.DS_Store
`,
    },
    {
      path: '.gitignore',
      contents: `node_modules
.env
.DS_Store
`,
    },
    {
      path: 'README.md',
      contents: `# ${name}

Generated with \`temporal-bun init\`.

## Development

\`\`\`bash
bun install
bun run dev
\`\`\`

## Packaging

\`\`\`bash
bun run docker:build --tag ${name}:latest
\`\`\`
`,
    },
  ]
}

if (import.meta.main) {
  await main()
}
