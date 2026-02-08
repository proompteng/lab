#!/usr/bin/env bun

import { ensureCli, fatal, repoRoot } from '../shared/cli'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

type KeycloakTokenResponse = {
  access_token: string
}

type KeycloakClientRepresentation = {
  id?: string
  clientId: string
  enabled: boolean
  protocol: 'openid-connect'
  publicClient: boolean
  standardFlowEnabled: boolean
  redirectUris: string[]
  webOrigins: string[]
  rootUrl?: string
  baseUrl?: string
  adminUrl?: string
  attributes?: Record<string, string>
}

const requireEnv = (key: string): string => {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`Missing required env var ${key}`)
  return value
}

const run = async (cmd: string[], stdin?: string): Promise<string> => {
  const proc = Bun.spawn(cmd, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (stdin) {
    void proc.stdin?.write(stdin)
  }
  void proc.stdin?.end()

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${cmd.join(' ')}\n${stderr}`)
  }

  return stdout
}

const getSecretValue = async (namespace: string, name: string, key: string): Promise<string> => {
  const out = await run(['kubectl', '-n', namespace, 'get', 'secret', name, '-o', `jsonpath={.data.${key}}`])
  const decoded = Buffer.from(out.trim(), 'base64').toString('utf8').trim()
  if (!decoded) throw new Error(`Secret ${namespace}/${name} key ${key} is empty`)
  return decoded
}

const fetchJson = async <T>(url: string, opts: RequestInit = {}): Promise<T> => {
  const res = await fetch(url, opts)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`)
  }
  return (await res.json()) as T
}

const fetchText = async (url: string, opts: RequestInit = {}): Promise<string> => {
  const res = await fetch(url, opts)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`)
  }
  return await res.text()
}

export const main = async () => {
  ensureCli('kubectl')

  const keycloakBaseUrl = process.env.KEYCLOAK_BASE_URL ?? 'https://auth.proompteng.ai'
  const realm = process.env.KEYCLOAK_REALM ?? 'master'
  const clientId = process.env.APP_OIDC_CLIENT_ID ?? 'proompteng-app'
  const appBaseUrl = process.env.APP_BASE_URL ?? 'https://app.proompteng.ai'

  const adminUser =
    process.env.KEYCLOAK_ADMIN_USERNAME?.trim() || (await getSecretValue('keycloak', 'keycloak-admin', 'username'))
  const adminPassword =
    process.env.KEYCLOAK_ADMIN_PASSWORD?.trim() || (await getSecretValue('keycloak', 'keycloak-admin', 'password'))

  const tokenBody = new URLSearchParams()
  tokenBody.set('grant_type', 'password')
  tokenBody.set('client_id', 'admin-cli')
  tokenBody.set('username', adminUser)
  tokenBody.set('password', adminPassword)

  const token = await fetchJson<KeycloakTokenResponse>(
    `${keycloakBaseUrl}/realms/${realm}/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: tokenBody,
    },
  )

  const authHeader = { Authorization: `Bearer ${token.access_token}` }
  const redirectUris = [
    `${appBaseUrl}/api/auth/callback/keycloak`,
    `${appBaseUrl}/auth/callback`,
    'http://localhost:3000/api/auth/callback/keycloak',
    'http://localhost:3000/auth/callback',
  ]
  const webOrigins = [appBaseUrl, 'http://localhost:3000']

  const clients = await fetchJson<KeycloakClientRepresentation[]>(
    `${keycloakBaseUrl}/admin/realms/${realm}/clients?clientId=${encodeURIComponent(clientId)}`,
    { headers: authHeader },
  )

  let id = clients[0]?.id
  if (!id) {
    const representation: KeycloakClientRepresentation = {
      clientId,
      enabled: true,
      protocol: 'openid-connect',
      publicClient: false,
      standardFlowEnabled: true,
      redirectUris,
      webOrigins,
      rootUrl: appBaseUrl,
      baseUrl: appBaseUrl,
      adminUrl: appBaseUrl,
      attributes: {
        'pkce.code.challenge.method': 'S256',
        'pkce.code.challenge.required': 'true',
      },
    }

    await fetchText(`${keycloakBaseUrl}/admin/realms/${realm}/clients`, {
      method: 'POST',
      headers: {
        ...authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(representation),
    })

    const created = await fetchJson<KeycloakClientRepresentation[]>(
      `${keycloakBaseUrl}/admin/realms/${realm}/clients?clientId=${encodeURIComponent(clientId)}`,
      { headers: authHeader },
    )
    id = created[0]?.id
  }

  if (!id) {
    throw new Error(`Failed to resolve Keycloak client id for clientId=${clientId}`)
  }

  // Update redirect URIs / origins on every run.
  const existing = await fetchJson<KeycloakClientRepresentation>(
    `${keycloakBaseUrl}/admin/realms/${realm}/clients/${id}`,
    {
      headers: authHeader,
    },
  )
  existing.redirectUris = redirectUris
  existing.webOrigins = webOrigins
  existing.standardFlowEnabled = true
  existing.publicClient = false
  existing.enabled = true
  existing.protocol = 'openid-connect'
  existing.attributes = {
    ...(existing.attributes ?? {}),
    'pkce.code.challenge.method': 'S256',
    'pkce.code.challenge.required': 'true',
  }

  await fetchText(`${keycloakBaseUrl}/admin/realms/${realm}/clients/${id}`, {
    method: 'PUT',
    headers: {
      ...authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(existing),
  })

  const secret = await fetchJson<{ value: string }>(
    `${keycloakBaseUrl}/admin/realms/${realm}/clients/${id}/client-secret`,
    { headers: authHeader },
  )

  console.log('Keycloak client is configured.')
  console.log(`  KEYCLOAK_BASE_URL=${keycloakBaseUrl}`)
  console.log(`  KEYCLOAK_REALM=${realm}`)
  console.log(`  APP_BASE_URL=${appBaseUrl}`)
  console.log(`  APP_OIDC_CLIENT_ID=${clientId}`)

  const outputPath =
    process.env.APP_OIDC_CLIENT_SECRET_OUTPUT?.trim() || resolve(repoRoot, '.local/app-auth/oidc-client-secret.txt')
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${secret.value}\n`, { mode: 0o600 })
  chmodSync(outputPath, 0o600)
  console.log(`  Wrote APP_OIDC_CLIENT_SECRET to ${outputPath}`)
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to configure Keycloak client', error))
}
