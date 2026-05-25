import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { findPrimitiveDefinition } from '../control-plane/registry'
import { PrimitiveSchemaForm } from '../components/control-plane/schema-form'
import { Alert, AlertDescription } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'

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
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-4 md:p-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-normal">New {primitive.display.label}</h1>
          <Badge variant="outline">{primitive.version}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{primitive.apiVersion}</p>
      </div>
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
    </div>
  )
}
