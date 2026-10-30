'use client'

import { fromJson } from '@bufbuild/protobuf'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Button,
  Card,
  CardContent,
  CardFooter,
  Checkbox,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
  Input,
  NativeSelect,
} from '@proompteng/design/ui'
import { useCallback, useEffect, useId, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { z } from 'zod'
import { connectorCatalogSchema, policyCatalogSchema, type ConnectorCatalog } from '@/lib/platform/catalog'
import type { PolicyWrite } from '@/lib/platform/policies'
import {
  GetPlatformConfigurationResponseSchema,
  WritePolicyRelationshipsResponseSchema,
  type GetPlatformConfigurationResponse,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'

const formSchema = z.object({
  resourceKind: z.string().min(1, 'Choose a policy'),
  resourceId: z.string().min(1, 'Choose a resource').max(256),
  relation: z.string().min(1, 'Choose a permission'),
  subjectKind: z.enum(['human', 'workload']),
  subjectId: z.string().min(1, 'Enter the subject identity').max(512),
  enabled: z.boolean(),
  reason: z.string().min(3, 'Explain the reason for this change').max(512),
})
type Form = z.infer<typeof formSchema>

async function read(response: Response) {
  const json = z.json().parse(await response.json())
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(json)
    throw new Error(
      response.status === 428
        ? 'Verify your passkey, then retry this change.'
        : error.success
          ? error.data.error
          : 'Policy administration is unavailable',
    )
  }
  return json
}

export function ServicePolicyPanel({ active }: { active: boolean }) {
  const [configuration, setConfiguration] = useState<GetPlatformConfigurationResponse>()
  const [catalog, setCatalog] = useState<ConnectorCatalog>()
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PolicyWrite>()
  const formId = useId()
  const form = useForm<Form>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      resourceKind: '',
      resourceId: '',
      relation: '',
      subjectKind: 'workload',
      subjectId: '',
      enabled: true,
      reason: '',
    },
  })
  const kind = form.watch('resourceKind')
  const relation = form.watch('relation')
  const subjectKind = form.watch('subjectKind')
  const policy = configuration ? policyCatalogSchema.parse(JSON.parse(configuration.policyCatalogJson)) : undefined
  const resources = policy?.resources.filter((resource) => resource.relations.length > 0) ?? []
  const relations = resources.find((resource) => resource.kind === kind)?.relations ?? []
  const subjects = relations.find((entry) => entry.name === relation)?.subjects ?? []
  const targets = [
    ...new Map(
      (catalog?.operations.flatMap((operation) => operation.targets) ?? [])
        .filter((target) => target.resource.kind === kind)
        .map((target) => [target.resource.id, target]),
    ).values(),
  ]
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
        setError(cause instanceof Error ? cause.message : 'Policy administration is unavailable')
    })
    return () => controller.abort()
  }, [active, load])
  const execute = async (request: PolicyWrite) => {
    setPending(request)
    setBusy(true)
    setError('')
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
      setError(cause instanceof Error ? cause.message : 'The policy change could not be confirmed.')
    } finally {
      setBusy(false)
    }
  }
  const submit = form.handleSubmit(async (value) => {
    if (!configuration || pending) return
    if (!subjects.includes(value.subjectKind)) {
      form.setError('subjectKind', { message: 'This relation does not accept that subject kind' })
      return
    }
    await execute({
      operationId: crypto.randomUUID(),
      expectedPolicyVersion: String(configuration.policyVersion),
      relationships: [
        {
          resource: { kind: value.resourceKind, id: value.resourceId },
          relation: value.relation,
          subjectKind: value.subjectKind,
          subjectId: value.subjectId,
          enabled: value.enabled,
        },
      ],
      reason: value.reason,
    })
  })
  const refresh = async () => {
    setBusy(true)
    setError('')
    try {
      await load()
      setPending(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Policies are unavailable')
    } finally {
      setBusy(false)
    }
  }
  const { errors } = form.formState
  return (
    <section aria-label="Service policies" className="@container/policies space-y-4">
      <FieldDescription>Assign resource permissions to people or registered services.</FieldDescription>
      {error ? (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      ) : null}
      {receipt ? (
        <p role="status" className="break-words text-xs text-zinc-400">
          {receipt}
        </p>
      ) : null}
      {!configuration ? (
        <p role="status" className="text-sm text-zinc-400">
          Loading service policies…
        </p>
      ) : (
        <Card size="sm">
          <form noValidate onSubmit={submit} className="space-y-4">
            <CardContent>
              <FieldSet disabled={blocked}>
                <FieldGroup className="grid gap-3 @min-[420px]/policies:grid-cols-2">
                  <Field data-invalid={Boolean(errors.resourceKind)}>
                    <FieldLabel htmlFor={formId + '-policy'}>Policy</FieldLabel>
                    <NativeSelect
                      id={formId + '-policy'}
                      className="w-full"
                      aria-invalid={Boolean(errors.resourceKind)}
                      aria-describedby={formId + '-policy-error'}
                      {...form.register('resourceKind', {
                        onChange: () => {
                          form.setValue('relation', '')
                          form.setValue('resourceId', '')
                        },
                      })}
                    >
                      <option value="">Choose a policy</option>
                      {resources.map((resource) => (
                        <option key={resource.kind} value={resource.kind}>
                          {resource.kind}
                        </option>
                      ))}
                    </NativeSelect>
                    <FieldError id={formId + '-policy-error'} errors={[errors.resourceKind]} />
                  </Field>
                  <Field data-invalid={Boolean(errors.relation)}>
                    <FieldLabel htmlFor={formId + '-permission'}>Permission</FieldLabel>
                    <NativeSelect
                      id={formId + '-permission'}
                      className="w-full"
                      aria-invalid={Boolean(errors.relation)}
                      aria-describedby={formId + '-permission-error'}
                      {...form.register('relation')}
                    >
                      <option value="">Choose a permission</option>
                      {relations.map((entry) => (
                        <option key={entry.name} value={entry.name}>
                          {entry.name}
                        </option>
                      ))}
                    </NativeSelect>
                    <FieldError id={formId + '-permission-error'} errors={[errors.relation]} />
                  </Field>
                  <Field className="col-span-full" data-invalid={Boolean(errors.resourceId)}>
                    <FieldLabel htmlFor={formId + '-resource'}>Resource identity</FieldLabel>
                    <Input
                      id={formId + '-resource'}
                      list={formId + '-resources'}
                      aria-invalid={Boolean(errors.resourceId)}
                      aria-describedby={formId + '-resource-help ' + formId + '-resource-error'}
                      {...form.register('resourceId')}
                    />
                    <datalist id={formId + '-resources'}>
                      {targets.map((target) => (
                        <option key={target.resource.id} value={target.resource.id}>
                          {target.name}
                        </option>
                      ))}
                    </datalist>
                    <FieldDescription id={formId + '-resource-help'}>
                      Choose a target or enter its exact resource ID.
                    </FieldDescription>
                    <FieldError id={formId + '-resource-error'} errors={[errors.resourceId]} />
                  </Field>
                  <Field data-invalid={Boolean(errors.subjectKind)}>
                    <FieldLabel htmlFor={formId + '-subject-kind'}>Subject kind</FieldLabel>
                    <NativeSelect
                      id={formId + '-subject-kind'}
                      className="w-full"
                      aria-invalid={Boolean(errors.subjectKind)}
                      aria-describedby={formId + '-subject-kind-error'}
                      {...form.register('subjectKind', { onChange: () => form.setValue('subjectId', '') })}
                    >
                      <option value="workload">Service</option>
                      <option value="human">Person</option>
                    </NativeSelect>
                    <FieldError id={formId + '-subject-kind-error'} errors={[errors.subjectKind]} />
                  </Field>
                  <Field data-invalid={Boolean(errors.subjectId)}>
                    <FieldLabel htmlFor={formId + '-subject'}>
                      {subjectKind === 'workload' ? 'Registered service identity' : 'Ofz human ID'}
                    </FieldLabel>
                    {subjectKind === 'workload' ? (
                      <>
                        <Input
                          id={formId + '-subject'}
                          list={formId + '-services'}
                          placeholder="spiffe://…"
                          aria-invalid={Boolean(errors.subjectId)}
                          aria-describedby={formId + '-subject-help ' + formId + '-subject-error'}
                          {...form.register('subjectId')}
                        />
                        <datalist id={formId + '-services'}>
                          {configuration.relayClients.flatMap((client) =>
                            client.identities.map((id) => (
                              <option key={id} value={id}>
                                {client.id + ' · ' + id}
                              </option>
                            )),
                          )}
                        </datalist>
                        <FieldDescription id={formId + '-subject-help'}>
                          Use an onboarded service identity.
                        </FieldDescription>
                      </>
                    ) : (
                      <Input
                        id={formId + '-subject'}
                        placeholder="Verified Ofz human ID"
                        aria-invalid={Boolean(errors.subjectId)}
                        aria-describedby={formId + '-subject-error'}
                        {...form.register('subjectId')}
                      />
                    )}
                    <FieldError id={formId + '-subject-error'} errors={[errors.subjectId]} />
                  </Field>
                  <Field orientation="horizontal" className="col-span-full">
                    <Controller
                      name="enabled"
                      control={form.control}
                      render={({ field }) => (
                        <Checkbox
                          id={formId + '-enabled'}
                          name={field.name}
                          ref={field.ref}
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          onBlur={field.onBlur}
                          disabled={blocked}
                        />
                      )}
                    />
                    <FieldLabel htmlFor={formId + '-enabled'}>Allow this permission. Clear to revoke it.</FieldLabel>
                  </Field>
                  <Field className="col-span-full" data-invalid={Boolean(errors.reason)}>
                    <FieldLabel htmlFor={formId + '-reason'}>Reason</FieldLabel>
                    <Input
                      id={formId + '-reason'}
                      aria-invalid={Boolean(errors.reason)}
                      aria-describedby={formId + '-reason-error'}
                      {...form.register('reason')}
                    />
                    <FieldError id={formId + '-reason-error'} errors={[errors.reason]} />
                  </Field>
                </FieldGroup>
              </FieldSet>
            </CardContent>
            <CardFooter className="flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={blocked}>
                Apply policy
              </Button>
              {pending ? (
                <Button type="button" size="sm" disabled={busy} onClick={() => void execute(pending)}>
                  Retry exact change
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
                Refresh policies
              </Button>
            </CardFooter>
          </form>
        </Card>
      )}
    </section>
  )
}
