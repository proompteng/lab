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
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  NativeSelect,
} from '@proompteng/design/ui'
import { useCallback, useEffect, useId, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { z } from 'zod'
import { connectorCatalogSchema, type ConnectorCatalog } from '@/lib/platform/catalog'
import { connectionReference, credentialMatchesRuntime, type SaveConnection } from '@/lib/tengri/connections'
import {
  ListPlatformConnectionsResponseSchema,
  type ListPlatformConnectionsResponse,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
import type { TengriAgent } from '@/lib/tengri/types'
import { startTengriSignIn } from '@/lib/tengri/auth-client'

const formSchema = z.object({
  connectorId: z.string().min(1, 'Choose a connector'),
  operations: z.array(z.string()).min(1, 'Select at least one operation'),
  targets: z.array(z.string()).min(1, 'Select at least one target'),
})
type Form = z.infer<typeof formSchema>
const resourceKey = (resource: { kind: string; id: string }) => JSON.stringify([resource.kind, resource.id])

async function responseJson(response: Response) {
  const json = z.json().parse(await response.json())
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(json)
    throw new Error(error.success ? error.data.error : 'Connections are unavailable')
  }
  return json
}

export function ConnectionsPanel({
  agent,
  active,
  disabled,
}: {
  agent: TengriAgent
  active: boolean
  disabled: boolean
}) {
  const [catalog, setCatalog] = useState<ConnectorCatalog>()
  const [snapshot, setSnapshot] = useState<ListPlatformConnectionsResponse>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<SaveConnection>()
  const [pendingDisconnect, setPendingDisconnect] = useState<{
    operationId: string
    agentId: string
    connectionId: string
  }>()
  const formId = useId()
  const form = useForm<Form>({
    resolver: zodResolver(formSchema),
    defaultValues: { connectorId: '', operations: [], targets: [] },
  })
  const connectorId = form.watch('connectorId')
  const getValues = form.getValues
  const reset = form.reset

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const [connections, available] = await Promise.all([
        fetch('/api/tengri/connections?agentId=' + encodeURIComponent(agent.id), { cache: 'no-store', signal }).then(
          responseJson,
        ),
        fetch('/api/platform/connectors', { cache: 'no-store', signal }).then(responseJson),
      ])
      if (signal?.aborted) return
      const next = fromJson(ListPlatformConnectionsResponseSchema, connections)
      const listed = connectorCatalogSchema.parse(available)
      setSnapshot(next)
      setPendingDisconnect((request) =>
        request && next.connections.some((connection) => connection.id === request.connectionId && !connection.enabled)
          ? undefined
          : request,
      )
      setCatalog(listed)
      if (!getValues('connectorId')) {
        const id = listed.operations.find((operation) => operation.readOnly)?.connectorId ?? ''
        const saved = next.connections.find(
          (connection) => connection.clientReference === connectionReference(agent.uid, id),
        )
        reset({
          connectorId: id,
          operations: saved
            ? listed.operations
                .filter((operation) => operation.connectorId === id && saved.actions.includes(operation.action))
                .map((operation) => operation.name)
            : [],
          targets: saved?.resources.map(resourceKey) ?? [],
        })
      }
    },
    [agent.id, agent.uid, getValues, reset],
  )

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void load(controller.signal).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Connections are unavailable')
    })
    return () => controller.abort()
  }, [active, agent.runtimeEpoch, load])

  const refresh = async () => {
    setBusy(true)
    setError('')
    try {
      await load()
      setPending(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Connections are unavailable')
    } finally {
      setBusy(false)
    }
  }
  const changeConnector = (id: string) => {
    const saved = snapshot?.connections.find(
      (connection) => connection.clientReference === connectionReference(agent.uid, id),
    )
    reset({
      connectorId: id,
      operations:
        catalog?.operations
          .filter((operation) => operation.connectorId === id && saved?.actions.includes(operation.action))
          .map((operation) => operation.name) ?? [],
      targets: saved?.resources.map(resourceKey) ?? [],
    })
    setNotice('')
  }
  const submit = form.handleSubmit(async (value) => {
    const existing = snapshot?.connections.find(
      (connection) => connection.clientReference === connectionReference(agent.uid, value.connectorId),
    )
    const request =
      pending ??
      ({
        kind: 'save',
        operationId: crypto.randomUUID(),
        agentId: agent.id,
        connectionId: existing?.id ?? crypto.randomUUID(),
        expectedVersion: String(existing?.version ?? BigInt(0)),
        connectorId: value.connectorId,
        operations: value.operations,
        targets: value.targets.map((key) => {
          const [kind, id] = z.tuple([z.string(), z.string()]).parse(JSON.parse(key))
          return { kind, id }
        }),
      } satisfies SaveConnection)
    setPending(request)
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/tengri/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      const next = fromJson(ListPlatformConnectionsResponseSchema, await responseJson(response))
      const current = next.connections.find((connection) => connection.id === request.connectionId)
      if (!current) throw new Error('The saved connection could not be confirmed. Refresh before retrying.')
      setSnapshot(next)
      setPending(undefined)
      setNotice(
        !current.enabled
          ? 'Connection is disconnected. Review its settings before reconnecting.'
          : current.credentialActive
            ? 'Connection is ready.'
            : 'Connection is saved. Resume the workspace to finish connecting.',
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Connection could not be confirmed. Retry the same change.')
      await load().catch(() => {})
    } finally {
      setBusy(false)
    }
  })
  const disconnect = async (connectionId: string) => {
    const request = pendingDisconnect ?? { operationId: crypto.randomUUID(), agentId: agent.id, connectionId }
    setPendingDisconnect(request)
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/tengri/connections', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      const result = z
        .object({ revoked: z.literal(true), cleanupPending: z.boolean() })
        .parse(await responseJson(response))
      setPendingDisconnect(undefined)
      setPending(undefined)
      setNotice(
        result.cleanupPending ? 'Disconnected. Guest tool cleanup is pending; access is revoked.' : 'Disconnected.',
      )
      await load()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Disconnection could not be confirmed. Refresh before retrying.',
      )
    } finally {
      setBusy(false)
    }
  }
  const renew = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/tengri/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'reconcile', agentId: agent.id }),
      })
      setSnapshot(fromJson(ListPlatformConnectionsResponseSchema, await responseJson(response)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Connection renewal could not be confirmed.')
    } finally {
      setBusy(false)
    }
  }

  const operations =
    catalog?.operations.filter((operation) => operation.connectorId === connectorId && operation.readOnly) ?? []
  const targets = [
    ...new Map(
      operations.flatMap((operation) => operation.targets).map((entry) => [resourceKey(entry.resource), entry]),
    ).values(),
  ]
  const selectedTargets = form.watch('targets')
  const targetNames = new Map(
    catalog?.operations
      .flatMap((operation) => operation.targets)
      .map((entry) => [resourceKey(entry.resource), entry.name]) ?? [],
  )
  const selectedConnection = snapshot?.connections.find(
    (connection) => connection.clientReference === connectionReference(agent.uid, connectorId),
  )
  const unavailableTargets = selectedTargets.filter(
    (key) => !targets.some((entry) => resourceKey(entry.resource) === key),
  )
  const targetOptions = [
    ...targets.map((entry) => ({ key: resourceKey(entry.resource), label: entry.name, unavailable: false })),
    ...unavailableTargets.map((key) => ({
      key,
      label: 'Unavailable saved target. Remove it before choosing a replacement.',
      unavailable: true,
    })),
  ]
  const blocked = disabled || busy || Boolean(pending) || Boolean(pendingDisconnect)
  const { errors } = form.formState
  return (
    <section aria-label="Connections" className="@container/connections space-y-4 text-zinc-200">
      <FieldDescription>
        Give this workspace selected platform tools. Each call uses your current permissions.
      </FieldDescription>
      {error ? (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-zinc-300">
          {notice}
        </p>
      ) : null}
      {snapshot?.connections.map((connection) => (
        <Card key={connection.id} size="sm">
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1 break-words">
              <p className="text-sm font-medium">{connection.clientReference.slice((agent.uid + '/').length)}</p>
              <p className="mt-1 text-xs text-zinc-400">
                {!connection.enabled
                  ? 'Disconnected'
                  : connection.credentialActive &&
                      credentialMatchesRuntime(
                        connection,
                        agent.runtimeEpoch ?? '',
                        snapshot.recoveryGeneration,
                        Date.now(),
                      )
                    ? 'Connected'
                    : 'Needs renewal'}
              </p>
              <p className="mt-1 text-xs text-zinc-400">
                {connection.resources
                  .map((resource) => targetNames.get(resourceKey(resource)) ?? resource.id)
                  .join(', ')}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {connection.enabled &&
              (!connection.credentialActive ||
                !credentialMatchesRuntime(
                  connection,
                  agent.runtimeEpoch ?? '',
                  snapshot.recoveryGeneration,
                  Date.now(),
                )) ? (
                <Button type="button" size="sm" variant="outline" disabled={blocked} onClick={() => void renew()}>
                  Renew access
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  disabled ||
                  busy ||
                  !connection.enabled ||
                  Boolean(pendingDisconnect && pendingDisconnect.connectionId !== connection.id)
                }
                onClick={() => void disconnect(connection.id)}
              >
                {pendingDisconnect?.connectionId === connection.id ? 'Retry disconnect' : 'Disconnect'}
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
      {!catalog ? (
        <p role="status" className="text-sm text-zinc-400">
          Loading connections…
        </p>
      ) : (
        <Card size="sm">
          <form noValidate onSubmit={submit} className="space-y-4">
            <CardContent>
              <FieldGroup>
                <Field data-invalid={Boolean(errors.connectorId)}>
                  <FieldLabel htmlFor={formId + '-connector'}>Connector</FieldLabel>
                  <NativeSelect
                    id={formId + '-connector'}
                    className="w-full"
                    aria-invalid={Boolean(errors.connectorId)}
                    aria-describedby={formId + '-connector-error'}
                    value={connectorId}
                    disabled={blocked}
                    onChange={(event) => changeConnector(event.target.value)}
                  >
                    <option value="">Choose a connector</option>
                    {[
                      ...new Set(
                        catalog.operations
                          .filter((operation) => operation.readOnly)
                          .map((operation) => operation.connectorId),
                      ),
                    ].map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </NativeSelect>
                  <FieldError id={formId + '-connector-error'} errors={[errors.connectorId]} />
                </Field>
                <div className="grid gap-4 @min-[420px]/connections:grid-cols-2">
                  <FieldSet disabled={blocked} aria-describedby={formId + '-operations-error'}>
                    <FieldLegend>Operations</FieldLegend>
                    <Controller
                      name="operations"
                      control={form.control}
                      render={({ field }) => (
                        <FieldGroup className="gap-3">
                          {operations.map((operation, index) => (
                            <Field
                              key={operation.name}
                              orientation="horizontal"
                              data-invalid={Boolean(errors.operations)}
                            >
                              <Checkbox
                                id={formId + '-operation-' + index}
                                name={field.name}
                                ref={index === 0 ? field.ref : undefined}
                                checked={field.value.includes(operation.name)}
                                disabled={blocked}
                                onBlur={field.onBlur}
                                onCheckedChange={(checked) =>
                                  field.onChange(
                                    checked
                                      ? [...field.value, operation.name]
                                      : field.value.filter((name) => name !== operation.name),
                                  )
                                }
                                aria-invalid={Boolean(errors.operations)}
                                aria-describedby={
                                  formId + '-operation-description-' + index + ' ' + formId + '-operations-error'
                                }
                              />
                              <FieldContent>
                                <FieldLabel htmlFor={formId + '-operation-' + index}>{operation.name}</FieldLabel>
                                <FieldDescription id={formId + '-operation-description-' + index}>
                                  {operation.description}
                                </FieldDescription>
                              </FieldContent>
                            </Field>
                          ))}
                        </FieldGroup>
                      )}
                    />
                    <FieldError id={formId + '-operations-error'} errors={[errors.operations]} />
                  </FieldSet>
                  <FieldSet disabled={blocked} aria-describedby={formId + '-targets-error'}>
                    <FieldLegend>Targets</FieldLegend>
                    <Controller
                      name="targets"
                      control={form.control}
                      render={({ field }) => (
                        <FieldGroup className="gap-3">
                          {targetOptions.map((option, index) => (
                            <Field key={option.key} orientation="horizontal" data-invalid={Boolean(errors.targets)}>
                              <Checkbox
                                id={formId + '-target-' + index}
                                name={field.name}
                                ref={index === 0 ? field.ref : undefined}
                                checked={field.value.includes(option.key)}
                                disabled={blocked}
                                onBlur={field.onBlur}
                                onCheckedChange={(checked) =>
                                  field.onChange(
                                    checked
                                      ? [...field.value, option.key]
                                      : field.value.filter((key) => key !== option.key),
                                  )
                                }
                                aria-invalid={Boolean(errors.targets)}
                                aria-describedby={formId + '-targets-error'}
                              />
                              <FieldLabel
                                htmlFor={formId + '-target-' + index}
                                className={option.unavailable ? 'text-amber-300' : undefined}
                              >
                                {option.label}
                              </FieldLabel>
                            </Field>
                          ))}
                        </FieldGroup>
                      )}
                    />
                    <FieldError id={formId + '-targets-error'} errors={[errors.targets]} />
                  </FieldSet>
                </div>
              </FieldGroup>
            </CardContent>
            <CardFooter className="flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={disabled || busy || Boolean(pendingDisconnect)}>
                {busy
                  ? 'Saving…'
                  : pending
                    ? 'Retry connection'
                    : selectedConnection && !selectedConnection.enabled
                      ? 'Reconnect'
                      : 'Save connection'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled || busy}
                onClick={() => void refresh()}
              >
                Refresh
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled || busy}
                onClick={() =>
                  void startTengriSignIn('step-up').catch(() => setError('Passkey verification could not start'))
                }
              >
                Verify passkey
              </Button>
            </CardFooter>
          </form>
        </Card>
      )}
    </section>
  )
}
