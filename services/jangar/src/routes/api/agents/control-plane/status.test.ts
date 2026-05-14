import { describe, expect, it } from 'vitest'

import { resolveTorghutConsumerEvidenceForStatusRequest } from './status'

describe('control-plane status route', () => {
  it('omits Torghut consumer evidence for non-recursive carry imports', async () => {
    const resolver = resolveTorghutConsumerEvidenceForStatusRequest(
      new Request('http://jangar.test/api/agents/control-plane/status', {
        headers: {
          'x-torghut-consumer-evidence-mode': 'omit',
        },
      }),
    )

    expect(resolver).toBeDefined()
    const resolution = await resolver!()
    expect(resolution.status.status).toBe('disabled')
    expect(resolution.status.reason_codes).toContain('torghut_consumer_evidence_omitted_for_non_recursive_status')
  })

  it('keeps normal status requests on the full Torghut consumer-evidence path', () => {
    expect(
      resolveTorghutConsumerEvidenceForStatusRequest(new Request('http://jangar.test/api/agents/control-plane/status')),
    ).toBeUndefined()
  })
})
