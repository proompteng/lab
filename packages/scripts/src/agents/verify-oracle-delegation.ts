#!/usr/bin/env bun

import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    'delivery-id': { type: 'string' },
    mode: { type: 'string', default: 'success' },
    preview: { type: 'boolean', default: false },
    output: { type: 'string' },
  },
})
const deliveryId = values['delivery-id']
if (!deliveryId || !/^[a-z0-9-]{1,63}$/.test(deliveryId)) {
  throw new Error('--delivery-id must contain 1 to 63 lowercase letters, digits, or hyphens')
}
const mode = values.mode
if (mode !== 'success' && mode !== 'failure' && mode !== 'cancel') {
  throw new Error('--mode must be success, failure, or cancel')
}
const baseUrl = process.env.AGENTS_SERVICE_BASE_URL ?? 'http://agents.ide-newton.ts.net'
const marker = `ORACLE_ACCEPTANCE_${deliveryId}`
const task =
  mode === 'cancel'
    ? `Cancellation acceptance. Run a shell command that prints ${marker} and sleeps for 600 seconds. Make no source or cluster changes. Do not inspect credentials or spawn subagents.`
    : `Read-only Oracle delegation and telemetry acceptance. Use two native goal turns. In your first turn, run codex --version and hostname, then end the turn with CHECKPOINT without completing the goal. On the automatic goal continuation, run one shell command that prints ${marker} and sleeps for 35 seconds. Finally return exactly one line containing ${marker}, the actual Codex version, and the hostname, and complete the Codex goal. Make no source or cluster changes. Do not inspect credentials or spawn subagents.`
const payload = {
  agentRef: { name: 'codex-agent' },
  namespace: 'agents',
  implementation: { text: task },
  goal: { objective: task },
  runtime: { type: 'job', config: { serviceAccountName: 'agents-sa' } },
  ttlSecondsAfterFinished: 60,
  parameters: {
    stage: 'verification',
    artifactKey: `oracle-acceptance/${deliveryId}/result.json`,
    ...(mode === 'failure'
      ? {
          repository: 'proompteng/lab',
          base: `oracle-missing-${deliveryId}`,
          head: `codex/${deliveryId}`,
        }
      : {}),
  },
  secrets: ['codex-auth', 'agents-artifacts', ...(mode === 'failure' ? ['github-token'] : [])],
  policy: { secretBindingRef: 'codex-github-token' },
  vcsPolicy: mode === 'failure' ? { required: true, mode: 'read-only' } : { required: false, mode: 'none' },
  ...(mode === 'failure' ? { vcsRef: { name: 'github' } } : {}),
}

if (values.preview) {
  process.stdout.write(`${JSON.stringify({ deliveryId, payload }, null, 2)}\n`)
  process.exit(0)
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an API object')
  return Object.fromEntries(Object.entries(value))
}
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value) throw new Error('Expected a non-empty API string')
  return value
}
const snapshot = (value: Record<string, unknown>) =>
  record(value.resource ?? record(record(value.agentRun).payload).resource)
