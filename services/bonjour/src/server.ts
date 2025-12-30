import './instrumentation'

import { serve } from '@hono/node-server'
import { Hono } from 'hono'

import { logger } from './logger'

const port = Number.parseInt(process.env.PORT ?? '3000', 10)

const app = new Hono()

app.use('*', async (c, next) => {
  const start = Date.now()
  await next()
  const durationMs = Date.now() - start
  logger.info(
    {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs,
    },
    'request completed',
  )
})

app.get('/healthz', (c) => c.json({ status: 'ok' }))

app.get('/', (c) => c.json({ message: 'bonjour from the cdk8s + Argo CD sample server' }))

const server = serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    logger.info({ port: info.port }, 'server listening')
  },
)

process.on('SIGTERM', () => {
  server.close(() => {
    logger.info('server terminated gracefully')
  })
})
