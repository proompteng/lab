import { describe, expect, it } from 'bun:test'

import { __private } from '../enrich-file'

describe('enrich-file', () => {
  it('wait mode resolves results through client.workflow.result', async () => {
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

    const result = await __private.resolveWorkflowResult(client, { handle })

    expect(receivedHandle).toBe(handle)
    expect(result).toEqual(expected)
  })
})
