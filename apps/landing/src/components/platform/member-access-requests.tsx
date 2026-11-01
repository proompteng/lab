'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { Badge, Button, Checkbox, Field, FieldError, FieldLabel, Input } from '@proompteng/design/ui'
import { useId, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { z } from 'zod'
import { accessActionName } from '@/lib/platform/access-requests'
import { policyReasonSchema } from '@/lib/platform/policies'
import {
  PlatformAccessRequestState,
  type ListPlatformConnectionsResponse,
  type PlatformConnectionScope,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
import { AccessRequestMutationStatus, useAccessRequestMutation } from './access-request-mutation'

const schema = z.object({
  actions: z.array(z.string()).min(1, 'Choose at least one capability.'),
  reason: policyReasonSchema,
})
const key = (scope: PlatformConnectionScope) =>
  JSON.stringify([scope.workspaceId, scope.resource?.kind, scope.resource?.id])
function RequestCard({
  scope,
  snapshot,
  mutation,
  disabled,
}: {
  scope: PlatformConnectionScope
  snapshot: ListPlatformConnectionsResponse
  mutation: ReturnType<typeof useAccessRequestMutation>
  disabled: boolean
}) {
  const id = useId()
  const [editing, setEditing] = useState(false)
  const available = snapshot.availableScopes.find((entry) => key(entry) === key(scope))
  const missing = scope.actions.filter((action) => !available?.actions.includes(action))
  const latest = snapshot.accessRequests.find((request) => request.scope && key(request.scope) === key(scope))
  const pending = latest?.state === PlatformAccessRequestState.PENDING ? latest : undefined
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { actions: missing, reason: '' },
  })
  if (!missing.length && !pending) return null
  const blocked = disabled || !mutation.ready || mutation.busy || Boolean(mutation.pending)
  const submit = form.handleSubmit(async (value) => {
    if (!scope.resource) return
    await mutation.save({
      kind: 'create',
      operationId: crypto.randomUUID(),
      workspaceId: scope.workspaceId,
      resource: { kind: scope.resource.kind, id: scope.resource.id },
      actions: value.actions,
      reason: value.reason,
    })
    setEditing(false)
  })
  return (
    <div className="space-y-3 rounded-lg border border-zinc-800 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">
            {scope.resourceName}
            {pending ? (
              <Badge variant="secondary" className="ml-2">
                Pending approval
              </Badge>
            ) : null}
          </p>
          <p className="text-xs text-zinc-400">{scope.workspaceName}</p>
          <p className="text-sm text-zinc-400">
            {(pending?.scope?.actions || missing).map(accessActionName).join(' · ')}
          </p>
        </div>
        {pending ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={blocked}
            onClick={() =>
              void mutation.save({ kind: 'cancel', operationId: crypto.randomUUID(), requestId: pending.id })
            }
          >
            Cancel request
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={blocked}
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? 'Cancel' : 'Request access'}
          </Button>
        )}
      </div>
      {pending ? (
        <p className="text-sm text-zinc-400">
          Your workspace admin can review this request. No access has been added yet.
        </p>
      ) : null}
      {!pending && latest?.state === PlatformAccessRequestState.DECLINED ? (
        <p className="text-sm text-zinc-400">Request declined. {latest.decisionReason}</p>
      ) : null}
      {!pending && latest?.state === PlatformAccessRequestState.APPROVED ? (
        <p className="text-sm text-zinc-400">
          The previous request was approved. Some access is no longer available. You can request it again.
        </p>
      ) : null}
      {editing && !pending ? (
        <form onSubmit={submit} className="space-y-3 border-t border-zinc-800 pt-3">
          <Controller
            name="actions"
            control={form.control}
            render={({ field }) => (
              <fieldset disabled={blocked} className="space-y-2">
                <legend className="mb-2 text-sm font-medium">Access to request</legend>
                {missing.map((action, index) => (
                  <Field key={action} orientation="horizontal">
                    <Checkbox
                      id={id + index}
                      checked={field.value.includes(action)}
                      onCheckedChange={(checked) =>
                        field.onChange(
                          checked ? [...field.value, action] : field.value.filter((value) => value !== action),
                        )
                      }
                      onBlur={field.onBlur}
                      ref={index === 0 ? field.ref : undefined}
                    />
                    <FieldLabel htmlFor={id + index}>{accessActionName(action)}</FieldLabel>
                  </Field>
                ))}
              </fieldset>
            )}
          />
          <FieldError errors={[form.formState.errors.actions]} />
          <Field data-invalid={Boolean(form.formState.errors.reason)}>
            <FieldLabel htmlFor={id + '-reason'}>Why do you need access?</FieldLabel>
            <Input
              id={id + '-reason'}
              className="text-base md:text-sm"
              maxLength={512}
              disabled={blocked}
              aria-invalid={Boolean(form.formState.errors.reason)}
              aria-describedby={id + '-error'}
              {...form.register('reason')}
            />
            <FieldError id={id + '-error'} errors={[form.formState.errors.reason]} />
          </Field>
          <Button type="submit" size="sm" disabled={blocked}>
            {mutation.busy ? 'Sending…' : 'Send request'}
          </Button>
        </form>
      ) : null}
    </div>
  )
}

export function MemberAccessRequests({
  snapshot,
  humanId,
  disabled,
  onChanged,
}: {
  snapshot: ListPlatformConnectionsResponse
  humanId: string
  disabled: boolean
  onChanged: () => void
}) {
  const mutation = useAccessRequestMutation(`platform-access-request:${humanId}:member`, onChanged)
  return (
    <section aria-label="Request integration access" className="space-y-3">
      {snapshot.requestableScopes.map((scope) => (
        <RequestCard key={key(scope)} scope={scope} snapshot={snapshot} mutation={mutation} disabled={disabled} />
      ))}
      <AccessRequestMutationStatus mutation={mutation} />
    </section>
  )
}
