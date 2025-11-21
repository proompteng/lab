import { expect, test } from 'bun:test'

import { createDefaultDataConverter, decodePayloadsToValues } from '../../src/common/payloads'
import { materializeCommands, type WorkflowCommandIntent } from '../../src/workflow/commands'
import type {
  CancelTimerCommandIntent,
  RequestCancelExternalWorkflowCommandIntent,
  UpsertSearchAttributesCommandIntent,
} from '../../src/workflow/commands'
import { CommandType } from '../../src/proto/temporal/api/enums/v1/command_type_pb'

test('materialize cancellation and search attribute commands', async () => {
  const dataConverter = createDefaultDataConverter()

  const cancelTimer: CancelTimerCommandIntent = {
    id: 'cancel-timer-0',
    kind: 'cancel-timer',
    sequence: 0,
    timerId: 'timer-0',
  }

  const cancelExternal: RequestCancelExternalWorkflowCommandIntent = {
    id: 'cancel-external-1',
    kind: 'request-cancel-external-workflow',
    sequence: 1,
    namespace: 'default',
    workflowId: 'wf-target',
    runId: 'run-target',
    childWorkflowOnly: false,
    reason: 'cleanup',
  }

  const upsertSearchAttributes: UpsertSearchAttributesCommandIntent = {
    id: 'upsert-search-2',
    kind: 'upsert-search-attributes',
    sequence: 2,
    searchAttributes: { CustomKeywordField: ['v1', 'v2'] },
  }

  const commands = await materializeCommands([cancelTimer, cancelExternal, upsertSearchAttributes] as WorkflowCommandIntent[], {
    dataConverter,
  })

  expect(commands.find((command) => command.commandType === CommandType.CANCEL_TIMER)).toBeTruthy()
  const cancelExternalCommand = commands.find(
    (command) => command.commandType === CommandType.REQUEST_CANCEL_EXTERNAL_WORKFLOW_EXECUTION,
  )
  expect(cancelExternalCommand?.commandType).toBe(CommandType.REQUEST_CANCEL_EXTERNAL_WORKFLOW_EXECUTION)
  const upsertCommand = commands.find((command) => command.commandType === CommandType.UPSERT_WORKFLOW_SEARCH_ATTRIBUTES)
  expect(upsertCommand).toBeTruthy()
  if (upsertCommand?.attributes?.case === 'upsertWorkflowSearchAttributesCommandAttributes') {
    const payload = upsertCommand.attributes.value.searchAttributes?.indexedFields?.CustomKeywordField
    const decoded = await decodePayloadsToValues(dataConverter, payload ? [payload] : undefined)
    expect(decoded[0]).toEqual(['v1', 'v2'])
  }
})
