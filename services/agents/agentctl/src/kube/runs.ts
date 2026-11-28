import { AGENT_RUN_SPEC } from '../runtime'
import { decodeKube, type KubeBackend } from './backend'
import { KubectlError } from './kubectl'
import { type AgentRun, agentRun, type Job, type Pod, rawList } from './resources'

export const RUN_LABEL = 'agents.proompteng.ai/agent-run'
const RUN_UID = 'agents.proompteng.ai/run-uid'
const STEP_INDEX = 'agents.proompteng.ai/step-index'

export const timestamp = (value?: string | null) => (value ? Date.parse(value) || 0 : 0)
const newest = (a: Job | Pod, b: Job | Pod) =>
  timestamp(b.metadata.creationTimestamp) - timestamp(a.metadata.creationTimestamp) ||
  b.metadata.name.localeCompare(a.metadata.name, 'en', { numeric: true })

export const isTerminalPhase = (phase?: string) =>
  ['succeeded', 'failed', 'cancelled', 'canceled'].includes(phase?.toLowerCase() ?? '')

export const jobTerminalPhase = (job: Job) => {
  const hasCondition = (type: string) => job.status?.conditions?.some((c) => c.type === type && c.status === 'True')
  if (hasCondition('Failed')) return 'Failed'
  if (hasCondition('Complete') || (job.status?.succeeded ?? 0) >= Math.max(job.spec?.completions ?? 1, 1)) {
    return 'Succeeded'
  }
  // Failed pod counts alone do not prove a Job finished: the Job may retry.
  return undefined
}

type Metadata = Job['metadata']
const runOwner = (meta: Metadata) => meta.ownerReferences?.find((ref) => ref.kind === 'AgentRun')
const runName = (meta: Metadata) => runOwner(meta)?.name ?? meta.labels?.[RUN_LABEL]
const jobOwner = (meta: Metadata) => meta.ownerReferences?.find((ref) => ref.kind === 'Job')
const jobName = (meta: Metadata) =>
  jobOwner(meta)?.name ?? meta.labels?.['batch.kubernetes.io/job-name'] ?? meta.labels?.['job-name']

const matchesRun = (meta: Metadata, run: AgentRun, namespace: string) => {
  const owner = runOwner(meta)
  return (
    (meta.namespace ?? namespace) === (run.metadata.namespace ?? namespace) &&
    (!owner || (owner.name === run.metadata.name && (!owner.uid || owner.uid === run.metadata.uid))) &&
    (!meta.labels?.[RUN_LABEL] || meta.labels[RUN_LABEL] === run.metadata.name) &&
    (!meta.labels?.[RUN_UID] || meta.labels[RUN_UID] === run.metadata.uid)
  )
}

export const hasRunUid = (job: Job, run: AgentRun) => {
  const uid = run.metadata.uid
  const ref = run.status?.runtimeRef
  return (
    !!uid &&
    (runOwner(job.metadata)?.uid === uid ||
      job.metadata.labels?.[RUN_UID] === uid ||
      (!!ref?.uid && ref.uid === job.metadata.uid && ref.name === job.metadata.name))
  )
}

const matchesJob = (pod: Pod, job: Job) => {
  const uid =
    jobOwner(pod.metadata)?.uid ??
    pod.metadata.labels?.['batch.kubernetes.io/controller-uid'] ??
    pod.metadata.labels?.['controller-uid']
  return jobName(pod.metadata) === job.metadata.name && (!uid || uid === job.metadata.uid)
}

const indexBy = <T>(items: readonly T[], key: (item: T) => string | undefined) => {
  const index = new Map<string, T[]>()
  for (const item of items) {
    const name = key(item)
    if (!name) continue
    const group = index.get(name)
    if (group) group.push(item)
    else index.set(name, [item])
  }
  return index
}

export const runtimeType = (run: AgentRun) => run.status?.runtimeRef?.type ?? run.spec?.runtime?.type
export const isJobRuntime = (type?: string) => type === 'job' || type === 'workflow'

const workflowAtRunScope = (run: AgentRun, job: Job | undefined, phase: string) => {
  if (runtimeType(run) !== 'workflow' || !isTerminalPhase(phase)) return true

  // A completed attempt is not a completed workflow. Only infer outcomes when no
  // earlier step, loop or retry can still change the run's outcome.
  const steps = run.spec?.workflow?.steps ?? []
  const rawIndex = job?.metadata.labels?.[STEP_INDEX]
  const index = rawIndex ? Number(rawIndex) - 1 : steps.length === 1 ? 0 : -1
  const step = steps[index]
  if (!step || step.loop) return false

  const statuses = run.status?.workflow?.steps ?? []
  if (
    steps.slice(0, index).some((earlier) => !statuses.some((s) => s.name === earlier.name && s.phase === 'Succeeded'))
  ) {
    return false
  }
  if (phase === 'Succeeded') return index === steps.length - 1
  const status = statuses.find((candidate) => candidate.name === step.name)
  return (
    (step.retries ?? 0) === 0 ||
    (status?.jobRef?.uid === job?.metadata.uid && !!job?.metadata.uid && (status?.attempt ?? 0) > (step.retries ?? 0))
  )
}

const podPriority = (pod: Pod, terminalJob: string | undefined) => {
  if (pod.metadata.deletionTimestamp) return 0
  const phase = pod.status?.phase
  if (terminalJob && phase === terminalJob) return 4
  if (phase === 'Running') return 3
  if (phase === 'Pending') return 2
  return 1
}

