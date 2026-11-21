import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

const workflow = readFileSync(new URL('../../../../../.github/workflows/torghut-ci.yml', import.meta.url), 'utf8')

type Workflow = {
  on: Record<string, unknown>
  jobs: Record<
    string,
    {
      if?: string
      needs?: string[]
      uses?: string
      steps?: { name: string; run?: string; env?: Record<string, string> }[]
    }
  >
}

describe('Torghut CI toolchain contract', () => {
  it('requires Torghut in the central queue gate and plans both validation paths', () => {
    const torghut = Bun.YAML.parse(workflow) as Workflow
    const router = Bun.YAML.parse(readFileSync('.github/workflows/pull-request.yml', 'utf8')) as Workflow
    expect(torghut.on).toHaveProperty('workflow_call')
    expect(router.jobs.torghut).toMatchObject({
      if: "github.event_name == 'merge_group'",
      uses: './.github/workflows/torghut-ci.yml',
    })
    expect(router.jobs['ci-pr'].needs).toContain('torghut')
    const gate = router.jobs['ci-pr'].steps?.find((step) => step.name === 'Enforce selected validation results')
    expect(gate?.env?.TORGHUT_RESULT).toBe('${{ needs.torghut.result }}')
    expect(gate?.run).toContain('"${TORGHUT_RESULT}" != success')
    expect(torghut.jobs['release-manifests'].if).toContain("github.event_name == 'merge_group'")

    const plan = torghut.jobs.changes.steps?.find((step) => step.name === 'Check changed Torghut paths')?.run
    if (!plan) throw new Error('Missing Torghut plan command')
    const result = Bun.spawnSync(['bash', '-c', plan], {
      env: { EVENT_NAME: 'merge_group', GITHUB_OUTPUT: '/dev/stdout', PATH: process.env.PATH ?? '' },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('service=true\nmanifests=true\n')
  })

  it('uses the supplied queue base and rejects a missing base instead of using the previous commit', () => {
    const torghut = Bun.YAML.parse(workflow) as Workflow
    const step = torghut.jobs['static-guards'].steps?.find((entry) => entry.name === 'Resolve Torghut diff base')
    expect(step?.env?.QUEUE_BASE_SHA).toBe('${{ github.event.merge_group.base_sha }}')
    if (!step?.run) throw new Error('Missing Torghut diff base command')
    const directory = mkdtempSync(join(tmpdir(), 'torghut-queue-base-'))
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], { cwd: directory })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      return result.stdout.toString().trim()
    }
    try {
      git('init', '--quiet')
      for (const commit of ['base', 'first queued change', 'second queued change']) {
        git(
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '--quiet',
          '--no-gpg-sign',
          '--allow-empty',
          '-m',
          commit,
        )
      }
      const base = git('rev-parse', 'HEAD~2')
      const run = (sha: string) =>
        Bun.spawnSync(['bash', '-c', step.run ?? ''], {
          cwd: directory,
          env: {
            EVENT_NAME: 'merge_group',
            GITHUB_ENV: '/dev/stdout',
            QUEUE_BASE_SHA: sha,
            PATH: process.env.PATH ?? '',
          },
        })
      const result = run(base)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain(`TORGHUT_DIFF_BASE=${base}\n`)
      expect(run('').exitCode).not.toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('guarantees jq and yq before manifest digest validation', () => {
    const setupStart = workflow.indexOf('- name: Set up Nix toolchain')
    const verificationStart = workflow.indexOf('- name: Verify Torghut Alloy config rollout digest')

    expect(setupStart).toBeGreaterThanOrEqual(0)
    expect(verificationStart).toBeGreaterThan(setupStart)

    const setup = workflow.slice(setupStart, verificationStart)
    expect(setup).toContain("install-ci-toolchain: 'true'")
    expect(setup).toContain("require-preinstalled: 'true'")
    expect(workflow.slice(verificationStart)).toContain('yq -r')
    expect(workflow.slice(verificationStart)).toContain('jq -jr')
  })
})
