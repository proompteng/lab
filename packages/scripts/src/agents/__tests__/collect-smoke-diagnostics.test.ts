import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'

import { captureFixtureCommand, collectFixtureDiagnostics, sanitizeFixtureList } from '../collect-smoke-diagnostics'

const success = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', timedOut: false })
const context = 'kind-agents-ci-123-2'

describe('sanitized fixture diagnostics', () => {
  it('retains useful status without specs, credentials, annotations, messages, or logs', () => {
    const result = sanitizeFixtureList({
      items: [
        {
          kind: 'Pod',
          metadata: { name: 'fixture-pod', namespace: 'agents-ci', annotations: { token: 'secret-annotation' } },
          spec: { containers: [{ env: [{ name: 'TOKEN', value: 'secret-env' }] }] },
          data: { password: 'secret-data' },
          status: {
            phase: 'Pending',
            message: 'secret-status',
            conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady', message: 'secret-condition' }],
            containerStatuses: [
              {
                name: 'fixture',
                ready: false,
                restartCount: 2,
                state: { waiting: { reason: 'ImagePullBackOff', message: 'secret-image-url' } },
              },
            ],
          },
          logs: 'secret-log',
        },
      ],
    })
    expect(result[0]?.status.phase).toBe('Pending')
    expect(result[0]?.status.containers[0]?.waitingReason).toBe('ImagePullBackOff')
    expect(JSON.stringify(result)).not.toContain('secret-')
    expect(JSON.stringify(result)).not.toContain('TOKEN')
  })

  it('rejects non-fixture contexts before issuing any command', async () => {
    let calls = 0
    const result = await collectFixtureDiagnostics('production', async () => {
      calls += 1
      return success('')
    })
    expect(calls).toBe(0)
    expect(result.scope).toBe('invalid_fixture_context')
  })

  it('does not query resources when the current context differs', async () => {
    const commands: string[][] = []
    const result = await collectFixtureDiagnostics(context, async (command) => {
      commands.push(command)
      return success('another-cluster')
    })
    expect(commands).toEqual([['kubectl', 'config', 'current-context']])
    expect(result.scope).toBe('context_unavailable_or_mismatched')
  })

  it('collects only the verified context and fixed fixture namespace', async () => {
    const commands: string[][] = []
    const result = await collectFixtureDiagnostics(context, async (command) => {
      commands.push(command)
      return success(commands.length === 1 ? context : '{"items":[]}')
    })
    expect(result.scope).toBe('verified_disposable_fixture')
    expect(result.resources).toHaveLength(6)
    expect(result.resources.every((item) => item.outcome === 'captured')).toBe(true)
    for (const command of commands.slice(1)) {
      expect(command.slice(0, 6)).toEqual(['kubectl', '--context', context, '--request-timeout=5s', '-n', 'agents-ci'])
    }
  })

  it('records unavailable APIs without persisting raw error contents', async () => {
    let calls = 0
    const result = await collectFixtureDiagnostics(context, async () => {
      calls += 1
      return calls === 1 ? success(context) : { exitCode: 1, stdout: '', stderr: 'secret-error', timedOut: false }
    })
    expect(result.resources).toHaveLength(6)
    expect(result.resources.every((item) => item.outcome === 'query_failed')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('secret-error')
  })

  it('retains an invalid-response outcome without raw response content', async () => {
    let calls = 0
    const result = await collectFixtureDiagnostics(context, async () => {
      calls += 1
      return success(calls === 1 ? context : 'secret-not-json')
    })
    expect(result.resources.every((item) => item.outcome === 'unavailable_or_invalid_response')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('secret-not-json')
  })

  it('kills a hung diagnostic command at the process deadline', async () => {
    const result = await captureFixtureCommand([process.execPath, '-e', 'setInterval(() => {}, 1000)'], 30)
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).not.toBe(0)
  })

  it('always collects and uploads before cleanup without extending smoke deadlines', () => {
    const workflow = parse(readFileSync(resolve(process.cwd(), '.github/workflows/agents-ci.yml'), 'utf8'))
    const steps = workflow.jobs.integration.steps as Array<Record<string, unknown>>
    const index = (name: string) => steps.findIndex((step) => step.name === name)
    const collect = index('Collect sanitized Agents fixture diagnostics')
    const upload = index('Upload sanitized Agents fixture diagnostics')
    const cleanup = index('Cleanup Agents integration resources')
    expect(collect).toBeGreaterThan(index('Run Agents integration smoke test'))
    expect(upload).toBeGreaterThan(collect)
    expect(cleanup).toBeGreaterThan(upload)
    expect(steps[collect]?.if).toBe('always()')
    expect(steps[upload]?.if).toBe('always()')
    const smoke = steps[index('Run Agents integration smoke test')]
    const smokeEnv = smoke?.env as Record<string, string> | undefined
    expect(smokeEnv?.AGENTS_TIMEOUT).toBe('15m')
  })
})
