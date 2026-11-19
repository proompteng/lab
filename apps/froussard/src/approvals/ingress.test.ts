import { Webhooks } from '@octokit/webhooks'
import { describe, expect, it, vi } from 'vitest'
import { approvalSignaturePayload } from './contracts'
import { enqueueApproval } from './ingress'

const command = { repositoryFullName: 'Owner/Repo', pullNumber: 7, deliveryId: 'delivery-check-run' }
const webhooks = new Webhooks({ secret: 'test-secret' })

describe('approval durable ingress', () => {
  it('signs a scoped command and waits for a durable acknowledgement', async () => {
    const send = vi.fn<(input: URL, init: RequestInit) => Promise<Response>>(async () =>
      Response.json({ invocationId: 'invocation-1', status: 'Accepted' }, { status: 202 }),
    )
    await enqueueApproval({
      command,
      ingressOrigin: 'http://restate.test',
      sign: (text) => webhooks.sign(text),
      fetchImplementation: send,
    })
    const [url, init] = send.mock.calls[0] ?? []
    expect(String(url)).toBe('http://restate.test/FroussardApprovals/owner%2Frepo%237/approve/send')
    expect(init?.headers).toMatchObject({ 'idempotency-key': command.deliveryId })
    if (typeof init?.body !== 'string') throw new Error('Expected signed JSON command')
    const body = JSON.parse(init.body)
    expect(await webhooks.verify(approvalSignaturePayload(command), body.signature)).toBe(true)
    expect(body).not.toHaveProperty('token')
  })
  it.each([404, 500, 503])('rejects HTTP %s instead of losing the delivery', async (status) => {
    await expect(
      enqueueApproval({
        command,
        ingressOrigin: 'http://restate.test',
        sign: (text) => webhooks.sign(text),
        fetchImplementation: async () => new Response('unavailable', { status }),
      }),
    ).rejects.toThrow(`HTTP ${status}`)
  })
  it('rejects an invalid acknowledgement', async () => {
    await expect(
      enqueueApproval({
        command,
        ingressOrigin: 'http://restate.test',
        sign: (text) => webhooks.sign(text),
        fetchImplementation: async () => Response.json({}, { status: 202 }),
      }),
    ).rejects.toThrow()
  })
})
