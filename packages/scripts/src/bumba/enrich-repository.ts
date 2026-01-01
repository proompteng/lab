#!/usr/bin/env bun

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { createTemporalClient } from '@proompteng/temporal-bun-sdk'

import { repoRoot as defaultRepoRoot, fatal } from '../shared/cli'

type Options = {
  repoRoot: string
  repository?: string
  ref?: string
  commit?: string
  context?: string
  pathPrefix?: string
  maxFiles?: number
  childWorkflowConcurrency?: number
  files: string[]
  taskQueue: string
  workflowId?: string
  namespace: string
  temporalAddress?: string
  wait: boolean
  eventDeliveryId?: string
}

const DEFAULT_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? 'bumba'
const DEFAULT_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default'
const DEFAULT_REPO_ROOT = process.env.BUMBA_WORKSPACE_ROOT ?? defaultRepoRoot
const DEFAULT_TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'temporal-grpc:7233'
const DEFAULT_CHILD_WORKFLOW_CONCURRENCY = (() => {
  const parsed = Number.parseInt(process.env.BUMBA_CHILD_WORKFLOW_CONCURRENCY ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
})()

const usage = () =>
  `
Usage:
  bun run packages/scripts/src/bumba/enrich-repository.ts [options]

Options:
      --repo-root <path>      Repository root (default: $BUMBA_WORKSPACE_ROOT or repo root)
      --repository <slug>     Repository slug (owner/name) for GitHub fetch fallback
      --ref <ref>             Git ref for listing
      --commit <sha>          Commit SHA to read files from
      --context <text>        Extra context passed to the enrichment model
      --path-prefix <path>    Restrict listing to a path prefix
      --max-files <count>     Limit the number of files listed
      --child-workflow-concurrency <count> Limit concurrent enrichFile child workflows
      --file <path>           File path to enrich (repeatable)
      --files <list>          Comma-separated file list
      --task-queue <name>     Temporal task queue (default: $TEMPORAL_TASK_QUEUE or ${DEFAULT_TASK_QUEUE})
      --workflow-id <id>      Workflow ID override (defaults to auto-generated)
      --namespace <name>      Temporal namespace (default: $TEMPORAL_NAMESPACE or ${DEFAULT_NAMESPACE})
      --temporal-address <addr> Override Temporal address (default: ${DEFAULT_TEMPORAL_ADDRESS})
      --event-delivery-id <id> Attach a GitHub delivery id for ingestion tracking
      --wait                  Wait for workflow completion and print the result
  -h, --help                  Show this help message

Examples:
  bun run packages/scripts/src/bumba/enrich-repository.ts --path-prefix services/bumba --max-files 50
  bun run packages/scripts/src/bumba/enrich-repository.ts --files services/bumba/src/worker.ts,services/bumba/src/activities/index.ts --wait
`.trim()

const readValue = (arg: string, argv: string[], index: number) => {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) {
    fatal(`${arg} requires a value`)
  }
  return value
}

const parseIntValue = (arg: string, value: string) => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fatal(`${arg} must be a positive integer`)
  }
  return parsed
}

