import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { SendHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Badge, Button, Textarea } from '~/components/base-ui'
import { GatewayFrame } from '~/components/gateway-shell'
import { loadInitialSnapshot } from '~/lib/load-snapshot'
import { createRule, fetchSnapshot } from '~/lib/sag-client'
import { type GatewayRule, type GatewaySnapshot } from '~/server/gateway'

export const Route = createFileRoute('/rules')({
  component: RulesRoute,
  loader: loadInitialSnapshot,
})

function RulesRoute() {
  const initialSnapshot = Route.useLoaderData() as GatewaySnapshot
  const [enabled, setEnabled] = useState(false)
  const [text, setText] = useState('')
  const queryClient = useQueryClient()
  useEffect(() => setEnabled(true), [])

  const snapshotQuery = useQuery({
    queryKey: ['sag-snapshot'],
    queryFn: fetchSnapshot,
    initialData: initialSnapshot,
    enabled,
  })
  const snapshot = snapshotQuery.data
  const mutation = useMutation({
    mutationFn: (nextText: string) => createRule(nextText),
    onSuccess: (result) => {
      queryClient.setQueryData(['sag-snapshot'], result.snapshot)
      setText('')
    },
  })

  return (
    <GatewayFrame active="/rules" snapshot={snapshot}>
      <div className="grid min-h-0 flex-1 grid-cols-[360px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-zinc-800 p-4">
          <h2 className="text-sm font-medium text-zinc-100">Rule Builder</h2>
          <div className="mt-4 flex min-h-0 flex-1 flex-col gap-3">
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Block AgentRuns that request production secrets"
              className="min-h-36"
            />
            <Button disabled={text.trim().length < 8 || mutation.isPending} onClick={() => mutation.mutate(text)}>
              <SendHorizontal data-icon="inline-start" />
              Create rule
            </Button>
          </div>
        </aside>
        <section className="min-h-0 overflow-y-auto">
          <div className="grid h-10 grid-cols-[220px_110px_150px_minmax(0,1fr)] items-center border-b border-zinc-800 px-5 text-[11px] font-medium text-zinc-500">
            <span>Name</span>
            <span>Mode</span>
            <span>Target</span>
            <span>Pattern</span>
          </div>
          <div className="divide-y divide-zinc-900">
            {snapshot.rules.map((rule) => (
              <RuleLine key={rule.id} rule={rule} />
            ))}
          </div>
        </section>
      </div>
    </GatewayFrame>
  )
}

function RuleLine({ rule }: { rule: GatewayRule }) {
  return (
    <div className="grid min-h-14 grid-cols-[220px_110px_150px_minmax(0,1fr)] items-center px-5 text-xs">
      <div className="min-w-0">
        <p className="truncate text-zinc-100">{rule.name}</p>
        <p className="truncate font-mono text-[11px] text-zinc-500">{rule.id}</p>
      </div>
      <Badge variant={rule.mode === 'block' ? 'destructive' : rule.mode === 'approval' ? 'secondary' : 'outline'}>
        {rule.mode}
      </Badge>
      <span className="font-mono text-[11px] text-zinc-400">{rule.target}</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-zinc-500">{rule.pattern}</span>
    </div>
  )
}
