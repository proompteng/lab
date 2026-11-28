import { join } from 'node:path'

import { beforeAll, expect, test } from 'bun:test'

const root = join(import.meta.dir, '../../../../..')
const name = 'agents-observability-query'
const providerLabel = 'agents.proompteng.ai/provider'
const runLabel = 'agents.proompteng.ai/agent-run'
const nsLabel = 'kubernetes.io/metadata.name'
const providers = { codex: 'codex-auto-ontology-runner', google: 'google-triage-runner' }
const subjects = Object.values(providers).map((name) => ({ kind: 'ServiceAccount', name, namespace: 'agents' }))
const resources = {
  '': [
    'pods',
    'pods/log',
    'pods/status',
    'events',
    'services',
    'endpoints',
    'nodes',
    'namespaces',
    'persistentvolumeclaims',
    'persistentvolumes',
    'limitranges',
    'resourcequotas',
  ],
  apps: ['deployments', 'replicasets', 'statefulsets', 'daemonsets'],
  batch: ['jobs', 'cronjobs'],
  'networking.k8s.io': ['ingresses', 'networkpolicies'],
  'discovery.k8s.io': ['endpointslices'],
  autoscaling: ['horizontalpodautoscalers'],
  policy: ['poddisruptionbudgets'],
  'argoproj.io': ['applications', 'applicationsets'],
  'kargo.akuity.io': ['warehouses', 'stages', 'freights', 'promotions'],
  'agents.proompteng.ai': [
    'agentruns',
    'agents',
    'agentproviders',
    'implementationspecs',
    'implementationsources',
    'memories',
    'versioncontrolproviders',
  ],
  'restate.dev': ['restatedeployments'],
  'postgresql.cnpg.io': ['clusters', 'backups', 'scheduledbackups'],
  'ceph.rook.io': ['cephclusters', 'cephblockpools', 'cephfilesystems', 'cephobjectstores'],
  'clickhouse.altinity.com': ['clickhouseinstallations'],
  'flink.apache.org': ['flinkdeployments'],
  'external-secrets.io': ['externalsecrets'],
  'bitnami.com': ['sealedsecrets'],
}

type Subject = { kind: string; name: string; namespace?: string }
type Rule = { apiGroups: string[]; resources: string[]; verbs: string[] }
type Selector = {
  matchLabels?: Record<string, string>
  matchExpressions?: { key: string; operator: string; values?: string[] }[]
}
type Peer = { namespaceSelector?: Selector; podSelector?: Selector; ipBlock?: { cidr: string; except?: string[] } }
type Port = { port: number; protocol: string }
type Manifest = {
  kind: string
  metadata: { name: string; namespace?: string }
  automountServiceAccountToken?: boolean
  data?: Record<string, string>
  rules?: Rule[]
  subjects?: Subject[]
  roleRef?: { apiGroup: string; kind: string; name: string }
  spec?: {
    template?: {
      spec: { automountServiceAccountToken: boolean; volumes: { name: string; configMap?: { name: string } }[] }
    }
    workload?: { serviceAccountName: string; automountServiceAccountToken?: boolean; serviceAccountToken?: object }
    security?: { allowedServiceAccounts: string[] }
    podSelector?: Selector
    policyTypes?: string[]
    ingress?: { from?: Peer[]; ports?: Port[] }[]
    egress?: { to?: Peer[]; ports?: Port[] }[]
  }
}

function render(app: string, ...args: string[]) {
  const result = Bun.spawnSync(['kustomize', 'build', ...args, `argocd/applications/${app}`], { cwd: root })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  const manifests = Bun.YAML.parse(result.stdout.toString()) as Manifest[]
  return manifests.filter(Boolean)
}

function get(manifests: Manifest[], kind: string, name: string) {
  const matches = manifests.filter((item) => item.kind === kind && item.metadata.name === name)
  expect(matches, `${kind} ${name}`).toHaveLength(1)
  return matches[0]!
}

let agents: Manifest[]
let kubeRouter: Manifest[]
beforeAll(() => {
  agents = render('agents', '--enable-helm')
  kubeRouter = render('kube-router')
}, 30_000)

