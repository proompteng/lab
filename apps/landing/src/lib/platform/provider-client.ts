'use client'

import { fromJson } from '@bufbuild/protobuf'
import { z } from 'zod'
import { PlatformClientError, readPlatformResponse } from './client'
import { providerId, providerMutationSchema, providerResultSchema, type ProviderMutation } from './provider-connections'
import {
  BeginProviderConnectionResponseSchema,
  DisconnectProviderConnectionResponseSchema,
} from '@/lib/tengri/generated/proompteng/authz/v1/platform_pb'

const key = (principal: string, profile: string) => 'platform-provider:' + JSON.stringify([principal, profile])
export function pendingProviderMutation(principal: string, profile: string) {
  const stored = sessionStorage.getItem(key(principal, profile))
  if (!stored) return undefined
  const mutation = providerMutationSchema.parse(JSON.parse(stored))
  if (mutation.profileId !== profile) throw new Error('This saved change belongs to another account.')
  return mutation
}

async function send(principal: string, intent: ProviderMutation) {
  const pending = pendingProviderMutation(principal, intent.profileId)
  if (pending && pending.operationId !== intent.operationId) throw new Error('Finish the saved account change first.')
  sessionStorage.setItem(key(principal, intent.profileId), JSON.stringify(intent))
  try {
    return await fetch('/api/platform/provider-connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intent),
    }).then(readPlatformResponse)
  } catch (error) {
    if (error instanceof PlatformClientError && error.status < 500 && error.status !== 401)
      sessionStorage.removeItem(key(principal, intent.profileId))
    throw error
  }
}

export async function connectProvider(principal: string, profileId: string, returnPath: string) {
  const pending = pendingProviderMutation(principal, profileId)
  if (pending && pending.kind !== 'begin') throw new Error('Finish disconnecting this account first.')
  const result = fromJson(
    BeginProviderConnectionResponseSchema,
    await send(principal, pending ?? { kind: 'begin', operationId: crypto.randomUUID(), profileId, returnPath }),
  )
  const url = z
    .url()
    .refine((value) => {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password
    })
    .parse(result.authorizationUrl)
  window.location.assign(url)
}

export async function disconnectProvider(principal: string, profileId: string, connectionId: string) {
  const pending = pendingProviderMutation(principal, profileId)
  if (pending && pending.kind !== 'disconnect') throw new Error('Finish the saved account connection first.')
  const result = fromJson(
    DisconnectProviderConnectionResponseSchema,
    await send(principal, pending ?? { kind: 'disconnect', operationId: crypto.randomUUID(), profileId, connectionId }),
  )
  if (!result.decision?.allowed || !result.decision.auditReceiptId)
    throw new Error('The disconnect is unconfirmed. Retry the saved change.')
  sessionStorage.removeItem(key(principal, profileId))
  return result
}

export function consumeProviderReturn(principal: string) {
  const url = new URL(window.location.href)
  const result = providerResultSchema.safeParse(url.searchParams.get('platform_connection'))
  const profile = providerId.safeParse(url.searchParams.get('provider_profile'))
  if (!result.success || !profile.success) return undefined
  sessionStorage.removeItem(key(principal, profile.data))
  url.searchParams.delete('platform_connection')
  url.searchParams.delete('provider_profile')
  window.history.replaceState(window.history.state, '', url)
  return { result: result.data, profileId: profile.data }
}
