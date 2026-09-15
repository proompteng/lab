import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { fetchPrimitiveResource } from '../control-plane/api-client'
import { isAgentRunDetailKind } from '../control-plane/agentrun-detail'
import { findPrimitiveDefinition } from '../control-plane/registry'
import { AgentRunDetailPage } from '../components/control-plane/agentrun-detail'
import { ControlPlanePage } from '../components/control-plane/control-plane-page'
import { Alert, AlertDescription } from '../components/ui/alert'
import { Skeleton } from '../components/ui/skeleton'
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
    setResource(null)
    setError(null)
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
    <ControlPlanePage>
      {!isAgentRunDetailKind(primitive.display.pathSegment) && error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {isAgentRunDetailKind(primitive.display.pathSegment) ? (
        <AgentRunDetailPage resource={resource} error={error} />
      ) : (
        <Tabs defaultValue="manifest" className="w-full">
          <TabsList>
            <TabsTrigger value="manifest">Manifest</TabsTrigger>
            <TabsTrigger value="status">Status</TabsTrigger>
          </TabsList>
          <TabsContent value="manifest" className="rounded-md border bg-background">
            {resource ? (
              <pre className="max-h-[70vh] overflow-auto p-4 text-xs leading-relaxed">
                {JSON.stringify(resource, null, 2)}
              </pre>
            ) : (
              <ManifestSkeleton />
            )}
          </TabsContent>
          <TabsContent value="status" className="rounded-md border bg-background">
            {resource ? (
              <pre className="max-h-[70vh] overflow-auto p-4 text-xs leading-relaxed">
                {JSON.stringify((resource.status as unknown) ?? {}, null, 2)}
              </pre>
            ) : (
              <ManifestSkeleton />
            )}
          </TabsContent>
        </Tabs>
      )}
    </ControlPlanePage>
  )
}

function ManifestSkeleton() {
  return (
    <div className="p-4 font-mono text-xs leading-relaxed">
      <CodeSkeletonLine prefix="{" width="w-0" />
      <CodeSkeletonLine indent={1} prefix='"apiVersion":' width="w-36" />
      <CodeSkeletonLine indent={1} prefix='"kind":' width="w-24" />
      <CodeSkeletonLine indent={1} prefix='"metadata": {' width="w-0" />
      <CodeSkeletonLine indent={2} prefix='"name":' width="w-44" />
      <CodeSkeletonLine indent={2} prefix='"namespace":' width="w-28" />
      <CodeSkeletonLine indent={1} prefix="}," width="w-0" />
      <CodeSkeletonLine indent={1} prefix='"spec": {' width="w-0" />
      <CodeSkeletonLine indent={2} prefix='"agentRef":' width="w-40" />
      <CodeSkeletonLine indent={2} prefix='"parameters":' width="w-56" />
      <CodeSkeletonLine indent={1} prefix="}," width="w-0" />
      <CodeSkeletonLine indent={1} prefix='"status": {' width="w-0" />
      <CodeSkeletonLine indent={2} prefix='"conditions":' width="w-48" />
      <CodeSkeletonLine indent={1} prefix="}" width="w-0" />
      <CodeSkeletonLine prefix="}" width="w-0" />
    </div>
  )
}

function CodeSkeletonLine({ indent = 0, prefix, width }: { indent?: number; prefix: string; width: string }) {
  const indentClass = indent === 2 ? 'pl-8' : indent === 1 ? 'pl-4' : ''

  return (
    <div className={`flex min-h-5 items-center gap-2 ${indentClass}`}>
      <span className="text-muted-foreground">{prefix}</span>
      {width === 'w-0' ? null : <Skeleton className={`h-3 ${width} max-w-full`} />}
    </div>
  )
}
