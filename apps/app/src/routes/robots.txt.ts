import { createFileRoute } from '@tanstack/react-router'

const robotsTxt = `User-agent: *
Disallow: /api/
Disallow: /auth/
Allow: /
`

export const Route = createFileRoute('/robots/txt')({
  server: {
    handlers: {
      GET: async () => {
        return new Response(robotsTxt, {
          status: 200,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            // Keep this short to avoid long cache when tweaking.
            'Cache-Control': 'public, max-age=300',
          },
        })
      },
    },
  },
})
