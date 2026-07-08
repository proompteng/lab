import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

it('selects RBD CSI nodeplugin pods by label without silently skipping mapped KRBD checks', () => {
  const runbook = readFileSync(join(repoRoot, 'docs/runbooks/rook-ceph-client-ops-performance.md'), 'utf8')

  expect(runbook).toContain("RBD_NODEPLUGIN_SELECTOR='app in (rook-ceph.rbd.csi.ceph.com-nodeplugin,csi-rbdplugin)'")
  expect(runbook).toContain('select(any(.spec.containers[]?; .name=="csi-rbdplugin"))')
  expect(runbook).toContain('No RBD CSI nodeplugin pods found with selector')
  expect(runbook).toContain('-c csi-rbdplugin -- rbd showmapped --format json')
  expect(runbook).not.toContain("rg 'rook-ceph\\.rbd\\.csi\\.ceph\\.com-nodeplugin'")
})
