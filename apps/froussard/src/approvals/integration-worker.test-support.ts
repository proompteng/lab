import { createEndpointHandler } from '@restatedev/restate-sdk/fetch'
import { makeApprovalOwner } from './owner'

const apiBaseUrl = process.env.FROUSSARD_TEST_GITHUB_URL ?? ''
if (new URL(apiBaseUrl).hostname !== '127.0.0.1') throw new Error('Integration GitHub must be local')
const handler = createEndpointHandler({
  services: [
    makeApprovalOwner({
      github: { token: 'test-token', ackReaction: '+1', apiBaseUrl, userAgent: 'froussard-test' },
      webhookSecret: 'test-webhook-secret',
    }),
  ],
})
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.FROUSSARD_TEST_PORT ?? 0), fetch: handler })
process.stdout.write(`${JSON.stringify({ port: server.port })}\n`)
