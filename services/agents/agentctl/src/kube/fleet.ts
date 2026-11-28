import { formatAge, isNotFoundError, outputResource, renderTable } from '../runtime'
import type { KubeBackend } from './backend'
import type { Deployment, Node, Pod } from './resources'
import { isTerminalPhase, observeRuns, readRunResources, type RunObservation, timestamp } from './runs'

export const REQUIRED_CRDS = [
  'agents.agents.proompteng.ai',
  'agentruns.agents.proompteng.ai',
  'agentproviders.agents.proompteng.ai',
  'implementationspecs.agents.proompteng.ai',
  'implementationsources.agents.proompteng.ai',
  'versioncontrolproviders.agents.proompteng.ai',
  'memories.agents.proompteng.ai',
  'orchestrations.orchestration.proompteng.ai',
  'orchestrationruns.orchestration.proompteng.ai',
  'approvalpolicies.approvals.proompteng.ai',
  'budgets.budgets.proompteng.ai',
  'secretbindings.security.proompteng.ai',
  'signals.signals.proompteng.ai',
  'signaldeliveries.signals.proompteng.ai',
  'tools.tools.proompteng.ai',
  'toolruns.tools.proompteng.ai',
  'schedules.schedules.proompteng.ai',
  'artifacts.artifacts.proompteng.ai',
  'workspaces.workspaces.proompteng.ai',
  'swarms.swarm.proompteng.ai',
]

const CONTROLLERS = 'agents-controllers'
const DEPLOYMENTS = ['agents', CONTROLLERS, 'agents-auto-ontology-mcp-gateway', 'agents-shell']
const CNPG_NAME = 'agents-db-next'
const LIMITS = [
  'CONCURRENCY_NAMESPACE',
  'CONCURRENCY_AGENT',
  'CONCURRENCY_CLUSTER',
  'REPO_CONCURRENCY_ENABLED',
  'REPO_CONCURRENCY_DEFAULT',
  'RATE_WINDOW_SECONDS',
  'RATE_NAMESPACE',
  'RATE_REPO',
  'RATE_CLUSTER',
].map((name) => `AGENTS_CONTROLLER_${name}`)

type Component = {
  component: string
  status: 'healthy' | 'degraded' | 'unknown' | 'missing' | 'not installed' | 'disabled'
  message: string
}

const read = async <T>(
  load: () => Promise<T>,
): Promise<{ value: T; issue?: never } | { value?: never; issue: string }> => {
  try {
    return { value: await load() }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const issue = /\bforbidden\b/i.test(message)
      ? 'access forbidden'
      : /\bunauthorized\b/i.test(message)
        ? 'not authenticated'
        : isNotFoundError(error)
          ? 'not found'
          : 'Kubernetes read failed'
    return { issue }
  }
}

const deploymentHealth = (name: string, deployment?: Deployment, issue?: string): Component => {
  const component = `deployment/${name}`
  if (issue) return { component, status: 'unknown', message: issue }
  if (!deployment) return { component, status: 'missing', message: 'deployment not found' }
  const desired = deployment.spec?.replicas ?? 1
  const ready = deployment.status?.readyReplicas ?? 0
  const available = deployment.status?.availableReplicas ?? 0
  const current = (deployment.status?.observedGeneration ?? 0) >= (deployment.metadata.generation ?? 0)
  return {
    component,
    status: current && desired > 0 && ready >= desired && available >= desired ? 'healthy' : 'degraded',
    message: `ready ${ready}/${desired}, available ${available}${current ? '' : ' (rollout not yet observed)'}`,
  }
}

const controllerEnv = (deployment?: Deployment) =>
  deployment?.spec?.template?.spec?.containers?.find((container) =>
    container.env?.some(
      (entry) => entry.name.startsWith('AGENTS_CONTROLLER_') || entry.name === 'AGENTS_LEADER_ELECTION_LEASE_NAME',
    ),
  )?.env ?? []

