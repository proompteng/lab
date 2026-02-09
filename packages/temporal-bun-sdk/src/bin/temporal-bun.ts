#!/usr/bin/env bun

import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { cwd, exit } from 'node:process'
import { Cause, Effect, Exit } from 'effect'
import { buildCodecsFromConfig, createDefaultDataConverter, type DataConverter } from '../common/payloads'
import { makeDefaultClientInterceptors } from '../interceptors/client'
import { makeDefaultWorkerInterceptors } from '../interceptors/worker'
import { runTemporalCliEffect } from '../runtime/cli-layer'
import { ObservabilityService, TemporalConfigService } from '../runtime/effect-layers'
import { executeLintWorkflows, parseLintWorkflowsFlags, printLintWorkflows } from './lint-workflows-command'
import { executeReplay, parseReplayOptions, printReplaySummary } from './replay-command'

type CommandResult = { exitCode?: number }

type CommandHandler = (
  args: string[],
  flags: Record<string, string | boolean>,
) => Effect.Effect<CommandResult | undefined, unknown, never>

const handleHelp: CommandHandler = () =>
  Effect.sync(() => {
    printHelp()
    return undefined
  })

const handleInit: CommandHandler = (args, flags) => Effect.tryPromise(() => runInitCommand(args, flags))

const handleDockerBuild: CommandHandler = (args, flags) => Effect.tryPromise(() => runDockerBuildCommand(args, flags))

const doctorCommandProgram = Effect.gen(function* () {
  const config = yield* TemporalConfigService
  const { logger, metricsRegistry, metricsExporter } = yield* ObservabilityService
  const doctorCounter = yield* metricsRegistry.counter(
    'temporal_bun_doctor_runs_total',
    'Temporal CLI doctor command executions',
  )
  yield* doctorCounter.inc()
  const codecChain = buildCodecsFromConfig(config.payloadCodecs)
  let dataConverter: DataConverter
  try {
    dataConverter = createDefaultDataConverter({
      payloadCodecs: codecChain,
      logger,
      metricsRegistry,
    })
  } catch (error) {
    yield* logger.log('error', 'payload codec configuration failed', {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })
    throw error
  }
  yield* logger.log('info', 'payload codec chain resolved', {
    codecs: codecChain.map((codec) => codec.name),
  })
  const clientInterceptors = yield* makeDefaultClientInterceptors({
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    identity: config.workerIdentity,
    logger,
    metricsRegistry,
    metricsExporter,
    retryPolicy: config.rpcRetryPolicy,
    tracingEnabled: config.tracingInterceptorsEnabled,
  })
  const workerInterceptors = yield* makeDefaultWorkerInterceptors({
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    identity: config.workerIdentity,
    buildId: config.workerBuildId ?? config.workerIdentity,
    logger,
    metricsRegistry,
    metricsExporter,
    dataConverter,
    tracingEnabled: config.tracingInterceptorsEnabled,
  })

  const retryIssues: string[] = []
  const retry = config.rpcRetryPolicy
  if (!retry || retry.maxAttempts < 1) {
    retryIssues.push('maxAttempts must be at least 1')
  }
  if (retry.initialDelayMs <= 0) {
    retryIssues.push('initialDelayMs must be positive')
  }
  if (retry.maxDelayMs < retry.initialDelayMs) {
    retryIssues.push('maxDelayMs must be >= initialDelayMs')
  }
  if (!Number.isFinite(retry.backoffCoefficient) || retry.backoffCoefficient <= 0) {
    retryIssues.push('backoffCoefficient must be > 0')
  }

  if (retryIssues.length > 0) {
    yield* logger.log('error', 'retry policy validation failed', {
      issues: retryIssues,
      retry,
    })
    throw new Error('temporal-bun doctor failed: retry policy invalid')
  }

  const interceptorSummary = {
    client: clientInterceptors.map((interceptor) => interceptor.name ?? 'anonymous'),
    worker: workerInterceptors.map((interceptor) => interceptor.name ?? 'anonymous'),
    tracingEnabled: config.tracingInterceptorsEnabled,
  }

  yield* logger.log('info', 'interceptor chain resolved', interceptorSummary)
  yield* logger.log('info', 'retry policy validated', { retry })
  yield* logger.log('info', 'temporal-bun doctor validation succeeded', {
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    logFormat: config.logFormat,
    metricsExporter: config.metricsExporter.type,
  })
  yield* metricsExporter.flush()
  yield* Effect.sync(() => {
    console.log('temporal-bun doctor complete — configuration validated and metrics sink flushed.')
    if (config.metricsExporter.type !== 'in-memory') {
      console.log(`  metrics sink: ${config.metricsExporter.type} ${config.metricsExporter.endpoint ?? ''}`)
    }
    console.log(`  client interceptors: ${interceptorSummary.client.join(', ')}`)
    console.log(`  worker interceptors: ${interceptorSummary.worker.join(', ')}`)
    console.log(`  tracing interceptors: ${interceptorSummary.tracingEnabled ? 'enabled' : 'disabled'}`)
    console.log(
      `  retry policy: attempts=${retry.maxAttempts} initial=${retry.initialDelayMs}ms max=${retry.maxDelayMs}ms backoff=${retry.backoffCoefficient} jitter=${retry.jitterFactor}`,
    )
  })
  return undefined
})

