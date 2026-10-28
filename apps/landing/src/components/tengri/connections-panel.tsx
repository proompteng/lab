'use client'

import { fromJson } from '@bufbuild/protobuf'
import { zodResolver } from '@hookform/resolvers/zod'
import { Button } from '@proompteng/design/ui'
import { useCallback, useEffect, useId, useState } from 'react'
import { useForm } from 'react-hook-form'
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
    setError('')
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
  const blocked = disabled || busy || Boolean(pending) || Boolean(pendingDisconnect)
  return (
    <section aria-label="Connections" className="space-y-4 text-zinc-200">
      <p className="text-sm text-zinc-400">
        Give this workspace selected platform tools. Each call uses your current permissions.
      </p>
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
        <div key={connection.id} className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
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
          </div>
        </div>
      ))}
      {!catalog ? (
        <p role="status" className="text-sm text-zinc-400">
          Loading connections…
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4 rounded-lg border border-zinc-700 bg-zinc-900/50 p-3">
          <div className="space-y-1">
            <label htmlFor={formId + '-connector'} className="text-sm">
              Connector
            </label>
            <select
              id={formId + '-connector'}
              className="block w-full rounded-md border border-zinc-700 bg-zinc-950 p-2 text-sm"
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
            </select>
            {form.formState.errors.connectorId ? (
              <p role="alert" className="text-xs text-red-300">
                {form.formState.errors.connectorId.message}
              </p>
            ) : null}
          </div>
          <fieldset disabled={blocked} className="space-y-2">
            <legend className="mb-2 text-sm">Operations</legend>
            {operations.map((operation) => (
              <label key={operation.name} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  value={operation.name}
                  {...form.register('operations')}
                  className="mt-1 accent-blue-500"
                />
                <span>
                  {operation.name}
                  <span className="mt-1 block text-xs text-zinc-400">{operation.description}</span>
                </span>
              </label>
            ))}
            {form.formState.errors.operations ? (
              <p role="alert" className="text-xs text-red-300">
                {form.formState.errors.operations.message}
              </p>
            ) : null}
          </fieldset>
          <fieldset disabled={blocked} className="space-y-2">
            <legend className="mb-2 text-sm">Targets</legend>
            {targets.map((entry) => (
              <label key={resourceKey(entry.resource)} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  value={resourceKey(entry.resource)}
                  {...form.register('targets')}
                  className="accent-blue-500"
                />
                {entry.name}
              </label>
            ))}
            {unavailableTargets.map((key) => (
              <label key={key} className="flex items-center gap-2 text-xs text-amber-300">
                <input type="checkbox" value={key} {...form.register('targets')} />
                Unavailable saved target. Remove it before choosing a replacement.
              </label>
            ))}
            {form.formState.errors.targets ? (
              <p role="alert" className="text-xs text-red-300">
                {form.formState.errors.targets.message}
              </p>
            ) : null}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              className="bg-blue-700 text-white hover:bg-blue-600"
              disabled={disabled || busy || Boolean(pendingDisconnect)}
            >
              {busy
                ? 'Saving…'
                : pending
                  ? 'Retry connection'
                  : selectedConnection && !selectedConnection.enabled
                    ? 'Reconnect'
                    : 'Save connection'}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={disabled || busy} onClick={() => void refresh()}>
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
          </div>
        </form>
      )}
    </section>
  )
}
