'use client'

import { policyReasonSchema } from '@/lib/platform/policies'

import { zodResolver } from '@hookform/resolvers/zod'
import {
  Button,
  Checkbox,
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
import { Controller, useForm } from 'react-hook-form'
import { z } from 'zod'
import { readPlatformResponse } from '@/lib/platform/client'
import { githubLoginSchema } from '@/lib/tengri/access-schemas'
import {
  PlatformWorkspaceRole,
  type GetPlatformWorkspaceResponse,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
import { PolicyMutationStatus, usePolicyMutation } from './policy-mutation'
import { SettingsSelect } from './settings-select'
import { CollectionToolbar, CollectionPagination, useCollection } from './collection-view'
import { portalPath } from '@/lib/platform/portal'

const schema = z
  .object({
    login: z.string(),
    role: z.enum(['member', 'administrator', 'remove']),
    reason: policyReasonSchema,
    confirmed: z.boolean(),
  })
  .refine((value) => value.role !== 'remove' || value.confirmed, {
    path: ['confirmed'],
    message: 'Confirm removal before continuing',
  })
type Form = z.infer<typeof schema>
type Person = { id: string; name: string }
export function WorkspacePeople({
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
  const [person, setPerson] = useState<Person>()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<Error>()
  const [resolving, setResolving] = useState(false)
  const form = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: { login: '', role: 'member', reason: '', confirmed: false },
  })
  const mutation = usePolicyMutation(workspace.id, humanId, 'people', () => {
    setOpen(false)
    collection.change({ person: '' })
    onChanged()
  })
  const collection = useCollection(
    detail.members,
    (member) => member.displayName || `GitHub ${member.githubId}`,
    (member, filter) =>
      filter === 'all' ||
      (filter === 'active'
        ? member.admitted
        : filter === 'inactive'
          ? !member.admitted
          : filter === 'administrator'
            ? member.role === PlatformWorkspaceRole.ADMINISTRATOR
            : member.role === PlatformWorkspaceRole.MEMBER),
  )
  const selectedId = collection.query.get('person')
  const lastAdmin =
    detail.members.filter((member) => member.admitted && member.role === PlatformWorkspaceRole.ADMINISTRATOR).length ===
      1 &&
    detail.members.some(
      (member) =>
        member.humanId === person?.id && member.admitted && member.role === PlatformWorkspaceRole.ADMINISTRATOR,
    )
  useEffect(() => {
    if (!selectedId) {
      setOpen(false)
      return
    }
    const member = detail.members.find((member) => member.humanId === selectedId)
    if (member) {
      setPerson({ id: member.humanId, name: member.displayName || `GitHub ${member.githubId}` })
      form.reset({
        login: '',
        role: member.role === PlatformWorkspaceRole.ADMINISTRATOR ? 'administrator' : 'member',
        reason: '',
        confirmed: false,
      })
      setOpen(true)
    }
  }, [selectedId, detail.members, form])
  const blocked = !mutation.ready || mutation.busy || Boolean(mutation.pending) || resolving
  const edit = (next?: Person, role: Form['role'] = 'member') => {
    setPerson(next)
    setError(undefined)
    form.reset({ login: '', role, reason: '', confirmed: false })
    collection.change({ person: next?.id || '' })
    setOpen(true)
  }
  const submit = form.handleSubmit(async (value) => {
    if (blocked || (lastAdmin && value.role !== 'administrator')) return
    setError(undefined)
    let recipient = person
    if (!recipient) {
      const login = githubLoginSchema.safeParse(value.login)
      if (!login.success) {
        form.setError('login', { message: 'Enter a GitHub username' })
        return
      }
      setResolving(true)
      try {
        const resolved = z.object({ humanId: z.string(), name: z.string() }).parse(
          await fetch(`/api/platform/workspaces/${workspace.id}/people`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ login: login.data }),
          }).then(readPlatformResponse),
        )
        recipient = { id: resolved.humanId, name: resolved.name }
        setPerson(recipient)
      } catch (cause) {
        setError(cause instanceof Error ? cause : new Error('This person could not be found.'))
        return
      } finally {
        setResolving(false)
      }
    }
    await mutation.save({
      operationId: crypto.randomUUID(),
      workspaceId: workspace.id,
      expectedPolicyVersion: String(detail.policyVersion),
      reason: value.reason,
      relationships: ['member', 'administrator'].map((relation) => ({
        resource: { kind: 'platform.workspace', id: workspace.id },
        relation,
        subjectKind: 'human',
        subjectId: recipient.id,
        enabled: value.role === relation,
      })),
    })
  })
  return (
    <section className="space-y-5" aria-label="Workspace people">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium">People</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Members use approved connections. Administrators also manage workspace access.
          </p>
        </div>
        <Button size="sm" disabled={blocked} onClick={() => edit()}>
          Add person
        </Button>
      </div>
      <CollectionToolbar
        label="people"
        state={collection}
        filters={[
          { value: 'active', label: 'Active members' },
          { value: 'administrator', label: 'Administrators' },
          { value: 'member', label: 'Members' },
          { value: 'inactive', label: 'Platform access removed' },
        ]}
      />
      <div className="rounded-lg border border-zinc-800">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Person</TableHead>
              <TableHead>Access</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {collection.rows.map((member) => (
              <TableRow key={member.humanId}>
                <TableCell>
                  <p>
                    {member.displayName || `GitHub ${member.githubId}`}
                    {member.humanId === humanId ? <span className="ml-2 text-xs text-zinc-400">You</span> : null}
                  </p>
                  <p className="mt-1 text-xs text-zinc-400">GitHub ID {member.githubId}</p>
                </TableCell>
                <TableCell>
                  {!member.admitted
                    ? 'Platform access removed'
                    : member.role === PlatformWorkspaceRole.ADMINISTRATOR
                      ? 'Administrator'
                      : 'Member'}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={blocked}
                    aria-label={`Manage ${member.displayName || 'GitHub ' + member.githubId}`}
                    onClick={() =>
                      edit(
                        { id: member.humanId, name: member.displayName || `GitHub ${member.githubId}` },
                        member.role === PlatformWorkspaceRole.ADMINISTRATOR ? 'administrator' : 'member',
                      )
                    }
                  >
                    Manage
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!collection.rows.length ? (
              <TableRow>
                <TableCell colSpan={3} className="py-10 text-center text-zinc-400">
                  No people match these filters. Clear the search or add an admitted person.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
      <CollectionPagination state={collection} />
      {selectedId && !detail.members.some((member) => member.humanId === selectedId) ? (
        <p role="alert">
          This person is not a member of this workspace.{' '}
          <button className="underline" onClick={() => collection.change({ person: '' })}>
            Back to people
          </button>
        </p>
      ) : null}
      {!open ? <PolicyMutationStatus mutation={mutation} /> : null}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!mutation.busy) {
            setOpen(next)
            if (!next) collection.change({ person: '' })
          }
        }}
      >
        <DialogContent className="tengri-theme font-geist max-h-[calc(100dvh-2rem)] overflow-y-auto border border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{person ? person.name : 'Add person'}</DialogTitle>
            <DialogDescription>
              Change access to {workspace.name}. New members must already have platform access.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            {!person ? (
              <Field>
                <FieldLabel htmlFor={`${id}-login`}>GitHub username</FieldLabel>
                <Input
                  id={`${id}-login`}
                  {...form.register('login')}
                  autoComplete="off"
                  className="text-base sm:text-sm"
                  disabled={blocked}
                />
                <FieldError errors={[form.formState.errors.login]} />
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`${id}-role`}>Workspace role</FieldLabel>
              <Controller
                name="role"
                control={form.control}
                render={({ field }) => (
                  <SettingsSelect
                    {...field}
                    id={`${id}-role`}
                    onValueChange={field.onChange}
                    disabled={blocked}
                    options={
                      lastAdmin
                        ? [{ value: 'administrator', label: 'Administrator' }]
                        : [
                            { value: 'member', label: 'Member' },
                            { value: 'administrator', label: 'Administrator' },
                            ...(person ? [{ value: 'remove', label: 'Remove from workspace' }] : []),
                          ]
                    }
                  />
                )}
              />
            </Field>
            {lastAdmin ? (
              <p className="text-sm text-amber-200">
                Add another active administrator before demoting or removing this person.
              </p>
            ) : null}
            {person ? (
              <a
                className="block text-sm underline underline-offset-4"
                href={portalPath(workspace.id, 'resources', { recipient: person.id })}
              >
                Inspect resource grants
              </a>
            ) : null}
            {form.watch('role') === 'remove' ? (
              <Field>
                <label className="flex items-start gap-3 text-sm">
                  <Controller
                    name="confirmed"
                    control={form.control}
                    render={({ field }) => (
                      <Checkbox checked={field.value} onCheckedChange={field.onChange} disabled={blocked} />
                    )}
                  />
                  Remove this person’s workspace membership. Their workspace access will stop, including existing
                  connections. This does not delete their platform identity.
                </label>
                <FieldError errors={[form.formState.errors.confirmed]} />
              </Field>
            ) : null}
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
            {error ? (
              <p role="alert" className="text-sm text-red-300">
                {error.message}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={blocked}
                onClick={() => {
                  setOpen(false)
                  collection.change({ person: '' })
                }}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={blocked}>
                {mutation.busy || resolving ? 'Saving…' : 'Save access'}
              </Button>
            </div>
            <PolicyMutationStatus mutation={mutation} />
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}