test('renders only the exact read-only cluster grants for both standard runner accounts', () => {
  for (const [provider, serviceAccountName] of Object.entries(providers)) {
    expect(get(agents, 'Agent', `${provider}-agent`).spec?.security?.allowedServiceAccounts).toEqual([
      serviceAccountName,
    ])
    const workload = get(agents, 'AgentProvider', provider).spec?.workload
    expect(workload).toMatchObject({ serviceAccountName, automountServiceAccountToken: true })
    expect(get(agents, 'ServiceAccount', serviceAccountName)).toMatchObject({
      metadata: { namespace: 'agents' },
      automountServiceAccountToken: false,
    })
  }
  expect(get(agents, 'AgentProvider', 'codex').spec?.workload?.serviceAccountToken).toMatchObject({
    audience: 'agents.proompteng.ai/auto-ontology-mcp',
    mountPath: '/var/run/secrets/agents-auto-ontology-mcp',
  })

  const roleName = 'agentrun-triage'
  const bindings = agents.filter((item) =>
    item.subjects?.some((subject) => {
      if (subject.kind === 'Group')
        return ['system:authenticated', 'system:serviceaccounts', 'system:serviceaccounts:agents'].includes(
          subject.name,
        )
      return subjects.some((runner) =>
        subject.kind === 'ServiceAccount'
          ? subject.name === runner.name && (subject.namespace ?? item.metadata.namespace) === runner.namespace
          : subject.kind === 'User' && subject.name === `system:serviceaccount:agents:${runner.name}`,
      )
    }),
  )
  expect(bindings).toMatchObject([
    {
      kind: 'ClusterRoleBinding',
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: roleName },
      subjects,
    },
  ])
  expect(bindings[0]?.subjects).toEqual(subjects)

  // An exact allowlist also rejects forbidden subresources, wildcards, and non-resource URL rules.
  const rules = get(agents, 'ClusterRole', roleName).rules
  expect(rules).toEqual(
    Object.entries(resources).map(([group, resources]) => ({
      apiGroups: [group],
      resources,
      verbs: ['get', 'list', 'watch'],
    })),
  )
})

