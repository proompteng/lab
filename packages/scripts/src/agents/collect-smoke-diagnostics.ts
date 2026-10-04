#!/usr/bin/env bun

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type FixtureCommandResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export const captureFixtureCommand = async (command: string[], timeoutMs = 10_000): Promise<FixtureCommandResult> => {
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim(), timedOut }
  } finally {
    clearTimeout(timer)
  }
}

const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const string = (value: unknown) => (typeof value === 'string' ? value : undefined)
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const boolean = (value: unknown) => (typeof value === 'boolean' ? value : undefined)
const array = (value: unknown) => (Array.isArray(value) ? value : [])

export const sanitizeFixtureList = (value: unknown) => {
  const source = object(value)
  if (!Array.isArray(source.items)) throw new Error('Invalid resource list')
  return source.items.map((item: unknown) => {
    const resource = object(item)
    const metadata = object(resource.metadata)
    const status = object(resource.status)
    const involved = object(resource.involvedObject)
    return {
      kind: string(resource.kind),
      name: string(metadata.name),
      namespace: string(metadata.namespace),
      createdAt: string(metadata.creationTimestamp),
      generation: number(metadata.generation),
      status: {
        phase: string(status.phase),
        observedGeneration: number(status.observedGeneration),
        replicas: number(status.replicas),
        readyReplicas: number(status.readyReplicas),
        updatedReplicas: number(status.updatedReplicas),
        availableReplicas: number(status.availableReplicas),
        unavailableReplicas: number(status.unavailableReplicas),
        active: number(status.active),
        succeeded: number(status.succeeded),
        failed: number(status.failed),
        conditions: array(status.conditions).map((value) => {
          const condition = object(value)
          return {
            type: string(condition.type),
            status: string(condition.status),
            reason: string(condition.reason),
            lastTransitionTime: string(condition.lastTransitionTime),
          }
        }),
        containers: array(status.containerStatuses).map((value) => {
          const container = object(value)
          const state = object(container.state)
          const terminated = object(state.terminated)
          return {
            name: string(container.name),
            ready: boolean(container.ready),
            restartCount: number(container.restartCount),
            waitingReason: string(object(state.waiting).reason),
            runningSince: string(object(state.running).startedAt),
            terminated: {
              reason: string(terminated.reason),
              exitCode: number(terminated.exitCode),
              startedAt: string(terminated.startedAt),
              finishedAt: string(terminated.finishedAt),
            },
          }
        }),
      },
      event: {
        type: string(resource.type),
        reason: string(resource.reason),
        count: number(resource.count),
        firstTimestamp: string(resource.firstTimestamp),
        lastTimestamp: string(resource.lastTimestamp),
        objectKind: string(involved.kind),
        objectName: string(involved.name),
      },
    }
  })
}

export const collectFixtureDiagnostics = async (context: string, capture = captureFixtureCommand) => {
  const result: {
    observedAt: string
    context: string
    namespace: string
    scope: string
    resources: Array<{ resource: string; outcome: string; items?: ReturnType<typeof sanitizeFixtureList> }>
  } = {
    observedAt: new Date().toISOString(),
    context,
    namespace: 'agents-ci',
    scope: 'unverified',
    resources: [],
  }
  if (!/^kind-agents-ci-\d+-\d+$/.test(context)) {
    result.scope = 'invalid_fixture_context'
    return result
  }
  try {
    const current = await capture(['kubectl', 'config', 'current-context'])
    if (current.exitCode !== 0 || current.timedOut || current.stdout !== context) {
      result.scope = 'context_unavailable_or_mismatched'
      return result
    }
  } catch {
    result.scope = 'context_unavailable_or_mismatched'
    return result
  }
  result.scope = 'verified_disposable_fixture'
  for (const resource of ['deployments', 'replicasets', 'pods', 'jobs', 'agentruns.agents.proompteng.ai', 'events']) {
    try {
      const response = await capture([
        'kubectl',
        '--context',
        context,
        '--request-timeout=5s',
        '-n',
        'agents-ci',
        'get',
        resource,
        '-o',
        'json',
      ])
      if (response.timedOut || response.exitCode !== 0) {
        result.resources.push({ resource, outcome: response.timedOut ? 'timed_out' : 'query_failed' })
        continue
      }
      result.resources.push({
        resource,
        outcome: 'captured',
        items: sanitizeFixtureList(JSON.parse(response.stdout)),
      })
    } catch {
      // Never persist raw command errors, specs, env, Secret data, or pod logs.
      result.resources.push({ resource, outcome: 'unavailable_or_invalid_response' })
    }
  }
  return result
}

if (import.meta.main) {
  const outputDirectory = process.env.AGENTS_DIAGNOSTICS_DIR
  if (!outputDirectory) throw new Error('AGENTS_DIAGNOSTICS_DIR is required')
  await mkdir(outputDirectory, { recursive: true })
  const diagnostics = await collectFixtureDiagnostics(`kind-${process.env.KIND_CLUSTER_NAME ?? ''}`)
  await writeFile(join(outputDirectory, 'fixture-state.json'), JSON.stringify(diagnostics, null, 2))
  console.log('Sanitized disposable-fixture state saved')
}
