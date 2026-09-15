const workflowTypes = [
  'integrationTimerWorkflow',
  'integrationActivityWorkflow',
  'integrationChildWorkflow',
  'integrationParentWorkflow',
  'integrationContinueAsNewWorkflow',
  'integrationHeartbeatWorkflow',
  'integrationHeartbeatTimeoutWorkflow',
  'integrationRetryProbeWorkflow',
  'integrationMetadataWorkflow',
  'integrationTimerCancellationWorkflow',
  'integrationWorkflowTaskFailureWorkflow',
  'integrationSignalQueryWorkflow',
  'integrationQueryOnlyWorkflow',
  'integrationUpdateWorkflow',
  'concurrencyWorkflow',
  'stickyMetadataWorkflow',
  'stickyArgsWorkflow',
  'codecPayloadWorkflow',
  'workerLoadCpuWorkflow',
  'workerLoadActivityWorkflow',
  'workerLoadUpdateWorkflow',
] as const

type Mode = 'verify' | 'terminate'

const args = new Set(process.argv.slice(2))
const mode: Mode = args.has('--terminate') ? 'terminate' : 'verify'
const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233'
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default'
const temporal = process.env.TEMPORAL_CLI_PATH ?? 'temporal'
const reason = readArg('--reason') ?? 'temporal-bun-sdk integration cleanup'
const terminateRps = process.env.TEMPORAL_CLEANUP_RPS ?? '5'
const maxAttempts = normalizePositiveInteger(process.env.TEMPORAL_CLEANUP_MAX_ATTEMPTS, 12)
const retryDelayMs = normalizePositiveInteger(process.env.TEMPORAL_CLEANUP_RETRY_MS, 1_000)

async function main(): Promise<void> {
  let foundVisibleWorkflows = false
  let leaked = false

  for (const workflowType of workflowTypes) {
    const query = `WorkflowType="${workflowType}" and ExecutionStatus="Running"`
    const before = await count(query)
    if (before === 0) {
      continue
    }

    foundVisibleWorkflows = true
    console.warn(`[temporal-bun-sdk] ${workflowType} has ${before} running workflow(s)`)
    const listOutput = await list(query, before)

    if (mode === 'terminate') {
      await terminate(query, workflowType, listOutput)
      const onlyStaleVisibilityRemains = await terminateRemainingWorkflows(query, workflowType)
      if (!onlyStaleVisibilityRemains) {
        await waitForNoRunningWorkflows(query, workflowType)
      }
      continue
    }

    const onlyStaleVisibilityRemains = await verifyOnlyStaleVisibility(query, workflowType, listOutput)
    if (!onlyStaleVisibilityRemains) {
      leaked = true
    }
  }

  if (leaked && mode === 'verify') {
    throw new Error('Temporal Bun SDK integration workflows leaked after test cleanup')
  }

  if (!foundVisibleWorkflows) {
    console.info('[temporal-bun-sdk] no running integration workflow leaks found')
  }
}

if (import.meta.main) {
  await main()
}

function readArg(name: string): string | undefined {
  const rawArgs = process.argv.slice(2)
  const index = rawArgs.indexOf(name)
  if (index >= 0) {
    return rawArgs[index + 1]
  }
  return undefined
}

async function count(query: string): Promise<number> {
  const output = await temporalCli(['workflow', 'count', '--namespace', namespace, '--query', query])
  const match = /Total:\s*(\d+)/i.exec(output.stdout)
  if (!match) {
    throw new Error(`Unable to parse Temporal count output for query ${query}: ${output.stdout}`)
  }
  return Number.parseInt(match[1] ?? '0', 10)
}

async function list(query: string, limit = 20): Promise<string> {
  const output = await temporalCli([
    'workflow',
    'list',
    '--namespace',
    namespace,
    '--query',
    query,
    '--limit',
    String(Math.max(limit, 20)),
  ])
  console.warn(output.stdout.trim())
  return output.stdout
}

