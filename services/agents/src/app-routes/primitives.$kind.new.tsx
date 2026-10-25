import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { findPrimitiveDefinition } from '../control-plane/registry'
import { ControlPlanePage } from '../components/control-plane/control-plane-page'
import { PrimitiveSchemaForm } from '../components/control-plane/schema-form'
import { Alert, AlertDescription } from '../components/ui/alert'

export const Route = createFileRoute('/primitives/$kind/new')({
  component: PrimitiveCreatePage,
})

const metadataString = (resource: Record<string, unknown>, key: string) => {
  const metadata =
    resource.metadata && typeof resource.metadata === 'object' ? (resource.metadata as Record<string, unknown>) : {}
  const value = metadata[key]
  return typeof value === 'string' ? value : ''
}

function PrimitiveCreatePage() {
  const { kind } = Route.useParams()
  const primitive = findPrimitiveDefinition(kind)
  const navigate = useNavigate()

  if (!primitive) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertDescription>Unknown primitive.</AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <ControlPlanePage>
      <PrimitiveSchemaForm
        primitive={primitive}
        onCreated={(resource) => {
          const name = metadataString(resource, 'name')
          const namespace = metadataString(resource, 'namespace') || 'agents'
          void navigate({
            to: '/primitives/$kind/$namespace/$name',
            params: { kind: primitive.display.pathSegment, namespace, name },
          })
        }}
      />
    </ControlPlanePage>
  )
}
