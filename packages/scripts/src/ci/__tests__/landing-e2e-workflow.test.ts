import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

const workflow = readFileSync(new URL('../../../../../.github/workflows/pull-request.yml', import.meta.url), 'utf8')

describe('landing browser validation workflow', () => {
  test('installs Chromium and runs the co-located Tengri Playwright suite', () => {
    const landingStep = workflow.match(
      /- name: Run landing validation[\s\S]*?\n\s+- name: Run selected validation/,
    )?.[0]

    expect(landingStep).toContain('bunx playwright install --with-deps chromium')
    expect(landingStep).toContain('bun run --cwd apps/landing test:e2e')
  })
})
