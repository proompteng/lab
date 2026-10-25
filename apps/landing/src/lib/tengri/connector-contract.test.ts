import { expect, test } from 'bun:test'
import { fromBinary, toBinary } from '@bufbuild/protobuf'
import { ObservationScopeSchema } from './generated/proompteng/authz/v1/authz_pb'

test('dormant connector fields preserve the existing observation-scope wire contract', () => {
  // Fields 1–6 from the pre-connector contract; absent fields 7–8 must stay absent.
  const legacy = Buffer.from(
    '0a0e2f776f726b73706163652f73726312087468726561642d311a0a7465726d696e616c2d3120012880083014',
    'hex',
  )
  const scope = fromBinary(ObservationScopeSchema, legacy)
  expect(scope).toMatchObject({
    fileRoots: ['/workspace/src'],
    threadIds: ['thread-1'],
    terminalIds: ['terminal-1'],
    browserScreenshot: true,
    maxBytes: 1024,
    maxItems: 20,
    connectorOperations: [],
    connectorRuntimeEpoch: '',
  })
  expect(Buffer.from(toBinary(ObservationScopeSchema, scope))).toEqual(legacy)
})
