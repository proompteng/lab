import { expect, test } from 'bun:test'

import {
  loadProductionFiles,
  productionPaths,
  reviewedPolicySources,
  validateProductionContent,
  type ProductionFiles,
} from './validate-production'

const coverageSources = ['preflightHook', 'coverageProbe'] as const
const optionalPolicyNamespaces = ['tengri', 'relay', 'glitchtip', 'jangar']

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
    'docker.io/cloudnativelabs/kube-router:v2.12.0',
  )
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.daemonSet}: kube-router must use the immutable multi-architecture v2.12.0 index`,
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

test('rejects a safety policy that overrides the catalog sync and AgentRun triage allowlists', async () => {
  const files = copy(await loadProductionFiles())
  files.safetyPolicies = files.safetyPolicies.replace(
    /  podSelector:\n    matchExpressions:[\s\S]*?\n  policyTypes:/,
    '  podSelector: {}\n  policyTypes:',
  )
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.safetyPolicies}: agents is not a retained traffic-neutral safety policy`,
  )
})

test('rejects a retired safety policy that can select Bayn pods', async () => {
  const files = copy(await loadProductionFiles())
  files.safetyPolicies = files.safetyPolicies.replace(
    '      network-policy.proompteng.ai/retired-rollout-policy: bayn',
    '      app.kubernetes.io/name: bayn',
  )
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.safetyPolicies}: bayn is not an inert retired rollout policy`,
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

for (const namespace of optionalPolicyNamespaces) {
  for (const key of coverageSources) {
    test(`requires conditional ${namespace} coverage in ${key}`, async () => {
      const files = await loadProductionFiles()
      const script = files[key]
      const lookup = `kubectl -n kube-system get namespace ${namespace}`
      const lookupStart = script.indexOf(lookup)
      expect(lookupStart).toBeGreaterThanOrEqual(0)
      const changes = [
        script.replace(lookup, `kubectl get namespace ${namespace}`),
        script.slice(0, lookupStart) + script.slice(lookupStart).replace('.items | length > 0', '.items | length >= 0'),
        script.replace(`printf '%s\\n' ${namespace}`, 'true'),
      ]
      for (const change of changes) {
        files[key] = change
        expect(validateProductionContent(files)).toContain(
          `${productionPaths[key]}: ${namespace} coverage must check for live NetworkPolicies`,
        )
      }
    })
  }
}

test('rejects a preflight that does not pin the exact Hermes policy set', async () => {
  const files = copy(await loadProductionFiles())
  files.preflightHook = files.preflightHook.replace(
    /expected_hermes_policy_hash=[a-f0-9]{64}/,
    `expected_hermes_policy_hash=${'0'.repeat(64)}`,
  )
  expect(validateProductionContent(files)).toContainEqual(
    expect.stringContaining(
      `${productionPaths.preflightHook}: missing production invariant "expected_hermes_policy_hash=`,
    ),
  )
})

test('rejects an unreviewed Hermes policy without a matching preflight contract', async () => {
  const files = copy(await loadProductionFiles())
  files.hermesPolicies += `
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: unreviewed
  namespace: hermes
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - {}
`
  expect(validateProductionContent(files)).toContainEqual(
    expect.stringContaining(
      `${productionPaths.preflightHook}: missing production invariant "expected_hermes_policy_hash=`,
    ),
  )
})

test('rejects an unreviewed Tengri policy without a matching preflight contract', async () => {
  const files = copy(await loadProductionFiles())
  files.tengriPolicies += `
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: unreviewed
  namespace: tengri
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - {}
`
  expect(validateProductionContent(files)).toContainEqual(
    expect.stringContaining(
      `${productionPaths.preflightHook}: missing production invariant "expected_tengri_policy_hash=`,
    ),
  )
})

test('rejects a Relay policy change without its exact preflight fingerprint', async () => {
  const files = copy(await loadProductionFiles())
  files.relayPolicies = files.relayPolicies.replace('port: 9443', 'port: 9444')
  expect(validateProductionContent(files)).toContainEqual(
    expect.stringContaining('missing production invariant "expected_relay_policy_hash='),
  )
})

test('rejects impact routing that skips Tengri policy changes', async () => {
  const files = copy(await loadProductionFiles())
  files.impactMap = files.impactMap.replace('      - argocd/applications/tengri/network-policies.yaml\n', '')
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.impactMap}: missing production invariant "- argocd/applications/tengri/network-policies.yaml"`,
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

test('rejects a preflight that cannot prove the retired selector matches no Pods', async () => {
  const files = copy(await loadProductionFiles())
  files.rbac = files.rbac.replace(
    /rules:\n  - apiGroups:\n      - ""\n    resources:\n      - pods\n    verbs:\n      - get\n      - list\n  - apiGroups:\n      - networking\.k8s\.io/,
    'rules:\n  - apiGroups:\n      - networking.k8s.io',
  )
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.rbac}: preflight must read namespaces, policy state, and retired-selector Pod matches`,
  )
})