const parseArgs = (argv: string[]): Options => {
  const options: Options = {
    repoRoot: DEFAULT_REPO_ROOT,
    taskQueue: DEFAULT_TASK_QUEUE,
    namespace: DEFAULT_NAMESPACE,
    files: [],
    wait: false,
    childWorkflowConcurrency: DEFAULT_CHILD_WORKFLOW_CONCURRENCY,
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

    if (arg === '--repo-root') {
      options.repoRoot = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--repo-root=')) {
      options.repoRoot = arg.slice('--repo-root='.length)
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

    if (arg === '--ref') {
      options.ref = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--ref=')) {
      options.ref = arg.slice('--ref='.length)
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

    if (arg === '--context') {
      options.context = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--context=')) {
      options.context = arg.slice('--context='.length)
      continue
    }

    if (arg === '--path-prefix') {
      options.pathPrefix = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--path-prefix=')) {
      options.pathPrefix = arg.slice('--path-prefix='.length)
      continue
    }

    if (arg === '--max-files') {
      options.maxFiles = parseIntValue(arg, readValue(arg, argv, i))
      i += 1
      continue
    }

    if (arg.startsWith('--max-files=')) {
      options.maxFiles = parseIntValue(arg, arg.slice('--max-files='.length))
      continue
    }

    if (arg === '--child-workflow-concurrency') {
      options.childWorkflowConcurrency = parseIntValue(arg, readValue(arg, argv, i))
      i += 1
      continue
    }

    if (arg.startsWith('--child-workflow-concurrency=')) {
      options.childWorkflowConcurrency = parseIntValue(arg, arg.slice('--child-workflow-concurrency='.length))
      continue
    }

    if (arg === '--file' || arg === '-f') {
      options.files.push(readValue(arg, argv, i))
      i += 1
      continue
    }

    if (arg.startsWith('--file=')) {
      options.files.push(arg.slice('--file='.length))
      continue
    }

    if (arg === '--files') {
      const value = readValue(arg, argv, i)
      options.files.push(
        ...value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
      )
      i += 1
      continue
    }

    if (arg.startsWith('--files=')) {
      const value = arg.slice('--files='.length)
      options.files.push(
        ...value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
      )
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

    if (arg === '--event-delivery-id') {
      options.eventDeliveryId = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--event-delivery-id=')) {
      options.eventDeliveryId = arg.slice('--event-delivery-id='.length)
      continue
    }

    fatal(`Unknown option: ${arg}`)
  }

  return options
}

const resolveFileInputs = (repoRoot: string, files: string[]) => {
  if (files.length === 0) return files

  const resolvedRoot = resolve(repoRoot)
  const results: string[] = []

  for (const filePath of files) {
    const resolvedFile = isAbsolute(filePath) ? resolve(filePath) : resolve(resolvedRoot, filePath)
    const relativePath = relative(resolvedRoot, resolvedFile)
    if (relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) {
      fatal(`File path escapes repo root: ${filePath}`)
    }

    if (existsSync(resolvedRoot) && !existsSync(resolvedFile)) {
      console.warn(`[bumba] file not found locally (${resolvedFile}); relying on remote fetch fallback.`)
    }

    results.push(relativePath)
  }

  return results
}

const buildWorkflowId = (provided?: string) => {
  if (provided) return provided
  return `bumba-repo-${randomUUID()}`
}

const main = async () => {
  const options = parseArgs(Bun.argv.slice(2))
  process.env.TEMPORAL_ADDRESS = options.temporalAddress ?? DEFAULT_TEMPORAL_ADDRESS

  const repoRoot = resolve(options.repoRoot)
  const files = resolveFileInputs(repoRoot, options.files)
  const workflowId = buildWorkflowId(options.workflowId)

  const { client } = await createTemporalClient({ namespace: options.namespace })

  const startResult = await client.workflow.start({
    workflowId,
    workflowType: 'enrichRepository',
    taskQueue: options.taskQueue,
    args: [
      {
        repoRoot,
        repository: options.repository,
        ref: options.ref,
        commit: options.commit,
        context: options.context,
        pathPrefix: options.pathPrefix,
        maxFiles: options.maxFiles,
        childWorkflowConcurrency: options.childWorkflowConcurrency,
        files: files.length > 0 ? files : undefined,
        eventDeliveryId: options.eventDeliveryId,
      },
    ],
  })

  const output: Record<string, unknown> = {
    workflowId: startResult.workflowId,
    runId: startResult.runId,
    namespace: startResult.namespace,
    taskQueue: options.taskQueue,
    repoRoot,
    repository: options.repository,
    ref: options.ref,
    commit: options.commit,
    pathPrefix: options.pathPrefix,
    maxFiles: options.maxFiles,
    childWorkflowConcurrency: options.childWorkflowConcurrency,
    files: files.length > 0 ? files : undefined,
    eventDeliveryId: options.eventDeliveryId,
  }

  if (options.wait) {
    output.result = await client.workflow.result(startResult.handle)
  }

  console.log(JSON.stringify(output, null, 2))
}

main().catch((error) => fatal('Failed to start bumba enrichRepository workflow', error))
