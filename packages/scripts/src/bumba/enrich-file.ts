#!/usr/bin/env bun

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { createTemporalClient } from '@proompteng/temporal-bun-sdk'

import { repoRoot as defaultRepoRoot, fatal } from '../shared/cli'

type Options = {
  filePath: string
  repoRoot: string
  context?: string
  taskQueue: string
  workflowId?: string
  namespace: string
  wait: boolean
  force: boolean
  temporalAddress?: string
  repository?: string
  commit?: string
}

const DEFAULT_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? 'bumba'
const DEFAULT_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default'
const DEFAULT_REPO_ROOT = process.env.BUMBA_WORKSPACE_ROOT ?? defaultRepoRoot
const DEFAULT_TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'temporal-grpc:7233'

const usage = () =>
  `
Usage:
  bun run packages/scripts/src/bumba/enrich-file.ts --file <path> [options]

Options:
  -f, --file <path>          File path to enrich (required; relative to repo root by default)
      --repo-root <path>     Repository root (default: $BUMBA_WORKSPACE_ROOT or repo root)
      --context <text>       Extra context passed to the enrichment model
      --repository <slug>    Repository slug (owner/name) for GitHub fetch fallback
      --commit <sha>         Commit SHA or ref to fetch when repoRoot is stale
      --task-queue <name>    Temporal task queue (default: $TEMPORAL_TASK_QUEUE or ${DEFAULT_TASK_QUEUE})
      --workflow-id <id>     Workflow ID override (defaults to auto-generated)
      --namespace <name>     Temporal namespace (default: $TEMPORAL_NAMESPACE or ${DEFAULT_NAMESPACE})
      --temporal-address <addr> Override Temporal address (default: ${DEFAULT_TEMPORAL_ADDRESS})
      --force               Clear existing enrichment entries before running
      --wait                Wait for workflow completion and print the result
  -h, --help                Show this help message

Examples:
  bun run packages/scripts/src/bumba/enrich-file.ts --file services/bumba/src/worker.ts
  bun run packages/scripts/src/bumba/enrich-file.ts --file apps/reestr/src/routes/index.tsx --context "UI entry"
`.trim()

const readValue = (arg: string, argv: string[], index: number) => {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) {
    fatal(`${arg} requires a value`)
  }
  return value
}

const parseArgs = (argv: string[]): Options => {
  const options: Partial<Options> = {
    taskQueue: DEFAULT_TASK_QUEUE,
    namespace: DEFAULT_NAMESPACE,
    repoRoot: DEFAULT_REPO_ROOT,
    wait: false,
    force: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue

    if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    }

    if (arg === '--wait') {
      options.wait = true
      continue
    }

    if (arg === '--force') {
      options.force = true
      continue
    }

    if (arg === '--file' || arg === '-f') {
      options.filePath = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--file=')) {
      options.filePath = arg.slice('--file='.length)
      continue
    }

    if (arg === '--repo-root') {
      options.repoRoot = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--repo-root=')) {
      options.repoRoot = arg.slice('--repo-root='.length)
      continue
    }

    if (arg === '--context') {
      options.context = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--context=')) {
      options.context = arg.slice('--context='.length)
      continue
    }

    if (arg === '--repository') {
      options.repository = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--repository=')) {
      options.repository = arg.slice('--repository='.length)
      continue
    }

    if (arg === '--commit') {
      options.commit = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--commit=')) {
      options.commit = arg.slice('--commit='.length)
      continue
    }

    if (arg === '--task-queue') {
      options.taskQueue = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--task-queue=')) {
      options.taskQueue = arg.slice('--task-queue='.length)
      continue
    }

    if (arg === '--workflow-id') {
      options.workflowId = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--workflow-id=')) {
      options.workflowId = arg.slice('--workflow-id='.length)
      continue
    }

    if (arg === '--namespace') {
      options.namespace = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--namespace=')) {
      options.namespace = arg.slice('--namespace='.length)
      continue
    }

    if (arg === '--temporal-address') {
      options.temporalAddress = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--temporal-address=')) {
      options.temporalAddress = arg.slice('--temporal-address='.length)
      continue
    }

    fatal(`Unknown option: ${arg}`)
  }

  if (!options.filePath) {
    fatal('Missing --file')
  }

  return options as Options
}

const resolveInputs = (options: Options) => {
  const repoRoot = resolve(options.repoRoot)
  const resolvedFile = isAbsolute(options.filePath) ? resolve(options.filePath) : resolve(repoRoot, options.filePath)
  const relativePath = relative(repoRoot, resolvedFile)

  if (relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) {
    fatal(`File path escapes repo root: ${options.filePath}`)
  }

  if (existsSync(repoRoot)) {
    if (!existsSync(resolvedFile)) {
      if (options.commit || options.repository) {
        console.warn(`[bumba] file not found locally (${resolvedFile}); relying on remote fetch fallback.`)
      } else {
        fatal(`File not found: ${resolvedFile}`)
      }
    }
  } else {
    console.warn(`[bumba] repo root not found locally (${repoRoot}); skipping local file check.`)
  }

  return { repoRoot, filePath: relativePath }
}

const buildWorkflowId = (filePath: string, provided?: string) => {
  if (provided) return provided
  const normalized = filePath.replace(/[^a-zA-Z0-9_.-]+/g, '-')
  return `bumba-${normalized}-${randomUUID()}`
}

const main = async () => {
  const options = parseArgs(Bun.argv.slice(2))
  process.env.TEMPORAL_ADDRESS = options.temporalAddress ?? DEFAULT_TEMPORAL_ADDRESS

  const { repoRoot, filePath } = resolveInputs(options)
  const workflowId = buildWorkflowId(filePath, options.workflowId)

  const { client } = await createTemporalClient({ namespace: options.namespace })

  const startResult = await client.workflow.start({
    workflowId,
    workflowType: 'enrichFile',
    taskQueue: options.taskQueue,
    args: [
      {
        repoRoot,
        filePath,
        context: options.context ?? '',
        repository: options.repository,
        commit: options.commit,
        force: options.force,
      },
    ],
  })

  const output: Record<string, unknown> = {
    workflowId: startResult.workflowId,
    runId: startResult.runId,
    namespace: startResult.namespace,
    taskQueue: options.taskQueue,
    repoRoot,
    filePath,
    repository: options.repository,
    commit: options.commit,
    force: options.force,
  }

  if (options.wait) {
    output.result = await startResult.handle.result()
  }

  console.log(JSON.stringify(output, null, 2))
}

main().catch((error) => fatal('Failed to start bumba workflow', error))
