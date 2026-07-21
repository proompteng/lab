import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const kubeRouterImage =
  'docker.io/cloudnativelabs/kube-router@sha256:0991f2cc7aaabe107b51c0c554d6b843f0483fd319b94f437fab638470c47c22'
const kubectlImage = 'docker.io/bitnami/kubectl@sha256:a67b11e95e953f550f020a41970185ccc5f83d78b86b8c575d02c904aa0f9cd7'
const safetyNamespaces = ['agents', 'argocd', 'bayn', 'bilig', 'kafka', 'media', 'pgadmin', 'synthesis', 'torghut']

export const productionPaths = {
  kustomization: 'argocd/applications/kube-router/kustomization.yaml',
  serviceAccounts: 'argocd/applications/kube-router/service-account.yaml',
  rbac: 'argocd/applications/kube-router/rbac.yaml',
  safetyPolicies: 'argocd/applications/kube-router/safety-policies.yaml',
  preflightHook: 'argocd/applications/kube-router/preflight-hook.yaml',
  service: 'argocd/applications/kube-router/service.yaml',
  daemonSet: 'argocd/applications/kube-router/daemonset.yaml',
  readme: 'argocd/applications/kube-router/README.md',
  cleanupKustomization: 'argocd/applications/kube-router/operations/cleanup/kustomization.yaml',
  cleanupDaemonSet: 'argocd/applications/kube-router/operations/cleanup/cleanup-daemonset.yaml',
  coverageProbe: 'scripts/kube-router/verify-safety-coverage.sh',
  allNodeProbe: 'scripts/kube-router/verify-all-node-enforcement.sh',
  platform: 'argocd/applicationsets/platform.yaml',
  clusterMetrics: 'argocd/applications/observability/cluster-metrics-alloy-config.river',
  clusterMetricsDeployment: 'argocd/applications/observability/cluster-metrics-alloy-deployment.yaml',
  kubeStateMetrics: 'argocd/applications/observability/kube-state-metrics-values.yaml',
  mimirRules: 'argocd/applications/observability/graf-mimir-rules.yaml',
  runbook: 'docs/runbooks/kube-router-network-policy-rollout.md',
  impactMap: '.github/ci/impact-map.yml',
  pullRequestWorkflow: '.github/workflows/pull-request.yml',
} as const

export type ProductionPath = keyof typeof productionPaths
export type ProductionFiles = Record<ProductionPath, string>

type YamlObject = Record<string, any>

function requireTerms(failures: string[], path: string, content: string, terms: string[]): void {
  for (const term of terms) {
    if (!content.includes(term)) {
      failures.push(`${path}: missing production invariant ${JSON.stringify(term)}`)
    }
  }
}

function forbidTerms(failures: string[], path: string, content: string, terms: string[]): void {
  for (const term of terms) {
    if (content.includes(term)) {
      failures.push(`${path}: contains forbidden production term ${JSON.stringify(term)}`)
    }
  }
}

function yamlDocuments(content: string): YamlObject[] {
  const parsed = Bun.YAML.parse(content)
  if (Array.isArray(parsed)) {
    return parsed as YamlObject[]
  }
  return [parsed as YamlObject]
}

function resource(documents: YamlObject[], kind: string, name: string): YamlObject | undefined {
  return documents.find((document) => document.kind === kind && document.metadata?.name === name)
}

function sortedStrings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return []
  }
  return [...value].sort()
}

export async function loadProductionFiles(): Promise<ProductionFiles> {
  const entries = await Promise.all(
    Object.entries(productionPaths).map(async ([name, path]) => [name, await readFile(path, 'utf8')] as const),
  )
  return Object.fromEntries(entries) as ProductionFiles
}