const leaseStatus = async (backend: KubeBackend, namespace: string, controller?: Deployment) => {
  const env = controllerEnv(controller)
  const get = (name: string) => env.find((entry) => entry.name === `AGENTS_LEADER_ELECTION_${name}`)
  const nameSetting = get('LEASE_NAME')
  const namespaceSetting = get('LEASE_NAMESPACE')
  const name = nameSetting?.value || 'agents-controller-leader'
  const leaseNamespace = namespaceSetting?.value || namespace
  const component = `lease/${name}`
  const base = { component, name, namespace: leaseNamespace }
  if (['0', 'false'].includes(get('ENABLED')?.value?.toLowerCase() ?? '')) {
    return { ...base, status: 'disabled' as const, message: 'leader election disabled' }
  }
  if (nameSetting?.valueFrom || namespaceSetting?.valueFrom) {
    return { ...base, status: 'unknown' as const, message: 'Lease target uses valueFrom' }
  }
  const leases = await read(() => backend.listLeases(leaseNamespace))
  if (!leases.value) return { ...base, status: 'unknown' as const, message: leases.issue }
  const lease = leases.value.find((lease) => lease.metadata.name === name)
  if (!lease) return { ...base, status: 'missing' as const, message: 'leader Lease not found' }

  const { holderIdentity, renewTime, leaseDurationSeconds } = lease.spec ?? {}
  const renewed = timestamp(renewTime)
  const fresh = renewed && leaseDurationSeconds && Date.now() < renewed + leaseDurationSeconds * 1000
  return {
    ...base,
    holderIdentity,
    renewTime,
    status: holderIdentity && fresh ? ('healthy' as const) : ('degraded' as const),
    message: `holder ${holderIdentity || '-'}, renewTime ${renewTime || '-'} (${formatAge(renewTime) || '-'})${fresh ? '' : ' [not current]'}`,
  }
}

const databaseStatus = async (backend: KubeBackend, namespace: string): Promise<Component> => {
  const component = `cluster/${CNPG_NAME}`
  const result = await read(() => backend.getCnpgCluster(namespace, CNPG_NAME))
  if (result.issue) return { component, status: 'unknown', message: result.issue }
  const cluster = result.value
  if (!cluster) return { component, status: 'not installed', message: 'CNPG Cluster not found (optional)' }
  const ready = cluster.status?.readyInstances ?? 0
  const desired = cluster.spec?.instances ?? 1
  const readyCondition = cluster.status?.conditions?.find((condition) => condition.type === 'Ready')
  const phase = cluster.status?.phase
  const healthy =
    ready >= desired && (readyCondition ? readyCondition.status === 'True' : phase === 'Cluster in healthy state')
  return {
    component,
    status: healthy ? 'healthy' : 'degraded',
    message: `ready ${ready}/${desired}${phase ? ` (${phase})` : ''}`,
  }
}

const readFleet = async (backend: KubeBackend, namespace: string) => {
  const [runs, jobs, pods, nodes] = await Promise.all([
    read(() => readRunResources(backend, namespace)),
    read(() => backend.listJobs(namespace)),
    read(() => backend.listPods(namespace)),
    read(() => backend.listNodes()),
  ])
  const unavailable = Object.entries({ runs, jobs, pods, nodes }).flatMap(([kind, result]) =>
    result.issue ? [`${kind}: ${result.issue}`] : [],
  )
  const observations =
    runs.value && jobs.value && pods.value
      ? await read(async () => observeRuns(runs.value.items, jobs.value, pods.value, namespace))
      : undefined
  if (observations?.issue) unavailable.push(`run observations: ${observations.issue}`)
  return {
    runs: observations?.value,
    nodes: nodeCapacity(nodes.value ?? [], pods.value),
    unavailable,
  }
}

const nodeCapacity = (nodes: readonly Node[], pods?: readonly Pod[]) => {
  const counts = new Map<string, { active: number; running: number }>()
  for (const pod of pods ?? []) {
    const name = pod.spec?.nodeName
    if (!name) continue
    const count = counts.get(name) ?? { active: 0, running: 0 }
    if (!pod.metadata.deletionTimestamp && !isTerminalPhase(pod.status?.phase)) count.active++
    if (pod.status?.phase === 'Running') count.running++
    counts.set(name, count)
  }
  const byName = new Map(nodes.map((node) => [node.metadata.name, node]))
  return [...new Set([...byName.keys(), ...counts.keys()])].sort().map((name) => {
    const node = byName.get(name)
    return {
      name,
      arch: node?.status?.nodeInfo?.architecture ?? node?.metadata.labels?.['kubernetes.io/arch'] ?? null,
      activePods: pods ? (counts.get(name)?.active ?? 0) : null,
      runningPods: pods ? (counts.get(name)?.running ?? 0) : null,
      allocatableCpu: node?.status?.allocatable?.cpu ?? null,
      allocatableMemory: node?.status?.allocatable?.memory ?? null,
      allocatablePods: node?.status?.allocatable?.pods ?? null,
    }
  })
}

