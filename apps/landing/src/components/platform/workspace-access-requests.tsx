'use client'

import { fromJson } from '@bufbuild/protobuf'
import { zodResolver } from '@hookform/resolvers/zod'
import { Button, Field, FieldError, FieldLabel, Input, Skeleton } from '@proompteng/design/ui'
import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { accessActionName } from '@/lib/platform/access-requests'
import { readPlatformResponse } from '@/lib/platform/client'
import { policyReasonSchema } from '@/lib/platform/policies'
import {
  ListPlatformAccessRequestsResponseSchema,
  type GetPlatformWorkspaceResponse,
  type PlatformAccessRequest,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
import { AccessRequestMutationStatus, useAccessRequestMutation } from './access-request-mutation'

const schema = z.object({ reason: policyReasonSchema })
export function WorkspaceAccessRequests({
  detail,
  humanId,
  onChanged,
}: {
  detail: GetPlatformWorkspaceResponse
  humanId: string
  onChanged: () => void
}) {
  const workspace = detail.workspace!
  const id = useId()
  const [requests, setRequests] = useState<PlatformAccessRequest[]>()
  const [error, setError] = useState<Error>()
  const [loading, setLoading] = useState(false)
  const [review, setReview] = useState<{ id: string; decision: 'approve' | 'decline' }>()
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { reason: '' } })
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true)
      setError(undefined)
      try {
        const json = await fetch(
          '/api/platform/access-requests?' + new URLSearchParams({ workspaceId: workspace.id }),
          { cache: 'no-store', signal },
        ).then(readPlatformResponse)
        if (!signal?.aborted) setRequests(fromJson(ListPlatformAccessRequestsResponseSchema, json).requests)
      } catch (cause) {
        if (!signal?.aborted) setError(cause instanceof Error ? cause : new Error('Requests could not be loaded.'))
      } finally {
        if (!signal?.aborted) setLoading(false)
      }
    },
    [workspace.id],
  )
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])
  const changed = () => {
    setReview(undefined)
    void load()
    onChanged()
  }
  const mutation = useAccessRequestMutation(`platform-access-request:${humanId}:${workspace.id}:admin`, changed)
  const blocked = !mutation.ready || mutation.busy || Boolean(mutation.pending)
  const submit = form.handleSubmit(async ({ reason }) => {
    if (!review) return
    await mutation.save({
      kind: 'review',
      operationId: crypto.randomUUID(),
      workspaceId: workspace.id,
      requestId: review.id,
      decision: review.decision,
      reason,
    })
  })
  return (
    <section className="space-y-4" aria-label="Access requests">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Access requests</h2>
          <p className="mt-1 text-sm text-zinc-400">Review the capabilities members need for their work.</p>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh requests"
          disabled={loading || mutation.busy}
          onClick={() => void load()}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-300">
          {error.message}
        </p>
      ) : null}
      {!requests && !error ? <Skeleton aria-label="Loading requests" className="h-20" /> : null}
      {requests?.length === 0 ? <p className="text-sm text-zinc-400">No pending access requests.</p> : null}
      {requests?.map((request) => {
        const member = detail.members.find((person) => person.humanId === request.requesterHumanId)
        const client = detail.clients.find((entry) => entry.client?.id === request.clientService)?.client
        return (
          <div key={request.id} className="space-y-3 rounded-lg border border-zinc-800 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1 text-sm">
                <p className="font-medium">
                  {member?.displayName || (member ? `GitHub ${member.githubId}` : 'Former member')}{' '}
                  <span className="font-normal text-zinc-400">via {client?.displayName || request.clientService}</span>
                </p>
                <p>{request.scope?.resourceName}</p>
                <p className="text-zinc-400">{request.scope?.actions.map(accessActionName).join(' · ')}</p>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={blocked}
                  onClick={() => {
                    setReview({ id: request.id, decision: 'decline' })
                    form.reset({ reason: '' })
                  }}
                >
                  Decline
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={blocked}
                  onClick={() => {
                    setReview({ id: request.id, decision: 'approve' })
                    form.reset({ reason: 'Approved requested workspace access' })
                  }}
                >
                  Review
                </Button>
              </div>
            </div>
            <p className="break-words text-sm text-zinc-400">{request.reason}</p>
            {review?.id === request.id ? (
              <form className="space-y-3 border-t border-zinc-800 pt-3" onSubmit={submit}>
                {review.decision === 'approve' ? (
                  <p className="text-sm text-zinc-400">
                    This grants the listed capabilities to this member in {workspace.name}. They can then connect in
                    their app.
                  </p>
                ) : null}
                <Field data-invalid={Boolean(form.formState.errors.reason)}>
                  <FieldLabel htmlFor={id + '-reason'}>
                    {review.decision === 'approve' ? 'Approval reason' : 'Reason for declining'}
                  </FieldLabel>
                  <Input
                    id={id + '-reason'}
                    maxLength={512}
                    className="text-base md:text-sm"
                    disabled={blocked}
                    aria-invalid={Boolean(form.formState.errors.reason)}
                    aria-describedby={id + '-error'}
                    {...form.register('reason')}
                  />
                  <FieldError id={id + '-error'} errors={[form.formState.errors.reason]} />
                </Field>
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={blocked}>
                    {mutation.busy ? 'Saving…' : review.decision === 'approve' ? 'Approve access' : 'Decline request'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={blocked}
                    onClick={() => setReview(undefined)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : null}
          </div>
        )
      })}
      <AccessRequestMutationStatus mutation={mutation} />
    </section>
  )
}
