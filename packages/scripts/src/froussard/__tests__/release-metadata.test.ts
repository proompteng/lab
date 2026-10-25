import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

import { repoRoot } from '../../shared/cli'

type EnvEntry = {
  readonly name?: string
  readonly value?: string
}

describe('froussard release metadata', () => {
  it('keeps the checked-in version aligned with the promoted source commit', () => {
    const manifest = YAML.parse(
      readFileSync(join(repoRoot, 'argocd/applications/froussard/knative-service.yaml'), 'utf8'),
    )
    const env = manifest.spec.template.spec.containers[0].env as EnvEntry[]
    const commit = env.find((entry) => entry.name === 'FROUSSARD_COMMIT')?.value
    const version = env.find((entry) => entry.name === 'FROUSSARD_VERSION')?.value

    expect(commit).toMatch(/^[0-9a-f]{40}$/)
    const described = version?.match(/^v\d+\.\d+\.\d+-\d+-g([0-9a-f]{7,40})$/)
    expect(described).not.toBeNull()
    expect(commit?.startsWith(described?.[1] ?? '')).toBe(true)
  })
})
