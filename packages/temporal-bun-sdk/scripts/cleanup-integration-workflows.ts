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
  let leaked = false

  for (const workflowType of workflowTypes) {
    const query = `WorkflowType="${workflowType}" and ExecutionStatus="Running"`
    const before = await count(query)
    if (before === 0) {
      continue
    }

    leaked = true
    console.warn(`[temporal-bun-sdk] ${workflowType} has ${before} running workflow(s)`)
    const listOutput = await list(query, before)

    if (mode === 'terminate') {
      await terminate(query, workflowType, listOutput)
      const after = await count(query)
      if (after > 0) {
        throw new Error(`${workflowType} still has ${after} running workflow(s) after cleanup`)
      }
    }
  }

  if (leaked && mode === 'verify') {
    throw new Error('Temporal Bun SDK integration workflows leaked after test cleanup')
  }

  if (!leaked) {
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
    if (!isRetryableTemporalCliError(message)) {
      throw error
    }

    await terminateIndividually(workflowType, listOutput)
    return
  }

  const jobId = /Started batch for job ID:\s*([0-9a-f-]+)/i.exec(output.stdout)?.[1]
  if (jobId) {
    await waitForBatch(jobId)
  }
}

async function terminateIndividually(workflowType: string, listOutput: string): Promise<void> {
  const workflowIds = parseWorkflowIdsFromListOutput(listOutput, workflowType)
  if (workflowIds.length === 0) {
    throw new Error(`Unable to parse ${workflowType} workflow IDs from Temporal list output:\n${listOutput}`)
  }

  console.warn(
    `[temporal-bun-sdk] Temporal batch termination is unavailable; terminating ${workflowIds.length} ${workflowType} workflow(s) individually`,
  )

  for (const workflowId of workflowIds) {
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
  }
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
  return /namespace rate limit exceeded|context deadline exceeded|transport: error while dialing|unavailable|not enough hosts to serve the request|please retry|temporarily unavailable/i.test(
    output,
  )
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
