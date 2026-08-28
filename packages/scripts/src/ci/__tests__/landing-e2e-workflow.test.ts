import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

const workflow = readFileSync(new URL('../../../../../.github/workflows/pull-request.yml', import.meta.url), 'utf8')
const scriptsWorkflow = readFileSync(
  new URL('../../../../../.github/workflows/scripts-ci.yml', import.meta.url),
  'utf8',
)

describe('landing browser validation workflow', () => {
  test('installs Chromium and runs the co-located Tengri Playwright suite', () => {
    const landingStep = workflow.match(
      /- name: Run landing validation[\s\S]*?\n\s+- name: Run selected validation/,
    )?.[0]

    expect(landingStep).toContain('bunx playwright install --with-deps chromium')
    expect(landingStep).toContain('bun run --cwd apps/landing test:e2e')
  })

  test('runs this contract for pull-request workflow-only changes', () => {
    const pullRequestTrigger = scriptsWorkflow.match(/pull_request:\n[\s\S]*?\n\nconcurrency:/)?.[0]

    expect(pullRequestTrigger).toContain("'.github/workflows/pull-request.yml'")
    expect(pullRequestTrigger).toContain("'.github/workflows/scripts-ci.yml'")
  })
})
