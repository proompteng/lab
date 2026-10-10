'use client'

import { z } from 'zod'

const errorSchema = z.object({ error: z.string().optional() })
const redirectSchema = z.object({ url: z.url() })
let logoutOperation: string | undefined

async function authRequest(path: string, operationId?: string) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: operationId ? { 'x-tengri-operation-id': operationId } : {},
  })
  if (!response.ok) {
    const parsed = errorSchema.safeParse(await response.json().catch(() => null))
    throw new Error(
      parsed.success ? parsed.data.error || 'Tengri authentication failed' : 'Tengri authentication failed',
    )
  }
  return response
}

export async function startTengriSignIn(stepUp = false) {
  const response = await authRequest(stepUp ? '/api/auth/step-up' : '/api/auth/login')
  const redirect = redirectSchema.parse(await response.json())
  window.location.assign(redirect.url)
}

export async function signOutTengri() {
  logoutOperation ??= crypto.randomUUID()
  await authRequest('/api/auth/logout', logoutOperation)
  logoutOperation = undefined
}