async function terminate(query: string, workflowType: string, listOutput: string): Promise<void> {
  let output: { stdout: string; stderr: string }
  try {
    output = await temporalCli([
      'workflow',
      'terminate',
      '--namespace',
      namespace,
      '--query',
      query,
      '--reason',
      reason,
      '--rps',
      terminateRps,
      '--yes',
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!shouldFallbackToIndividualTermination(message)) {
      throw error
    }

    await terminateIndividually(workflowType, listOutput, 'Temporal batch termination is unavailable')
    return
  }

  const jobId = /Started batch for job ID:\s*([0-9a-f-]+)/i.exec(output.stdout)?.[1]
  if (jobId) {
    await waitForBatch(jobId)
  }
}

type IndividualTerminationResult = {
  readonly alreadyResolvedWorkflowIds: readonly string[]
  readonly terminatedWorkflowIds: readonly string[]
}

async function terminateIndividually(
  workflowType: string,
  listOutput: string,
  context: string,
): Promise<IndividualTerminationResult> {
  const workflowIds = parseWorkflowIdsFromListOutput(listOutput, workflowType)
  if (workflowIds.length === 0) {
    throw new Error(`Unable to parse ${workflowType} workflow IDs from Temporal list output:\n${listOutput}`)
  }
  const alreadyResolvedWorkflowIds: string[] = []
  const terminatedWorkflowIds: string[] = []

  console.warn(
    `[temporal-bun-sdk] ${context}; terminating ${workflowIds.length} ${workflowType} workflow(s) individually`,
  )

  for (const workflowId of workflowIds) {
    try {
      await temporalCli([
        'workflow',
        'terminate',
        '--namespace',
        namespace,
        '--workflow-id',
        workflowId,
        '--reason',
        reason,
      ])
      terminatedWorkflowIds.push(workflowId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isWorkflowAlreadyCompleted(message)) {
        throw error
      }
      alreadyResolvedWorkflowIds.push(workflowId)
      console.warn(`[temporal-bun-sdk] ${workflowId} completed before individual cleanup could terminate it`)
    }
  }

  return { alreadyResolvedWorkflowIds, terminatedWorkflowIds }
}

async function terminateRemainingWorkflows(query: string, workflowType: string): Promise<boolean> {
  const after = await waitForNoRunningWorkflowCount(query)
  if (after === 0) {
    return false
  }

  console.warn(
    `[temporal-bun-sdk] ${workflowType} still has ${after} running workflow(s) after batch cleanup; retrying individually`,
  )
  const listOutput = await list(query, after)
  const result = await terminateIndividually(
    workflowType,
    listOutput,
    'remaining workflows are still visible after batch cleanup',
  )
  if (result.alreadyResolvedWorkflowIds.length === 0) {
    return false
  }

  const remainingAfterIndividual = await waitForNoRunningWorkflowCount(query)
  if (remainingAfterIndividual === 0) {
    return false
  }

  const remainingListOutput = await list(query, remainingAfterIndividual)
  const onlyStaleVisibilityRemains = onlyAlreadyResolvedWorkflowsRemainVisible(
    remainingListOutput,
    workflowType,
    result.alreadyResolvedWorkflowIds,
  )
  if (!onlyStaleVisibilityRemains) {
    return false
  }

  console.warn(
    `[temporal-bun-sdk] ${workflowType} has ${remainingAfterIndividual} stale visibility record(s) for workflow(s) already reported terminal or missing`,
  )
  return true
}

type VerifyOnlyStaleVisibilityOptions = {
  readonly terminateVisibleWorkflows?: (
    workflowType: string,
    listOutput: string,
    context: string,
  ) => Promise<IndividualTerminationResult>
  readonly waitForNoRunningCount?: (query: string) => Promise<number>
  readonly listRunning?: (query: string, limit?: number) => Promise<string>
}

export async function verifyOnlyStaleVisibility(
  query: string,
  workflowType: string,
  listOutput: string,
  options: VerifyOnlyStaleVisibilityOptions = {},
): Promise<boolean> {
  const terminateVisibleWorkflows = options.terminateVisibleWorkflows ?? terminateIndividually
  const waitForNoRunningCount = options.waitForNoRunningCount ?? waitForNoRunningWorkflowCount
  const listRunning = options.listRunning ?? list

  const result = await terminateVisibleWorkflows(
    workflowType,
    listOutput,
    'verify detected running workflows after test cleanup',
  )
  if (result.terminatedWorkflowIds.length > 0) {
    console.error(
      `[temporal-bun-sdk] ${workflowType} leaked ${result.terminatedWorkflowIds.length} workflow(s) that required termination during verification`,
    )
    return false
  }

  if (result.alreadyResolvedWorkflowIds.length === 0) {
    return false
  }

  const remaining = await waitForNoRunningCount(query)
  if (remaining === 0) {
    return true
  }

  const remainingListOutput = await listRunning(query, remaining)
  const onlyStaleVisibilityRemains = onlyAlreadyResolvedWorkflowsRemainVisible(
    remainingListOutput,
    workflowType,
    result.alreadyResolvedWorkflowIds,
  )
  if (onlyStaleVisibilityRemains) {
    console.warn(
      `[temporal-bun-sdk] ${workflowType} has ${remaining} stale visibility record(s) during verification for workflow(s) already reported terminal or missing`,
    )
  }
  return onlyStaleVisibilityRemains
}

async function waitForBatch(jobId: string): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const output = await temporalCli(['batch', 'describe', '--job-id', jobId, '--namespace', namespace])
    const state = /^ *State +(.+)$/im.exec(output.stdout)?.[1]?.trim()
    if (state === 'Completed') {
      return
    }
    if (state === 'Failed') {
      throw new Error(`Temporal batch ${jobId} failed:\n${output.stdout}`)
    }
    await Bun.sleep(retryDelayMs * attempt)
  }
  throw new Error(`Timed out waiting for Temporal batch ${jobId} to complete`)
}

