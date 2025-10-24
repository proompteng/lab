import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => {
  return c.text('Nata!')
})

app.get('/health/liveness', (c) => {
  console.log('Liveness check request received')
  return c.text('OK')
})

app.get('/health/readiness', (c) => {
  console.log('Health check request received')
  return c.text('OK')
})

app.use('*', async (c, next) => {
  console.log(`Request: ${c.req.method} ${c.req.url}`)
  await next()
})

app.onError((err, c) => {
  console.error('Server error:', err)
  return c.text('Internal Server Error', 500)
})

const port = Number(process.env.PORT) || 8080

serve({
  fetch: app.fetch,
  port,
  hostname: '0.0.0.0',
})
