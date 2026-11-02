'use client'

import { fromJson } from '@bufbuild/protobuf'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  Skeleton,
} from '@proompteng/design/ui'
import { ChevronDown, ChevronLeft, Plug, Server } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { z } from 'zod'
import { connectorCatalogSchema, type ConnectorCatalog } from '@/lib/platform/catalog'
import { startSignIn } from '@/lib/platform/auth-client'
import { MemberAccessRequests } from '@/components/platform/member-access-requests'
import { ProviderAccount } from '@/components/platform/provider-accounts'
import { connectProvider, consumeProviderReturn } from '@/lib/platform/provider-client'
import { providerResultMessage } from '@/lib/platform/provider-connections'
import {
  completePendingConnection,
  connectionConnector,
  connectionReference,
  connectionScopeLimit,
  credentialMatchesRuntime,
  pendingConnectionKey,
  readPendingConnection,
  retainPendingConnection,
  type SaveConnection,
} from '@/lib/tengri/connections'
import {
  ListPlatformConnectionsResponseSchema,
  ListProviderConnectionsResponseSchema,
  ProviderConnectionState,
  type ProviderConnection,
  type ListPlatformConnectionsResponse,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'
import type { TengriAgent } from '@/lib/tengri/types'

const formSchema = z.object({
  operations: z
    .array(z.string())
    .min(1, 'Allow at least one kind of access.')
    .max(connectionScopeLimit, 'Choose up to 16 tools.'),
  targets: z
    .array(z.string())
    .min(1, 'Choose at least one resource.')
    .max(connectionScopeLimit, 'Choose up to 16 resources.'),
})
type Form = z.infer<typeof formSchema>
const resourceKey = (resource: { kind: string; id: string }) => JSON.stringify([resource.kind, resource.id])

class ConnectionRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}
async function responseJson(response: Response) {
  const json = z.json().parse(await response.json())
  if (!response.ok) {
    const error = z.object({ error: z.string(), code: z.string().optional() }).safeParse(json)
    throw new ConnectionRequestError(
      response.status,
      error.success ? error.data.error : 'Connections are unavailable. Try again.',
      error.success ? error.data.code : undefined,
    )
  }
  return json
}

