'use client'

import { fromJson } from '@bufbuild/protobuf'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Button,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@proompteng/design/ui'
import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { accessActionName } from '@/lib/platform/access-requests'
import { readPlatformResponse } from '@/lib/platform/client'
import { policyReasonSchema } from '@/lib/platform/policies'
import {
  ListPlatformAccessRequestsResponseSchema,
  type GetPlatformWorkspaceResponse,
  type PlatformAccessRequest,
  PlatformAccessRequestState,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
import { AccessRequestMutationStatus, useAccessRequestMutation } from './access-request-mutation'

import { usePortalQuery } from './collection-view'
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
  const { query, change } = usePortalQuery()
  const history = query.get('history') === 'true'
  const cursor = query.get('cursor') || ''
  const requestId = query.get('request') || ''
  const [nextCursor, setNextCursor] = useState('')
  const [requests, setRequests] = useState<PlatformAccessRequest[]>()
  const [error, setError] = useState<Error>()
  const [loading, setLoading] = useState(false)
  const [review, setReview] = useState<{ id: string; decision: 'approve' | 'decline' }>()
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { reason: '' } })
  const readVersion = useRef(0)
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const version = ++readVersion.current
      setLoading(true)
      setRequests(undefined)
      setReview(undefined)
      setError(undefined)
      try {
        const json = await fetch(
          '/api/platform/access-requests?' +
            new URLSearchParams({
              workspaceId: workspace.id,
              history: String(history),
              ...(requestId ? { requestId } : cursor ? { cursor } : {}),
            }),
          { cache: 'no-store', signal },
        ).then(readPlatformResponse)
        if (!signal?.aborted && version === readVersion.current) {
          const result = fromJson(ListPlatformAccessRequestsResponseSchema, json)
          setRequests(result.requests)
          setNextCursor(result.cursor)
        }
      } catch (cause) {
        if (!signal?.aborted && version === readVersion.current)
          setError(cause instanceof Error ? cause : new Error('Requests could not be loaded.'))
      } finally {
        if (!signal?.aborted && version === readVersion.current) setLoading(false)
      }
    },
    [workspace.id, history, cursor, requestId],
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
    if (
      !review ||
      blocked ||
      !requests?.some((request) => request.id === review.id && request.state === PlatformAccessRequestState.PENDING)
    )
      return
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
      <Tabs
        value={history ? 'history' : 'pending'}
        onValueChange={(value) => change({ history: value === 'history' ? 'true' : '', cursor: '', request: '' })}
      >
        <TabsList aria-label="Request views">
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
      </Tabs>
      <p className="text-xs text-zinc-400">
        Newest requests first. Each page contains up to 128 requests; history includes approved, declined and cancelled
        requests.
      </p>
      {query.get('request') && requests && !requests.some((request) => request.id === query.get('request')) ? (
        <p role="alert">
          This request is not available in this workspace. Return to the queue.{' '}
          <Button size="sm" variant="ghost" onClick={() => change({ request: '', cursor: '', history: '' })}>
            Back to queue
          </Button>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-300">
          {error.message}
        </p>
      ) : null}
      {!requests && !error ? <Skeleton aria-label="Loading requests" className="h-20" /> : null}
      {requests?.length === 0 ? (
        <p className="text-sm text-zinc-400">
          {history ? 'No previous access requests.' : 'No pending access requests.'}
        </p>
      ) : null}
      {requests
        ?.filter((request) => !query.get('request') || request.id === query.get('request'))
        .map((request) => {
          const member = detail.members.find((person) => person.humanId === request.requesterHumanId)
          const client = detail.clients.find((entry) => entry.client?.id === request.clientService)?.client
          return (
            <div key={request.id} className="space-y-3 rounded-lg border border-zinc-800 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1 text-sm">
                  <p className="font-medium">
                    {member?.displayName || (member ? `GitHub ${member.githubId}` : 'Former member')}{' '}
                    <span className="font-normal text-zinc-400">
                      via {client?.displayName || request.clientService}
                    </span>
                  </p>
                  <p>{request.scope?.resourceName}</p>
                  <p className="text-zinc-400">{request.scope?.actions.map(accessActionName).join(' · ')}</p>
                </div>
                {request.state === PlatformAccessRequestState.PENDING ? (
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
                ) : (
                  <span className="text-xs text-zinc-400">
                    {PlatformAccessRequestState[request.state]?.toLowerCase()}
                  </span>
                )}
              </div>
              <p className="break-words text-sm text-zinc-400">{request.reason}</p>
              <div className="space-y-2 text-xs text-zinc-400">
                <p>
                  Requested{' '}
                  <time dateTime={new Date(Number(request.createdAtUnixMs)).toISOString()}>
                    {new Date(Number(request.createdAtUnixMs)).toLocaleString()}
                  </time>
                </p>
                {request.decisionReason ? <p>Decision reason: {request.decisionReason}</p> : null}
                <details>
                  <summary className="cursor-pointer">Request details</summary>
                  <p className="mt-2 break-all">Request {request.id}</p>
                  <p className="break-all">
                    {request.scope?.resource?.kind} / {request.scope?.resource?.id}
                  </p>
                </details>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => change({ request: query.get('request') ? '' : request.id })}
                >
                  {query.get('request') ? 'Back to list' : 'Open request'}
                </Button>
              </div>
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
      {nextCursor ? (
        <Button
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => change({ cursor: nextCursor, request: '' })}
        >
          Earlier requests
        </Button>
      ) : null}
      {cursor ? (
        <Button variant="ghost" size="sm" onClick={() => change({ cursor: '', request: '' })}>
          Newest requests
        </Button>
      ) : null}
      <AccessRequestMutationStatus mutation={mutation} />
    </section>
  )
}