const runCounts = (runs?: readonly RunObservation[]) =>
  runs
    ? {
        total: runs.length,
        active: runs.filter((run) => run.active).length,
        pending: runs.filter((run) => run.pending).length,
        stale: runs.filter((run) => run.stale).length,
      }
    : null

const tableOutput = (output: string) => !['json', 'yaml', 'yaml-stream'].includes(output)
const showNodes = (nodes: ReturnType<typeof nodeCapacity>, capacity: boolean) => {
  console.log('\nPods by node (selected namespace):')
  renderTable(nodes, [
    { label: 'NODE', value: (node) => node.name },
    { label: 'RUNNING_PODS', value: (node) => String(node.runningPods ?? '-') },
    ...(capacity
      ? [
          { label: 'ARCH', value: (node: (typeof nodes)[number]) => node.arch ?? '-' },
          { label: 'ACTIVE_PODS', value: (node: (typeof nodes)[number]) => String(node.activePods ?? '-') },
          { label: 'ALLOCATABLE_PODS', value: (node: (typeof nodes)[number]) => node.allocatablePods ?? '-' },
          { label: 'ALLOCATABLE_CPU', value: (node: (typeof nodes)[number]) => node.allocatableCpu ?? '-' },
          { label: 'ALLOCATABLE_RAM', value: (node: (typeof nodes)[number]) => node.allocatableMemory ?? '-' },
        ]
      : []),
  ])
}

const showInventory = (namespace: string, counts: ReturnType<typeof runCounts>, gaps: readonly string[]) => {
  console.log(
    counts
      ? `AgentRuns in ${namespace}: ${counts.total} total, ${counts.active} active, ${counts.pending} pending, ${counts.stale} stale (CR/runtime desync)`
      : `AgentRuns in ${namespace}: inventory unavailable`,
  )
  if (gaps.length) console.log(`Incomplete reads: ${gaps.join('; ')}`)
}

export const outputFleet = async (backend: KubeBackend, namespace: string, output: string) => {
  const [fleet, deployments] = await Promise.all([
    readFleet(backend, namespace),
    read(() => backend.listDeployments(namespace)),
  ])
  const controller = deployments.value?.find((deployment) => deployment.metadata.name === CONTROLLERS)
  const env = controllerEnv(controller)
  const limits = Object.fromEntries(
    LIMITS.map((name) => {
      const entry = env.find((item) => item.name === name)
      const value = entry?.value
      return [name, value && /^(?:\d+|true|false)$/i.test(value) ? value : entry?.valueFrom ? '(valueFrom)' : null]
    }),
  )
  const counts = runCounts(fleet.runs)
  const unavailable = [...fleet.unavailable]
  if (!controller) unavailable.push(`deployment/${CONTROLLERS}: ${deployments.issue ?? 'not found'}`)
  if (!tableOutput(output)) {
    outputResource({ namespace, runs: counts, nodes: fleet.nodes, controllerLimits: limits, unavailable }, output)
    return
  }
  showInventory(namespace, counts, unavailable)
  showNodes(fleet.nodes, true)
  console.log(`\nController limits (deployment/${CONTROLLERS}):`)
  renderTable(Object.entries(limits), [
    { label: 'ENV', value: ([name]) => name },
    { label: 'VALUE', value: ([, value]) => value ?? '-' },
  ])
}