test('rejects a preflight that cannot determine whether optional namespaces exist', async () => {
  const files = copy(await loadProductionFiles())
  files.rbac = files.rbac.replace(
    /  - apiGroups:\n      - ""\n    resources:\n      - namespaces\n    verbs:\n      - get\n/,
    '',
  )
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.rbac}: preflight must read namespaces, policy state, and retired-selector Pod matches`,
  )
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
  const acceptedDigests = '*"@$kube_router_index_digest"|*"@$platform_digest")'
  files.runbook = files.runbook.replace(acceptedDigests, '*"@$platform_digest")')
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant ${JSON.stringify(acceptedDigests)}`,
  )
})

test('rejects runtime verification that can accept an empty pod list', async () => {
  const files = copy(await loadProductionFiles())
  files.runbook = files.runbook.replace('if [ "$pod_count" -ne "$desired" ]; then', 'if false; then')
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant "if [ \\"$pod_count\\" -ne \\"$desired\\" ]; then"`,
  )
})

test('rejects a policy metrics probe that can fail from SIGPIPE under pipefail', async () => {
  const files = copy(await loadProductionFiles())
  const scrape = 'kubectl -n kube-system exec "$pod" -c kube-router -- wget -qO- http://127.0.0.1:20241/metrics'
  const assignment = `metrics=$(${scrape})`
  files.runbook = files.runbook.replace(assignment, `${scrape} |`)
  expect(validateProductionContent(files)).toContain(
    `${productionPaths.runbook}: missing production invariant ${JSON.stringify(assignment)}`,
  )
})

for (const [namespace, sources] of Object.entries(reviewedPolicySources)) {
  test(`rejects ${namespace} source drift without a new reviewed contract`, async () => {
    const files = copy(await loadProductionFiles())
    files[sources[0]] +=
      `\n---\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: unreviewed\nspec:\n  podSelector: {}\n  policyTypes: [Ingress]\n  ingress: []\n`
    expect(validateProductionContent(files)).toContainEqual(
      expect.stringContaining(`${namespace}) expected_reviewed_policy_hash=`),
    )
  })
  test(`rejects a corrupted ${namespace} fingerprint`, async () => {
    const files = copy(await loadProductionFiles())
    files.preflightHook = files.preflightHook.replace(
      new RegExp(`(${namespace}\\) expected_reviewed_policy_hash=)[a-f0-9]{64}`),
      `$1${'0'.repeat(64)}`,
    )
    expect(validateProductionContent(files)).toContainEqual(
      expect.stringContaining(`${namespace}) expected_reviewed_policy_hash=`),
    )
  })
  test(`rejects missing CI routing for every ${namespace} source`, async () => {
    const baseline = await loadProductionFiles()
    for (const key of sources) {
      const files = copy(baseline)
      files.impactMap = files.impactMap.replace(`      - ${productionPaths[key]}\n`, '')
      expect(validateProductionContent(files)).toContain(
        `${productionPaths.impactMap}: root-scripts must cover ${productionPaths[key]}`,
      )
    }
  })
  if (optionalPolicyNamespaces.includes(namespace)) {
    test(`requires ${namespace} to use the reviewed policy case instead of the allow-all check`, async () => {
      const files = await loadProductionFiles()
      files.preflightHook = files.preflightHook.replace(`|${namespace}|`, '|')
      expect(validateProductionContent(files)).toContainEqual(
        expect.stringContaining(`${productionPaths.preflightHook}: missing production invariant "buzz|`),
      )
    })
  } else {
    test(`rejects missing ${namespace} namespace coverage`, async () => {
      for (const key of coverageSources) {
        const files = copy(await loadProductionFiles())
        files[key] = files[key].replace(new RegExp(` ${namespace}(?= |\\n)`), '')
        expect(validateProductionContent(files)).toContainEqual(
          expect.stringContaining(`${productionPaths[key]}: missing production invariant`),
        )
      }
    })
  }
}

test('normalizes API-omitted empty policy rules and ignores other manifest kinds', async () => {
  const files = copy(await loadProductionFiles())
  files.grafanaRehearsalPolicies = files.grafanaRehearsalPolicies.replace(/^  (ingress|egress): \[\]\n/gm, '')
  files.grafanaRehearsalPolicies += '\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: unrelated\ndata: {}\n'
  expect(validateProductionContent(files)).toEqual([])
})
