'use client'

import { fromJson } from '@bufbuild/protobuf'
import { zodResolver } from '@hookform/resolvers/zod'
import {
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
} from '@proompteng/design/ui'
import { useCallback, useEffect, useId, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { z } from 'zod'
import { connectorCatalogSchema, policyCatalogSchema, type ConnectorCatalog } from '@/lib/platform/catalog'
import type { PolicyWrite } from '@/lib/platform/policies'
import { PasskeyRequiredError, startTengriSignIn } from '@/lib/tengri/auth-client'
import {
  GetPlatformConfigurationResponseSchema,
  WritePolicyRelationshipsResponseSchema,
  type GetPlatformConfigurationResponse,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
import { SettingsSelect } from './settings-select'

const formSchema = z.object({
  resource: z.string().min(1, 'Choose a resource'),
  relations: z.array(z.string()).min(1, 'Choose at least one permission').max(128),
  subjectKind: z.enum(['human', 'workload']),
  subjectId: z.string().min(1, 'Choose a service or enter a person ID').max(512),
  enabled: z.boolean(),
  reason: z.string().min(3, 'Explain the reason for this change').max(512),
})
type Form = z.infer<typeof formSchema>

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

async function read(response: Response) {
  const json = z.json().parse(await response.json())
  if (!response.ok) {
    if (response.status === 428) throw new PasskeyRequiredError()
    const error = z.object({ error: z.string() }).safeParse(json)
    throw new Error(error.success ? error.data.error : 'Policy administration is unavailable')
  }
  return json
}

export function ServicePolicyPanel({ active }: { active: boolean }) {
  const [configuration, setConfiguration] = useState<GetPlatformConfigurationResponse>()
  const [catalog, setCatalog] = useState<ConnectorCatalog>()
  const [error, setError] = useState<Error>()
  const [receipt, setReceipt] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PolicyWrite>()
  const formId = useId()
  const form = useForm<Form>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      resource: '',
      relations: [],
      subjectKind: 'workload',
      subjectId: '',
      enabled: true,
      reason: '',
    },
  })
  const selectedResource = form.watch('resource')
  const subjectKind = form.watch('subjectKind')
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
  const relations = policy?.resources.find((entry) => entry.kind === target?.resource.kind)?.relations ?? []
  const serviceOptions =
    configuration?.relayClients.flatMap((client) =>
      client.identities.map((identity) => ({
        value: identity,
        label:
          label(client.id) +
          (client.identities.length > 1
            ? ' · ' + identity.replace(/^spiffe:\/\/[^/]+\/ns\//, '').replace('/sa/', ' / ')
            : ''),
      })),
    ) ?? []
  const blocked = busy || Boolean(pending)
  const load = useCallback(async (signal?: AbortSignal) => {
    const [config, connectors] = await Promise.all([
      fetch('/api/platform/policies', { cache: 'no-store', signal }).then(read),
      fetch('/api/platform/connectors', { cache: 'no-store', signal }).then(read),
    ])
    if (signal?.aborted) return
    const next = fromJson(GetPlatformConfigurationResponseSchema, config)
    policyCatalogSchema.parse(JSON.parse(next.policyCatalogJson))
    setConfiguration(next)
    setCatalog(connectorCatalogSchema.parse(connectors))
  }, [])
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void load(controller.signal).catch((cause: unknown) => {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause : new Error('Policy administration is unavailable'))
    })
    return () => controller.abort()
  }, [active, load])
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
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('The policy change could not be confirmed.'))
    } finally {
      setBusy(false)
    }
  }
  const submit = form.handleSubmit(async (value) => {
    if (!configuration || pending) return
    if (!target) {
      form.setError('resource', { message: 'Choose an available resource' })
      return
    }
    if (value.subjectKind === 'workload' && !serviceOptions.some((option) => option.value === value.subjectId)) {
      form.setError('subjectId', { message: 'Choose a registered service' })
      return
    }
    if (
      value.relations.some(
        (name) => !relations.find((entry) => entry.name === name)?.subjects.includes(value.subjectKind),
      )
    ) {
      form.setError('relations', { message: 'Choose permissions available for this recipient' })
      return
    }
    await execute({
      operationId: crypto.randomUUID(),
      expectedPolicyVersion: String(configuration.policyVersion),
      relationships: value.relations.map((relation) => ({
        resource: target.resource,
        relation,
        subjectKind: value.subjectKind,
        subjectId: value.subjectId,
        enabled: value.enabled,
      })),
      reason: value.reason,
    })
  })
  const refresh = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await load()
      setPending(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Policies are unavailable'))
    } finally {
      setBusy(false)
    }
  }
  const { errors } = form.formState
  const needsVerification = error instanceof PasskeyRequiredError
  return (
    <section aria-label="Service access" className="@container/policies space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Service access</h2>
        <FieldDescription>Choose who can use a resource and what they can do.</FieldDescription>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-red-300">
          {error.message}
        </p>
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
        <p role="status" className="text-xs text-zinc-400">
          Loading service access…
        </p>
      ) : (
        <form noValidate onSubmit={submit} className="space-y-4">
          <FieldSet disabled={blocked}>
            <FieldGroup className="grid gap-4 @min-[420px]/policies:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={formId + '-recipient'}>Assign to</FieldLabel>
                <Controller
                  name="subjectKind"
                  control={form.control}
                  render={({ field }) => (
                    <SettingsSelect
                      {...field}
                      id={formId + '-recipient'}
                      disabled={blocked}
                      options={[
                        { value: 'workload', label: 'Service' },
                        { value: 'human', label: 'Person' },
                      ]}
                      onValueChange={(value) => {
                        field.onChange(value)
                        form.setValue('subjectId', '')
                        form.setValue('relations', [])
                      }}
                    />
                  )}
                />
              </Field>
              <Field data-invalid={Boolean(errors.subjectId)}>
                <FieldLabel htmlFor={formId + '-subject'}>
                  {subjectKind === 'workload' ? 'Service' : 'Person ID'}
                </FieldLabel>
                {subjectKind === 'workload' ? (
                  <Controller
                    name="subjectId"
                    control={form.control}
                    render={({ field }) => (
                      <SettingsSelect
                        {...field}
                        id={formId + '-subject'}
                        disabled={blocked}
                        onValueChange={field.onChange}
                        options={serviceOptions}
                        placeholder="Choose a service"
                        aria-invalid={Boolean(errors.subjectId)}
                        aria-describedby={formId + '-subject-error'}
                      />
                    )}
                  />
                ) : (
                  <Input
                    id={formId + '-subject'}
                    placeholder="Ofz person ID"
                    {...form.register('subjectId')}
                    aria-invalid={Boolean(errors.subjectId)}
                    aria-describedby={formId + '-subject-error'}
                  />
                )}
                <FieldError id={formId + '-subject-error'} errors={[errors.subjectId]} />
              </Field>
              <Field className="col-span-full" data-invalid={Boolean(errors.resource)}>
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
                      aria-invalid={Boolean(errors.resource)}
                      aria-describedby={formId + '-resource-error'}
                      options={targets.map((entry) => ({
                        value: resourceKey(entry.resource),
                        label: entry.name + ' · ' + entry.resource.id.split('/')[0],
                      }))}
                      onValueChange={(value) => {
                        field.onChange(value)
                        form.setValue('relations', [])
                      }}
                    />
                  )}
                />
                {target ? <FieldDescription>{label(target.resource.kind)}</FieldDescription> : null}
                <FieldError id={formId + '-resource-error'} errors={[errors.resource]} />
              </Field>
              <FieldSet className="col-span-full gap-2" aria-describedby={formId + '-permissions-error'}>
                <FieldLegend variant="label">Permissions</FieldLegend>
                {!target ? <FieldDescription>Choose a resource to see its permissions.</FieldDescription> : null}
                {relations
                  .filter((entry) => entry.subjects.includes(subjectKind))
                  .map((entry) => (
                    <Field key={entry.name} orientation="horizontal" className="gap-2">
                      <Controller
                        name="relations"
                        control={form.control}
                        render={({ field }) => (
                          <Checkbox
                            id={formId + '-' + entry.name}
                            name={field.name}
                            checked={field.value.includes(entry.name)}
                            disabled={blocked}
                            onBlur={field.onBlur}
                            aria-invalid={Boolean(errors.relations)}
                            aria-describedby={formId + '-permissions-error'}
                            onCheckedChange={(checked) =>
                              field.onChange(
                                checked
                                  ? [...field.value, entry.name]
                                  : field.value.filter((name) => name !== entry.name),
                              )
                            }
                          />
                        )}
                      />
                      <FieldLabel htmlFor={formId + '-' + entry.name}>{label(entry.name)}</FieldLabel>
                    </Field>
                  ))}
                {target && !relations.some((entry) => entry.subjects.includes(subjectKind)) ? (
                  <FieldDescription>No permissions are available for this recipient.</FieldDescription>
                ) : null}
                <FieldError id={formId + '-permissions-error'} errors={[errors.relations]} />
              </FieldSet>
              <Field>
                <FieldLabel htmlFor={formId + '-change'}>Change</FieldLabel>
                <Controller
                  name="enabled"
                  control={form.control}
                  render={({ field }) => (
                    <SettingsSelect
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      id={formId + '-change'}
                      value={field.value ? 'allow' : 'remove'}
                      disabled={blocked}
                      onValueChange={(value) => field.onChange(value === 'allow')}
                      options={[
                        { value: 'allow', label: 'Allow access' },
                        { value: 'remove', label: 'Remove access' },
                      ]}
                    />
                  )}
                />
              </Field>
              <Field className="col-span-full" data-invalid={Boolean(errors.reason)}>
                <FieldLabel htmlFor={formId + '-reason'}>Reason</FieldLabel>
                <Input
                  id={formId + '-reason'}
                  placeholder="Why is this access changing?"
                  aria-invalid={Boolean(errors.reason)}
                  aria-describedby={formId + '-reason-error'}
                  {...form.register('reason')}
                />
                <FieldError id={formId + '-reason-error'} errors={[errors.reason]} />
              </Field>
            </FieldGroup>
          </FieldSet>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type={needsVerification ? 'button' : 'submit'}
              size="sm"
              disabled={needsVerification ? busy : blocked}
              onClick={
                needsVerification
                  ? () =>
                      void startTengriSignIn('step-up').catch(() =>
                        setError(new PasskeyRequiredError('Verification could not start. Try again.')),
                      )
                  : undefined
              }
            >
              {needsVerification ? 'Verify identity' : 'Save access'}
            </Button>
            {pending && !needsVerification ? (
              <Button type="button" size="sm" disabled={busy} onClick={() => void execute(pending)}>
                Retry exact change
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
              Refresh
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}
