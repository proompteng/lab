'use client'

import { policyReasonSchema } from '@/lib/platform/policies'

import { zodResolver } from '@hookform/resolvers/zod'
import {
  Button,
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
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
import { useEffect, useId, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import type {
  GetPlatformWorkspaceResponse,
  PlatformWorkspaceClient,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
import { PolicyMutationStatus, usePolicyMutation } from './policy-mutation'
import { CollectionToolbar, CollectionPagination, useCollection } from './collection-view'
import { portalPath } from '@/lib/platform/portal'
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
    collection.change({ client: '' })
    onChanged()
  })
  const collection = useCollection(
    detail.clients.filter((entry) => entry.client),
    (entry) => entry.client!.displayName || entry.client!.id,
    (entry, filter) => filter === 'all' || (filter === 'enabled' ? entry.enabled : !entry.enabled),
  )
  const clientId = collection.query.get('client')
  useEffect(() => {
    setSelected(detail.clients.find((entry) => entry.client?.id === clientId))
    form.reset({ reason: '' })
  }, [clientId, detail.clients, form])
  const blocked = !mutation.ready || mutation.busy || Boolean(mutation.pending)
  return (
    <section aria-label="Workspace clients" className="space-y-4">
      <div>
        <h2 className="text-sm font-medium">Clients</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Choose which apps may use this workspace. Resource permissions are assigned separately in Resource access.
        </p>
      </div>
      <CollectionToolbar
        label="clients"
        state={collection}
        filters={[
          { value: 'enabled', label: 'Enrolled' },
          { value: 'disabled', label: 'Not enrolled' },
        ]}
      />
      <div className="rounded-lg border border-zinc-800">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Application</TableHead>
              <TableHead>Enrollment</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {collection.rows.map((entry) => (
              <TableRow key={entry.client!.id}>
                <TableCell>{entry.client!.displayName || entry.client!.id}</TableCell>
                <TableCell>{entry.enabled ? 'Enabled for this workspace' : 'Not enabled'}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={blocked}
                    aria-label={`Manage ${entry.client!.displayName}`}
                    onClick={() => collection.change({ client: entry.client!.id })}
                  >
                    Manage
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!collection.rows.length ? (
              <TableRow>
                <TableCell colSpan={3} className="py-10 text-center text-zinc-400">
                  No registered clients match these filters.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
      <CollectionPagination state={collection} />
      {clientId && !selected ? (
        <p role="alert">
          This client is not registered.{' '}
          <button className="underline" onClick={() => collection.change({ client: '' })}>
            Back to integrations
          </button>
        </p>
      ) : null}
      {!selected ? <PolicyMutationStatus mutation={mutation} /> : null}
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open && !mutation.busy) {
            setSelected(undefined)
            collection.change({ client: '' })
          }
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
          <dl className="space-y-2 text-sm">
            <dt className="text-zinc-400">Registered workload identities</dt>
            {selected?.client?.identities.map((identity) => (
              <dd key={identity} className="break-all font-mono text-xs">
                {identity}
              </dd>
            ))}
          </dl>
          <p className="text-sm text-zinc-400">
            Enrollment is not a health check or a permission grant. Client identity and destinations are reviewed
            platform configuration; they cannot be rotated here.
          </p>
          {selected?.enabled ? (
            <a
              className="text-sm underline underline-offset-4"
              href={portalPath(detail.workspace!.id, 'resources', { recipient: selected.client!.id })}
            >
              Inspect resource grants
            </a>
          ) : null}
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
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={blocked}
                onClick={() => {
                  setSelected(undefined)
                  collection.change({ client: '' })
                }}
              >
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
