'use client'

import { fromJson } from '@bufbuild/protobuf'
import { Button, Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@proompteng/design/ui'
import { useCallback, useEffect, useState } from 'react'
import { readPlatformResponse } from '@/lib/platform/client'
import {
  connectProvider,
  consumeProviderReturn,
  disconnectProvider,
  pendingProviderMutation,
} from '@/lib/platform/provider-client'
import { providerResultMessage, type ProviderMutation } from '@/lib/platform/provider-connections'
import {
  ListProviderConnectionsResponseSchema,
  ProviderConnectionState,
  type ProviderConnection,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'

export function ProviderAccount({
  profile,
  principalId,
  disabled,
  onChanged,
}: {
  profile: ProviderConnection
  principalId: string
  disabled?: boolean
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<ProviderMutation>()
  const restorePending = useCallback(() => {
    try {
      setPending(pendingProviderMutation(principalId, profile.profileId))
    } catch {
      setError('The saved account change could not be read. Refresh before continuing.')
    }
  }, [principalId, profile.profileId])
  useEffect(restorePending, [restorePending])
  const change = async (disconnect: boolean) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (disconnect) {
        const result = await disconnectProvider(principalId, profile.profileId, profile.connectionId)
        setNotice(
          result.providerRevocationConfirmed
            ? 'Account disconnected.'
            : 'Account disconnected here. Remove the app in your provider settings to revoke its upstream access.',
        )
        await onChanged()
      } else {
        await connectProvider(principalId, profile.profileId, window.location.pathname + window.location.search)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The account change could not be confirmed.')
    } finally {
      restorePending()
      setBusy(false)
    }
  }
  return (
    <Item variant="outline" className="bg-zinc-950/30">
      <ItemContent className="min-w-0">
        <ItemTitle className="text-sm">{profile.name}</ItemTitle>
        <ItemDescription className="break-words">
          {profile.accountName || (profile.workspaceManaged ? 'Shared workspace account' : 'Your account')} ·{' '}
          {profile.state === ProviderConnectionState.READY
            ? 'Connected'
            : profile.state === ProviderConnectionState.RECONNECT
              ? 'Reconnect needed'
              : 'Not connected'}
        </ItemDescription>
        {profile.providerScopes.length ? (
          <ItemDescription className="break-words">Access: {profile.providerScopes.join(', ')}</ItemDescription>
        ) : null}
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
      </ItemContent>
      <ItemActions className="flex-wrap">
        {(profile.state !== ProviderConnectionState.DISCONNECTED && profile.connectionId) ||
        pending?.kind === 'disconnect' ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled || busy || pending?.kind === 'begin'}
            onClick={() => void change(true)}
          >
            {pending?.kind === 'disconnect' ? 'Retry disconnect' : 'Disconnect account'}
          </Button>
        ) : null}
        {profile.state !== ProviderConnectionState.READY || pending?.kind === 'begin' ? (
          <Button
            type="button"
            size="sm"
            disabled={disabled || busy || pending?.kind === 'disconnect'}
            onClick={() => void change(false)}
          >
            {busy ? 'Connecting…' : profile.connectionId ? 'Reconnect account' : 'Connect account'}
          </Button>
        ) : null}
      </ItemActions>
    </Item>
  )
}

export function WorkspaceProviderAccounts({ workspaceId, principalId }: { workspaceId: string; principalId: string }) {
  const [profiles, setProfiles] = useState<ProviderConnection[]>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const json = await fetch('/api/platform/provider-connections?' + new URLSearchParams({ workspaceId }), {
        cache: 'no-store',
        signal,
      }).then(readPlatformResponse)
      if (!signal?.aborted)
        setProfiles(
          fromJson(ListProviderConnectionsResponseSchema, json).connections.filter(
            (profile) => profile.workspaceManaged,
          ),
        )
    },
    [workspaceId],
  )
  useEffect(() => {
    const controller = new AbortController()
    const returned = consumeProviderReturn(principalId)
    if (returned) setNotice(providerResultMessage[returned.result])
    void load(controller.signal).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Accounts could not be loaded.')
    })
    return () => controller.abort()
  }, [load, principalId])
  if (profiles?.length === 0 && !notice && !error) return null
  return (
    <section aria-label="Workspace accounts" className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">Workspace accounts</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Connect shared provider accounts for the clients and resources you allow below.
        </p>
      </div>
      {notice ? (
        <p role="status" className="text-sm text-zinc-300">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-300">
          {error}{' '}
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void load()
                .then(() => setError(''))
                .catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : 'Accounts could not be loaded.'),
                )
            }
          >
            Try again
          </Button>
        </p>
      ) : null}
      {!profiles && !error ? (
        <p role="status" className="text-sm text-zinc-400">
          Loading accounts…
        </p>
      ) : null}
      <ItemGroup>
        {profiles?.map((profile) => (
          <ProviderAccount key={profile.profileId} profile={profile} principalId={principalId} onChanged={load} />
        ))}
      </ItemGroup>
    </section>
  )
}
