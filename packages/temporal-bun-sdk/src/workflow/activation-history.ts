import { EventType } from '../proto/temporal/api/enums/v1/event_type_pb'
import type { HistoryEvent } from '../proto/temporal/api/history/v1/message_pb'
import type { WorkflowActivation, WorkflowActivationJob } from './activation'
import type { WorkflowUpdateInvocation } from './executor'

export const buildWorkflowActivations = (
  history: readonly HistoryEvent[],
  jobs: ReadonlyMap<string, WorkflowActivationJob>,
  updates: readonly WorkflowUpdateInvocation[],
): readonly WorkflowActivation[] | undefined => {
  const events = [...history].sort((left, right) =>
    left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0,
  )
  const starts = events.filter((event) => event.eventType === EventType.WORKFLOW_TASK_STARTED)
  if (starts.length === 0) return undefined

  const completed = new Set<string>()
  const discarded = new Set<string>()
  for (const event of events) {
    switch (event.attributes.case) {
      case 'workflowTaskCompletedEventAttributes':
        completed.add(event.attributes.value.startedEventId.toString())
        break
      case 'workflowTaskFailedEventAttributes':
      case 'workflowTaskTimedOutEventAttributes':
        discarded.add(event.attributes.value.startedEventId.toString())
        break
    }
  }
  const latestStart = starts[starts.length - 1]?.eventId.toString()
  const boundaries = starts.filter((event) => {
    const id = event.eventId.toString()
    return completed.has(id) || (id === latestStart && !discarded.has(id))
  })
  const boundaryIds = new Set(boundaries.map((event) => event.eventId.toString()))
  const remainingUpdates = new Set(updates)
  const activations: WorkflowActivation[] = []
  let pendingJobs: WorkflowActivationJob[] = []
  for (const event of events) {
    const id = event.eventId.toString()
    const job = jobs.get(id)
    if (job) pendingJobs.push(job)
    if (!boundaryIds.has(id)) continue
    const batchUpdates: WorkflowUpdateInvocation[] = []
    const last = event === boundaries[boundaries.length - 1]
    for (const update of remainingUpdates) {
      if (last || (update.sequencingEventId && BigInt(update.sequencingEventId) <= event.eventId)) {
        batchUpdates.push(update)
        remainingUpdates.delete(update)
      }
    }
    activations.push({ jobs: pendingJobs, updates: batchUpdates })
    pendingJobs = []
  }
  return activations
}