export function ConnectionsPanel({
  agent,
  principalId,
  active,
  disabled,
}: {
  agent: TengriAgent
  principalId: string
  active: boolean
  disabled: boolean
}) {
  const [catalog, setCatalog] = useState<ConnectorCatalog>()
  const [snapshot, setSnapshot] = useState<ListPlatformConnectionsResponse>()
  const [providers, setProviders] = useState<ProviderConnection[]>()
  const [editor, setEditor] = useState<string>()
  const [customizing, setCustomizing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<SaveConnection>()
  const [pendingDisconnect, setPendingDisconnect] = useState<{
    operationId: string
    agentId: string
    connectionId: string
  }>()
  const restored = useRef('')
  const editorHeading = useRef<HTMLHeadingElement>(null)
  const returnButton = useRef<HTMLButtonElement>(null)
  const lastEditor = useRef<string | undefined>(undefined)
  const formId = useId()
  const pendingKey = pendingConnectionKey(principalId, agent.uid)
  const form = useForm<Form>({ resolver: zodResolver(formSchema), defaultValues: { operations: [], targets: [] } })
  const reset = form.reset
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const [connections, available, accounts] = await Promise.all([
        fetch('/api/tengri/connections?agentId=' + encodeURIComponent(agent.id), { cache: 'no-store', signal }).then(
          responseJson,
        ),
        fetch('/api/platform/connectors', { cache: 'no-store', signal }).then(responseJson),
        fetch('/api/platform/provider-connections', { cache: 'no-store', signal }).then(responseJson),
      ])
      if (signal?.aborted) return
      const next = fromJson(ListPlatformConnectionsResponseSchema, connections)
      for (const connection of next.connections) connectionConnector(connection, agent.uid)
      setSnapshot(next)
      setCatalog(connectorCatalogSchema.parse(available))
      setProviders(fromJson(ListProviderConnectionsResponseSchema, accounts).connections)
    },
    [agent.id, agent.uid],
  )

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const refresh = () =>
      void load(controller.signal).catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Connections are unavailable.')
      })
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      controller.abort()
      window.removeEventListener('focus', refresh)
    }
  }, [active, agent.runtimeEpoch, load])
  useEffect(() => {
    if (!active) return
    if (editor) editorHeading.current?.focus()
    else if (lastEditor.current) returnButton.current?.focus()
  }, [active, editor])

  useEffect(() => {
    if (
      !pendingDisconnect ||
      !snapshot?.connections.some(
        (connection) => connection.id === pendingDisconnect.connectionId && !connection.enabled,
      )
    )
      return
    if (pending?.connectionId === pendingDisconnect.connectionId) {
      completePendingConnection(sessionStorage, pendingKey, pending.operationId)
      setPending(undefined)
    }
    setPendingDisconnect(undefined)
    setError('')
    setNotice('Disconnected. Access is revoked.')
  }, [pending, pendingDisconnect, pendingKey, snapshot])

  const save = useCallback(
    async (request: SaveConnection, afterSignIn = false) => {
      setBusy(true)
      setError('')
      setNotice('')
      try {
        retainPendingConnection(sessionStorage, pendingKey, request, false)
        setPending(request)
        const provider = providers?.find((profile) => profile.connectorId === request.connectorId)
        if (provider && provider.state !== ProviderConnectionState.READY) {
          if (provider.workspaceManaged) throw new Error('Your workspace admin needs to reconnect this account.')
          retainPendingConnection(sessionStorage, pendingKey, request, true)
          await connectProvider(principalId, provider.profileId, window.location.pathname + window.location.search)
          return
        }
        const response = await fetch('/api/tengri/connections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        })
        const next = fromJson(ListPlatformConnectionsResponseSchema, await responseJson(response))
        const current = next.connections.find((connection) => connection.id === request.connectionId)
        if (!current) throw new Error('The connection could not be confirmed. Try again to check the same request.')
        completePendingConnection(sessionStorage, pendingKey, request.operationId)
        setSnapshot(next)
        setPending(undefined)
        reset({ operations: request.operations, targets: request.targets.map(resourceKey) })
        setEditor(undefined)
        setNotice(
          !current.enabled
            ? 'Disconnected.'
            : credentialMatchesRuntime(current, agent.runtimeEpoch ?? '', next.recoveryGeneration, Date.now())
              ? ''
              : 'Access is saved. Your agent is not connected yet.',
        )
      } catch (cause) {
        if (cause instanceof ConnectionRequestError) {
          if (cause.status === 401 && !afterSignIn) {
            try {
              retainPendingConnection(sessionStorage, pendingKey, request, true)
              await startSignIn('login')
            } catch {
              setError('Sign-in could not start. Your choices are saved. Try again when you’re ready.')
            }
            return
          }
          if (cause.code === 'connection_access_denied' || cause.code === 'connection_scope_changed') {
            completePendingConnection(sessionStorage, pendingKey, request.operationId)
            setPending(undefined)
          }
        }
        setError(cause instanceof Error ? cause.message : 'The connection could not be confirmed. Try again.')
        await load().catch(() => {})
      } finally {
        setBusy(false)
      }
    },
    [agent.runtimeEpoch, load, pendingKey, principalId, providers, reset],
  )

  useEffect(() => {
    if (!active || !catalog || !snapshot || !providers || restored.current === pendingKey) return
    restored.current = pendingKey
    try {
      const returned = consumeProviderReturn(principalId)
      const retained = readPendingConnection(sessionStorage, pendingKey)
      if (returned) {
        setNotice(providerResultMessage[returned.result])
        if (retained && returned.result !== 'connected') {
          retainPendingConnection(sessionStorage, pendingKey, retained.request, false)
          retained.resumeAfterSignIn = false
        }
      }
      if (!retained) return
      if (retained.request.agentId !== agent.id) throw new Error('This setup belongs to another workspace.')
      setPending(retained.request)
      setEditor(retained.request.connectorId)
      lastEditor.current = retained.request.connectorId
      reset({ operations: retained.request.operations, targets: retained.request.targets.map(resourceKey) })
      if (retained.resumeAfterSignIn) void save(retained.request, true)
      else if (!returned) setNotice('Your choices are saved. Try again to finish connecting.')
    } catch {
      setError('Your previous setup could not be restored. Refresh Connections before continuing.')
    }
  }, [active, agent.id, catalog, pendingKey, principalId, providers, reset, save, snapshot])

  const available = catalog?.operations.filter((operation) => operation.readOnly) ?? []
  const serviceIds = [
    ...new Set([
      ...available.map((operation) => operation.connectorId),
      ...(snapshot?.connections.map((connection) => connectionConnector(connection, agent.uid)) ?? []),
    ]),
  ]
  const serviceName = (id: string) =>
    available.some(
      (operation) =>
        operation.connectorId === id &&
        operation.targets.some((target) => target.resource.kind === 'kubernetes.namespace'),
    )
      ? 'Kubernetes'
      : id
  const targetNames = new Map(
    catalog?.operations
      .flatMap((operation) => operation.targets)
      .map((target) => [resourceKey(target.resource), target.name]) ?? [],
  )
  const savedConnection = (id: string) =>
    snapshot?.connections.find((connection) => connection.clientReference === connectionReference(agent.uid, id))
  const isConnected = (id: string) => {
    const connection = savedConnection(id)
    return Boolean(
      connection &&
      snapshot &&
      !providers?.some((profile) => profile.connectorId === id && profile.state !== ProviderConnectionState.READY) &&
      credentialMatchesRuntime(connection, agent.runtimeEpoch ?? '', snapshot.recoveryGeneration, Date.now()),
    )
  }
  const openEditor = (id: string) => {
    const connection = savedConnection(id)
    const operations = available.filter((operation) => operation.connectorId === id)
    if (lastEditor.current !== id)
      reset({
        operations:
          pending?.connectorId === id
            ? pending.operations
            : connection
              ? connection.actions.map(
                  (action) => operations.find((operation) => operation.action === action)?.name ?? action,
                )
              : operations.map((operation) => operation.name),
        targets:
          pending?.connectorId === id
            ? pending.targets.map(resourceKey)
            : (connection?.resources.map(resourceKey) ?? []),
      })
    lastEditor.current = id
    setEditor(id)
    setCustomizing(false)
    setNotice('')
    if (!pending) setError('')
  }
  const connect = (id: string) => {
    const operations = available.filter((operation) => operation.connectorId === id)
    const targets = [
      ...new Map(
        operations
          .flatMap((operation) => operation.targets)
          .map((target) => [resourceKey(target.resource), target.resource]),
      ).values(),
    ]
    if (savedConnection(id) || pending || targets.length !== 1 || agent.phase !== 'ready') {
      openEditor(id)
      return
    }
    lastEditor.current = id
    reset({ operations: operations.map((operation) => operation.name), targets: targets.map(resourceKey) })
    void save({
      kind: 'save',
      operationId: crypto.randomUUID(),
      agentId: agent.id,
      connectionId: crypto.randomUUID(),
      expectedVersion: '0',
      connectorId: id,
      operations: operations.map((operation) => operation.name),
      targets,
    })
  }
  const refresh = async () => {
    setBusy(true)
    setError('')
    try {
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Connections are unavailable.')
    } finally {
      setBusy(false)
    }
  }
  const reconnect = async () => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/tengri/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'reconcile', agentId: agent.id }),
      })
      setSnapshot(fromJson(ListPlatformConnectionsResponseSchema, await responseJson(response)))
      setEditor(undefined)
      setNotice('Connection checked.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The connection could not be confirmed.')
    } finally {
      setBusy(false)
    }
  }
  const submit = form.handleSubmit(
    async (value) => {
      if (!editor) return
      const workspaces = new Set(
        snapshot?.availableScopes
          .filter((scope) => scope.resource && value.targets.includes(resourceKey(scope.resource)))
          .map((scope) => scope.workspaceId),
      )
      if (workspaces.size > 1) {
        form.setError('targets', { message: 'Choose resources from one workspace.' })
        return
      }
      const existing = savedConnection(editor)
      if (
        !pending &&
        existing?.enabled &&
        !form.formState.isDirty &&
        !providers?.some((profile) => profile.connectorId === editor && profile.state !== ProviderConnectionState.READY)
      ) {
        await reconnect()
        return
      }
      await save(
        pending ?? {
          kind: 'save',
          operationId: crypto.randomUUID(),
          agentId: agent.id,
          connectionId: existing?.id ?? crypto.randomUUID(),
          expectedVersion: String(existing?.version ?? BigInt(0)),
          connectorId: editor,
          operations: value.operations,
          targets: value.targets.map((key) => {
            const [kind, id] = z.tuple([z.string(), z.string()]).parse(JSON.parse(key))
            return { kind, id }
          }),
        },
      )
    },
    (invalid) => {
      if (invalid.operations) setCustomizing(true)
    },
  )
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
      if (pending?.connectionId === connectionId) {
        completePendingConnection(sessionStorage, pendingKey, pending.operationId)
        setPending(undefined)
      }
      setSnapshot((current) =>
        current
          ? {
              ...current,
              connections: current.connections.map((connection) =>
                connection.id === connectionId
                  ? { ...connection, enabled: false, credentialActive: false }
                  : connection,
              ),
            }
          : current,
      )
      setEditor(undefined)
      setNotice(
        result.cleanupPending
          ? 'Disconnected. Access is revoked; tool cleanup will finish when the workspace is available.'
          : 'Disconnected.',
      )
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Disconnection could not be confirmed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const operations = available.filter((operation) => operation.connectorId === editor)
  const targets = [
    ...new Map(
      operations.flatMap((operation) => operation.targets).map((target) => [resourceKey(target.resource), target]),
    ).values(),
  ]
  const selectedTargets = form.watch('targets')
  const selectedOperations = form.watch('operations')
  const permittedOperations = operations.filter((operation) =>
    selectedTargets.every((key) => operation.targets.some((target) => resourceKey(target.resource) === key)),
  )
  const operationOptions = [
    ...permittedOperations.map((operation) => ({ name: operation.name, label: operation.description })),
    ...selectedOperations
      .filter((name) => !permittedOperations.some((operation) => operation.name === name))
      .map((name) => ({ name, label: 'Unavailable tool. Remove it to continue.' })),
  ]
  const targetOptions = [
    ...targets.map((target) => ({ key: resourceKey(target.resource), label: target.name })),
    ...selectedTargets
      .filter((key) => !targets.some((target) => resourceKey(target.resource) === key))
      .map((key) => ({ key, label: 'Unavailable saved resource. Remove it to continue.' })),
  ]
  const selected = editor ? savedConnection(editor) : undefined
  const selectedConnected = editor ? isConnected(editor) : false
  const selectedProvider = providers?.find((profile) => profile.connectorId === editor)
  const blocked = disabled || busy || Boolean(pending) || Boolean(pendingDisconnect)
  const { errors } = form.formState
  return (
    <section aria-label="Connections" className="space-y-4 text-zinc-200">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-zinc-300">
          {notice}
        </p>
      ) : null}
      {!catalog || !snapshot || !providers ? (
        <div role="status" aria-label="Loading connections" className="space-y-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-24 w-full" />
          {error ? (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : editor ? (
        <>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditor(undefined)}>
            <ChevronLeft aria-hidden="true" /> Back to connections
          </Button>
          <div className="space-y-1">
            <h2 ref={editorHeading} tabIndex={-1} className="text-base font-medium outline-none">
              {selected?.enabled ? 'Manage ' : 'Connect '}
              {serviceName(editor)}
            </h2>
            <FieldDescription>{editor} · Read access for this agent. You can disconnect at any time.</FieldDescription>
          </div>
          {selectedProvider ? (
            selectedProvider.workspaceManaged ? (
              <FieldDescription>
                {selectedProvider.state === ProviderConnectionState.READY
                  ? 'Uses your connected workspace account.'
                  : 'Your workspace admin needs to connect this account before you can continue.'}
              </FieldDescription>
            ) : (
              <ProviderAccount
                profile={selectedProvider}
                principalId={principalId}
                showConnect={false}
                disabled={disabled || busy}
                onChanged={load}
              />
            )
          ) : null}
          <Card size="sm">
            <form noValidate onSubmit={submit}>
              <CardContent className="space-y-5">
                <FieldSet disabled={blocked} aria-describedby={formId + '-targets-error'}>
                  <FieldLegend>
                    {targets.some((target) => target.resource.kind === 'kubernetes.namespace')
                      ? 'Namespaces'
                      : 'Resources'}
                  </FieldLegend>
                  <FieldDescription>Choose what your agent can read.</FieldDescription>
                  <Controller
                    name="targets"
                    control={form.control}
                    render={({ field }) => (
                      <FieldGroup className="gap-2">
                        {targetOptions.map((target, index) => (
                          <Field key={target.key} orientation="horizontal" data-invalid={Boolean(errors.targets)}>
                            <Checkbox
                              id={formId + '-target-' + index}
                              name={field.name}
                              ref={index === 0 ? field.ref : undefined}
                              checked={field.value.includes(target.key)}
                              disabled={blocked}
                              onBlur={field.onBlur}
                              onCheckedChange={(checked) => {
                                const targets = checked
                                  ? [...field.value, target.key]
                                  : field.value.filter((key) => key !== target.key)
                                field.onChange(targets)
                                const allowed = operations.filter((operation) =>
                                  targets.every((key) =>
                                    operation.targets.some((target) => resourceKey(target.resource) === key),
                                  ),
                                )
                                form.setValue(
                                  'operations',
                                  allowed.map((operation) => operation.name),
                                  { shouldDirty: true },
                                )
                              }}
                              aria-invalid={Boolean(errors.targets)}
                              aria-describedby={formId + '-targets-error'}
                            />
                            <div className="min-w-0">
                              <FieldLabel htmlFor={formId + '-target-' + index}>{target.label}</FieldLabel>
                              <FieldDescription>
                                {
                                  snapshot.availableScopes.find(
                                    (scope) => scope.resource && resourceKey(scope.resource) === target.key,
                                  )?.workspaceName
                                }
                              </FieldDescription>
                            </div>
                          </Field>
                        ))}
                        {targetOptions.length === 0 ? (
                          <FieldDescription>No resources are currently available.</FieldDescription>
                        ) : null}
                      </FieldGroup>
                    )}
                  />
                  <FieldError id={formId + '-targets-error'} errors={[errors.targets]} />
                </FieldSet>
                <div className="space-y-2 border-t pt-4">
                  <p className="text-sm font-medium">Your agent will be able to</p>
                  <ul className="list-inside list-disc space-y-1 text-sm text-zinc-400">
                    {operationOptions
                      .filter((operation) => selectedOperations.includes(operation.name))
                      .map((operation) => (
                        <li key={operation.name}>{operation.label}</li>
                      ))}
                  </ul>
                  <Collapsible open={customizing} onOpenChange={setCustomizing}>
                    <CollapsibleTrigger render={<Button type="button" size="sm" variant="ghost" />}>
                      Customize access <ChevronDown aria-hidden="true" />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <FieldSet disabled={blocked} className="pt-3" aria-describedby={formId + '-operations-error'}>
                        <FieldLegend className="sr-only">Allowed tools</FieldLegend>
                        <Controller
                          name="operations"
                          control={form.control}
                          render={({ field }) => (
                            <FieldGroup className="gap-3">
                              {operationOptions.map((operation, index) => (
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
                                    aria-describedby={formId + '-operations-error'}
                                  />
                                  <FieldLabel htmlFor={formId + '-operation-' + index}>{operation.label}</FieldLabel>
                                </Field>
                              ))}
                            </FieldGroup>
                          )}
                        />
                      </FieldSet>
                    </CollapsibleContent>
                  </Collapsible>
                  <FieldError id={formId + '-operations-error'} errors={[errors.operations]} />
                </div>
                {agent.phase !== 'ready' ? (
                  <FieldDescription>
                    Resume your workspace to connect its tools. Your saved access stays in place.
                  </FieldDescription>
                ) : null}
                {pending ? (
                  <FieldDescription>
                    Your request is saved. Try again to confirm it before making another change.
                  </FieldDescription>
                ) : null}
              </CardContent>
              <CardFooter className="flex-wrap gap-2">
                {selected?.enabled ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled || busy}
                    className="mr-auto"
                    onClick={() => void disconnect(selected.id)}
                  >
                    {pendingDisconnect ? 'Retry disconnect' : 'Disconnect'}
                  </Button>
                ) : null}
                <Button
                  type="submit"
                  size="sm"
                  className="ml-auto"
                  disabled={
                    disabled ||
                    busy ||
                    Boolean(pendingDisconnect) ||
                    Boolean(
                      selectedProvider?.workspaceManaged && selectedProvider.state !== ProviderConnectionState.READY,
                    ) ||
                    agent.phase !== 'ready' ||
                    Boolean(selected?.enabled && selectedConnected && !form.formState.isDirty && !pending)
                  }
                >
                  {busy
                    ? 'Connecting…'
                    : pending
                      ? 'Try again'
                      : selected?.enabled
                        ? form.formState.isDirty || selectedConnected
                          ? 'Save changes'
                          : 'Reconnect'
                        : selected
                          ? 'Reconnect'
                          : 'Connect'}
                </Button>
              </CardFooter>
            </form>
          </Card>
        </>
      ) : (
        <>
          <FieldDescription>
            Connect the services your agent works with. You control what it can access.
          </FieldDescription>
          <ItemGroup aria-label="Available services">
            {serviceIds.map((id) => {
              const connection = savedConnection(id)
              const connected = isConnected(id)
              const waiting = pending?.connectorId === id
              return (
                <Item key={id} role="listitem" variant="outline" className="bg-zinc-950/30">
                  <ItemMedia variant="icon">
                    <Server aria-hidden="true" />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="text-sm">
                      {serviceName(id)}{' '}
                      <Badge variant="secondary">
                        {connected
                          ? 'Connected'
                          : connection?.enabled
                            ? agent.phase === 'ready'
                              ? 'Needs attention'
                              : 'Ready on resume'
                            : 'Not connected'}
                      </Badge>
                    </ItemTitle>
                    <ItemDescription>
                      {[
                        id,
                        ...new Set(
                          available
                            .filter((operation) => operation.connectorId === id)
                            .flatMap((operation) => operation.targets.map((target) => target.name)),
                        ),
                      ].join(' · ')}
                    </ItemDescription>
                    {!connection?.enabled ? (
                      <ItemDescription>
                        {available
                          .filter((operation) => operation.connectorId === id)
                          .map((operation) => operation.description)
                          .join(', ')}
                      </ItemDescription>
                    ) : null}
                    {connection?.enabled ? (
                      <ItemDescription className="break-words">
                        {connection.resources
                          .map((resource) => targetNames.get(resourceKey(resource)) ?? 'Unavailable resource')
                          .join(', ')}
                      </ItemDescription>
                    ) : null}
                  </ItemContent>
                  <ItemActions>
                    <Button
                      ref={lastEditor.current === id ? returnButton : undefined}
                      type="button"
                      size="sm"
                      variant={connected ? 'outline' : 'default'}
                      disabled={
                        disabled ||
                        busy ||
                        Boolean(pending && !waiting) ||
                        Boolean(pendingDisconnect && pendingDisconnect.connectionId !== connection?.id)
                      }
                      onClick={() => connect(id)}
                    >
                      {waiting ? 'Finish setup' : connection?.enabled ? 'Manage' : 'Connect'}
                    </Button>
                  </ItemActions>
                </Item>
              )
            })}
          </ItemGroup>
          <MemberAccessRequests
            snapshot={snapshot}
            humanId={principalId}
            disabled={disabled || busy}
            onChanged={() => void refresh()}
          />
          {serviceIds.length === 0 && snapshot.requestableScopes.length === 0 ? (
            <div className="space-y-2 py-6 text-center text-zinc-400">
              <Plug aria-hidden="true" className="mx-auto size-6" />
              <p>No services are available yet.</p>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
