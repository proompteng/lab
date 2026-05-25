import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { fetchPrimitiveResource } from '../control-plane/api-client'
import { findPrimitiveDefinition } from '../control-plane/registry'
import { Alert, AlertDescription } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'

export const Route = createFileRoute('/primitives/$kind/$namespace/$name')({
  component: PrimitiveDetailPage,
})

function PrimitiveDetailPage() {
  const { kind, namespace, name } = Route.useParams()
  const primitive = findPrimitiveDefinition(kind)
  const [resource, setResource] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!primitive) return
    fetchPrimitiveResource(primitive.display.pathSegment, namespace, name)
      .then((response) => setResource(response.resource))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [primitive?.kind, namespace, name])

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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-normal">{name}</h1>
            <Badge variant="outline">{primitive.display.label}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">{namespace}</p>
        </div>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Tabs defaultValue="manifest" className="w-full">
        <TabsList>
          <TabsTrigger value="manifest">Manifest</TabsTrigger>
          <TabsTrigger value="status">Status</TabsTrigger>
        </TabsList>
        <TabsContent value="manifest" className="rounded-md border bg-background">
          <pre className="max-h-[70vh] overflow-auto p-4 text-xs leading-relaxed">
            {resource ? JSON.stringify(resource, null, 2) : 'Loading...'}
          </pre>
        </TabsContent>
        <TabsContent value="status" className="rounded-md border bg-background">
          <pre className="max-h-[70vh] overflow-auto p-4 text-xs leading-relaxed">
            {resource ? JSON.stringify((resource.status as unknown) ?? {}, null, 2) : 'Loading...'}
          </pre>
        </TabsContent>
      </Tabs>
    </div>
  )
}
