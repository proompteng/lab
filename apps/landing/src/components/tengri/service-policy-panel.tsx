'use client'

import { fromJson } from '@bufbuild/protobuf'
import { zodResolver } from '@hookform/resolvers/zod'
import { Button, Input } from '@proompteng/design/ui'
import { useCallback, useEffect, useId, useState } from 'react'
import { useForm } from 'react-hook-form'
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
  const selectClass = 'block w-full rounded-md border border-zinc-700 bg-zinc-950 p-2 text-sm'
  const inlineError = (name: keyof Form) =>
    form.formState.errors[name] ? (
      <p role="alert" className="text-xs text-red-300">
        {form.formState.errors[name]?.message}
      </p>
    ) : null
  return (
    <section aria-label="Service policies" className="space-y-4">
      <p className="text-sm text-zinc-400">
        Assign declared permissions to people or registered services. Ofz checks administrator authority and current
        passkey verification for every change.
      </p>
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
        <form onSubmit={submit} className="space-y-4">
          <fieldset disabled={blocked} className="space-y-4">
            <div>
              <label htmlFor={formId + '-policy'} className="text-sm">
                Policy
              </label>
              <select
                id={formId + '-policy'}
                className={selectClass}
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
              </select>
              {inlineError('resourceKind')}
            </div>
            <div>
              <label htmlFor={formId + '-resource'} className="text-sm">
                Resource identity
              </label>
              <Input id={formId + '-resource'} list={formId + '-resources'} {...form.register('resourceId')} />
              <datalist id={formId + '-resources'}>
                {targets.map((target) => (
                  <option key={target.resource.id} value={target.resource.id}>
                    {target.name}
                  </option>
                ))}
              </datalist>
              <p className="mt-1 text-xs text-zinc-400">
                Choose an enrolled target, or enter the exact resource ID from its owning service.
              </p>
              {inlineError('resourceId')}
            </div>
            <div>
              <label htmlFor={formId + '-permission'} className="text-sm">
                Permission
              </label>
              <select id={formId + '-permission'} className={selectClass} {...form.register('relation')}>
                <option value="">Choose a permission</option>
                {relations.map((entry) => (
                  <option key={entry.name} value={entry.name}>
                    {entry.name}
                  </option>
                ))}
              </select>
              {inlineError('relation')}
            </div>
            <div>
              <label htmlFor={formId + '-subject-kind'} className="text-sm">
                Subject kind
              </label>
              <select
                id={formId + '-subject-kind'}
                className={selectClass}
                {...form.register('subjectKind', { onChange: () => form.setValue('subjectId', '') })}
              >
                <option value="workload">Service</option>
                <option value="human">Person</option>
              </select>
              {inlineError('subjectKind')}
            </div>
            <div>
              <label htmlFor={formId + '-subject'} className="text-sm">
                {subjectKind === 'workload' ? 'Registered service identity' : 'Ofz human ID'}
              </label>
              {subjectKind === 'workload' ? (
                <>
                  <Input
                    id={formId + '-subject'}
                    list={formId + '-services'}
                    placeholder="spiffe://…"
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
                  <p className="mt-1 text-xs text-zinc-400">
                    Choose a known client or enter the exact identity of an onboarded service.
                  </p>
                </>
              ) : (
                <Input id={formId + '-subject'} placeholder="github:42" {...form.register('subjectId')} />
              )}
              {inlineError('subjectId')}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" {...form.register('enabled')} className="accent-blue-500" />
              Allow this permission. Clear to revoke it.
            </label>
            <div>
              <label htmlFor={formId + '-reason'} className="text-sm">
                Reason
              </label>
              <Input id={formId + '-reason'} {...form.register('reason')} />
              {inlineError('reason')}
            </div>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" className="bg-blue-700 text-white hover:bg-blue-600" disabled={blocked}>
              Apply policy
            </Button>
            {pending ? (
              <Button
                type="button"
                size="sm"
                className="bg-blue-700 text-white hover:bg-blue-600"
                disabled={busy}
                onClick={() => void execute(pending)}
              >
                Retry exact change
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
              Refresh policies
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}
