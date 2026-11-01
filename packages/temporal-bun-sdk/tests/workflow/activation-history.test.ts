import { expect, test } from 'bun:test'
import { create } from '@bufbuild/protobuf'

import { EventType } from '../../src/proto/temporal/api/enums/v1/event_type_pb'
import { HistoryEventSchema, type HistoryEvent } from '../../src/proto/temporal/api/history/v1/message_pb'
import type { WorkflowActivationJob } from '../../src/workflow/activation'
import { buildWorkflowActivations } from '../../src/workflow/activation-history'
import type { WorkflowUpdateInvocation } from '../../src/workflow/executor'

const event = (id: number, type: EventType, attributes?: HistoryEvent['attributes']) =>
  create(HistoryEventSchema, { eventId: BigInt(id), eventType: type, attributes })

const started = (id: number) => event(id, EventType.WORKFLOW_TASK_STARTED)
const completed = (id: number, startedEventId: number) =>
  create(HistoryEventSchema, {
    eventId: BigInt(id),
    eventType: EventType.WORKFLOW_TASK_COMPLETED,
    attributes: { case: 'workflowTaskCompletedEventAttributes', value: { startedEventId: BigInt(startedEventId) } },
  })
const signal = (id: number): WorkflowActivationJob => ({
  type: 'signal',
  delivery: { name: 'item', args: [id], metadata: { eventId: String(id) } },
})
const update = (id: string, sequencingEventId?: string): WorkflowUpdateInvocation => ({
  protocolInstanceId: id,
  requestMessageId: id,
  updateId: id,
  name: 'update',
  payload: id,
  sequencingEventId,
})

test('jobs arriving during a workflow task become visible only at the next successful task', () => {
  const history = [
    event(1, EventType.WORKFLOW_EXECUTION_STARTED),
    event(2, EventType.WORKFLOW_EXECUTION_SIGNALED),
    started(3),
    event(4, EventType.WORKFLOW_EXECUTION_SIGNALED),
    completed(5, 3),
    started(6),
    event(7, EventType.WORKFLOW_EXECUTION_SIGNALED),
  ]
  const jobs = new Map(['2', '4', '7'].map((id) => [id, signal(Number(id))]))
  expect(buildWorkflowActivations(history.reverse(), jobs, [])?.map((batch) => batch.jobs)).toEqual([
    [signal(2)],
    [signal(4)],
  ])
})

test('failed and timed out tasks do not consume activation jobs', () => {
  const history = [
    event(1, EventType.WORKFLOW_EXECUTION_SIGNALED),
    started(2),
    create(HistoryEventSchema, {
      eventId: 3n,
      eventType: EventType.WORKFLOW_TASK_FAILED,
      attributes: { case: 'workflowTaskFailedEventAttributes', value: { startedEventId: 2n } },
    }),
    event(4, EventType.WORKFLOW_EXECUTION_SIGNALED),
    started(5),
    create(HistoryEventSchema, {
      eventId: 6n,
      eventType: EventType.WORKFLOW_TASK_TIMED_OUT,
      attributes: { case: 'workflowTaskTimedOutEventAttributes', value: { startedEventId: 5n } },
    }),
    started(7),
    completed(8, 7),
    started(9),
  ]
  expect(
    buildWorkflowActivations(
      history,
      new Map([
        ['1', signal(1)],
        ['4', signal(4)],
      ]),
      [],
    )?.map((batch) => batch.jobs),
  ).toEqual([[signal(1), signal(4)], []])
})

test('update requests replay at their recorded task boundary', () => {
  const first = update('first', '2')
  const second = update('second', '5')
  const current = update('current')
  const history = [started(3), completed(4, 3), started(6)]
  expect(buildWorkflowActivations(history, new Map(), [first, second, current])?.map((batch) => batch.updates)).toEqual(
    [[first], [second, current]],
  )
  expect(buildWorkflowActivations([], new Map(), [])).toBeUndefined()
})
