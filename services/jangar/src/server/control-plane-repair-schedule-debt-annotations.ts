import {
  SWARM_ADMISSION_ANNOTATION_PRODUCER_REVISION,
  SWARM_ADMISSION_ANNOTATION_RUNTIME_DIGEST,
} from '@proompteng/agent-contracts'

import { asRecord, asString, readNested } from '@proompteng/agent-contracts'

export const SCHEDULE_DEBT_ANNOTATION_LANE = 'jangar.proompteng.ai/schedule-debt-lane'
export const SCHEDULE_DEBT_ANNOTATION_SOURCE_REF = 'jangar.proompteng.ai/schedule-debt-source-ref'
export const SCHEDULE_DEBT_ANNOTATION_IMAGE_REF = 'jangar.proompteng.ai/schedule-debt-image-ref'
export const SCHEDULE_DEBT_ANNOTATION_OBJECTIVE_REF = 'jangar.proompteng.ai/schedule-debt-objective-ref'

const RUNTIME_DIGEST_ANNOTATION = SWARM_ADMISSION_ANNOTATION_RUNTIME_DIGEST
const ADMISSION_PRODUCER_REVISION_ANNOTATION = SWARM_ADMISSION_ANNOTATION_PRODUCER_REVISION

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const firstNonEmpty = (values: Array<string | undefined | null>) => {
  for (const value of values) {
    const normalized = normalizeNonEmpty(value)
    if (normalized) return normalized
  }
  return null
}

export const buildScheduleDebtAnnotations = ({
  schedule,
  scheduleName,
  namespace,
  image,
}: {
  schedule: unknown
  scheduleName: string
  namespace: string
  image: string
}) => {
  const annotations = asRecord(readNested(schedule, ['metadata', 'annotations'])) ?? {}
  const targetRef = asRecord(readNested(schedule, ['spec', 'targetRef'])) ?? {}
  const targetKind = asString(targetRef.kind)
  const targetName = asString(targetRef.name)
  const targetNamespace = asString(targetRef.namespace) ?? namespace

  return Object.fromEntries(
    [
      [SCHEDULE_DEBT_ANNOTATION_LANE, scheduleName],
      [
        SCHEDULE_DEBT_ANNOTATION_SOURCE_REF,
        firstNonEmpty([
          process.env.JANGAR_SOURCE_HEAD_SHA,
          process.env.JANGAR_COMMIT,
          process.env.GIT_COMMIT,
          process.env.COMMIT_SHA,
          process.env.JANGAR_GITOPS_REVISION,
        ]),
      ],
      [
        SCHEDULE_DEBT_ANNOTATION_IMAGE_REF,
        firstNonEmpty([
          asString(annotations[RUNTIME_DIGEST_ANNOTATION]),
          asString(annotations[ADMISSION_PRODUCER_REVISION_ANNOTATION]),
          image,
        ]),
      ],
      [
        SCHEDULE_DEBT_ANNOTATION_OBJECTIVE_REF,
        targetKind && targetName ? `${targetKind}:${targetNamespace}:${targetName}` : scheduleName,
      ],
    ].filter((entry): entry is [string, string] => Boolean(entry[1])),
  )
}
