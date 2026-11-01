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

const schema = z.object({
  login: z.string(),
  role: z.enum(['member', 'administrator', 'remove']),
  reason: policyReasonSchema,
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
    defaultValues: { login: '', role: 'member', reason: '' },
  })
  const mutation = usePolicyMutation(workspace.id, humanId, 'people', () => {
    setOpen(false)
    onChanged()
  })
  const blocked = !mutation.ready || mutation.busy || Boolean(mutation.pending) || resolving
  const edit = (next?: Person, role: Form['role'] = 'member') => {
    setPerson(next)
    setError(undefined)
    form.reset({ login: '', role, reason: '' })
    setOpen(true)
  }
  const submit = form.handleSubmit(async (value) => {
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
      <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
        {detail.members.map((member) => (
          <li key={member.humanId} className="flex items-center justify-between gap-4 p-4">
            <div className="min-w-0">
              <p className="truncate text-sm">
                {member.displayName || `GitHub ${member.githubId}`}
                {member.humanId === humanId ? <span className="ml-2 text-xs text-zinc-400">You</span> : null}
              </p>
              <p className="mt-1 text-xs text-zinc-400">
                {!member.admitted
                  ? 'Platform access removed'
                  : member.role === PlatformWorkspaceRole.ADMINISTRATOR
                    ? 'Administrator'
                    : 'Member'}
              </p>
            </div>
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
          </li>
        ))}
      </ul>
      {!open ? <PolicyMutationStatus mutation={mutation} /> : null}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!mutation.busy) setOpen(next)
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
                    options={[
                      { value: 'member', label: 'Member' },
                      { value: 'administrator', label: 'Administrator' },
                      ...(person ? [{ value: 'remove', label: 'Remove from workspace' }] : []),
                    ]}
                  />
                )}
              />
            </Field>
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
              <Button type="button" variant="ghost" size="sm" disabled={blocked} onClick={() => setOpen(false)}>
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
