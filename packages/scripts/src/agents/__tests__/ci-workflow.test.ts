import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

type Job = {
  name?: string
  needs?: string | string[]
  if?: string
  uses?: string
  'continue-on-error'?: boolean
  steps?: { name: string; uses?: string; with?: Record<string, string>; run?: string; env?: Record<string, string> }[]
}

const loadWorkflow = (name: string): { jobs: Record<string, Job> } =>
  parse(readFileSync(new URL(`../../../../../.github/workflows/${name}`, import.meta.url), 'utf8'))

test('only a direct Agents push needs history to plan validation', () => {
  const { jobs } = loadWorkflow('agents-ci.yml')
  const checkout = jobs.plan?.steps?.find((step) => step.uses === 'actions/checkout@v5')
  expect(checkout?.with?.['fetch-depth']).toBe("${{ github.event_name == 'push' && '0' || '1' }}")
})

test('Agents unit, static, and Kind start from the same plan without dropping enforceable results', () => {
  const { jobs } = loadWorkflow('agents-ci.yml')
  for (const [id, name, selected] of [
    ['unit', 'Agents typecheck and unit tests', 'run_unit'],
    ['static', 'Validate Agents chart and CRDs', 'run_static'],
    ['integration', 'Agents Kind smoke (${{ needs.plan.outputs.tier }})', 'run_integration'],
  ]) {
    expect(jobs[id]).toMatchObject({ name, needs: 'plan', if: `\${{ needs.plan.outputs.${selected} == 'true' }}` })
    expect(jobs[id]?.['continue-on-error']).toBeUndefined()
  }

  const router = loadWorkflow('pull-request.yml')
  for (const caller of ['agents', 'agents-full']) {
    expect(router.jobs[caller]?.uses).toBe('./.github/workflows/agents-ci.yml')
    expect(router.jobs['ci-pr']?.needs).toContain(caller)
  }
  const gate = router.jobs['ci-pr']?.steps?.find((step) => step.name === 'Enforce selected validation results')
  expect(gate?.env?.AGENTS_RESULT).toBe(
    "${{ github.event_name == 'merge_group' && needs.agents-full.result || needs.agents.result }}",
  )
  if (!gate?.run) throw new Error('Missing ci-pr gate command')

  const successfulJobs = Object.fromEntries(
    Object.keys(gate.env ?? {})
      .filter((name) => name.endsWith('_RESULT'))
      .map((name) => [name, 'success']),
  )
  for (const [fullValidation, agentsResult, exitCode] of [
    ['false', 'success', 0],
    ['false', 'failure', 1],
    ['false', 'cancelled', 1],
    ['true', 'success', 0],
    ['true', 'skipped', 1],
  ] as const) {
    const result = Bun.spawnSync(['bash', '-c', gate.run], {
      env: {
        ...successfulJobs,
        PATH: process.env.PATH ?? '',
        VALIDATE_EXPECTED: 'success',
        LANDING_EXPECTED: 'success',
        AGENTS_RESULT: agentsResult,
        FULL_VALIDATION: fullValidation,
        DELEGATED: '["agents-ci"]',
      },
    })
    expect(result.exitCode).toBe(exitCode)
  }
})
