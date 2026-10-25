import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

const workflow = readFileSync(new URL('../../../../../.github/workflows/pull-request.yml', import.meta.url), 'utf8')
const scriptsWorkflow = readFileSync(
  new URL('../../../../../.github/workflows/scripts-ci.yml', import.meta.url),
  'utf8',
)
const tengriWorkflow = readFileSync(new URL('../../../../../.github/workflows/tengri.yaml', import.meta.url), 'utf8')

describe('landing browser validation workflow', () => {
  test('installs Chromium and runs the co-located Tengri Playwright suite', () => {
    const landingStep =
      workflow.match(/- name: Run landing validation[\s\S]*?\n\s+- name: Upload landing browser artifacts/)?.[0] ?? ''
    const artifactStep = workflow.match(
      /- name: Upload landing browser artifacts[\s\S]*?\n\s+- name: Run selected validation/,
    )?.[0]
    const runner = workflow.match(/runs-on: >-\n[\s\S]*?\n\s+env:/)?.[0]

    expect(landingStep).toContain('node .github/scripts/install-tengri-chromium.mjs')
    expect(landingStep).toContain('bun run --cwd apps/landing test:e2e')
    expect(landingStep).toContain('bun run --filter landing build')
    expect(landingStep.indexOf('bun run --filter landing build')).toBeLessThan(
      landingStep.indexOf('bun run --cwd apps/landing test:e2e'),
    )
    expect(landingStep).toContain('TENGRI_EDITOR_NEXT_MODE=start bash services/nanoagent/test-vscode-browser.sh')
    expect(runner).toContain("matrix.target == 'landing' && 'ubuntu-24.04'")
    expect(runner).not.toContain("matrix.target == 'landing' && 'arc-amd64'")
    expect(runner).not.toContain("matrix.target == 'docs' || matrix.target == 'landing'")
    expect(artifactStep).toContain("always() && matrix.target == 'landing'")
    expect(artifactStep).toContain('apps/landing/test-results')
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
    const native = readFileSync('.github/workflows/tengri-images.yml', 'utf8')
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