test('restricts runner observability traffic to the query proxy and preserves Kubernetes API reachability', () => {
  const runnerSelector = {
    matchExpressions: [{ key: providerLabel, operator: 'In', values: ['codex', 'google'] }],
  }
  const proxySelector = { matchLabels: { 'app.kubernetes.io/name': name } }
  const tcp = (port: number) => ({ port, protocol: 'TCP' })
  expect(get(agents, 'NetworkPolicy', 'agentrun-triage-egress').spec).toEqual({
    podSelector: runnerSelector,
    policyTypes: ['Egress'],
    egress: [
      {
        to: [
          {
            namespaceSelector: {
              matchExpressions: [
                { key: nsLabel, operator: 'NotIn', values: ['observability', 'tailscale', 'traefik'] },
              ],
            },
            podSelector: { matchExpressions: [{ key: 'app.kubernetes.io/name', operator: 'NotIn', values: [name] }] },
          },
        ],
      },
      {
        to: [
          {
            ipBlock: {
              cidr: '0.0.0.0/0',
              except: [
                '10.0.0.0/8',
                '100.64.0.0/10',
                '127.0.0.0/8',
                '169.254.0.0/16',
                '172.16.0.0/12',
                '192.168.0.0/16',
              ],
            },
          },
        ],
      },
      { to: [{ ipBlock: { cidr: '10.96.0.1/32' } }], ports: [tcp(443)] },
      {
        to: ['100.100.244.141', '100.100.244.142', '100.100.244.190'].map((ip) => ({ ipBlock: { cidr: `${ip}/32` } })),
        ports: [tcp(6443)],
      },
      { to: [{ podSelector: proxySelector }], ports: [tcp(8080)] },
    ],
  })
  const observability = { matchLabels: { [nsLabel]: 'observability' } }
  expect(get(agents, 'NetworkPolicy', name).spec).toEqual({
    podSelector: proxySelector,
    policyTypes: ['Ingress', 'Egress'],
    ingress: [
      {
        from: [
          {
            podSelector: {
              matchExpressions: [...runnerSelector.matchExpressions, { key: runLabel, operator: 'Exists' }],
            },
          },
        ],
        ports: [tcp(8080)],
      },
    ],
    egress: [
      {
        to: [
          {
            namespaceSelector: observability,
            podSelector: {
              matchLabels: { 'app.kubernetes.io/instance': 'observability-mimir' },
              matchExpressions: [
                { key: 'app.kubernetes.io/component', operator: 'In', values: ['gateway', 'alertmanager'] },
              ],
            },
          },
          {
            namespaceSelector: observability,
            podSelector: {
              matchLabels: { 'app.kubernetes.io/component': 'gateway' },
              matchExpressions: [
                {
                  key: 'app.kubernetes.io/instance',
                  operator: 'In',
                  values: ['observability-loki-v3', 'observability-tempo-v3'],
                },
              ],
            },
          },
        ],
        ports: [tcp(8080)],
      },
      {
        to: [
          {
            namespaceSelector: observability,
            podSelector: {
              matchLabels: {
                'app.kubernetes.io/instance': 'observability-grafana',
                'app.kubernetes.io/name': 'grafana',
              },
            },
          },
        ],
        ports: [tcp(3000)],
      },
      {
        to: [
          {
            namespaceSelector: { matchLabels: { [nsLabel]: 'kube-system' } },
            podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
          },
        ],
        ports: [{ port: 53, protocol: 'UDP' }, tcp(53)],
      },
    ],
  })
  const safety = kubeRouter.find(
    (item) =>
      item.kind === 'NetworkPolicy' &&
      item.metadata.namespace === 'agents' &&
      item.metadata.name === 'kube-router-rollout-allow-all',
  )
  expect(safety?.spec?.podSelector).toEqual({
    matchExpressions: [
      { key: 'app.kubernetes.io/name', operator: 'NotIn', values: ['auto-ontology-sync', name] },
      { key: providerLabel, operator: 'NotIn', values: ['codex', 'google'] },
    ],
  })
})

test('renders a credential-free proxy with explicit GET query paths and a fixed tenant', () => {
  const pod = get(agents, 'Deployment', name).spec?.template?.spec
  expect(pod?.automountServiceAccountToken).toBe(false)
  const configName = pod?.volumes.find((volume) => volume.name === 'config')?.configMap?.name
  expect(configName).toStartWith(`${name}-`)
  const config = get(agents, 'ConfigMap', configName!).data?.['nginx.conf'] ?? ''
  expect(config).toContain('if ($request_method != GET) { return 405; }')
  expect(config).toContain('if ($query_backend = "") { return 404; }')
  expect(config).toContain('proxy_pass_request_headers off;')
  expect(config).toContain('proxy_pass_request_body off;')
  expect(config).toContain('proxy_set_header X-Scope-OrgID anonymous;')
  expect(config).toContain('proxy_pass http://$query_backend$uri$is_args$args;')

  const routes = [...config.matchAll(/^\s*~(\S+) (\w+);$/gm)].map(([, path, backend]) => ({
    path: new RegExp(path!),
    backend,
  }))
  const backendFor = (path: string) => routes.find((route) => route.path.test(path))?.backend
  expect(backendFor('/prometheus/api/v1/query')).toBe('mimir')
  expect(backendFor('/prometheus/api/v1/alerts')).toBe('mimir')
  expect(backendFor('/loki/api/v1/query_range')).toBe('loki')
  expect(backendFor('/api/search')).toBe('tempo')
  expect(backendFor('/alertmanager/api/v2/alerts')).toBe('alertmanager')
  expect(backendFor('/api/dashboards/uid/agents')).toBe('grafana')
  for (const path of [
    '/api/v1/push',
    '/loki/api/v1/push',
    '/loki/api/v1/delete',
    '/v1/traces',
    '/ingester/flush',
    '/multitenant_alertmanager/configs',
    '/api/admin/settings',
  ]) {
    expect(backendFor(path), path).toBeUndefined()
  }
})
