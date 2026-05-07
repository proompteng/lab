import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('agents-ci workflow', () => {
  it('uses the mirrored Bun base image for local Jangar integration builds', () => {
    const workflow = readFileSync(new URL('../../../../.github/workflows/agents-ci.yml', import.meta.url), 'utf8')

    expect(workflow).toContain('--build-arg "BUN_BASE_IMAGE=mirror.gcr.io/oven/bun"')
    expect(workflow).not.toContain('--build-arg "BUN_BASE_IMAGE=docker.io/oven/bun"')
  })

  it('bounds kubectl downloads so integration runners fail instead of hanging', () => {
    const workflow = readFileSync(new URL('../../../../.github/workflows/agents-ci.yml', import.meta.url), 'utf8')

    expect(workflow).toContain('--connect-timeout 20')
    expect(workflow).toContain('--max-time 120')
    expect(workflow).toContain('--retry 3')
    expect(workflow).toContain('--retry-all-errors')
  })
})
