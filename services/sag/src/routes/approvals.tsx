import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { CheckCircle2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Badge, Button } from '~/components/base-ui'
import { GatewayFrame } from '~/components/gateway-shell'
import { loadInitialSnapshot } from '~/lib/load-snapshot'
import { approveRun, fetchSnapshot } from '~/lib/sag-client'
import { type Approval, type GatewaySnapshot } from '~/server/gateway'

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
      <section className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid h-10 grid-cols-[160px_130px_minmax(0,1fr)_240px_120px] items-center border-b border-zinc-800 px-5 text-[11px] font-medium text-zinc-500">
          <span>Approval</span>
          <span>Status</span>
          <span>Action</span>
          <span>Target</span>
          <span />
        </div>
        <div className="divide-y divide-zinc-900">
          {snapshot.approvals.map((approval) => (
            <ApprovalLine
              key={approval.id}
              approval={approval}
              approving={mutation.isPending}
              onApprove={() => mutation.mutate(approval.id)}
            />
          ))}
          {snapshot.approvals.length === 0 ? <div className="p-6 text-sm text-zinc-500">No approvals.</div> : null}
        </div>
      </section>
    </GatewayFrame>
  )
}

function ApprovalLine({
  approval,
  approving,
  onApprove,
}: {
  approval: Approval
  approving: boolean
  onApprove: () => void
}) {
  return (
    <div className="grid min-h-14 grid-cols-[160px_130px_minmax(0,1fr)_240px_120px] items-center px-5 text-xs">
      <span className="font-mono text-[11px] text-zinc-400">{approval.id}</span>
      <Badge variant={approval.status === 'pending' ? 'secondary' : 'outline'}>{approval.status}</Badge>
      <span className="min-w-0 truncate text-zinc-300">{approval.action}</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-zinc-500">{approval.target}</span>
      <Button size="sm" variant="secondary" disabled={approval.status !== 'pending' || approving} onClick={onApprove}>
        <CheckCircle2 data-icon="inline-start" />
        Approve
      </Button>
    </div>
  )
}
