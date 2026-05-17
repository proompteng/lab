import { asRecord, asString, readNested } from '~/server/primitives-http'
import { createKubernetesClient } from '~/server/primitives-kube'
import { resolveSwarmScheduleStage } from '~/server/supporting-primitives-schedule-identity'
import { hashNameSuffix, makeHashedName } from '~/server/supporting-primitives-naming'

const INITIAL_SWARM_SCHEDULE_RUN_LABEL = 'schedules.proompteng.ai/initial-catchup'

const buildInitialSwarmScheduleJobName = (schedule: Record<string, unknown>) => {
  const scheduleName = asString(readNested(schedule, ['metadata', 'name'])) ?? 'schedule'
  const metadata = asRecord(schedule.metadata) ?? {}
  const spec = asRecord(schedule.spec) ?? {}
  const hash = hashNameSuffix(
    JSON.stringify({
      uid: asString(metadata.uid) ?? null,
      generation: metadata.generation ?? null,
      cron: asString(spec.cron) ?? null,
      targetRef: asRecord(spec.targetRef) ?? null,
    }),
  )
  return makeHashedName(scheduleName, `initial-${hash}`)
}

export const maybeCreateInitialSwarmScheduleJob = async (
  kube: ReturnType<typeof createKubernetesClient>,
  schedule: Record<string, unknown>,
  cronJob: Record<string, unknown>,
  namespace: string,
) => {
  if (!resolveSwarmScheduleStage(schedule)) return
  if (asString(readNested(schedule, ['status', 'lastRunTime']))) return

  const jobName = buildInitialSwarmScheduleJobName(schedule)
  const existingJob = await kube.get('job', jobName, namespace)
  if (existingJob) return

  const scheduleName = asString(readNested(schedule, ['metadata', 'name'])) ?? 'schedule'
  const jobTemplate = asRecord(readNested(cronJob, ['spec', 'jobTemplate'])) ?? {}
  const templateMetadata = asRecord(jobTemplate.metadata) ?? {}
  const templateSpec = asRecord(jobTemplate.spec)
  if (!templateSpec) return

  const ownerReferences = readNested(cronJob, ['metadata', 'ownerReferences'])
  const labels = Object.assign(
    {},
    asRecord(readNested(cronJob, ['metadata', 'labels'])),
    asRecord(templateMetadata.labels),
    { [INITIAL_SWARM_SCHEDULE_RUN_LABEL]: 'true' },
  )
  const annotations = Object.assign({}, asRecord(templateMetadata.annotations), {
    'schedules.proompteng.ai/initial-catchup-for': scheduleName,
  })

  await kube.apply({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace,
      labels,
      annotations,
      ...(Array.isArray(ownerReferences) ? { ownerReferences } : {}),
    },
    spec: {
      ...templateSpec,
      ttlSecondsAfterFinished: templateSpec.ttlSecondsAfterFinished ?? 3600,
    },
  })
}