export const observeRuns = (
  runs: readonly Record<string, unknown>[],
  jobs: readonly Job[],
  pods: readonly Pod[],
  namespace: string,
) => {
  const jobsByRun = indexBy(jobs, (job) => runName(job.metadata))
  const jobsByName = new Map(jobs.map((job) => [job.metadata.name, job]))
  const podsByRun = indexBy(pods, (pod) => runName(pod.metadata))
  const podsByJob = indexBy(pods, (pod) => jobName(pod.metadata))
  return runs.map((resource) => {
    const run = decodeKube(agentRun, resource, 'AgentRun')
    const name = run.metadata.name
    const ref = run.status?.runtimeRef
    const refJob =
      isJobRuntime(runtimeType(run)) && ref?.name && (ref.namespace ?? namespace) === namespace
        ? jobsByName.get(ref.name)
        : undefined
    const referencedJob = refJob && ref?.uid && refJob.metadata.uid === ref.uid ? refJob : undefined
    const currentRefJob =
      referencedJob && matchesRun(referencedJob.metadata, run, namespace) ? referencedJob : undefined
    const ownedJobs = [...new Set([...(jobsByRun.get(name) ?? []), ...(currentRefJob ? [currentRefJob] : [])])]
      .filter((job) => matchesRun(job.metadata, run, namespace))
      .sort(newest)
    const ownedPods = new Set<Pod>()
    for (const job of ownedJobs) {
      for (const pod of podsByJob.get(job.metadata.name) ?? []) {
        if (matchesRun(pod.metadata, run, namespace) && matchesJob(pod, job)) ownedPods.add(pod)
      }
    }
    for (const pod of podsByRun.get(name) ?? []) {
      const ownerName = jobName(pod.metadata)
      // If a Job with this name exists, require its UID to match; never reattach a replaced Job's Pod.
      if ((!ownerName || !jobsByName.has(ownerName)) && matchesRun(pod.metadata, run, namespace)) ownedPods.add(pod)
    }
    const livePod = (pod: Pod) => !pod.metadata.deletionTimestamp && !isTerminalPhase(pod.status?.phase)
    const nonDeletingJobs = ownedJobs.filter((job) => !job.metadata.deletionTimestamp)
    const jobsWithLivePods = new Set([...ownedPods].filter(livePod).map((pod) => jobName(pod.metadata)))
    const liveJob = nonDeletingJobs.find(
      (job) => !jobTerminalPhase(job) && ((job.status?.active ?? 0) > 0 || jobsWithLivePods.has(job.metadata.name)),
    )
    const job =
      (currentRefJob && !currentRefJob.metadata.deletionTimestamp ? currentRefJob : undefined) ??
      liveJob ??
      nonDeletingJobs[0] ??
      currentRefJob ??
      ownedJobs[0]
    const terminalJob = job && jobTerminalPhase(job)
    const pod = [...ownedPods]
      .filter((pod) => !job || matchesJob(pod, job))
      .sort((a, b) => podPriority(b, terminalJob) - podPriority(a, terminalJob) || newest(a, b))[0]
    const podPhase = pod?.status?.phase
    const jobPhase =
      terminalJob ??
      (job
        ? podPhase === 'Running' || (job.status?.ready ?? 0) > 0
          ? 'Running'
          : podPhase === 'Succeeded' && (job.spec?.completions ?? 1) === 1
            ? 'Succeeded'
            : 'Pending'
        : undefined)
    const workloadPhase = jobPhase ?? podPhase
    const observedPhase = workloadPhase && workflowAtRunScope(run, job, workloadPhase) ? workloadPhase : undefined
    const phase = run.status?.phase || 'Pending'
    const stale = !!observedPhase && phase.toLowerCase() !== observedPhase.toLowerCase()
    const active =
      !!liveJob || [...ownedPods].some(livePod) || (!isTerminalPhase(phase) && !isTerminalPhase(observedPhase))
    return {
      resource,
      run,
      name,
      agent: run.spec?.agentRef?.name,
      phase,
      podPhase,
      jobPhase,
      observedPhase,
      stale,
      active,
      pending: active && (observedPhase ?? phase) === 'Pending',
      head: run.status?.vcs?.headBranch ?? run.spec?.parameters?.head,
      node: pod?.spec?.nodeName,
      serviceAccount: pod?.spec?.serviceAccountName ?? job?.spec?.template?.spec?.serviceAccountName,
      job,
      pod,
      jobs: ownedJobs,
      pods: [...ownedPods],
    }
  })
}

export type RunObservation = ReturnType<typeof observeRuns>[number]

export const readRunResources = async (backend: KubeBackend, namespace: string, selector?: string) =>
  decodeKube(rawList, await backend.listCustomObjects(AGENT_RUN_SPEC, namespace, selector), 'AgentRun list')

export const readRunWorkloads = async (backend: KubeBackend, namespace: string, name: string, signal?: AbortSignal) => {
  // AgentRun names longer than a label value cannot have controller-labelled Jobs.
  if (name.length > 63) return { jobs: [], pods: [] }
  const selector = `${RUN_LABEL}=${name}`
  const [jobs, pods] = await Promise.all([
    backend.listJobs(namespace, selector, signal),
    backend.listPods(namespace, selector, signal),
  ])
  return { jobs, pods }
}

export const readRun = async (backend: KubeBackend, namespace: string, name: string, signal?: AbortSignal) => {
  if (!/^[a-z0-9](?:[-.a-z0-9]*[a-z0-9])?$/.test(name)) throw new KubectlError('Invalid AgentRun name')
  return backend.getCustomObject(AGENT_RUN_SPEC, namespace, name, signal)
}

export const readRunObservation = async (
  backend: KubeBackend,
  namespace: string,
  name: string,
  signal?: AbortSignal,
) => {
  const resource = await readRun(backend, namespace, name, signal)
  const { jobs, pods } = await readRunWorkloads(backend, namespace, name, signal)
  return observeRuns([resource], jobs, pods, namespace)[0]
}
