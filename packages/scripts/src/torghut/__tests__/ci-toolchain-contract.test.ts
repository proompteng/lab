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
    const directory = mkdtempSync(join(tmpdir(), 'torghut-queue-plan-'))
    try {
      const output = join(directory, 'output')
      const result = Bun.spawnSync(['bash', '-c', plan], {
        env: { EVENT_NAME: 'merge_group', GITHUB_OUTPUT: output, PATH: process.env.PATH ?? '' },
      })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      expect(readFileSync(output, 'utf8')).toBe('service=true\nmanifests=true\n')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('requires the existing schema and notebook validators to succeed on the queued revision', () => {
    const router = Bun.YAML.parse(readFileSync('.github/workflows/pull-request.yml', 'utf8')) as Workflow
    const gate = router.jobs['ci-pr'].steps?.find((step) => step.name === 'Enforce selected validation results')
    if (!gate?.run) throw new Error('Missing queue gate command')
    const command = gate.run

    const run = (name: string, result: string) =>
      Bun.spawnSync(['bash', '-c', command], {
        env: {
          ...Object.fromEntries(Object.keys(gate.env ?? {}).map((key) => [key, 'success'])),
          PATH: process.env.PATH ?? '',
          FULL_VALIDATION: 'true',
          DELEGATED: '[]',
          [name]: result,
        },
      })

    for (const [job, file, result] of [
      ['torghut-schema', 'torghut-schema.yml', 'TORGHUT_SCHEMA_RESULT'],
      ['torghut-notebooks', 'torghut-notebooks-ci.yml', 'TORGHUT_NOTEBOOKS_RESULT'],
    ]) {
      const validator = Bun.YAML.parse(readFileSync(`.github/workflows/${file}`, 'utf8')) as Workflow
      expect(validator.on).toHaveProperty('workflow_call')
      expect(validator.on).toHaveProperty('pull_request')
      expect(validator.on).toHaveProperty('push')
      expect(validator.on).not.toHaveProperty('merge_group')
      expect(router.jobs[job]).toEqual({
        name: expect.any(String),
        if: "github.event_name == 'merge_group'",
        uses: `./.github/workflows/${file}`,
      })
      expect(router.jobs['ci-pr'].needs).toContain(job)
      expect(gate.env?.[result]).toBe(`\${{ needs.${job}.result }}`)
      expect(run(result, 'success').exitCode).toBe(0)
      for (const failure of ['failure', 'cancelled', 'skipped']) {
        const check = run(result, failure)
        expect(check.exitCode).toBe(1)
        expect(check.stderr.toString()).toContain('Torghut validation failed')
      }
    }
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
      const environment = join(directory, 'environment')
      const run = (sha: string) =>
        Bun.spawnSync(['bash', '-c', step.run ?? ''], {
          cwd: directory,
          env: {
            EVENT_NAME: 'merge_group',
            GITHUB_ENV: environment,
            QUEUE_BASE_SHA: sha,
            PATH: process.env.PATH ?? '',
          },
        })
      const result = run(base)
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      expect(readFileSync(environment, 'utf8')).toBe(`TORGHUT_DIFF_BASE=${base}\n`)
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