const handleDoctor: CommandHandler = (_args, flags) =>
  Effect.promise(() =>
    runTemporalCliEffect(doctorCommandProgram, {
      config: { env: { ...process.env, ...buildDoctorOverrides(flags) } as NodeJS.ProcessEnv },
    }),
  )

const buildReplayProgram = (flagsOrOptions: Parameters<typeof executeReplay>[0]) => executeReplay(flagsOrOptions)

const handleReplay: CommandHandler = (_args, flags) => {
  const options = parseReplayOptions(flags)
  const commandEffect = buildReplayProgram(options).pipe(
    Effect.tap((result) => Effect.sync(() => printReplaySummary(result, options.jsonOutput))),
    Effect.map((result) => (result.exitCode && result.exitCode !== 0 ? { exitCode: result.exitCode } : undefined)),
  )
  return Effect.promise(() => runTemporalCliEffect(commandEffect, { config: { env: process.env } }))
}

const handleLintWorkflows: CommandHandler = (_args, flags) =>
  Effect.tryPromise(async () => {
    const options = parseLintWorkflowsFlags(flags)
    const result = await executeLintWorkflows(options)
    await printLintWorkflows(result)
    return result.exitCode !== 0 ? { exitCode: result.exitCode } : undefined
  })

const commands: Record<string, CommandHandler> = {
  init: handleInit,
  'docker-build': handleDockerBuild,
  doctor: handleDoctor,
  replay: handleReplay,
  'lint-workflows': handleLintWorkflows,
  help: handleHelp,
}

export const temporalCliTestHooks = {
  handleDoctor: (_args: string[], _flags: Record<string, string | boolean>) => doctorCommandProgram,
  handleReplay: (_args: string[], flags: Record<string, string | boolean>) => buildReplayProgram(flags),
  handleLintWorkflows: (_args: string[], flags: Record<string, string | boolean>) =>
    Effect.tryPromise(async () => {
      const options = parseLintWorkflowsFlags(flags)
      return await executeLintWorkflows(options)
    }),
}

export const main = async () => {
  const [command = 'help', ...rest] = process.argv.slice(2)
  const { args, flags } = parseArgs(rest)
  const handler =
    commands[command] ??
    (() =>
      Effect.sync(() => {
        console.error(`Unknown command "${command}".`)
        printHelp()
        return { exitCode: 1 }
      }))
  const exitResult = await Effect.runPromiseExit(handler(args, flags))
  if (Exit.isFailure(exitResult)) {
    console.error(Cause.pretty(exitResult.cause))
    exit(1)
    return
  }
  const result = exitResult.value
  if (result && typeof result.exitCode === 'number') {
    exit(result.exitCode)
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
  lint-workflows           Lint workflow modules for nondeterminism hazards
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
  --history-dir <path>    Replay all history JSON files under a directory
  --out <path>            Write replay batch artifacts (report + per-history JSON)
  --json                  Emit a JSON replay summary alongside console output
  --debug                 Pause execution for a debugger during replay
  --workflows <glob>      Lint workflow entries (comma-separated globs allowed)
  --mode <mode>           Lint mode (strict|warn|off)
  --format <format>       Lint output format (text|json)
  --config <path>         Workflow lint config path (default: .temporal-bun-workflows.json)
  --changed-only          Lint only entries impacted by git diff (best-effort)
`)
}

async function runInitCommand(
  args: string[],
  flags: Record<string, string | boolean>,
): Promise<CommandResult | undefined> {
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

  return undefined
}

async function runDockerBuildCommand(
  _args: string[],
  flags: Record<string, string | boolean>,
): Promise<CommandResult | undefined> {
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

  return undefined
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
            '@proompteng/temporal-bun-sdk': '^0.5.0',
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
