import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'

const workflow = readFileSync(new URL('../../../../../.github/workflows/torghut-ci.yml', import.meta.url), 'utf8')

describe('Torghut CI toolchain contract', () => {
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
