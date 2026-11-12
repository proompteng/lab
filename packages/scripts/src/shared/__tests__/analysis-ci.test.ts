import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'

const workflow = YAML.parse(
  readFileSync(new URL('../../../../../.github/workflows/analysis-shared-ci.yml', import.meta.url), 'utf8'),
)
const admission = workflow.jobs['admit-publish'].steps[0].with.script as string
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const admit = new AsyncFunction('github', 'core', 'process', admission)
const sha = 'a'.repeat(40)
const sourceRun = () => ({
  head_sha: sha,
  head_branch: 'main',
  head_repository: { full_name: 'gregkonush/analysis' },
  path: '.github/workflows/analysis-image.yml',
  run_attempt: 2,
  event: 'push',
})
const sourceEnv = () => ({
  SOURCE_SHA: sha,
  SOURCE_REF: 'refs/heads/main',
  UPSTREAM_RUN_ID: '1234',
  UPSTREAM_RUN_ATTEMPT: '2',
})

describe('analysis common-worker bridge', () => {
  it('keeps application execution on the shared ARM pool without exposing its source credential to actions', () => {
    expect(workflow.permissions).toEqual({})
    for (const name of ['validate', 'publish']) {
      const job = workflow.jobs[name]
      expect(job['runs-on']).toBe('arc-arm64')
      expect(job.env).toBeUndefined()
      const checkout = job.steps.find((step: { uses?: string }) => step.uses === 'actions/checkout@v6')
      expect(checkout.with).toMatchObject({
        repository: 'gregkonush/analysis',
        ref: '${{ inputs.source_sha }}',
        'persist-credentials': false,
      })
      const action = job.steps.find((step: { uses?: string }) => step.uses?.startsWith('./.github/actions/'))
      expect(JSON.stringify(action)).not.toContain('TOKEN')
    }
    expect(workflow.jobs.publish.needs).toEqual(['validate', 'admit-publish'])
    expect(workflow.jobs.publish.if).toBe("needs.admit-publish.outputs.approved == 'true'")
  })

  it('rejects malformed source inputs before private checkout', () => {
    const script = workflow.jobs.validate.steps[0].run as string
    for (const [value, accepted] of [
      [sha, true],
      ['main', false],
      [sha + '; exit 0', false],
    ] as const) {
      const result = spawnSync('bash', ['-c', script], {
        env: { ...process.env, ...sourceEnv(), SOURCE_SHA: value },
        encoding: 'utf8',
      })
      expect(result.status).toBe(accepted ? 0 : 1)
    }
  })

  it('admits only the exact trusted upstream main run while the source is still current', async () => {
    for (const scenario of ['valid', 'stale', 'other-repo', 'wrong-sha', 'wrong-workflow', 'pr', 'attempt', 'ref']) {
      const run = sourceRun()
      const env = sourceEnv()
      if (scenario === 'other-repo') run.head_repository.full_name = 'other/analysis'
      if (scenario === 'wrong-sha') run.head_sha = 'b'.repeat(40)
      if (scenario === 'wrong-workflow') run.path = '.github/workflows/other.yml'
      if (scenario === 'pr') run.event = 'pull_request'
      if (scenario === 'attempt') run.run_attempt = 1
      if (scenario === 'ref') env.SOURCE_REF = 'refs/heads/other'
      const outputs: Record<string, string> = {}
      const github = {
        rest: {
          actions: {
            getWorkflowRunAttempt: async (request: Record<string, unknown>) => {
              expect(request).toEqual({
                owner: 'gregkonush',
                repo: 'analysis',
                run_id: 1234,
                attempt_number: 2,
              })
              return { data: run }
            },
          },
          git: { getRef: async () => ({ data: { object: { sha: scenario === 'stale' ? 'b'.repeat(40) : sha } } }) },
        },
      }
      const operation = admit(
        github,
        {
          setOutput: (name: string, value: string) => {
            outputs[name] = value
          },
        },
        { env },
      )
      if (scenario === 'valid') {
        await operation
        expect(outputs.approved).toBe('true')
      } else {
        await expect(operation).rejects.toThrow()
        expect(outputs.approved).toBeUndefined()
      }
    }
  })
})
