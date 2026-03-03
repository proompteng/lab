import { createFileRoute } from '@tanstack/react-router'

import {
  getPullDeploymentEvidenceSummaryHandler,
  postPullDeploymentEvidenceHandler,
} from '~/server/github-review-handlers'

export const Route = createFileRoute('/api/github/pulls/$owner/$repo/$number/deployment')({
  server: {
    handlers: {
      POST: async ({ request, params }) => postPullDeploymentEvidenceHandler(request, params),
      GET: async ({ request, params }) => getPullDeploymentEvidenceSummaryHandler(request, params),
    },
  },
})
