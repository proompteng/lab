#!/usr/bin/env bun

import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { cwd, exit } from 'node:process'
import { Effect } from 'effect'
import { loadTemporalConfig } from '../config'
import { createObservabilityServices } from '../observability'
import { handleReplay } from './replay-command'

type CommandResult = { exitCode?: number }

type CommandHandler = (args: string[], flags: Record<string, string | boolean>) => Promise<CommandResult | undefined>

const commands: Record<string, CommandHandler> = {
  init: handleInit,
  'docker-build': handleDockerBuild,
  doctor: handleDoctor,
  replay: handleReplay,
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
    const result = await handler(args, flags)
    if (result && typeof result.exitCode === 'number') {
      exit(result.exitCode)
      return
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    exit(1)
  }
}

export function parseArgs(argv: string[]) {
  const args: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (!value.startsWith('-')) {
      args.push(value)
      continue
    }

    const trimmed = value.replace(/^-+/, '')
    if (trimmed.length === 0) {
      continue
    }

    const equalsIndex = trimmed.indexOf('=')
    if (equalsIndex !== -1) {
      const key = trimmed.slice(0, equalsIndex)
      const flagValue = trimmed.slice(equalsIndex + 1)
      flags[key] = flagValue
      continue
    }

    const key = trimmed
    const next = argv[index + 1]
    if (next && !next.startsWith('-')) {
      flags[key] = next
      index++
      continue
    }

    flags[key] = true
  }

  return { args, flags }
}

function printHelp() {
  console.log(`temporal-bun <command> [options]

Commands:
  init [directory]        Scaffold a new Temporal worker project
  docker-build            Build a Docker image for the current project
  doctor                  Validate configuration + observability sinks
  replay                  Replay workflow histories to diff determinism
  help                    Show this help message

Options:
  --force                 Overwrite existing files during init
  --tag <name>            Image tag for docker-build (default: temporal-worker:latest)
  --context <path>        Build context for docker-build (default: .)
  --file <path>           Dockerfile path for docker-build (default: ./Dockerfile)
  --log-format <format>   Set TEMPORAL_LOG_FORMAT for doctor (json|pretty)
  --log-level <level>     Set TEMPORAL_LOG_LEVEL for doctor (debug|info|warn|error)
  --metrics <spec>        Set metrics exporter spec for doctor (e.g., file:/tmp/metrics.json)
  --metrics-exporter <name>
                          Alternate way to set TEMPORAL_METRICS_EXPORTER
  --metrics-endpoint <url>
                          Endpoint path/URL for the selected metrics exporter
  --history-file <path>   Replay a workflow history JSON file
  --execution <workflowId/runId>
                          Fetch workflow history via Temporal CLI/Service
  --workflow-type <name>  Workflow type for the replay diagnostics
  --namespace <name>      Override namespace for replay or worker helpers
  --temporal-cli <path>   Override the Temporal CLI binary for replay
  --source <cli|service|auto>
                          Force a history source when replaying live executions
  --json                  Emit a JSON replay summary alongside console output
`)
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

function normalizeStringFlag(value: string | boolean | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function parseMetricsSpec(value?: string): { exporter?: string; endpoint?: string } {
  if (!value) {
    return {}
  }
  const colon = value.indexOf(':')
  if (colon === -1) {
    return { exporter: value }
  }
  const exporter = value.slice(0, colon)
  const endpoint = value.slice(colon + 1)
  return { exporter, endpoint: endpoint.length > 0 ? endpoint : undefined }
}

function buildDoctorOverrides(flags: Record<string, string | boolean>): Record<string, string> {
  const overrides: Record<string, string> = {}
  const setEnv = (key: string, flag: string | boolean | undefined) => {
    const value = normalizeStringFlag(flag)
    if (value) {
      overrides[key] = value
    }
  }
  setEnv('TEMPORAL_LOG_FORMAT', flags['log-format'])
  setEnv('TEMPORAL_LOG_LEVEL', flags['log-level'])

  const metricsSpec = parseMetricsSpec(normalizeStringFlag(flags.metrics))
  const exporter = normalizeStringFlag(flags['metrics-exporter']) ?? metricsSpec.exporter
  const endpoint = normalizeStringFlag(flags['metrics-endpoint']) ?? metricsSpec.endpoint
  if (exporter) {
    overrides.TEMPORAL_METRICS_EXPORTER = exporter
  }
  if (endpoint) {
    overrides.TEMPORAL_METRICS_ENDPOINT = endpoint
  }

  return overrides
}

async function handleDoctor(_args: string[], flags: Record<string, string | boolean>) {
  const overrides = buildDoctorOverrides(flags)
  const config = await loadTemporalConfig({ env: { ...process.env, ...overrides } })

  const observability = await Effect.runPromise(
    createObservabilityServices({
      logLevel: config.logLevel,
      logFormat: config.logFormat,
      metrics: config.metricsExporter,
    }),
  )
  const { logger, metricsRegistry, metricsExporter } = observability

  const doctorCounter = await Effect.runPromise(
    metricsRegistry.counter('temporal_bun_doctor_runs_total', 'Temporal CLI doctor command executions'),
  )
  await Effect.runPromise(doctorCounter.inc())
  await Effect.runPromise(
    logger.log('info', 'temporal-bun doctor validation succeeded', {
      namespace: config.namespace,
      taskQueue: config.taskQueue,
      logFormat: config.logFormat,
      metricsExporter: config.metricsExporter.type,
    }),
  )
  await Effect.runPromise(metricsExporter.flush())

  console.log('temporal-bun doctor complete — configuration validated and metrics sink flushed.')
  if (config.metricsExporter.type !== 'in-memory') {
    console.log(`  metrics sink: ${config.metricsExporter.type} ${config.metricsExporter.endpoint ?? ''}`)
  }
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
            effect: '^3.2.0',
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
      path: 'src/workflows/index.ts',
      contents: [
        "import { Effect } from 'effect'",
        "import * as Schema from 'effect/Schema'",
        "import { defineWorkflow } from '@proompteng/temporal-bun-sdk/workflow'",
        '',
        'export const workflows = [',
        '  defineWorkflow(',
        "    'helloWorkflow',",
        '    Schema.Array(Schema.String),',
        '    ({ input }) =>',
        '      Effect.sync(() => {',
        '        const [rawName] = input',
        "        const name = typeof rawName === 'string' && rawName.length > 0 ? rawName : 'Temporal'",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: template placeholder required in generated file
        '        return `Hello, ${name}!`',
        '      }),',
        '  ),',
        ']',
        '',
        'export default workflows',
      ].join('\n'),
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
      contents: [
        `# ${name}`,
        '',
        'Generated with `temporal-bun init`.',
        '',
        '## Development',
        '',
        '```bash',
        'bun install',
        'bun run dev',
        '```',
        '',
        '## Packaging',
        '',
        '```bash',
        `bun run docker:build --tag ${name}:latest`,
        '```',
      ].join('\n'),
    },
  ]
}

if (import.meta.main) {
  await main()
}
