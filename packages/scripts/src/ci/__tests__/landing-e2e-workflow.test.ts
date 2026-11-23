import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

const workflow = readFileSync(new URL('../../../../../.github/workflows/pull-request.yml', import.meta.url), 'utf8')
const scriptsWorkflow = readFileSync(
  new URL('../../../../../.github/workflows/scripts-ci.yml', import.meta.url),
  'utf8',
)
const tengriWorkflow = readFileSync(new URL('../../../../../.github/workflows/tengri.yaml', import.meta.url), 'utf8')
const { jobs } = Bun.YAML.parse(workflow) as {
  jobs: Record<
    string,
    {
      name: string
      'runs-on': string
      needs: string | string[]
      strategy?: { matrix: { exclude: { target: string }[] } }
      steps: { name: string; run?: string; uses?: string; if?: string; with?: { path?: string } }[]
    }
  >
}

describe('landing browser validation workflow', () => {
  test('installs Chromium and runs the co-located Tengri Playwright suite', () => {
    const landing = jobs['landing']
    const landingStep = landing.steps.find((step) => step.name === 'Run landing validation')?.run ?? ''
    const artifactStep = landing.steps.find((step) => step.name === 'Upload landing browser artifacts')

    expect(landingStep).toContain('node .github/scripts/install-tengri-chromium.mjs')
    expect(landingStep).toContain('bun run --cwd apps/landing test:e2e')
    expect(landingStep).toContain('bun run --filter landing build')
    expect(landingStep.indexOf('bun run --filter landing build')).toBeLessThan(
      landingStep.indexOf('bun run --cwd apps/landing test:e2e'),
    )
    expect(landingStep).toContain('TENGRI_EDITOR_NEXT_MODE=start bash services/nanoagent/test-vscode-browser.sh')
    expect(landing.name).toBe('PR validation (landing)')
    expect(landing['runs-on']).toBe('ubuntu-24.04')
    expect(landing.needs).toBe('plan')
    expect(artifactStep?.if).toBe('${{ always() }}')
    expect(artifactStep?.with?.path).toContain('apps/landing/test-results')
  })

  test('prepares the editor actions only for Landing', () => {
    const validate = jobs['validate']
    const landingUses = jobs['landing'].steps.map((step) => step.uses?.split('@')[0])
    const validationUses = validate.steps.map((step) => step.uses?.split('@')[0])

    expect(validate.strategy?.matrix.exclude).toContainEqual({ target: 'landing' })
    for (const action of [
      'actions/setup-go',
      'dtolnay/rust-toolchain',
      'Swatinem/rust-cache',
      'actions/upload-artifact',
    ]) {
      expect(landingUses).toContain(action)
      expect(validationUses).not.toContain(action)
    }
  })

  test('requires successful Landing checks for a plan that selected them', () => {
    const gate = jobs['ci-pr']
    const script = gate.steps.find((step) => step.name === 'Enforce selected validation results')?.run ?? ''
    expect(gate.needs).toContain('landing')
    expect(script).not.toBe('')

    const runGate = (landing: string, landingExpected: string, validate: string, validateExpected: string) =>
      Bun.spawnSync(['bash', '-c', script], {
        env: {
          ...process.env,
          FULL_VALIDATION: 'false',
          PLAN_RESULT: 'success',
          VALIDATE_RESULT: validate,
          VALIDATE_EXPECTED: validateExpected,
          LANDING_RESULT: landing,
          LANDING_EXPECTED: landingExpected,
          AGENTS_RESULT: 'skipped',
          BAYN_RESULT: 'skipped',
          DELEGATED: '[]',
        },
      }).exitCode

    expect(runGate('success', 'success', 'skipped', 'skipped')).toBe(0)
    expect(runGate('success', 'success', 'success', 'success')).toBe(0)
    expect(runGate('skipped', 'skipped', 'success', 'success')).toBe(0)
    expect(runGate('skipped', 'success', 'success', 'success')).toBe(1)
    expect(runGate('failure', 'success', 'success', 'success')).toBe(1)
    expect(runGate('cancelled', 'success', 'skipped', 'skipped')).toBe(1)
    expect(runGate('success', 'success', 'failure', 'success')).toBe(1)
  })

  test('runs this contract for pull-request workflow-only changes', () => {
    const pullRequestTrigger = scriptsWorkflow.match(/pull_request:\n[\s\S]*?\n\nconcurrency:/)?.[0]

    expect(pullRequestTrigger).toContain("'.github/workflows/pull-request.yml'")
    expect(pullRequestTrigger).toContain("'.github/workflows/scripts-ci.yml'")
    expect(pullRequestTrigger).toContain("'.github/workflows/tengri.yaml'")
  })

  test('does not duplicate pull-request browser validation', () => {
    const trigger = tengriWorkflow.match(/on:\n[\s\S]*?\n\nconcurrency:/)?.[0]

    expect(trigger).toContain('push:')
    expect(trigger).toContain('workflow_dispatch:')
    expect(trigger).not.toContain('pull_request:')
    expect(tengriWorkflow.indexOf('- name: Build desktop for browser acceptance')).toBeLessThan(
      tengriWorkflow.indexOf('- name: Run Tengri desktop browser suite'),
    )
  })

  test('runs Landing units and runtime SQL acceptance once while retaining identity proof', () => {
    const ofz = readFileSync('.github/workflows/ofz.yaml', 'utf8')
    const native = readFileSync('.github/workflows/tengri-validation.yml', 'utf8')
    const combined = [workflow, ofz, native].join('\n')
    expect(combined.match(/bun run --cwd apps\/landing test\n/g)).toHaveLength(1)
    expect(combined.match(/bash (?:services\/tengri\/)?test-runtime\.sh/g)).toHaveLength(1)
    expect(ofz).toContain('bash test-policy.sh')
    expect(ofz.match(/bash services\/tengri\/test-database-failover\.sh/g)).toHaveLength(1)
    expect(ofz).not.toContain('\n          bash test-control.sh\n')
    expect(readFileSync('services/tengri/test-database-failover.sh', 'utf8')).toContain('test-control.sh" failover')
    expect(ofz).toContain('bash services/ofz/test-control.sh identity')
    expect(native).toContain('bash test-rpc-interop.sh')
    expect(ofz).toContain('runs-on: ubuntu-24.04')
    const parsed = Bun.YAML.parse(native) as { jobs: Record<string, { 'runs-on': string }> }
    for (const job of ['validate-tengri', 'validate-nanoagent']) {
      expect(parsed.jobs[job]['runs-on']).toBe('ubuntu-24.04')
    }
  })
})
