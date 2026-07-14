#!/usr/bin/env bun

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { createTemporalClient } from '@proompteng/temporal-bun-sdk'
import { VersioningBehavior } from '@proompteng/temporal-bun-sdk/worker'

import { repoRoot as defaultRepoRoot, fatal } from '../shared/cli'

type Options = {
  repoRoot: string
  repository: string
  ref: string
  commit?: string
  taskQueue: string
  namespace: string
  temporalAddress: string
  workflowId?: string
}

const defaults: Options = {
  repoRoot: process.env.BUMBA_WORKSPACE_ROOT ?? defaultRepoRoot,
  repository: process.env.REPOSITORY ?? 'proompteng/lab',
  ref: process.env.BUMBA_ATLAS_DEFAULT_REF ?? 'main',
  taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'bumba',
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  temporalAddress: process.env.TEMPORAL_ADDRESS ?? 'temporal-grpc:7233',
}

const usage = () =>
  `
Usage:
  bun run atlas:rebuild [options]

Options:
      --repo-root <path>        Git checkout used by the Bumba activity
      --repository <owner/repo> Repository slug (default: proompteng/lab)
      --ref <ref>               Authoritative origin ref (default: main)
      --commit <sha>            Event commit for traceability; origin/<ref> remains authoritative
      --task-queue <name>       Temporal task queue (default: bumba)
      --namespace <name>        Temporal namespace (default: default)
      --temporal-address <addr> Temporal frontend address
      --workflow-id <id>        Workflow ID override
  -h, --help                    Show this help

The command waits for the reconciliation result and exits nonzero on workflow failure.
`.trim()

const readValue = (arg: string, argv: string[], index: number) => {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) fatal(`${arg} requires a value`)
  return value
}

const parseArgs = (argv: string[]): Options => {
  const options = { ...defaults }
  const keys: Record<string, keyof Options> = {
    '--repo-root': 'repoRoot',
    '--repository': 'repository',
    '--ref': 'ref',
    '--commit': 'commit',
    '--task-queue': 'taskQueue',
    '--namespace': 'namespace',
    '--temporal-address': 'temporalAddress',
    '--workflow-id': 'workflowId',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg) continue
    if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    }
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    const key = keys[name]
    if (!key) fatal(`Unknown option: ${arg}`)
    const value = equals === -1 ? readValue(arg, argv, index) : arg.slice(equals + 1)
    if (!value.trim()) fatal(`${name} requires a value`)
    options[key] = value
    if (equals === -1) index += 1
  }

  if (options.ref !== 'main') fatal('Atlas rebuild accepts only --ref main')
  if (!options.repository.includes('/')) fatal('--repository must be an owner/name slug')
  return options
}

const main = async () => {
  const options = parseArgs(Bun.argv.slice(2))
  process.env.TEMPORAL_ADDRESS = options.temporalAddress
  const { client } = await createTemporalClient({ namespace: options.namespace })
  const workflowId = options.workflowId ?? `bumba-atlas-rebuild-${randomUUID()}`
  const started = await client.workflow.start({
    workflowId,
    workflowType: 'reconcileAtlasRepository',
    taskQueue: options.taskQueue,
    versioningBehavior: VersioningBehavior.AUTO_UPGRADE,
    args: [
      {
        repoRoot: resolve(options.repoRoot),
        repository: options.repository,
        ref: options.ref,
        commit: options.commit,
      },
    ],
  })
  const result = await client.workflow.result(started.handle)
  console.log(
    JSON.stringify(
      {
        workflowId: started.workflowId,
        runId: started.runId,
        namespace: started.namespace,
        result,
      },
      null,
      2,
    ),
  )
}

if (import.meta.main) {
  main().catch((error) => fatal('Atlas rebuild failed', error))
}
