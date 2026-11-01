'use client'

import { policyReasonSchema } from '@/lib/platform/policies'

import { zodResolver } from '@hookform/resolvers/zod'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  Input,
} from '@proompteng/design/ui'
import { useId, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import type {
  GetPlatformWorkspaceResponse,
  PlatformWorkspaceClient,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
import { PolicyMutationStatus, usePolicyMutation } from './policy-mutation'
const schema = z.object({ reason: policyReasonSchema })
export function WorkspaceClients({
  detail,
  humanId,
  onChanged,
}: {
  detail: GetPlatformWorkspaceResponse
  humanId: string
  onChanged: () => void
}) {
  const [selected, setSelected] = useState<PlatformWorkspaceClient>()
  const id = useId()
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { reason: '' } })
  const mutation = usePolicyMutation(detail.workspace!.id, humanId, 'clients', () => {
    setSelected(undefined)
    onChanged()
  })
  const blocked = !mutation.ready || mutation.busy || Boolean(mutation.pending)
  return (
    <section aria-label="Workspace clients" className="space-y-4">
      <div>
        <h2 className="text-sm font-medium">Clients</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Choose which apps may use this workspace. Resource permissions are assigned separately below.
        </p>
      </div>
      <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
        {detail.clients
          .filter((entry) => entry.client)
          .map((entry) => (
            <li key={entry.client!.id} className="flex items-center justify-between gap-4 p-4">
              <div>
                <p className="text-sm">{entry.client!.displayName || entry.client!.id}</p>
                <p className="mt-1 text-xs text-zinc-400">
                  {entry.enabled ? 'Enabled for this workspace' : 'Not enabled'}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={blocked}
                onClick={() => {
                  form.reset({ reason: '' })
                  setSelected(entry)
                }}
              >
                {entry.enabled ? 'Disable' : 'Enable'}
              </Button>
            </li>
          ))}
      </ul>
      {!selected ? <PolicyMutationStatus mutation={mutation} /> : null}
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open && !mutation.busy) setSelected(undefined)
        }}
      >
        <DialogContent className="tengri-theme font-geist max-h-[calc(100dvh-2rem)] overflow-y-auto border border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {selected?.enabled ? 'Disable' : 'Enable'} {selected?.client?.displayName}
            </DialogTitle>
            <DialogDescription>
              {selected?.enabled
                ? 'Existing calls from this client will be denied in this workspace.'
                : 'This client may use the resource permissions approved for it in this workspace.'}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={form.handleSubmit(async (value) => {
              if (!selected?.client || blocked) return
              await mutation.save({
                operationId: crypto.randomUUID(),
                workspaceId: detail.workspace!.id,
                expectedPolicyVersion: String(detail.policyVersion),
                reason: value.reason,
                relationships: selected.client.identities.map((subjectId) => ({
                  resource: { kind: 'platform.workspace', id: detail.workspace!.id },
                  relation: 'client',
                  subjectKind: 'workload',
                  subjectId,
                  enabled: !selected.enabled,
                })),
              })
            })}
          >
            <Field>
              <FieldLabel htmlFor={`${id}-reason`}>Reason</FieldLabel>
              <Input
                id={`${id}-reason`}
                {...form.register('reason')}
                className="text-base sm:text-sm"
                disabled={blocked}
              />
              <FieldError errors={[form.formState.errors.reason]} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" disabled={blocked} onClick={() => setSelected(undefined)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={blocked}>
                {mutation.busy ? 'Saving…' : selected?.enabled ? 'Disable client' : 'Enable client'}
              </Button>
            </div>
            <PolicyMutationStatus mutation={mutation} />
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}
