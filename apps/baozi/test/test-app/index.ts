import { serve } from 'bun'

serve({
  fetch(_req: Request) {
    return new Response('Hello from Bun S2I!')
  },
  port: 3000, // Default port exposed in Dockerfile
})

console.log('Bun server listening on port 3000')
