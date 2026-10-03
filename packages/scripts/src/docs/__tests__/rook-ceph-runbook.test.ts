import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

import { repoRoot } from '../../shared/cli'

it('selects RBD CSI nodeplugin pods by label without silently skipping mapped KRBD checks', () => {
  const runbook = readFileSync(join(repoRoot, 'docs/runbooks/rook-ceph-client-ops-performance.md'), 'utf8')

  expect(runbook).toContain("RBD_NODEPLUGIN_SELECTOR='app in (rook-ceph.rbd.csi.ceph.com-nodeplugin,csi-rbdplugin)'")
  expect(runbook).toContain('select(any(.spec.containers[]?; .name=="csi-rbdplugin"))')
  expect(runbook).toContain('No RBD CSI nodeplugin pods found with selector')
  expect(runbook).toContain('-c csi-rbdplugin -- rbd showmapped --format json')
  expect(runbook).not.toContain("rg 'rook-ceph\\.rbd\\.csi\\.ceph\\.com-nodeplugin'")
})

it('runs the packages scripts regression suite when the protected runbook changes', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/scripts-ci.yml'), 'utf8')
  const runbookPath = "'docs/runbooks/rook-ceph-client-ops-performance.md'"

  expect(workflow.split(runbookPath)).toHaveLength(3)
})

it('waits for the NBD writer before starting remount readback', () => {
  const runbook = readFileSync(join(repoRoot, 'docs/runbooks/rook-ceph-client-ops-performance.md'), 'utf8')
  const writerWait = 'wait --for=condition=complete --timeout=30m \\\n  job/rook-ceph-block-nbd-canary-benchmark'
  const remountApply = 'kubectl apply -f kubernetes/rook-ceph-rbd-canary/job-rook-ceph-block-nbd-canary-remount.yaml'

  expect(runbook).toContain(writerWait)
  expect(runbook.indexOf(writerWait)).toBeLessThan(runbook.indexOf(remountApply))
})

it('overrides and restores daemon-scoped mClock capacity during recovery surge', () => {
  const runbook = readFileSync(join(repoRoot, 'docs/runbooks/rook-ceph-client-ops-performance.md'), 'utf8')

  expect(runbook).toContain('ceph config set "osd.${osd_id}" osd_mclock_max_capacity_iops_hdd 750')
  expect(runbook).toContain('for osd_value in 0:210 1:250 2:260 3:200 4:220 5:240; do')
  expect(runbook).toContain('ceph config set "osd.${osd_id}" osd_mclock_max_capacity_iops_hdd "${capacity}"')
})

it('rolls OSDs when scrub configuration changes', () => {
  const values = readFileSync(join(repoRoot, 'argocd/applications/rook-ceph/cluster-values.yaml'), 'utf8')
  const kustomization = readFileSync(join(repoRoot, 'argocd/applications/rook-ceph/kustomization.yaml'), 'utf8')
  const rolloutPatch = readFileSync(
    join(repoRoot, 'argocd/applications/rook-ceph/cephcluster-osd-config-rollout.yaml'),
    'utf8',
  )

  expect(values).toContain('osd_scrub_auto_repair: "true"')
  expect(values).toContain('osd_scrub_auto_repair_num_errors: "5"')
  expect(values).toContain('osd_max_scrubs: "1"')
  expect(kustomization).toContain('path: cephcluster-osd-config-rollout.yaml')
  expect(kustomization).toContain('kind: CephCluster')
  expect(kustomization).toContain('name: rook-ceph')
  expect(rolloutPatch).toContain('spec:\n  annotations:\n    osd:')
  expect(rolloutPatch).toContain('ops.proompteng.ai/osd-config-revision: scrub-catchup-v1')
  expect(YAML.parse(rolloutPatch)).not.toHaveProperty([
    'metadata',
    'annotations',
    'ops.proompteng.ai/osd-config-revision',
  ])
})

it('allows scrubbing all day and reserves capacity for it without overcommitting mClock', () => {
  const values = YAML.parse(readFileSync(join(repoRoot, 'argocd/applications/rook-ceph/cluster-values.yaml'), 'utf8'))
  const osd: Record<string, string> = values.cephClusterSpec.cephConfig.osd

  expect(osd.osd_mclock_profile).toBe('custom')
  expect(osd.osd_scrub_begin_hour).toBe('0')
  expect(osd.osd_scrub_end_hour).toBe('0')
  expect(osd.osd_max_scrubs).toBe('1')
  expect(osd).not.toHaveProperty('osd_scrub_sleep')

  const classes = ['client', 'background_recovery', 'background_best_effort']
  let reservedCapacity = 0
  for (const service of classes) {
    const reservation = Number(osd[`osd_mclock_scheduler_${service}_res`])
    const weight = Number(osd[`osd_mclock_scheduler_${service}_wgt`])
    const limit = Number(osd[`osd_mclock_scheduler_${service}_lim`])

    expect(reservation).toBeGreaterThan(0)
    expect(weight).toBeGreaterThan(0)
    expect(Number.isInteger(weight)).toBe(true)
    // Ceph interprets zero as unlimited; idle capacity can serve any class.
    expect(limit).toBe(0)
    reservedCapacity += reservation
  }
  expect(reservedCapacity).toBeLessThanOrEqual(1)
  expect(Number(osd.osd_mclock_scheduler_background_best_effort_res)).toBeGreaterThan(
    Number(osd.osd_mclock_scheduler_client_res),
  )
  expect(Number(osd.osd_mclock_scheduler_background_best_effort_res)).toBeGreaterThan(
    Number(osd.osd_mclock_scheduler_background_recovery_res),
  )
})