const telemetry = (value: Record<string, unknown>): Record<string, unknown> | null => {
  const status = snapshot(value).status
  if (!status) return null
  const runner = record(status).runner
  const observed = runner ? record(runner).telemetry : null
  return observed ? record(observed) : null
}
const request = async (path: string, method = 'GET', body?: unknown) => {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/json', 'Idempotency-Key': deliveryId },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const result = record(await response.json())
  if (!response.ok)
    throw new Error(
      `Agents API ${method} ${path} returned ${response.status}: ${typeof result.error === 'string' ? result.error : 'request failed'}`,
    )
  return result
}
const first = await request('/v1/agent-runs', 'POST', payload)
const id = text(record(first.agentRun).id)
const second = await request('/v1/agent-runs', 'POST', payload)
if (text(record(second.agentRun).id) !== id) throw new Error('Retry created another projection')
if (first.resource && second.resource) {
  const firstUid = text(record(record(first.resource).metadata).uid)
  if (text(record(record(second.resource).metadata).uid) !== firstUid) throw new Error('Retry created another AgentRun')
}
const path = `/v1/agent-runs/${encodeURIComponent(id)}`
const deadline = Date.now() + 10 * 60_000
let current = second
let phase = ''
let cancellationRequested = false
const progress: Array<Record<string, unknown>> = []
while (Date.now() < deadline) {
  current = await request(path)
  const run = record(current.agentRun)
  const nextPhase = text(run.status)
  const observed = telemetry(current)
  if (observed && progress.at(-1)?.heartbeatAt !== observed.heartbeatAt) progress.push(observed)
  if (phase !== nextPhase) {
    phase = nextPhase
    process.stdout.write(`${id} ${phase}\n`)
  }
  if (mode === 'cancel' && phase === 'Running' && !cancellationRequested) {
    await request(path, 'DELETE')
    cancellationRequested = true
  }
  if (['Succeeded', 'Failed', 'Cancelled'].includes(phase)) break
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
const expected = mode === 'success' ? 'Succeeded' : mode === 'failure' ? 'Failed' : 'Cancelled'
if (phase !== expected) {
  if (!['Succeeded', 'Failed', 'Cancelled'].includes(phase)) await request(path, 'DELETE')
  throw new Error(`Expected ${expected}, observed ${phase || 'no phase'}`)
}
const terminal = current
if (mode !== 'cancel' && telemetry(terminal)?.state !== 'finished') {
  throw new Error('Terminal worker has no finished telemetry snapshot')
}
const resultArtifactUrl = (value: Record<string, unknown>): string | null => {
  const artifacts = record(snapshot(value).status).artifacts
  if (!Array.isArray(artifacts)) return null
  for (const artifact of artifacts) {
    const item = record(artifact)
    if (item.name === 'runner-result' && typeof item.url === 'string') return item.url
  }
  return null
}
const expectedArtifactUrl = `s3://agents-artifacts/oracle-acceptance/${deliveryId}/result.json`
const resultPreview = (value: Record<string, unknown>) => {
  return record(record(snapshot(value).status).runner).result
}
if (mode === 'success') {
  if (resultArtifactUrl(terminal) !== expectedArtifactUrl) {
    throw new Error('Successful worker has no retained result artifact')
  }
  const preview = record(resultPreview(terminal))
  if (typeof preview.text !== 'string' || !preview.text.includes(marker) || !preview.text.includes('0.166.0')) {
    throw new Error('Worker result does not prove the marker and Codex 0.166.0 execution')
  }
  const final = telemetry(terminal)
  if (!final || final.state !== 'finished' || !(Number(record(final.usage).totalTokens) > 0)) {
    throw new Error('Successful worker has no final usage summary')
  }
  const idleCommand = progress.some((sample, index) => {
    const previous = progress[index - 1]
    return (
      previous &&
      sample.state === 'running' &&
      Number(sample.activeToolCount) > 0 &&
      sample.lastActivityAt === previous.lastActivityAt &&
      sample.heartbeatAt !== previous.heartbeatAt
    )
  })
  if (!idleCommand) throw new Error('No advancing heartbeat was observed while a command was quiet')
}
while (current.resource && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2000))
  current = await request(path)
}
if (current.resource) throw new Error('AgentRun cleanup did not finish before the acceptance deadline')
if (text(record(current.agentRun).status) !== expected) throw new Error('Terminal status was lost after cleanup')
if (mode === 'success' && resultArtifactUrl(current) !== expectedArtifactUrl)
  throw new Error('Result artifact reference was lost after cleanup')
if (mode === 'success' && JSON.stringify(resultPreview(current)) !== JSON.stringify(resultPreview(terminal))) {
  throw new Error('Worker result preview was lost after cleanup')
}
if (mode !== 'cancel' && JSON.stringify(telemetry(current)) !== JSON.stringify(telemetry(terminal))) {
  throw new Error('Final telemetry was lost after cleanup')
}
let retainedLogs: Record<string, unknown> | null = null
if (mode !== 'cancel') {
  const name = text(record(snapshot(current).metadata).name)
  retainedLogs = await request(
    `/v1/control-plane/logs?name=${encodeURIComponent(name)}&namespace=agents&tailLines=5000`,
  )
  if (retainedLogs.source !== 'artifact') throw new Error('Logs were not retrieved from retained storage after cleanup')
  const events = text(retainedLogs.logs)
    .trim()
    .split('\n')
    .map((line) => record(record(JSON.parse(line)).event))
  if (!events.some((event) => event.type === 'heartbeat' && record(event.telemetry).state === 'finished')) {
    throw new Error('Archived logs do not include the finished telemetry snapshot')
  }
  if (mode === 'success') {
    const turns = new Set(events.filter((event) => event.type === 'turn_started').map((event) => event.turnId))
    if (turns.size < 2) throw new Error('Archived logs do not prove the native goal continuation')
    if (!events.some((event) => event.type === 'usage')) throw new Error('Archived logs have no usage events')
  } else if (!events.some((event) => event.type === 'error')) {
    throw new Error('Failed worker logs do not retain the failure')
  }
}
const receipt = { deliveryId, id, mode, marker, progress, terminal, retained: current, retainedLogs }
if (values.output) await writeFile(values.output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(
  `${JSON.stringify({ deliveryId, id, phase: expected, retainedAfterCleanup: true, progressSamples: progress.length, logSource: retainedLogs?.source ?? null })}\n`,
)
