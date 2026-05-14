import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { SendHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { GatewayFrame } from '~/components/gateway-shell'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Empty, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { Textarea } from '~/components/ui/textarea'
import { ruleModeLabel, ruleScope, ruleTargetLabel, statusBadgeVariant, userFacingText } from '~/lib/sag-display'
import { createRule, fetchSnapshot } from '~/lib/sag-client'
import { loadInitialSnapshot } from '~/lib/load-snapshot'
import type { GatewayRule, GatewaySnapshot } from '~/server/gateway'

export const Route = createFileRoute('/rules')({
  component: PoliciesRoute,
  loader: loadInitialSnapshot,
})

function PoliciesRoute() {
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
      <header className="flex h-14 shrink-0 items-center border-b border-zinc-900 px-5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-zinc-50">Policies</h2>
          <div className="mt-0.5 text-xs text-zinc-400">{snapshot.rules.length} active</div>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col gap-3 border-r border-zinc-900 p-4">
          <h3 className="text-xs font-medium text-zinc-500">Create policy</h3>
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Require approval before production changes"
            className="min-h-36 bg-zinc-950"
          />
          <Button disabled={text.trim().length < 8 || mutation.isPending} onClick={() => mutation.mutate(text)}>
            <SendHorizontal data-icon="inline-start" />
            Create
          </Button>
        </aside>
        <section className="min-h-0 overflow-y-auto">
          {snapshot.rules.length === 0 ? (
            <Empty className="min-h-36 border-0">
              <EmptyHeader>
                <EmptyTitle>No policies</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : null}
          {snapshot.rules.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow className="border-zinc-900">
                  <TableHead className="px-4 text-xs text-zinc-400">Policy</TableHead>
                  <TableHead className="w-32 px-4 text-xs text-zinc-400">Mode</TableHead>
                  <TableHead className="px-4 text-xs text-zinc-400">Applies to</TableHead>
                  <TableHead className="w-36 px-4 text-xs text-zinc-400">Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.rules.map((rule) => (
                  <PolicyLine key={rule.id} rule={rule} />
                ))}
              </TableBody>
            </Table>
          ) : null}
        </section>
      </div>
    </GatewayFrame>
  )
}

function PolicyLine({ rule }: { rule: GatewayRule }) {
  return (
    <TableRow className="border-zinc-900">
      <TableCell className="px-4">
        <div className="grid gap-0.5">
          <span className="text-xs font-medium text-zinc-100">{rule.name}</span>
          <span className="line-clamp-1 text-[11px] text-zinc-600">{userFacingText(rule.summary)}</span>
        </div>
      </TableCell>
      <TableCell className="w-32 px-4">
        <Badge
          variant={statusBadgeVariant(
            rule.mode === 'block' ? 'blocked' : rule.mode === 'approval' ? 'needs_approval' : 'allowed',
          )}
        >
          {ruleModeLabel(rule.mode)}
        </Badge>
      </TableCell>
      <TableCell className="px-4">
        <div className="grid gap-0.5">
          <span className="text-xs text-zinc-300">{ruleTargetLabel(rule.target)}</span>
          <span className="text-[11px] text-zinc-600">{ruleScope(rule)}</span>
        </div>
      </TableCell>
      <TableCell className="w-36 px-4 text-xs text-zinc-500">
        {rule.source === 'natural-language' ? 'Request' : 'System'}
      </TableCell>
    </TableRow>
  )
}
