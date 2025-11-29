import { httpRouter } from 'convex/server'
import { httpAction } from './_generated/server'

// Minimal router to enable HTTP Actions. Extend with routes as needed.
const http = httpRouter()

http.route({
  path: '/',
  method: 'GET',
  handler: httpAction(async () => new Response('ok')),
})

export default http