type WaitForNoRunningWorkflowsOptions = {
  readonly countRunning?: (query: string) => Promise<number>
  readonly sleep?: (ms: number) => Promise<void>
  readonly maxAttempts?: number
  readonly retryDelayMs?: number
}

export async function waitForNoRunningWorkflowCount(
  query: string,
  options: WaitForNoRunningWorkflowsOptions = {},
): Promise<number> {
  const countRunning = options.countRunning ?? count
  const sleep = options.sleep ?? Bun.sleep
  const attempts = options.maxAttempts ?? maxAttempts
  const delayMs = options.retryDelayMs ?? retryDelayMs
  let after = 0

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    after = await countRunning(query)
    if (after === 0) {
      return 0
    }
    if (attempt < attempts) {
      await sleep(delayMs * attempt)
    }
  }

  return after
}

export async function waitForNoRunningWorkflows(
  query: string,
  workflowType: string,
  options: WaitForNoRunningWorkflowsOptions = {},
): Promise<void> {
  const after = await waitForNoRunningWorkflowCount(query, options)
  if (after === 0) {
    return
  }
  throw new Error(`${workflowType} still has ${after} running workflow(s) after cleanup`)
}

async function temporalCli(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  let lastOutput = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const child = Bun.spawn([temporal, '--address', address, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        TEMPORAL_ADDRESS: address,
        TEMPORAL_NAMESPACE: namespace,
      },
    })
    const exitCode = await child.exited
    const stdout = child.stdout ? await new Response(child.stdout).text() : ''
    const stderr = child.stderr ? await new Response(child.stderr).text() : ''
    if (exitCode === 0) {
      return { stdout, stderr }
    }
    lastOutput = stderr || stdout
    if (!isRetryableTemporalCliError(lastOutput) || attempt === maxAttempts) {
      throw new Error(`temporal ${args.join(' ')} failed with exit ${exitCode}: ${lastOutput}`)
    }
    await Bun.sleep(retryDelayMs * attempt)
  }
  throw new Error(`temporal ${args.join(' ')} failed: ${lastOutput}`)
}

export function isRetryableTemporalCliError(output: string): boolean {
  return /namespace rate limit exceeded|context deadline exceeded|transport: error while dialing|unavailable|not enough hosts to serve the request|please retry|temporarily unavailable|workflow is busy/i.test(
    output,
  )
}

export function isTemporalBatchCapacityError(output: string): boolean {
  return /failed starting batch operation:.*max concurrent batch operations is reached|max concurrent batch operations is reached/i.test(
    output,
  )
}

export function shouldFallbackToIndividualTermination(output: string): boolean {
  return isRetryableTemporalCliError(output) || isTemporalBatchCapacityError(output)
}

export function isWorkflowAlreadyCompleted(output: string): boolean {
  return /workflow execution already completed|workflow not found for ID/i.test(output)
}

export function onlyAlreadyResolvedWorkflowsRemainVisible(
  output: string,
  workflowType: string,
  alreadyResolvedWorkflowIds: readonly string[],
): boolean {
  const workflowIds = parseWorkflowIdsFromListOutput(output, workflowType)
  if (workflowIds.length === 0) {
    return false
  }
  const alreadyResolved = new Set(alreadyResolvedWorkflowIds)
  return workflowIds.every((workflowId) => alreadyResolved.has(workflowId))
}

export function parseWorkflowIdsFromListOutput(output: string, workflowType: string): string[] {
  const workflowIds: string[] = []
  for (const line of output.split('\n')) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 3 || columns[0] !== 'Running' || columns[2] !== workflowType) {
      continue
    }
    const workflowId = columns[1]
    if (workflowId) {
      workflowIds.push(workflowId)
    }
  }
  return workflowIds
}

function normalizePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
