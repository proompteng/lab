import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '../../../../..')

const readRepoFile = (path: string) => readFileSync(join(repoRoot, path), 'utf8')

const bashBlockAfter = (document: string, marker: string): string => {
  const markerIndex = document.indexOf(marker)
  expect(markerIndex, `missing marker: ${marker}`).toBeGreaterThanOrEqual(0)
  const blockStart = document.indexOf('```bash\n', markerIndex)
  expect(blockStart, `missing bash block after: ${marker}`).toBeGreaterThanOrEqual(0)
  const contentStart = blockStart + '```bash\n'.length
  const blockEnd = document.indexOf('\n```', contentStart)
  expect(blockEnd, `unterminated bash block after: ${marker}`).toBeGreaterThanOrEqual(0)
  return document.slice(contentStart, blockEnd)
}

describe('Talos bootstrap MTU contracts', () => {
  test('keeps the node-specific MTU patch in every first-install command', () => {
    const altra = readRepoFile('devices/altra/docs/cluster-bootstrap.md')
    const ryzen = readRepoFile('devices/ryzen/docs/cluster-bootstrap.md')
    const turinJoin = readRepoFile('devices/turin/docs/cluster-join-plan.md')
    const turinGpu = readRepoFile('devices/turin/docs/nvidia-gpu-on-talos.md')
    const canonicalJoin = readRepoFile('devices/galactic/docs/add-control-plane-node.md')

    expect(bashBlockAfter(altra, '## 2) Apply config to `altra` (first install)')).toContain(
      '--config-patch @devices/altra/manifests/network-mtu.patch.yaml',
    )
    expect(bashBlockAfter(ryzen, '### 2.5 Apply config with patches')).toContain(
      '--config-patch @devices/ryzen/manifests/network-mtu.patch.yaml',
    )
    expect(bashBlockAfter(turinJoin, 'Then include these patches with the first `talosctl apply-config`')).toContain(
      '--config-patch @devices/turin/manifests/network-mtu.patch.yaml',
    )
    expect(bashBlockAfter(turinJoin, 'For a clean Turin install')).toContain(
      '--config-patch @devices/turin/manifests/network-mtu.patch.yaml',
    )
    expect(bashBlockAfter(turinGpu, '## Apply with first install')).toContain(
      '--config-patch @devices/turin/manifests/network-mtu.patch.yaml',
    )
    expect(bashBlockAfter(canonicalJoin, '## 3) Apply config (install + join)')).toContain(
      '--config-patch @<device_dir>/manifests/network-mtu.patch.yaml',
    )
  })

  test('keeps each machine patch pinned to its physical interface and MTU', () => {
    const patches = [
      ['devices/altra/manifests/network-mtu.patch.yaml', 'interface: enP5p1s0'],
      ['devices/ryzen/manifests/network-mtu.patch.yaml', 'interface: eno1'],
      ['devices/turin/manifests/network-mtu.patch.yaml', 'interface: eno2np1'],
    ] as const

    for (const [path, interfaceLine] of patches) {
      const patch = readRepoFile(path)
      expect(patch, path).toContain(interfaceLine)
      expect(patch, path).toContain('mtu: 1450')
    }
  })

  test('runs the docs contract when an affected bootstrap input changes', () => {
    const workflow = readRepoFile('.github/workflows/scripts-ci.yml')
    const protectedPaths = [
      'devices/altra/docs/cluster-bootstrap.md',
      'devices/ryzen/docs/cluster-bootstrap.md',
      'devices/turin/docs/nvidia-gpu-on-talos.md',
      'devices/turin/docs/cluster-join-plan.md',
      'devices/galactic/docs/add-control-plane-node.md',
      'devices/altra/manifests/network-mtu.patch.yaml',
      'devices/ryzen/manifests/network-mtu.patch.yaml',
      'devices/turin/manifests/network-mtu.patch.yaml',
    ]

    for (const path of protectedPaths) {
      expect(workflow.split(`'${path}'`), path).toHaveLength(3)
    }
  })
})
