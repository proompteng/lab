import { createFileRoute } from '@tanstack/react-router'

import { JsonResponseView } from '@/components/json-response-view'

export const Route = createFileRoute('/api/health')({
  component: HealthApiView,
})

function HealthApiView() {
  return <JsonResponseView title="Health" requestPath="/health" />
}
