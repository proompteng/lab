'use client'

import { z } from 'zod'

const errorSchema = z.object({ error: z.string().optional() })
const redirectSchema = z.object({ url: z.url() })
let logoutOperation: string | undefined

export class PasskeyRequiredError extends Error {
  constructor(message = 'Verify your identity to save this change.') {
    super(message)
  }
}

async function authRequest(path: string, operationId?: string) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: operationId ? { 'x-platform-operation-id': operationId } : {},
  })
  if (!response.ok) {
    const parsed = errorSchema.safeParse(await response.json().catch(() => null))
    throw new Error(parsed.success ? parsed.data.error || 'Sign-in failed. Try again.' : 'Sign-in failed. Try again.')
  }
  return response
}

export async function startSignIn(action: 'login' | 'step-up' | 'add-passkey' = 'login') {
  const response = await authRequest(`/api/auth/${action}`)
  const redirect = redirectSchema.parse(await response.json())
  window.location.assign(redirect.url)
}

export async function signOut() {
  logoutOperation ??= crypto.randomUUID()
  await authRequest('/api/auth/logout', logoutOperation)
  logoutOperation = undefined
}
