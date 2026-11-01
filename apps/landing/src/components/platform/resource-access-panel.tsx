'use client'

import { policyReasonSchema } from '@/lib/platform/policies'

import { fromJson } from '@bufbuild/protobuf'
import { zodResolver } from '@hookform/resolvers/zod'
import { Button, Checkbox, Field, FieldError, FieldLabel, Input } from '@proompteng/design/ui'
import { useEffect, useId, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { z } from 'zod'
import { policyCatalogSchema } from '@/lib/platform/catalog'
import { readPlatformResponse } from '@/lib/platform/client'
import {
  GetPlatformConfigurationResponseSchema,
  ReadPolicyRelationshipsResponseSchema,
  type GetPlatformWorkspaceResponse,
  type ReadPolicyRelationshipsResponse,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
import { PolicyMutationStatus, usePolicyMutation } from './policy-mutation'
import { SettingsSelect } from './settings-select'

const schema = z.object({
  recipient: z.string().min(1, 'Choose who needs access'),
  resource: z.string().min(1, 'Choose a resource'),
  relations: z.record(z.string(), z.boolean()),
  reason: policyReasonSchema,
})
type Form = z.infer<typeof schema>
type Recipient = { key: string; name: string; kind: 'human' | 'workload' | 'workspace'; ids: string[] }
const permissionNames: Record<string, string> = {
  status_reader: 'Pod status',
  log_reader: 'Pod logs',
  event_reader: 'Namespace events',
  status_workspace: 'Pod status',
  log_workspace: 'Pod logs',
  event_workspace: 'Namespace events',
}
export function ResourceAccessPanel({
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
  const form = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: {
      recipient: 'workspace',
      resource: workspace.resources.length === 1 ? '0' : '',
      relations: {},
      reason: '',
    },
  })
  const recipientKey = form.watch('recipient')
  const resourceKey = form.watch('resource')
  const [catalog, setCatalog] = useState<z.infer<typeof policyCatalogSchema>>()
  const [snapshot, setSnapshot] = useState<{ key: string; values: ReadPolicyRelationshipsResponse[] }>()
  const [error, setError] = useState<Error>()
  const [refresh, setRefresh] = useState(0)
  const mutation = usePolicyMutation(workspace.id, humanId, 'resources', onChanged)
  const recipients: Recipient[] = [
    { key: 'workspace', name: 'All workspace members', kind: 'workspace', ids: [workspace.id] },
    ...detail.members
      .filter((person) => person.admitted)
      .map((person) => ({
        key: person.humanId,
        name: person.displayName || `GitHub ${person.githubId}`,
        kind: 'human' as const,
        ids: [person.humanId],
      })),
    ...detail.clients
      .filter((entry) => entry.enabled && entry.client)
      .map((entry) => ({
        key: entry.client!.id,
        name: entry.client!.displayName || entry.client!.id,
        kind: 'workload' as const,
        ids: entry.client!.identities,
      })),
  ]
  const recipient = recipients.find((entry) => entry.key === recipientKey)
  const target = resourceKey === '' ? undefined : workspace.resources[Number(resourceKey)]
  const key = JSON.stringify([recipientKey, resourceKey])
  const saved = snapshot?.key === key ? snapshot.values : undefined
  const relations =
    catalog?.resources
      .find((resource) => resource.kind === target?.resource?.kind)
      ?.relations.filter((relation) => recipient && relation.subjects.includes(recipient.kind)) ?? []
  const selected = form.watch('relations')
  const changed =
    saved &&
    relations.some(
      (relation) =>
        selected[relation.name] !== undefined &&
        saved.some((value) => value.relations.includes(relation.name) !== selected[relation.name]),
    )
  const blocked = !mutation.ready || mutation.busy || Boolean(mutation.pending)
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/platform/policies', { signal: controller.signal, cache: 'no-store' })
      .then(readPlatformResponse)
      .then((json) => {
        if (!controller.signal.aborted)
          setCatalog(
            policyCatalogSchema.parse(
              JSON.parse(fromJson(GetPlatformConfigurationResponseSchema, json).policyCatalogJson),
            ),
          )
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause : new Error('Policy metadata could not be loaded.'))
      })
    return () => controller.abort()
  }, [refresh])
  useEffect(() => {
    setSnapshot(undefined)
    setError(undefined)
    if (!recipient || !target?.resource) return
    const controller = new AbortController()
    void Promise.all(
      recipient.ids.map((subjectId) =>
        fetch(
          '/api/platform/policies?' +
            new URLSearchParams({
              workspaceId: workspace.id,
              kind: target.resource!.kind,
              id: target.resource!.id,
              subjectKind: recipient.kind,
              subjectId,
            }),
          { signal: controller.signal, cache: 'no-store' },
        )
          .then(readPlatformResponse)
          .then((json) => fromJson(ReadPolicyRelationshipsResponseSchema, json)),
      ),
    )
      .then((values) => {
        if (controller.signal.aborted) return
        if (values.some((value) => value.policyVersion !== values[0]?.policyVersion))
          throw new Error('Access changed while loading. Refresh to try again.')
        setSnapshot({ key, values })
        form.setValue('relations', {})
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause : new Error('Current access could not be loaded.'))
      })
    return () => controller.abort()
  }, [recipientKey, resourceKey, workspace.id, refresh, detail.policyVersion])
  const submit = form.handleSubmit(async (value) => {
    if (!recipient || !target?.resource || !saved || !changed || blocked) return
    const relationships = recipient.ids.flatMap((subjectId, index) =>
      relations
        .filter(
          (relation) =>
            value.relations[relation.name] !== undefined &&
            saved[index]?.relations.includes(relation.name) !== value.relations[relation.name],
        )
        .map((relation) => ({
          resource: { kind: target.resource!.kind, id: target.resource!.id },
          relation: relation.name,
          subjectKind: recipient.kind,
          subjectId,
          enabled: value.relations[relation.name]!,
        })),
    )
    await mutation.save({
      operationId: crypto.randomUUID(),
      workspaceId: workspace.id,
      expectedPolicyVersion: String(saved[0]!.policyVersion),
      relationships,
      reason: value.reason,
    })
  })
  return (
    <section aria-label="Resource access" className="space-y-5">
      <div>
        <h2 className="text-sm font-medium">Resource access</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Approve what members and clients can use through Relay. Connecting never adds permissions.
        </p>
      </div>
      <form onSubmit={submit} className="space-y-4">
        <fieldset disabled={blocked} className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-recipient`}>Who can use it</FieldLabel>
            <Controller
              control={form.control}
              name="recipient"
              render={({ field }) => (
                <SettingsSelect
                  {...field}
                  onValueChange={field.onChange}
                  id={`${id}-recipient`}
                  options={recipients.map((entry) => ({ value: entry.key, label: entry.name }))}
                />
              )}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-resource`}>Resource</FieldLabel>
            <Controller
              control={form.control}
              name="resource"
              render={({ field }) => (
                <SettingsSelect
                  {...field}
                  onValueChange={field.onChange}
                  id={`${id}-resource`}
                  placeholder="Choose a resource"
                  options={workspace.resources.map((entry, index) => ({ value: String(index), label: entry.name }))}
                />
              )}
            />
            <FieldError errors={[form.formState.errors.resource]} />
          </Field>
        </fieldset>
        {target ? (
          <fieldset disabled={blocked || !saved} className="space-y-3 rounded-lg border border-zinc-800 p-4">
            <legend className="px-1 text-xs text-zinc-400">Allowed operations</legend>
            {relations.map((relation) => (
              <label key={relation.name} className="flex min-h-9 items-center gap-3 text-sm">
                <Checkbox
                  checked={
                    selected[relation.name] ?? Boolean(saved?.every((value) => value.relations.includes(relation.name)))
                  }
                  indeterminate={
                    selected[relation.name] === undefined &&
                    Boolean(saved?.some((value) => value.relations.includes(relation.name))) &&
                    !saved?.every((value) => value.relations.includes(relation.name))
                  }
                  onCheckedChange={(checked) =>
                    form.setValue(
                      'relations',
                      { ...selected, [relation.name]: checked === true },
                      { shouldDirty: true },
                    )
                  }
                />
                {permissionNames[relation.name] || relation.name.replaceAll('_', ' ')}
              </label>
            ))}
            {!saved && !error ? (
              <p role="status" className="text-sm text-zinc-400">
                Loading current access…
              </p>
            ) : null}
            {saved && !relations.length ? (
              <p className="text-sm text-zinc-400">
                This resource has no editable permissions for the selected recipient.
              </p>
            ) : null}
          </fieldset>
        ) : null}
        <Field>
          <FieldLabel htmlFor={`${id}-reason`}>Reason for this change</FieldLabel>
          <Input
            id={`${id}-reason`}
            {...form.register('reason')}
            disabled={blocked}
            placeholder="Why is this access needed?"
            className="text-base sm:text-sm"
          />
          <FieldError errors={[form.formState.errors.reason]} />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-red-300">
            {error.message}{' '}
            <Button type="button" size="sm" variant="ghost" onClick={() => setRefresh((value) => value + 1)}>
              Retry
            </Button>
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={blocked || !changed || !saved}>
            {mutation.busy ? 'Saving…' : 'Save access'}
          </Button>
          <p className="text-xs text-zinc-400">Changes apply to this workspace.</p>
        </div>
        <PolicyMutationStatus mutation={mutation} />
      </form>
    </section>
  )
}
