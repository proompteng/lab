import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { CheckCircle2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { GatewayFrame } from '~/components/gateway-shell'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Empty, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import {
  approvalActionLabel,
  formatTime,
  statusBadgeVariant,
  statusLabel,
  targetLabel,
  userFacingText,
} from '~/lib/sag-display'
import { approveRun, fetchSnapshot } from '~/lib/sag-client'
import { loadInitialSnapshot } from '~/lib/load-snapshot'
import type { Approval, GatewaySnapshot } from '~/server/gateway'

export const Route = createFileRoute('/approvals')({
  component: ApprovalsRoute,
  loader: loadInitialSnapshot,
})

function ApprovalsRoute() {
  const initialSnapshot = Route.useLoaderData() as GatewaySnapshot
  const [enabled, setEnabled] = useState(false)
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
    mutationFn: (approvalId: string) => approveRun(approvalId),
    onSuccess: (result) => queryClient.setQueryData(['sag-snapshot'], result.snapshot),
  })

  return (
    <GatewayFrame active="/approvals" snapshot={snapshot}>
      <header className="flex h-14 shrink-0 items-center border-b border-zinc-900 px-5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-zinc-50">Approvals</h2>
          <div className="mt-0.5 text-xs text-zinc-400">{snapshot.stats.awaitingApproval} waiting</div>
        </div>
      </header>
      <section className="min-h-0 flex-1 overflow-y-auto">
        {snapshot.approvals.length === 0 ? (
          <Empty className="min-h-36 border-0">
            <EmptyHeader>
              <EmptyTitle>No approvals</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : null}
        {snapshot.approvals.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow className="border-zinc-900">
                <TableHead className="w-36 px-4 text-xs text-zinc-400">Status</TableHead>
                <TableHead className="px-4 text-xs text-zinc-400">Action</TableHead>
                <TableHead className="px-4 text-xs text-zinc-400">Run</TableHead>
                <TableHead className="px-4 text-xs text-zinc-400">Reason</TableHead>
                <TableHead className="w-28 px-4 text-xs text-zinc-400" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshot.approvals.map((approval) => (
                <ApprovalLine
                  key={approval.id}
                  approval={approval}
                  runTitle={snapshot.actionRuns.find((run) => run.id === approval.taskId)?.title}
                  approving={mutation.isPending}
                  onApprove={() => mutation.mutate(approval.id)}
                />
              ))}
            </TableBody>
          </Table>
        ) : null}
      </section>
    </GatewayFrame>
  )
}

function ApprovalLine({
  approval,
  runTitle,
  approving,
  onApprove,
}: {
  approval: Approval
  runTitle?: string
  approving: boolean
  onApprove: () => void
}) {
  return (
    <TableRow className="border-zinc-900">
      <TableCell className="w-36 px-4">
        <Badge variant={statusBadgeVariant(approval.status)}>{statusLabel(approval.status)}</Badge>
      </TableCell>
      <TableCell className="px-4">
        <div className="grid gap-0.5">
          <span className="text-sm font-medium text-zinc-100">{approvalActionLabel(approval.action)}</span>
          <span className="text-xs text-zinc-400">{targetLabel(approval.target)}</span>
        </div>
      </TableCell>
      <TableCell className="px-4 text-sm text-zinc-300">{runTitle ?? formatTime(approval.createdAt)}</TableCell>
      <TableCell className="px-4 text-sm text-zinc-300">{userFacingText(approval.reason)}</TableCell>
      <TableCell className="w-28 px-4 text-right">
        <Button size="sm" variant="secondary" disabled={approval.status !== 'pending' || approving} onClick={onApprove}>
          <CheckCircle2 data-icon="inline-start" />
          Approve
        </Button>
      </TableCell>
    </TableRow>
  )
}
