import { expect, test } from 'bun:test'

import {
  loadProductionFiles,
  productionPaths,
  validateProductionContent,
  type ProductionFiles,
} from './validate-production'

function copy(files: ProductionFiles): ProductionFiles {
  return { ...files }
}

test('accepts the production kube-router rollout', async () => {
  expect(validateProductionContent(await loadProductionFiles())).toEqual([])
})

test('rejects a mutable controller image', async () => {
  const files = copy(await loadProductionFiles())
  files.daemonSet = files.daemonSet.replace(
    /docker\.io\/cloudnativelabs\/kube-router@sha256:[a-f0-9]+/,
    'docker.io/cloudnativelabs/kube-router:v2.10.0',
  )
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.daemonSet}: kube-router must use the immutable multi-architecture v2.10.0 index`,
  )
})

test('rejects enabling kube-router routing', async () => {
  const files = copy(await loadProductionFiles())
  files.daemonSet = files.daemonSet.replace('--run-router=false', '--run-router=true')
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.daemonSet}: controller flags must select firewall-only Flannel coexistence`,
  )
})

test('rejects architecture pinning that misses a cluster node', async () => {
  const files = copy(await loadProductionFiles())
  files.daemonSet = files.daemonSet.replace(
    '        kubernetes.io/os: linux',
    '        kubernetes.io/os: linux\n        kubernetes.io/arch: amd64',
  )
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.daemonSet}: controller must cover every Linux architecture in the cluster`,
  )
})

test('rejects an enforcement probe that skips arm64', async () => {
  const files = copy(await loadProductionFiles())
  files.allNodeProbe = files.allNodeProbe.replace(
    '  nodeName: PROBE_NODE',
    '  nodeName: PROBE_NODE\n  nodeSelector:\n    kubernetes.io/arch: amd64',
  )
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.allNodeProbe}: contains forbidden production term "kubernetes.io/arch"`,
  )
})

test('rejects incomplete safety namespace coverage', async () => {
  const files = copy(await loadProductionFiles())
  files.safetyPolicies = files.safetyPolicies.replace(
    /---\napiVersion: networking\.k8s\.io\/v1\nkind: NetworkPolicy\nmetadata:\n  name: kube-router-rollout-allow-all\n  namespace: torghut[\s\S]*$/,
    '',
  )
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.safetyPolicies}: safety policy namespace coverage must match the audited live set`,
  )
})

test('rejects a safety policy that can deny traffic', async () => {
  const files = copy(await loadProductionFiles())
  files.safetyPolicies = files.safetyPolicies.replace('  ingress:\n    - {}', '  ingress: []')
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.safetyPolicies}: agents is not a retained traffic-neutral safety policy`,
  )
})

test('rejects bypassing the live namespace preflight', async () => {
  const files = copy(await loadProductionFiles())
  files.preflightHook = files.preflightHook.replace(
    'if [[ "$actual_namespaces" != "$expected_namespaces" ]]',
    'if false',
  )
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.preflightHook}: missing production invariant "if [[ \\"$actual_namespaces\\" != \\"$expected_namespaces\\" ]]"`,
  )
})

test('rejects automatic controller activation', async () => {
  const files = copy(await loadProductionFiles())
  files.platform = files.platform.replace(/(\n\s+- name: kube-router\n[\s\S]*?automation:) manual/, '$1 auto')
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.platform}: missing production invariant "automation: manual"`,
  )
})

test('rejects production CNI host mutation', async () => {
  const files = copy(await loadProductionFiles())
  files.daemonSet += '\n# /etc/cni/net.d\n'
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.daemonSet}: contains forbidden production term "/etc/cni/net.d"`,
  )
})

test('rejects running emergency cleanup during normal reconciliation', async () => {
  const files = copy(await loadProductionFiles())
  files.kustomization = files.kustomization.replace('  - daemonset.yaml', '  - daemonset.yaml\n  - operations/cleanup')
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.kustomization}: contains forbidden production term "operations/cleanup"`,
  )
})

test('rejects kube-router global cleanup that can flush unrelated node state', async () => {
  const files = copy(await loadProductionFiles())
  files.cleanupDaemonSet = files.cleanupDaemonSet.replace(
    '              set -o pipefail',
    '              /usr/local/bin/kube-router --cleanup-config\n              set -o pipefail',
  )
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.cleanupDaemonSet}: contains forbidden production term "--cleanup-config"`,
  )
})

test('rejects write-capable controller RBAC', async () => {
  const files = copy(await loadProductionFiles())
  files.rbac = files.rbac.replace('      - watch', '      - watch\n      - update')
  expect(validateProductionContent(files)).toContain(`${productionPaths.rbac}: kube-router must remain read-only`)
})

test('rejects telemetry that drops DaemonSet readiness', async () => {
  const files = copy(await loadProductionFiles())
  files.kubeStateMetrics = files.kubeStateMetrics.replace('  - daemonsets\n', '')
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.kubeStateMetrics}: missing production invariant "  - daemonsets"`,
  )
})

test('rejects a stale Alloy rollout checksum', async () => {
  const files = copy(await loadProductionFiles())
  files.clusterMetricsDeployment = files.clusterMetricsDeployment.replace(
    /observability\.proompteng\.ai\/config-sha256: [a-f0-9]+/,
    'observability.proompteng.ai/config-sha256: stale',
  )
  expect(validateProductionContent(files)).toContainEqual(
    expect.stringContaining(`${productionPaths.clusterMetricsDeployment}: missing production invariant`),
  )
})

test('rejects enforcement testing before controller activation', async () => {
  const files = copy(await loadProductionFiles())
  files.runbook = files.runbook.replace(
    'argocd app sync kube-router --revision "$main_revision" --prune=false --timeout 600',
    'bash scripts/hermes/verify-network-policy-enforcement.sh\nargocd app sync kube-router --revision "$main_revision" --prune=false --timeout 600',
  )
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: coverage, activation, and enforcement proof are out of order`,
  )
})

test('rejects runtime verification that ignores the reported multi-architecture index digest', async () => {
  const files = copy(await loadProductionFiles())
  files.runbook = files.runbook.replace('*"@$kube_router_index_digest"|*"@$platform_digest")', '*"@$platform_digest")')
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "*\\\"@$kube_router_index_digest\\\"|*\\\"@$platform_digest\\\")"`,
  )
})

test('rejects a policy metrics probe that can fail from SIGPIPE under pipefail', async () => {
  const files = copy(await loadProductionFiles())
  files.runbook = files.runbook.replace(
    'metrics=$(kubectl -n kube-system exec "$pod" -c kube-router -- wget -qO- http://127.0.0.1:20241/metrics)',
    'kubectl -n kube-system exec "$pod" -c kube-router -- wget -qO- http://127.0.0.1:20241/metrics |',
  )
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "metrics=$(kubectl -n kube-system exec \\\"$pod\\\" -c kube-router -- wget -qO- http://127.0.0.1:20241/metrics)"`,
  )
})
