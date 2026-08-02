import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { parse } from 'yaml'

const workflowPath = '.github/workflows/bayn-qualification.yml'
const packageManifestPath = 'services/bayn/package.json'

interface WorkflowStep {
  readonly name?: string
  readonly id?: string
  readonly if?: string
  readonly run?: string
  readonly uses?: string
  readonly with?: Record<string, unknown>
  readonly env?: Record<string, unknown>
}

interface QualificationWorkflow {
  readonly permissions: Record<string, string>
  readonly jobs: {
    readonly eligibility: {
      readonly steps: readonly WorkflowStep[]
    }
  }
}

const workflow = parse(readFileSync(workflowPath, 'utf8')) as QualificationWorkflow
const packageManifest = JSON.parse(readFileSync(packageManifestPath, 'utf8')) as {
  readonly scripts: Record<string, string>
}
const steps = workflow.jobs.eligibility.steps

const step = (name: string): WorkflowStep => {
  const found = steps.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`workflow step is missing: ${name}`)
  return found
}

const stepIndex = (name: string): number => steps.findIndex((candidate) => candidate.name === name)

const runText = (name: string): string => step(name).run ?? ''

describe('Bayn qualification workflow contract', () => {
  test('keeps dormancy ahead of every privileged or image operation', () => {
    const dormancy = stepIndex('Verify typed candidate dormancy before any privileged access')
    const stop = stepIndex('Stop safely while qualification is dormant')
    const toolchain = stepIndex('Set up the runner image-inspection toolchain')
    const build = stepIndex('Resolve and load the exact checked-out source image')
    const preflight = stepIndex('Preflight the exact source image without credentials or network')
    const execution = stepIndex('Collect, lock, execute once, and independently audit the sealed holdout')

    expect(dormancy).toBeGreaterThanOrEqual(0)
    expect(stop).toBeGreaterThan(dormancy)
    expect(toolchain).toBeGreaterThan(stop)
    expect(build).toBeGreaterThan(toolchain)
    expect(preflight).toBeGreaterThan(build)
    expect(execution).toBeGreaterThan(preflight)
    expect(step('Stop safely while qualification is dormant').if).toBe("steps.dormancy.outputs.dormant == 'true'")
    for (const name of [
      'Set up the runner image-inspection toolchain',
      'Resolve and load the exact checked-out source image',
      'Preflight the exact source image without credentials or network',
      'Collect, lock, execute once, and independently audit the sealed holdout',
    ]) {
      expect(step(name).if).toBe("steps.dormancy.outputs.dormant == 'false'")
    }
    expect(runText('Verify typed candidate dormancy before any privileged access')).toContain(
      'verify-qualification-dormancy.ts',
    )
    expect(runText('Verify typed candidate dormancy before any privileged access')).toContain(
      '--repository-root "$GITHUB_WORKSPACE"',
    )
    expect(runText('Verify typed candidate dormancy before any privileged access')).toContain(
      '--github-output "$GITHUB_OUTPUT"',
    )
  })

  test('runs the exact checked-out source image without release or deployment orchestration', () => {
    const checkout = step('Checkout exact scheduled main')
    expect(checkout.uses).toBe('actions/checkout@v5')
    expect(checkout.with).toMatchObject({
      ref: '${{ github.sha }}',
      'fetch-depth': 0,
      'persist-credentials': false,
    })

    const build = runText('Resolve and load the exact checked-out source image')
    expect(build).toContain('crane digest "$image_tag"')
    expect(build).toContain('image_reference="${IMAGE_REPOSITORY}@${image_digest}"')
    expect(build).toContain('crane config --platform linux/arm64 "$image_reference"')
    expect(build).toContain('docker pull --platform linux/arm64 "$image_reference"')
    expect(build).toContain('echo "reference=${image_reference}" >> "$GITHUB_OUTPUT"')

    const allRuns = steps.flatMap((candidate) => (candidate.run === undefined ? [] : [candidate.run]))
    const orchestrationText = allRuns.join('\n')
    expect(orchestrationText).not.toContain('docker push')
    expect(orchestrationText).not.toContain('kubectl')
    expect(orchestrationText).not.toContain('argocd')
    expect(orchestrationText).not.toContain('deployment.yaml')
    expect(orchestrationText).not.toContain('BAYN_QUALIFICATION_RUN_ID')

    const preflight = runText('Preflight the exact source image without credentials or network')
    expect(preflight).toContain('--network none')
    expect(preflight).toContain('--read-only')
    expect(preflight).toContain('--mount "type=bind,src=${GITHUB_WORKSPACE},dst=/workspace,readonly"')
    expect(preflight).toContain('-e BAYN_QUALIFICATION_MODE=preflight')
    expect(preflight).toContain('--entrypoint bayn-qualification-collector')

    const execution = runText('Collect, lock, execute once, and independently audit the sealed holdout')
    expect(execution).toContain('--network host')
    expect(execution).toContain('--read-only')
    expect(execution).toContain('-e BAYN_QUALIFICATION_MODE=execute')
    expect(execution).toContain('--entrypoint bayn-qualification-collector')
    expect((orchestrationText.match(/BAYN_QUALIFICATION_MODE=execute/g) ?? []).length).toBe(1)
  })

  test('keeps the qualification boundary read-only and wires only the declared execution secrets', () => {
    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(step('Reject manual invocation').if).toBe("github.event_name == 'workflow_dispatch'")
    expect(runText('Reject manual invocation')).toContain('Manual qualification dispatch is forbidden.')

    const expectedSecrets = [
      'BAYN_QUALIFICATION_CLICKHOUSE_USERNAME',
      'BAYN_QUALIFICATION_CLICKHOUSE_PASSWORD',
      'BAYN_QUALIFICATION_POSTGRES_URL',
      'BAYN_QUALIFICATION_POSTGRES_CA_PEM',
      'BAYN_QUALIFICATION_SIGNAL_PUBLISHER_USERNAME',
      'BAYN_QUALIFICATION_AUDIT_CLICKHOUSE_USERNAME',
      'BAYN_QUALIFICATION_AUDIT_CLICKHOUSE_PASSWORD',
    ]
    const executionEnv = step('Collect, lock, execute once, and independently audit the sealed holdout').env ?? {}
    expect(Object.keys(executionEnv).filter((key) => key.startsWith('BAYN_'))).toEqual([
      'BAYN_CLICKHOUSE_USERNAME',
      'BAYN_CLICKHOUSE_PASSWORD',
      'BAYN_POSTGRES_URL',
      'BAYN_QUALIFICATION_POSTGRES_CA_PEM',
      'BAYN_AUDIT_SIGNAL_PUBLISHER_USERNAME',
      'BAYN_AUDIT_CLICKHOUSE_USERNAME',
      'BAYN_AUDIT_CLICKHOUSE_PASSWORD',
    ])
    for (const secret of expectedSecrets) {
      expect(JSON.stringify(executionEnv)).toContain(`secrets.${secret}`)
    }
    expect(
      JSON.stringify(step('Preflight the exact source image without credentials or network').env ?? {}),
    ).not.toContain('secrets.')
  })

  test('parses every shell step with Bash and exposes the local candidate-development wrapper', () => {
    for (const candidate of steps) {
      if (candidate.run === undefined) continue
      expect(() => execFileSync('bash', ['-n'], { input: candidate.run, encoding: 'utf8' })).not.toThrow()
    }
    expect(packageManifest.scripts['candidate:development:local']).toBe(
      'bun ../../packages/scripts/src/bayn/candidate-development-local/command.ts',
    )
  })
})