export function validateProductionContent(files: ProductionFiles): string[] {
  const failures: string[] = []

  const kustomization = yamlDocuments(files.kustomization)[0]
  const expectedResources = [
    'service-account.yaml',
    'rbac.yaml',
    'safety-policies.yaml',
    'preflight-hook.yaml',
    'service.yaml',
    'daemonset.yaml',
  ]
  if (kustomization.kind !== 'Kustomization' || kustomization.namespace !== undefined) {
    failures.push(
      `${productionPaths.kustomization}: must be a cross-namespace Kustomization without namespace override`,
    )
  }
  if (JSON.stringify(kustomization.resources) !== JSON.stringify(expectedResources)) {
    failures.push(`${productionPaths.kustomization}: production resources are incomplete or reordered`)
  }
  forbidTerms(failures, productionPaths.kustomization, files.kustomization, ['operations/cleanup', 'kind: Namespace'])

  const daemonSet = resource(yamlDocuments(files.daemonSet), 'DaemonSet', 'kube-router')
  const podSpec = daemonSet?.spec?.template?.spec
  const container = podSpec?.containers?.find((entry: YamlObject) => entry.name === 'kube-router')
  const args = sortedStrings(container?.args)
  const requiredArgs = [
    '--cache-sync-timeout=1m',
    '--enable-cni=false',
    '--enable-ipv4=true',
    '--enable-ipv6=false',
    '--health-port=20244',
    '--hostname-override=$(NODE_NAME)',
    '--iptables-sync-period=30s',
    '--metrics-port=20241',
    '--run-firewall=true',
    '--run-loadbalancer=false',
    '--run-router=false',
    '--run-service-proxy=false',
    '--service-cluster-ip-range=10.96.0.0/12',
    '--v=2',
  ].sort()
  if (daemonSet?.metadata?.namespace !== 'kube-system') {
    failures.push(`${productionPaths.daemonSet}: DaemonSet must run in kube-system`)
  }
  if (container?.image !== kubeRouterImage) {
    failures.push(`${productionPaths.daemonSet}: kube-router must use the immutable multi-architecture v2.10.0 index`)
  }
  if (JSON.stringify(args) !== JSON.stringify(requiredArgs)) {
    failures.push(`${productionPaths.daemonSet}: controller flags must select firewall-only Flannel coexistence`)
  }
  if (
    podSpec?.hostNetwork !== true ||
    podSpec?.hostPID !== true ||
    podSpec?.priorityClassName !== 'system-node-critical' ||
    podSpec?.nodeSelector?.['kubernetes.io/os'] !== 'linux' ||
    podSpec?.nodeSelector?.['kubernetes.io/arch'] !== undefined
  ) {
    failures.push(`${productionPaths.daemonSet}: controller must cover every Linux architecture in the cluster`)
  }
  if (
    daemonSet?.spec?.updateStrategy?.rollingUpdate?.maxUnavailable !== 1 ||
    daemonSet?.spec?.updateStrategy?.rollingUpdate?.maxSurge !== 0 ||
    daemonSet?.spec?.minReadySeconds !== 15
  ) {
    failures.push(`${productionPaths.daemonSet}: rolling availability controls are not production-safe`)
  }
  if (
    container?.securityContext?.privileged !== true ||
    container?.securityContext?.runAsUser !== 0 ||
    container?.securityContext?.readOnlyRootFilesystem !== true
  ) {
    failures.push(`${productionPaths.daemonSet}: required host-firewall privilege must be explicit and bounded`)
  }
  const volumes = podSpec?.volumes ?? []
  const moduleVolume = volumes.find((entry: YamlObject) => entry.name === 'lib-modules')
  const xtablesVolume = volumes.find((entry: YamlObject) => entry.name === 'xtables-lock')
  if (moduleVolume?.hostPath?.path !== '/usr/lib/modules' || moduleVolume?.hostPath?.type !== 'Directory') {
    failures.push(`${productionPaths.daemonSet}: Talos modules must be mounted from /usr/lib/modules`)
  }
  if (xtablesVolume?.hostPath?.path !== '/run/xtables.lock' || xtablesVolume?.hostPath?.type !== 'FileOrCreate') {
    failures.push(`${productionPaths.daemonSet}: kube-router and host firewall writers must share xtables.lock`)
  }
  forbidTerms(failures, productionPaths.daemonSet, files.daemonSet, [
    ':latest',
    '/etc/cni/net.d',
    '/opt/cni/bin',
    '--run-router=true',
    '--run-service-proxy=true',
    '--enable-cni=true',
  ])

  const safetyPolicies = yamlDocuments(files.safetyPolicies)
  const actualSafetyNamespaces = safetyPolicies.map((policy) => policy.metadata?.namespace).sort()
  if (JSON.stringify(actualSafetyNamespaces) !== JSON.stringify([...safetyNamespaces].sort())) {
    failures.push(`${productionPaths.safetyPolicies}: safety policy namespace coverage must match the audited live set`)
  }
  for (const policy of safetyPolicies) {
    const namespace = policy.metadata?.namespace ?? '<missing>'
    if (
      policy.apiVersion !== 'networking.k8s.io/v1' ||
      policy.kind !== 'NetworkPolicy' ||
      policy.metadata?.name !== 'kube-router-rollout-allow-all' ||
      JSON.stringify(policy.spec?.podSelector) !== '{}' ||
      JSON.stringify(sortedStrings(policy.spec?.policyTypes)) !== JSON.stringify(['Egress', 'Ingress']) ||
      JSON.stringify(policy.spec?.ingress) !== '[{}]' ||
      JSON.stringify(policy.spec?.egress) !== '[{}]' ||
      policy.metadata?.annotations?.['argocd.argoproj.io/sync-wave'] !== '-3' ||
      policy.metadata?.annotations?.['argocd.argoproj.io/sync-options'] !== 'Prune=false'
    ) {
      failures.push(`${productionPaths.safetyPolicies}: ${namespace} is not a retained traffic-neutral safety policy`)
    }
  }

  const hook = resource(yamlDocuments(files.preflightHook), 'Job', 'kube-router-policy-preflight')
  const hookContainer = hook?.spec?.template?.spec?.containers?.[0]
  if (
    hook?.metadata?.annotations?.['argocd.argoproj.io/hook'] !== 'Sync' ||
    hook?.metadata?.annotations?.['argocd.argoproj.io/sync-wave'] !== '-2' ||
    hook?.spec?.backoffLimit !== 0 ||
    hook?.spec?.activeDeadlineSeconds !== 120 ||
    hookContainer?.image !== kubectlImage ||
    hookContainer?.env?.find((entry: YamlObject) => entry.name === 'HOME')?.value !== '/tmp'
  ) {
    failures.push(`${productionPaths.preflightHook}: the bounded pre-DaemonSet coverage gate is incomplete`)
  }
  requireTerms(failures, productionPaths.preflightHook, files.preflightHook, [
    "printf '%s\\n' agents argocd bayn bilig kafka media pgadmin synthesis torghut | sort -u",
    'kubectl get networkpolicies.networking.k8s.io --all-namespaces -o json',
    'if [[ "$actual_namespaces" != "$expected_namespaces" ]]',
    'kubectl -n "$namespace" get networkpolicy kube-router-rollout-allow-all -o json',
    '.spec.podSelector == {}',
    '.spec.ingress == [{}]',
    '.spec.egress == [{}]',
  ])

  const roles = yamlDocuments(files.rbac).filter((document) => document.kind === 'ClusterRole')
  for (const role of roles) {
    const verbs = (role.rules ?? []).flatMap((rule: YamlObject) => rule.verbs ?? [])
    if (verbs.some((verb: string) => ['*', 'create', 'delete', 'deletecollection', 'patch', 'update'].includes(verb))) {
      failures.push(`${productionPaths.rbac}: ${role.metadata?.name} must remain read-only`)
    }
  }
  requireTerms(failures, productionPaths.rbac, files.rbac, [
    '- endpointslices',
    '- networkpolicies',
    'name: kube-router-policy-preflight',
  ])
  forbidTerms(failures, productionPaths.rbac, files.rbac, ['services/status', 'resources:\n      - "*"'])

  requireTerms(failures, productionPaths.serviceAccounts, files.serviceAccounts, [
    'name: kube-router',
    'name: kube-router-policy-preflight',
    'namespace: kube-system',
  ])
  requireTerms(failures, productionPaths.service, files.service, [
    'name: kube-router-metrics',
    'clusterIP: None',
    'port: 20241',
    'port: 20244',
  ])

  const cleanupKustomization = yamlDocuments(files.cleanupKustomization)[0]
  const cleanupDaemonSet = resource(yamlDocuments(files.cleanupDaemonSet), 'DaemonSet', 'kube-router-cleanup')
  const cleanupInit = cleanupDaemonSet?.spec?.template?.spec?.initContainers?.[0]
  if (
    cleanupKustomization.namespace !== 'kube-system' ||
    JSON.stringify(cleanupKustomization.resources) !== JSON.stringify(['cleanup-daemonset.yaml']) ||
    cleanupInit?.image !== kubeRouterImage ||
    JSON.stringify(cleanupInit?.command) !== JSON.stringify(['/bin/bash', '-ec']) ||
    cleanupInit?.securityContext?.privileged !== true ||
    cleanupDaemonSet?.spec?.template?.spec?.automountServiceAccountToken !== false
  ) {
    failures.push(`${productionPaths.cleanupDaemonSet}: pinned all-node emergency cleanup is incomplete`)
  }
  requireTerms(failures, productionPaths.cleanupDaemonSet, files.cleanupDaemonSet, [
    'cleanup_filter_family /usr/sbin/iptables /usr/sbin/iptables-save',
    'cleanup_filter_family /usr/sbin/ip6tables /usr/sbin/ip6tables-save',
    "awk '/^:KUBE-(ROUTER|NWPLCY|POD-FW)-/",
    "awk '/^(inet6:)?KUBE-(SRC|DST)-|^(inet6:)?kube-router-local-pods$/",
  ])
  forbidTerms(failures, productionPaths.cleanupDaemonSet, files.cleanupDaemonSet, ['--cleanup-config'])
  requireTerms(failures, productionPaths.readme, files.readme, [
    'manual Argo CD application',
    'amd64: `sha256:81619a698b981a5c4fd6c89ae015d0faadce5d7a5270df7562c1743e58e3283f`',
    'arm64: `sha256:b8df3247641d5f4e84e14d30b673b6362a0e3d56901218a1e1ee38a40f37afd8`',
    'Prune=false',
  ])

  const kubeRouterEntry =
    /\n\s+- name: kube-router\n[\s\S]*?\n\s+- name: volume-snapshot-controller/.exec(files.platform)?.[0] ?? ''
  requireTerms(failures, productionPaths.platform, kubeRouterEntry, [
    'path: argocd/applications/kube-router',
    'namespace: kube-system',
    'automation: manual',
    'enabled: "true"',
  ])

  requireTerms(failures, productionPaths.clusterMetrics, files.clusterMetrics, [
    'discovery.kubernetes "kube_router_pods"',
    'prometheus.scrape "kube_router"',
    'job_name        = "kube-router"',
    'kube_router_controller_(iptables|policy)_.*',
    'kube_daemonset_status_desired_number_scheduled',
    'kube_daemonset_status_number_ready',
  ])
  const metricsHash = createHash('sha256').update(files.clusterMetrics).digest('hex')
  requireTerms(failures, productionPaths.clusterMetricsDeployment, files.clusterMetricsDeployment, [
    `observability.proompteng.ai/config-sha256: ${metricsHash}`,
  ])
  requireTerms(failures, productionPaths.kubeStateMetrics, files.kubeStateMetrics, ['  - daemonsets'])
  requireTerms(failures, productionPaths.mimirRules, files.mimirRules, [
    '- name: kube-router-network-policy.rules',
    'record: kube_router_rollout_enabled',
    'alert: KubeRouterDaemonSetUnavailable',
    'alert: KubeRouterMetricsMissing',
    'alert: KubeRouterContainerRestarting',
    '(kube_router_rollout_enabled == 1)',
    'runbook_url: docs/runbooks/kube-router-network-policy-rollout.md',
  ])

  requireTerms(failures, productionPaths.coverageProbe, files.coverageProbe, [
    'set -euo pipefail',
    'kubectl get networkpolicies.networking.k8s.io --all-namespaces -o json',
    'if [[ "$actual_namespaces" != "$desired_namespaces" ]]',
  ])
  requireTerms(failures, productionPaths.allNodeProbe, files.allNodeProbe, [
    kubeRouterImage,
    'kind: Pod',
    'activeDeadlineSeconds: 900',
    'nodeName: PROBE_NODE',
    'wait pod -l app.kubernetes.io/component=server',
    'wait pod -l app.kubernetes.io/component=client',
    'test "$client_count" = "$linux_node_count"',
    'test "$server_count" = "$linux_node_count"',
    'index($client_node)',
    '$servers[(($client_index + 1) % ($servers | length))].status.podIP',
    'name: deny-client-egress',
    'egress: []',
    'name: deny-server-ingress',
    'ingress: []',
    'if [[ "$policy_enforced" != true ]]',
    'if [[ "$policy_released" != true ]]',
    'network_policy_ingress_and_egress_enforced_on_all_linux_nodes=true',
  ])
  forbidTerms(failures, productionPaths.allNodeProbe, files.allNodeProbe, ['kubernetes.io/arch'])
  const safetyCheckPosition = files.runbook.indexOf('bash scripts/kube-router/verify-safety-coverage.sh')
  const syncPosition = files.runbook.indexOf('argocd app sync kube-router')
  const allNodeEnforcementPosition = files.runbook.indexOf('bash scripts/kube-router/verify-all-node-enforcement.sh')
  const enforcementPosition = files.runbook.indexOf('bash scripts/hermes/verify-network-policy-enforcement.sh')
  if (
    !(
      safetyCheckPosition >= 0 &&
      safetyCheckPosition < syncPosition &&
      syncPosition < allNodeEnforcementPosition &&
      allNodeEnforcementPosition < enforcementPosition
    )
  ) {
    failures.push(`${productionPaths.runbook}: coverage, activation, and enforcement proof are out of order`)
  }
  requireTerms(failures, productionPaths.runbook, files.runbook, [
    'kubectl -n kube-system rollout status daemonset/kube-router',
    'kube_router_index_digest=sha256:0991f2cc7aaabe107b51c0c554d6b843f0483fd319b94f437fab638470c47c22',
    'pod_rows=$(',
    'if [ "$pod_count" -ne "$desired" ]; then',
    "while IFS=$'\\t' read -r pod node pod_ready restart_count image_id",
    'test "$restart_count" = 0',
    'node_arch=$(kubectl get node "$node" -o jsonpath=\'{.status.nodeInfo.architecture}\')',
    '*"@$kube_router_index_digest"|*"@$platform_digest")',
    'test "$(kubectl -n kube-system exec "$pod" -c kube-router -- uname -m)" = "$expected_runtime_arch"',
    'metrics=$(kubectl -n kube-system exec "$pod" -c kube-router -- wget -qO- http://127.0.0.1:20241/metrics)',
    'grep -Eq \'^kube_router_controller_policy_(chains|ipsets) \' <<< "$metrics"',
    'pod_logs=$(kubectl -n kube-system logs "$pod" -c kube-router --prefix --tail=500)',
    'done <<< "$pod_rows"',
    'operations/cleanup',
    'kubectl -n kube-system delete daemonset kube-router --wait=true',
    'KUBE-ROUTER-*',
    "does not use kube-router's generic cleanup mode",
    'iptables_state=$(kubectl -n kube-system exec "$pod" -c verifier -- iptables-save)',
    'ipset_state=$(kubectl -n kube-system exec "$pod" -c verifier -- ipset list -name)',
    'Do not sync Hermes unless the policy probe passes',
  ])

  requireTerms(failures, productionPaths.impactMap, files.impactMap, [
    '- argocd/applications/kube-router/**',
    '- docs/runbooks/kube-router-network-policy-rollout.md',
  ])
  requireTerms(failures, productionPaths.pullRequestWorkflow, files.pullRequestWorkflow, [
    'bun run scripts/kube-router/validate-production.ts',
    'bun test scripts/kube-router/*.test.ts',
  ])

  return failures
}

if (import.meta.main) {
  const failures = validateProductionContent(await loadProductionFiles())
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure)
    }
    process.exitCode = 1
  } else {
    console.log('kube-router production validation passed')
  }
}
