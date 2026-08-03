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
  test('keeps the pure lifecycle gate ahead of every image, credential, or holdout operation', () => {
    const lifecycleDependencies = stepIndex('Install local Bayn lifecycle dependencies')
    const lifecycle = stepIndex('Verify candidate lifecycle before any image or credential access')
    const stop = stepIndex('Stop safely while qualification is dormant')
    const toolchain = stepIndex('Set up the local image-build toolchain')
    const build = stepIndex('Build and load the exact checked-out source image locally')
    const qualification = stepIndex('Run exactly one isolated read-only qualification')
    const terminalUpload = stepIndex('Upload immutable terminal qualification evidence')
    const activationUpload = stepIndex('Upload exactly one qualified activation terminal')

    expect(lifecycleDependencies).toBeGreaterThanOrEqual(0)
    expect(lifecycleDependencies).toBeLessThan(lifecycle)
    expect(runText('Install local Bayn lifecycle dependencies')).toContain(
      'bun install --frozen-lockfile --ignore-scripts --filter @proompteng/bayn',
    )
    expect(lifecycle).toBeGreaterThanOrEqual(0)
    expect(stop).toBeGreaterThan(lifecycle)
    expect(toolchain).toBeGreaterThan(lifecycle)
    expect(build).toBeGreaterThan(lifecycle)
    expect(qualification).toBeGreaterThan(lifecycle)
    expect(step('Stop safely while qualification is dormant').if).toBe("steps.lifecycle.outputs.eligible != 'true'")

    for (const name of [
      'Set up the local image-build toolchain',
      'Build and load the exact checked-out source image locally',
      'Run exactly one isolated read-only qualification',
      'Upload immutable terminal qualification evidence',
      'Upload exactly one qualified activation terminal',
      'Summarize terminal qualification evidence',
    ]) {
      expect(step(name).if).toContain("steps.lifecycle.outputs.eligible == 'true'")
    }
    expect(activationUpload).toBeGreaterThan(terminalUpload)
    expect(step('Upload exactly one qualified activation terminal').if).toContain(
      "steps.qualify.outputs.verdict == 'QUALIFIED'",
    )

    const lifecycleRun = runText('Verify candidate lifecycle before any image or credential access')
    expect(lifecycleRun).toContain('verify-qualification-dormancy.ts')
    expect(lifecycleRun).toContain('--repository-root "$GITHUB_WORKSPACE"')
    expect(lifecycleRun).toContain('--github-output "$GITHUB_OUTPUT"')
    expect(lifecycleRun).not.toContain('secrets.')
    expect(lifecycleRun).not.toContain('docker')
  })

  test('builds and binds the exact checked-out Bayn image locally without release orchestration', () => {
    const checkout = step('Checkout exact scheduled main')
    expect(checkout.uses).toBe('actions/checkout@v5')
    expect(checkout.with).toMatchObject({
      ref: '${{ github.sha }}',
      'fetch-depth': 0,
      'persist-credentials': false,
    })

    const build = runText('Build and load the exact checked-out source image locally')
    expect(build).toContain('nix build .#bayn-image')
    expect(build).toContain('bash nix/verify-bayn-image-command.sh "$image_tar"')
    expect(build).toContain('docker load --input "$image_tar"')
    expect(build).toContain('local_manifest_digest="$(bash nix/oci-inspect-archive.sh "$image_tar" | jq -er')
    expect(build).not.toContain("docker image inspect --format '{{.Id}}'")
    expect(build).toContain('published_reference="${IMAGE_REPOSITORY}:sha-${GITHUB_SHA}"')
    expect(build).toContain('published_digest="$(regctl image digest "$published_reference")"')
    expect(build).toContain('published_manifest="$(regctl manifest get "$published_reference" --format raw-body)"')
    expect(build).toContain('and any(.manifests[]; .platform.os == "linux" and .platform.architecture == "amd64")')
    expect(build).toContain('and .digest == $local_manifest_digest')
    expect(build).toContain('source_revision="$(docker image inspect')
    expect(build).toContain('test "$source_revision" = "${GITHUB_SHA}"')
    expect(build).toContain('echo "binding=${IMAGE_REPOSITORY}@${published_digest}" >> "$GITHUB_OUTPUT"')

    const orchestrationText = steps
      .flatMap((candidate) => (candidate.run === undefined ? [] : [candidate.run]))
      .join('\n')
    for (const forbidden of ['crane', 'docker pull', 'docker push', 'kubectl', 'argocd', 'deployment.yaml']) {
      expect(orchestrationText).not.toContain(forbidden)
    }
    expect(orchestrationText).not.toContain('BAYN_QUALIFICATION_RUN_ID')
    expect(orchestrationText).not.toContain('workflow_call')

    const qualification = runText('Run exactly one isolated read-only qualification')
    const qualificationEnv = step('Run exactly one isolated read-only qualification').env ?? {}
    expect(qualificationEnv.IMAGE_BINDING).toBe('${{ steps.image.outputs.binding }}')
    expect(qualification).toContain('-e BAYN_QUALIFICATION_IMAGE_REFERENCE="$IMAGE_BINDING"')
  })

  test('runs exactly one isolated read-only qualification after eligibility', () => {
    const qualification = runText('Run exactly one isolated read-only qualification')

    expect(steps.some((candidate) => candidate.name?.toLowerCase().includes('preflight'))).toBe(false)
    expect(qualification).toContain('docker run --rm')
    expect(qualification).toContain('--pull=never')
    expect(qualification).toContain('--network host')
    expect(qualification).toContain('--read-only')
    expect(qualification).toContain('--cap-drop=ALL')
    expect(qualification).toContain('--security-opt=no-new-privileges')
    expect(qualification).toContain('--mount "type=bind,src=${GITHUB_WORKSPACE},dst=/workspace,readonly"')
    expect(qualification).toContain('-e BAYN_QUALIFICATION_MODE=execute')
    expect(qualification).toContain('--entrypoint bayn-qualification-collector')
    expect(qualification).toContain('>"$log" 2>&1')
    expect(qualification).toContain('set +x')
    expect(qualification).not.toContain('BAYN_QUALIFICATION_MODE=preflight')
    expect(qualification).not.toContain('tee')
    expect(qualification).not.toContain('--privileged')
    expect(qualification).not.toContain('sudo')

    const orchestrationText = steps
      .flatMap((candidate) => (candidate.run === undefined ? [] : [candidate.run]))
      .join('\n')
    expect((orchestrationText.match(/BAYN_QUALIFICATION_MODE=execute/g) ?? []).length).toBe(1)
    expect((orchestrationText.match(/docker run --rm/g) ?? []).length).toBe(1)
  })

  test('uploads the exact terminal once and creates no activation artifact for REJECTED', () => {
    const qualify = runText('Run exactly one isolated read-only qualification')
    const terminalUpload = step('Upload immutable terminal qualification evidence')
    const activationUpload = step('Upload exactly one qualified activation terminal')
    expect(qualify).toContain('echo "verdict=$(jq -r \'.terminal.verdict\' "$terminal")" >> "$GITHUB_OUTPUT"')
    expect(terminalUpload.uses).toBe('actions/upload-artifact@v4')
    expect(activationUpload.uses).toBe('actions/upload-artifact@v4')
    expect(activationUpload.with?.name).toBe(
      'bayn-paper-activation-evidence-${{ github.run_id }}-${{ github.run_attempt }}',
    )
    expect(activationUpload.with?.path).toBe('${{ steps.qualify.outputs.terminal }}')
    expect(activationUpload.if).toBe(
      "steps.lifecycle.outputs.eligible == 'true' && steps.qualify.outcome == 'success' && steps.qualify.outputs.verdict == 'QUALIFIED'",
    )
    expect(activationUpload.if).not.toContain('REJECTED')
  })

  test('keeps the qualification boundary read-only and wires credentials only at execution', () => {
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
    const executionEnv = step('Run exactly one isolated read-only qualification').env ?? {}
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

    const preExecution = steps
      .slice(0, stepIndex('Run exactly one isolated read-only qualification'))
      .flatMap((candidate) => (candidate.env === undefined ? [] : [JSON.stringify(candidate.env)]))
      .join('\n')
    expect(preExecution).not.toContain('secrets.')
    expect(preExecution).not.toContain('GITHUB_TOKEN')
  })

  test('parses every shell step with Bash and preserves the local candidate-development wrapper', () => {
    for (const candidate of steps) {
      if (candidate.run === undefined) continue
      expect(() => execFileSync('bash', ['-n'], { input: candidate.run, encoding: 'utf8' })).not.toThrow()
    }
    expect(packageManifest.scripts['candidate:development:local']).toBe(
      'bun ../../packages/scripts/src/bayn/candidate-development-local/command.ts',
    )
  })
})
