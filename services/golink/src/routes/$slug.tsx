import { createFileRoute, redirect } from '@tanstack/react-router'
import { serverFns } from '../server/links'

export const Route = createFileRoute('/$slug')({
  loader: async ({ params }) => {
    const record = await serverFns.resolveSlug({ data: { slug: params.slug } })

    if (!record) {
      throw new Response('Not Found', { status: 404 })
    }

    throw redirect({ to: record.targetUrl, status: 302 })
  },
})
