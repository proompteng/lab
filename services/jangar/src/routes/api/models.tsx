import { createFileRoute } from '@tanstack/react-router'

import { JsonResponseView } from '@/components/json-response-view'

export const Route = createFileRoute('/api/models')({
  component: ModelsApiView,
})

function ModelsApiView() {
  return <JsonResponseView title="Models" requestPath="/openai/v1/models" />
}