export const outputKubeHealth = async (backend: KubeBackend, namespace: string, output: string, diagnose: boolean) => {
  const [ns, deployments, crds, database, fleet] = await Promise.all([
    read(() => backend.readNamespace(namespace)),
    read(() => backend.listDeployments(namespace)),
    read(() => backend.listCrds()),
    databaseStatus(backend, namespace),
    readFleet(backend, namespace),
  ])
  const controller = deployments.value?.find((deployment) => deployment.metadata.name === CONTROLLERS)
  const leader = await leaseStatus(backend, namespace, controller)
  const deploymentRows = DEPLOYMENTS.map((name) =>
    deploymentHealth(
      name,
      deployments.value?.find((deployment) => deployment.metadata.name === name),
      deployments.issue,
    ),
  )
  const installed = new Map(crds.value?.map((crd) => [crd.metadata.name, crd]))
  const crdRows = REQUIRED_CRDS.map((name) => {
    const resource = installed.get(name)
    const established = resource?.status?.conditions?.some(
      (condition) => condition.type === 'Established' && condition.status === 'True',
    )
    return {
      name,
      status: crds.issue ? 'unknown' : !resource ? 'missing' : established ? 'present' : 'not established',
    }
  })
  const missing = crdRows.filter((entry) => entry.status === 'missing').map((entry) => entry.name)
  const unready = crdRows.filter((entry) => entry.status === 'not established').map((entry) => entry.name)
  const components: Component[] = [
    {
      component: `namespace/${namespace}`,
      status: ns.issue === 'not found' ? 'missing' : ns.issue ? 'unknown' : 'healthy',
      message: ns.issue ?? '',
    },
    ...deploymentRows,
    leader,
    database,
    {
      component: 'crds',
      status: crds.issue ? 'unknown' : missing.length || unready.length ? 'degraded' : 'healthy',
      message:
        crds.issue ??
        `${crdRows.length - missing.length - unready.length}/${crdRows.length} ready${missing.length ? `; missing: ${missing.join(', ')}` : ''}${unready.length ? `; not established: ${unready.join(', ')}` : ''}`,
    },
  ]
  const counts = runCounts(fleet.runs)
  const hints: string[] = []
  if (diagnose) {
    for (const entry of deploymentRows) {
      if (entry.status === 'degraded') {
        hints.push(
          `${entry.component}: check rollout and deployment Events with kubectl -n ${namespace} describe ${entry.component}.`,
        )
      }
      if (entry.status === 'missing') {
        hints.push(`${entry.component}: check the Agents Argo CD Application and reconcile the split-mode manifests.`)
      }
    }
    if (['missing', 'degraded'].includes(leader.status)) {
      hints.push(
        `Leader Lease: check kubectl -n ${leader.namespace} describe ${leader.component} and controller logs for Lease RBAC or renew failures.`,
      )
    }
    if (database.status === 'degraded') {
      hints.push(
        `${database.component}: inspect CNPG Cluster Events and instance readiness with kubectl -n ${namespace} describe clusters.postgresql.cnpg.io/${CNPG_NAME}.`,
      )
    }
    if (missing.length || unready.length) {
      hints.push(
        'Check Agents GitOps CRD sync and Established conditions before reconciling controllers; see docs/agents/runbooks.md.',
      )
    }
    if (counts?.stale) {
      hints.push(
        `${counts.stale} run(s) disagree with their workload. Run agentctl -n ${namespace} run list --stale -o wide and agentctl -n ${namespace} describe run <name>; if mismatch persists, check the controller leader logs and Job/Pod watch RBAC.`,
      )
    }
    if (ns.issue === 'not found') hints.push(`Namespace ${namespace} is missing; check --context and --namespace.`)
    if (fleet.unavailable.length || components.some((entry) => entry.status === 'unknown')) {
      hints.push(
        'Some evidence is unavailable. Check the kube context and kubectl auth can-i for the failed reads; do not treat unknown as healthy.',
      )
    }
  }
  if (!tableOutput(output)) {
    outputResource(
      {
        mode: 'kube',
        namespace,
        components,
        leader,
        crds: crdRows,
        runs: counts,
        nodes: fleet.nodes,
        unavailable: fleet.unavailable,
        ...(diagnose ? { hints } : {}),
      },
      output,
    )
    return
  }
  renderTable(components, [
    { label: 'COMPONENT', value: (entry) => entry.component },
    { label: 'STATUS', value: (entry) => entry.status },
    { label: 'DETAIL', value: (entry) => entry.message },
  ])
  if (output === 'wide') {
    console.log('\nRequired CRDs:')
    renderTable(crdRows, [
      { label: 'CRD', value: (entry) => entry.name },
      { label: 'STATUS', value: (entry) => entry.status },
    ])
  }
  console.log('')
  showInventory(namespace, counts, fleet.unavailable)
  showNodes(fleet.nodes, false)
  if (diagnose) {
    console.log('\nRemediation:')
    if (!hints.length) console.log('  No issues found in the observed components and workloads.')
    for (const hint of hints) console.log(`  - ${hint}`)
  }
}
