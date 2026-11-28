import { createEndpointHandler } from '@restatedev/restate-sdk/fetch'
import { Schema } from 'effect'
import { makeApprovalOwner } from '@/approvals/owner'
import { logger } from '@/logger'

export const ApprovalServerConfigSchema = Schema.Struct({
  token: Schema.String.check(Schema.isMinLength(1)),
  webhookSecret: Schema.String.check(Schema.isMinLength(1)),
  requestIdentityKeys: Schema.Array(
    Schema.String.check(Schema.isPattern(/^publickeyv1_[1-9A-HJ-NP-Za-km-z]{43,44}$/)),
  ).check(Schema.isMinLength(1)),
})

export const startApprovalServer = () => {
  const config = Schema.decodeUnknownSync(ApprovalServerConfigSchema)({
    token: process.env.GITHUB_TOKEN,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    requestIdentityKeys: process.env.RESTATE_REQUEST_IDENTITY_KEYS?.split(','),
  })
  const handler = createEndpointHandler({
    services: [
      makeApprovalOwner({
        github: {
          token: config.token,
          ackReaction: '+1',
          apiBaseUrl: process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com',
          userAgent: 'froussard-webhook',
        },
        webhookSecret: config.webhookSecret,
      }),
    ],
    identityKeys: [...config.requestIdentityKeys],
  })
  const server = Bun.serve({
    hostname: '0.0.0.0',
    port: 9080,
    fetch: (request) =>
      new URL(request.url).pathname === '/health/readiness' ? new Response('ready') : handler(request),
  })
  logger.info({ port: server.port }, 'Restate approval endpoint listening')
  process.on('SIGTERM', () => {
    void server.stop(true)
    process.exit(0)
  })
  process.on('SIGINT', () => {
    void server.stop(true)
    process.exit(0)
  })
  return server
}

if (import.meta.main) startApprovalServer()
