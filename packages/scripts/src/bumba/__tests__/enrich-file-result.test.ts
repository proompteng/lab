import { describe, expect, it } from 'bun:test'

import { resolveWorkflowResult } from '../enrich-file-result'

describe('enrich-file result helper', () => {
  it('resolves results through client.workflow.result', async () => {
    const handle = { id: 'workflow-handle' }
    const expected = { ok: true }

    let receivedHandle: unknown
    const client = {
      workflow: {
        result: async (candidateHandle: unknown) => {
          receivedHandle = candidateHandle
          return expected
        },
      },
    }

    const result = await resolveWorkflowResult(client, { handle })

    expect(receivedHandle).toBe(handle)
    expect(result).toEqual(expected)
  })
})
