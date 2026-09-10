import { expect, test } from 'bun:test'

import { createDefaultDataConverter } from '../../src/common/payloads'
import { CommandType } from '../../src/proto/temporal/api/enums/v1/command_type_pb'
import {
  materializeCommands,
  type RequestCancelNexusOperationCommandIntent,
  type ScheduleNexusOperationCommandIntent,
} from '../../src/workflow/commands'

const dataConverter = createDefaultDataConverter()

test('materialize nexus schedule and cancel commands', async () => {
  const scheduleIntent: ScheduleNexusOperationCommandIntent = {
    id: 'schedule-nexus-operation-0',
    kind: 'schedule-nexus-operation',
    sequence: 0,
    endpoint: 'payments',
    service: 'billing',
    operation: 'charge',
    operationId: 'nexus-0',
    input: { amount: 100 },
    scheduleToCloseTimeoutMs: 30_000,
    nexusHeader: { 'x-temporal-bun-operation-id': 'nexus-0' },
  }

  const cancelIntent: RequestCancelNexusOperationCommandIntent = {
    id: 'request-cancel-nexus-operation-1',
    kind: 'request-cancel-nexus-operation',
    sequence: 1,
    operationId: 'nexus-0',
    scheduledEventId: '42',
  }

  const commands = await materializeCommands([scheduleIntent, cancelIntent], { dataConverter })
  const scheduleCommand = commands.find((command) => command.commandType === CommandType.SCHEDULE_NEXUS_OPERATION)
  const cancelCommand = commands.find((command) => command.commandType === CommandType.REQUEST_CANCEL_NEXUS_OPERATION)

  expect(scheduleCommand).toBeTruthy()
  expect(cancelCommand).toBeTruthy()
  if (scheduleCommand?.attributes?.case === 'scheduleNexusOperationCommandAttributes') {
    expect(scheduleCommand.attributes.value.nexusHeader['x-temporal-bun-operation-id']).toBe('nexus-0')
  }
})
