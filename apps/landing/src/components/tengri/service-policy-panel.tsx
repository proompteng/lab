'use client'

import { fromJson } from '@bufbuild/protobuf'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Badge,
  Button,
  Checkbox,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  Skeleton,
} from '@proompteng/design/ui'
import { ChevronLeft, Server, Users } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { z } from 'zod'
import { connectorCatalogSchema, policyCatalogSchema, type ConnectorCatalog } from '@/lib/platform/catalog'
import type { PolicyWrite } from '@/lib/platform/policies'
import { PasskeyRequiredError, startTengriSignIn } from '@/lib/tengri/auth-client'
import { ListAccessResponseSchema, type AccessEntry } from '@/lib/tengri/generated/proompteng/authz/v1/authz_pb'
import {
  GetPlatformConfigurationResponseSchema,
  ReadPolicyRelationshipsResponseSchema,
  WritePolicyRelationshipsResponseSchema,
  type GetPlatformConfigurationResponse,
  type ReadPolicyRelationshipsResponse,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
import { SettingsSelect } from './settings-select'

const formSchema = z.object({
  resource: z.string().min(1, 'Choose a resource'),
  relations: z.array(z.string()).max(128),
  reason: z.string().min(3, 'Explain the reason for this change').max(512),
})
type Form = z.infer<typeof formSchema>
type Recipient = { kind: 'workload' | 'human'; id: string; name: string }
const labels: Record<string, string> = {
  opencode: 'OpenCode',
  'kubernetes.namespace': 'Kubernetes namespace',
  status_reader: 'Pod status',
  log_reader: 'Pod logs',
  event_reader: 'Namespace events',
}
const label = (value: string) =>
  labels[value] ?? value.replace(/[._-]/g, ' ').replace(/^./, (letter) => letter.toUpperCase())
const resourceKey = (resource: { kind: string; id: string }) => JSON.stringify([resource.kind, resource.id])
class PolicyRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
async function read(response: Response) {
  const json = z.json().parse(await response.json())
  if (!response.ok) {
    if (response.status === 428) throw new PasskeyRequiredError()
    const error = z.object({ error: z.string() }).safeParse(json)
    throw new PolicyRequestError(response.status, error.success ? error.data.error : 'Service access is unavailable')
  }
  return json
}

export function ServicePolicyPanel({ active }: { active: boolean }) {
  const [configuration, setConfiguration] = useState<GetPlatformConfigurationResponse>()
  const [catalog, setCatalog] = useState<ConnectorCatalog>()
  const [people, setPeople] = useState<AccessEntry[]>([])
  const [peopleCursor, setPeopleCursor] = useState('')
  const [recipient, setRecipient] = useState<Recipient>()
  const [snapshot, setSnapshot] = useState<{ key: string; refresh: number; value: ReadPolicyRelationshipsResponse }>()
  const [error, setError] = useState<Error>()
  const [receipt, setReceipt] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PolicyWrite>()
  const [refresh, setRefresh] = useState(0)
  const heading = useRef<HTMLHeadingElement>(null)
  const returnButton = useRef<HTMLButtonElement>(null)
  const formId = useId()
  const form = useForm<Form>({
    resolver: zodResolver(formSchema),
    defaultValues: { resource: '', relations: [], reason: '' },
  })
  const selectedResource = form.watch('resource')
  const selectedRelations = form.watch('relations')
  const reset = form.reset
  const setValue = form.setValue
  const policy = configuration ? policyCatalogSchema.parse(JSON.parse(configuration.policyCatalogJson)) : undefined
  const targets = [
    ...new Map(
      (catalog?.operations.flatMap((operation) => operation.targets) ?? [])
        .filter((target) =>
          policy?.resources.some((entry) => entry.kind === target.resource.kind && entry.relations.length),
        )
        .map((target) => [resourceKey(target.resource), target]),
    ).values(),
  ]
  const target = targets.find((entry) => resourceKey(entry.resource) === selectedResource)
  const relations =
    policy?.resources
      .find((entry) => entry.kind === target?.resource.kind)
      ?.relations.filter((entry) => recipient && entry.subjects.includes(recipient.kind)) ?? []
  const selectionKey = recipient && target ? JSON.stringify([recipient.kind, recipient.id, target.resource]) : ''
  const saved = snapshot?.key === selectionKey ? snapshot.value : undefined
  const changed = saved
    ? relations.filter((entry) => saved.relations.includes(entry.name) !== selectedRelations.includes(entry.name))
    : []
  const blocked = busy || Boolean(pending)
  const load = useCallback(async (signal?: AbortSignal) => {
    const [config, connectors, roster] = await Promise.all([
      fetch('/api/platform/policies', { cache: 'no-store', signal }).then(read),
      fetch('/api/platform/connectors', { cache: 'no-store', signal }).then(read),
      fetch('/api/tengri/access?view=platform', { cache: 'no-store', signal }).then(read),
    ])
    if (signal?.aborted) return
    const next = fromJson(GetPlatformConfigurationResponseSchema, config)
    policyCatalogSchema.parse(JSON.parse(next.policyCatalogJson))
    setConfiguration(next)
    setCatalog(connectorCatalogSchema.parse(connectors))
    const page = fromJson(ListAccessResponseSchema, roster)
    setPeople([...new Map(page.entries.map((entry) => [entry.subjectId, entry])).values()])
    setPeopleCursor(page.cursor)
  }, [])
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void load(controller.signal).catch((cause) => {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause : new Error('Service access is unavailable'))
    })
    return () => controller.abort()
  }, [active, load])
  useEffect(() => {
    if (!active || !recipient || !target || (snapshot?.key === selectionKey && snapshot.refresh === refresh)) return
    const controller = new AbortController()
    setSnapshot(undefined)
    setError(undefined)
    const query = new URLSearchParams({
      kind: target.resource.kind,
      id: target.resource.id,
      subjectKind: recipient.kind,
      subjectId: recipient.id,
    })
    void fetch('/api/platform/policies?' + query, { cache: 'no-store', signal: controller.signal })
      .then(read)
      .then((json) => {
        if (controller.signal.aborted) return
        const value = fromJson(ReadPolicyRelationshipsResponseSchema, json)
        setSnapshot({ key: selectionKey, refresh, value })
        setValue('relations', value.relations)
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause : new Error('Saved access could not be loaded'))
      })
    return () => controller.abort()
  }, [active, recipient, selectedResource, refresh, selectionKey, setValue, target?.resource.kind, target?.resource.id])
  useEffect(() => {
    if (recipient) heading.current?.focus()
  }, [recipient])
  const open = (next: Recipient) => {
    reset({ resource: '', relations: [], reason: '' })
    setSnapshot(undefined)
    setError(undefined)
    setReceipt('')
    setRecipient(next)
  }
  const morePeople = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const json = await fetch(
        '/api/tengri/access?' + new URLSearchParams({ view: 'platform', cursor: peopleCursor }),
        { cache: 'no-store' },
      ).then(read)
      const page = fromJson(ListAccessResponseSchema, json)
      setPeople((previous) => [
        ...new Map([...previous, ...page.entries].map((entry) => [entry.subjectId, entry])).values(),
      ])
      setPeopleCursor(page.cursor)
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('More people could not be loaded'))
    } finally {
      setBusy(false)
    }
  }
  const execute = async (request: PolicyWrite) => {
    setPending(request)
    setBusy(true)
    setError(undefined)
    try {
      const response = await fetch('/api/platform/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      const decision = fromJson(WritePolicyRelationshipsResponseSchema, await read(response)).decision
      if (!decision?.allowed || !decision.auditReceiptId)
        throw new Error('The policy receipt could not be confirmed. Retry the same change.')
      setReceipt('Operation ' + request.operationId + ' · audit ' + decision.auditReceiptId)
      setPending(undefined)
      setValue('reason', '')
      setRefresh((value) => value + 1)
    } catch (cause) {
      if (cause instanceof PasskeyRequiredError || (cause instanceof PolicyRequestError && cause.status < 500))
        setPending(undefined)
      setError(cause instanceof Error ? cause : new Error('The policy change could not be confirmed.'))
    } finally {
      setBusy(false)
    }
  }
  const submit = form.handleSubmit(async (value) => {
    if (!recipient || !target || !saved || pending || !changed.length) return
    await execute({
      operationId: crypto.randomUUID(),
      expectedPolicyVersion: String(saved.policyVersion),
      relationships: changed.map((relation) => ({
        resource: target.resource,
        relation: relation.name,
        subjectKind: recipient.kind,
        subjectId: recipient.id,
        enabled: value.relations.includes(relation.name),
      })),
      reason: value.reason,
    })
  })
  const needsVerification = error instanceof PasskeyRequiredError
  return (
    <section aria-label="Service access" className="@container/policies space-y-4">
      {recipient ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={blocked}
          onClick={() => {
            setRecipient(undefined)
            setError(undefined)
            returnButton.current?.focus()
          }}
        >
          <ChevronLeft aria-hidden="true" className="size-3.5" />
          All services & people
        </Button>
      ) : null}
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 ref={heading} tabIndex={-1} className="text-sm font-medium outline-none">
            {recipient ? recipient.name : 'Service access'}
          </h2>
          <FieldDescription>
            {recipient
              ? 'Choose a resource, then edit its saved permissions.'
              : 'Manage what registered services and people can do through Relay.'}
          </FieldDescription>
        </div>
        <Button
          ref={returnButton}
          type="button"
          size="sm"
          variant="ghost"
          disabled={blocked}
          onClick={() => {
            setError(undefined)
            if (recipient) setRefresh((value) => value + 1)
            else
              void load().catch((cause) =>
                setError(cause instanceof Error ? cause : new Error('Access could not be refreshed')),
              )
          }}
        >
          Refresh
        </Button>
      </div>
      {error ? (
        <p role="alert" className="rounded-md border border-red-900/60 bg-red-950/20 p-3 text-xs text-red-200">
          {error.message}
        </p>
      ) : null}
      {pending ? (
        <div className="space-y-2 rounded-md border border-amber-800/60 p-3 text-xs">
          <p>The last result is unconfirmed. Retry the same change before editing access.</p>
          <Button type="button" size="sm" disabled={busy} onClick={() => void execute(pending)}>
            Retry exact change
          </Button>
        </div>
      ) : null}
      {receipt ? (
        <div role="status" className="space-y-1 text-xs text-zinc-400">
          <p className="text-zinc-200">Access updated.</p>
          <details>
            <summary className="cursor-pointer">View receipt</summary>
            <p className="mt-1 break-all">{receipt}</p>
          </details>
        </div>
      ) : null}
      {!configuration ? (
        <div role="status" aria-label="Loading service access">
          <Skeleton className="h-20 bg-zinc-700/40" />
        </div>
      ) : !recipient ? (
        <div className="space-y-5">
          <ItemGroup className="gap-0 overflow-hidden rounded-lg border border-zinc-700/70 bg-zinc-900/30">
            {configuration.relayClients.flatMap((client) =>
              client.identities.map((identity) => (
                <Item
                  role="listitem"
                  key={identity}
                  size="sm"
                  className="rounded-none border-0 border-b border-zinc-700/60 px-3 py-3 last:border-b-0"
                >
                  <ItemMedia>
                    <Server aria-hidden="true" className="size-4 text-zinc-400" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{label(client.id)}</ItemTitle>
                    <ItemDescription>
                      {client.identities.length > 1
                        ? identity.replace(/^spiffe:\/\/[^/]+\/ns\//, '').replace('/sa/', ' / ')
                        : 'Registered Relay client'}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={'Manage ' + label(client.id)}
                      onClick={() => open({ kind: 'workload', id: identity, name: label(client.id) })}
                    >
                      Manage
                    </Button>
                  </ItemActions>
                </Item>
              )),
            )}
            {!configuration.relayClients.length ? (
              <p role="listitem" className="p-4 text-xs text-zinc-400">
                No Relay clients have been registered.
              </p>
            ) : null}
          </ItemGroup>
          <details className="group rounded-lg border border-zinc-700/70">
            <summary className="cursor-pointer px-3 py-3 text-xs font-medium">People’s resource permissions</summary>
            <div className="space-y-2 border-t border-zinc-700/60 p-3">
              <p className="text-xs leading-5 text-zinc-400">
                Resource permissions are separate from workspace roles. Choose a platform member to manage their
                connector access.
              </p>
              {people.map((person) => (
                <Button
                  key={person.subjectId}
                  size="sm"
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() =>
                    open({
                      kind: 'human',
                      id: person.subjectId,
                      name: person.displayName || 'GitHub #' + person.githubId,
                    })
                  }
                >
                  <Users aria-hidden="true" className="size-3.5" />
                  {person.displayName || 'GitHub #' + person.githubId}
                </Button>
              ))}
              {peopleCursor ? (
                <Button type="button" size="sm" variant="outline" disabled={blocked} onClick={() => void morePeople()}>
                  {busy ? 'Loading…' : 'More people'}
                </Button>
              ) : null}
            </div>
          </details>
        </div>
      ) : (
        <form noValidate onSubmit={submit} className="space-y-4">
          <FieldSet disabled={blocked}>
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor={formId + '-resource'}>Resource</FieldLabel>
                <Controller
                  name="resource"
                  control={form.control}
                  render={({ field }) => (
                    <SettingsSelect
                      {...field}
                      id={formId + '-resource'}
                      disabled={blocked}
                      placeholder="Choose a resource"
                      options={targets.map((entry) => ({
                        value: resourceKey(entry.resource),
                        label: entry.name + ' · ' + entry.resource.id.split('/')[0],
                      }))}
                      onValueChange={(value) => {
                        field.onChange(value)
                        setSnapshot(undefined)
                        setValue('relations', [])
                        setValue('reason', '')
                      }}
                    />
                  )}
                />
                <FieldError errors={[form.formState.errors.resource]} />
              </Field>
              {target ? (
                <FieldSet className="gap-0 overflow-hidden rounded-lg border border-zinc-700/70">
                  <FieldLegend
                    variant="label"
                    className="m-0 flex w-full items-center justify-between border-b border-zinc-700/60 bg-zinc-800/40 px-3 py-2"
                  >
                    {label(target.resource.kind)}
                    {saved ? <Badge variant="secondary">{saved.relations.length} allowed</Badge> : null}
                  </FieldLegend>
                  {!saved ? (
                    <p role="status" className="p-3 text-xs text-zinc-400">
                      {error ? 'Saved permissions are unavailable. Refresh to retry.' : 'Loading saved permissions…'}
                    </p>
                  ) : (
                    relations.map((relation) => (
                      <Field
                        key={relation.name}
                        orientation="horizontal"
                        className="gap-3 border-b border-zinc-700/50 px-3 py-3 last:border-b-0"
                      >
                        <Controller
                          name="relations"
                          control={form.control}
                          render={({ field }) => (
                            <Checkbox
                              id={formId + '-' + relation.name}
                              name={field.name}
                              checked={field.value.includes(relation.name)}
                              disabled={blocked}
                              onBlur={field.onBlur}
                              onCheckedChange={(checked) =>
                                field.onChange(
                                  checked
                                    ? [...field.value, relation.name]
                                    : field.value.filter((name) => name !== relation.name),
                                )
                              }
                            />
                          )}
                        />
                        <FieldLabel htmlFor={formId + '-' + relation.name} className="flex-1">
                          {label(relation.name)}
                        </FieldLabel>
                        <span className="text-[11px] text-zinc-400">
                          {selectedRelations.includes(relation.name) ? 'Allowed' : 'No access'}
                        </span>
                      </Field>
                    ))
                  )}
                  {saved && !relations.length ? (
                    <p className="p-3 text-xs text-zinc-400">No editable permissions for this recipient.</p>
                  ) : null}
                </FieldSet>
              ) : (
                <p className="rounded-lg border border-dashed border-zinc-700 p-4 text-xs leading-5 text-zinc-400">
                  Select a namespace or resource to see the access currently saved in Ofz. Unchecked permissions grant
                  no access.
                </p>
              )}
              {saved ? (
                <Field>
                  <FieldLabel htmlFor={formId + '-reason'}>Reason for change</FieldLabel>
                  <Input
                    id={formId + '-reason'}
                    placeholder="Briefly explain this access change"
                    aria-invalid={Boolean(form.formState.errors.reason)}
                    {...form.register('reason')}
                  />
                  <FieldError errors={[form.formState.errors.reason]} />
                </Field>
              ) : null}
            </FieldGroup>
          </FieldSet>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type={needsVerification ? 'button' : 'submit'}
              size="sm"
              disabled={busy || Boolean(pending) || (!needsVerification && !changed.length)}
              onClick={
                needsVerification
                  ? () =>
                      void startTengriSignIn('step-up').catch(() =>
                        setError(new PasskeyRequiredError('Verification could not start. Try again.')),
                      )
                  : undefined
              }
            >
              {busy ? 'Saving…' : needsVerification ? 'Verify identity' : 'Save changes'}
            </Button>
            <p className="text-xs text-zinc-400">
              {changed.length
                ? changed.length + (changed.length === 1 ? ' permission changed' : ' permissions changed')
                : saved
                  ? 'No unsaved changes'
                  : 'Permissions load after choosing a resource'}
            </p>
          </div>
        </form>
      )}
    </section>
  )
}
