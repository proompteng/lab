import { createFileRoute, notFound, redirect } from '@tanstack/react-router'
import { serverFns } from '../server/links'

export const Route = createFileRoute('/$slug')({
  loader: async ({ params }) => {
    const record = await serverFns.resolveSlug({ data: { slug: params.slug } })

    if (!record) {
      throw notFound()
    }

    // External redirect: use `href` so absolute URLs aren't prefixed and SSR can emit a clean 302.
    throw redirect({ href: record.targetUrl, statusCode: 302 })
  },
})
