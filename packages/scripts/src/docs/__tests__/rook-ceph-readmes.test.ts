import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

const readmes = ['kubernetes/rook-ceph-rbd-canary/README.md', 'kubernetes/rook-ceph-rwx-benchmarks/README.md']
const scriptsWorkflow = readFileSync(join(repoRoot, '.github/workflows/scripts-ci.yml'), 'utf8')

for (const relativePath of readmes) {
  it(`${relativePath} supports both authenticated Galactic contexts`, () => {
    const readme = readFileSync(join(repoRoot, relativePath), 'utf8')

    expect(readme).toContain('galactic-lan|galactic-tailscale')
    expect(readme).toContain('use `galactic-tailscale` when operating off the LAN')
    expect(readme).toContain('kubectl --context "$GALACTIC_CONTEXT"')
    expect(readme).not.toContain('--context galactic-lan')
  })

  it(`${relativePath} runs the scripts regression suite when changed`, () => {
    expect(scriptsWorkflow.split(`'${relativePath}'`)).toHaveLength(3)
  })
}
