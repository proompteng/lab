import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'

const workflow = readFileSync(
  new URL('../../../../../.github/workflows/nix-oci-build-common.yml', import.meta.url),
  'utf8',
)
const step = workflow.split('      - name: Create OCI image index\n')[1]?.split('\n      - name:')[0]
const script = step?.split('        run: |\n')[1]?.replace(/^          /gm, '')
if (script === undefined) throw new Error('Create OCI image index shell step is missing')

const source = '1'.repeat(40)
const runId = '123456'
const runIndexStep = (overrides: Record<string, string> = {}) => {
  // Execute the actual workflow shell, intercepting only its final timed command. No registry calls run.
  const result = Bun.spawnSync(['bash', '-c', `bash() { printf '%s\\0' "$@"; }\n${script}`], {
    env: {
      ...process.env,
      IMAGE: 'registry.example/lab/bayn',
      TAG: `sha-${source}`,
      SOURCE_SHA: source,
      GITHUB_REPOSITORY: 'proompteng/lab',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_RUN_ID: runId,
      BUILD_CONCLUSION: 'success',
      LATEST: 'false',
      PUBLISH_KARGO_TAG: 'false',
      KARGO_TAG_INCLUDE_RUN_ID: 'true',
      NIX_OCI_LOG_DIR: '/unused-fixture',
      ...overrides,
    },
  })
  return {
    exitCode: result.exitCode,
    args: result.stdout.toString().split('\0').filter(Boolean),
    stderr: result.stderr.toString(),
  }
}

describe('Nix OCI workflow receipt preparation', () => {
  it('passes validated run identity while deferring the Bayn cohort alias', () => {
    const result = runIndexStep()
    expect(result.exitCode).toBe(0)
    expect(result.args).toContain('--defer-kargo-tag')
    expect(result.args[result.args.indexOf('--kargo-tag') + 1]).toBe(`kargo-sha-${source}-run-${runId}`)
    expect(result.args).toContain(`ai.proompteng.github-actions-run-id=${runId}`)
    expect(result.args).toContain('ai.proompteng.github-actions-build-conclusion=success')
    expect(result.args).not.toContain('--latest')
  })

  it('retains direct main receipt publication when explicitly enabled', () => {
    const result = runIndexStep({ PUBLISH_KARGO_TAG: 'true' })
    expect(result.exitCode).toBe(0)
    expect(result.args[result.args.indexOf('--kargo-tag') + 1]).toBe(`kargo-sha-${source}-run-${runId}`)
    expect(result.args).not.toContain('--defer-kargo-tag')
  })

  it('never exposes a receipt alias from a non-main diagnostic build', () => {
    const result = runIndexStep({ PUBLISH_KARGO_TAG: 'true', GITHUB_REF: 'refs/heads/codex/fixture' })
    expect(result.exitCode).toBe(0)
    expect(result.args[result.args.indexOf('--kargo-tag') + 1]).toBe(`kargo-sha-${source}-run-${runId}`)
    expect(result.args).toContain('--defer-kargo-tag')
  })

  it('preserves ordinary main publication without receipt metadata', () => {
    const result = runIndexStep({ PUBLISH_KARGO_TAG: 'true', KARGO_TAG_INCLUDE_RUN_ID: 'false' })
    expect(result.exitCode).toBe(0)
    expect(result.args[result.args.indexOf('--kargo-tag') + 1]).toBe(`kargo-sha-${source}`)
    expect(result.args).not.toContain('--defer-kargo-tag')
    expect(result.args.some((arg) => arg.startsWith('ai.proompteng.github-actions-'))).toBe(false)
  })

  it('leaves non-receipt preparation undiscoverable', () => {
    const result = runIndexStep({ KARGO_TAG_INCLUDE_RUN_ID: 'false' })
    expect(result.exitCode).toBe(0)
    expect(result.args).not.toContain('--kargo-tag')
    expect(result.args).not.toContain('--defer-kargo-tag')
  })

  it.each(['failure', 'cancelled', 'skipped'])('rejects a %s platform build before index creation', (conclusion) => {
    const result = runIndexStep({ BUILD_CONCLUSION: conclusion })
    expect(result.exitCode).toBe(2)
    expect(result.args).toEqual([])
    expect(result.stderr).toContain('Refusing to publish an OCI index')
  })

  it.each(['0', '-1', 'invalid'])('rejects invalid run ID %s before index creation', (id) => {
    const result = runIndexStep({ GITHUB_RUN_ID: id })
    expect(result.exitCode).toBe(2)
    expect(result.args).toEqual([])
    expect(result.stderr).toContain('GITHUB_RUN_ID must be a positive integer')
  })
})
