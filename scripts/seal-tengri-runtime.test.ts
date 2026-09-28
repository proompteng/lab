import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const generator = resolve(import.meta.dir, 'seal-tengri-runtime.ts')
const cleanups: Array<() => Promise<void>> = []

const validSecrets = {
  BETTER_AUTH_SECRET: 'better-auth-production-secret-000000000000',
  GITHUB_CLIENT_ID: 'Ov23liTengriTestClient',
  GITHUB_CLIENT_SECRET: 'github-production-client-secret',
  TENGRI_INTERNAL_HMAC_SECRET: 'a'.repeat(43),
  TENGRI_TICKET_SIGNING_SECRET: 'ticket-signing-secret-000000000000000000',
}

type Harness = Awaited<ReturnType<typeof createHarness>>

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'tengri-sealing-'))
  const bin = join(root, 'bin')
  const captures = join(root, 'captures')
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(captures, { recursive: true }),
    mkdir(join(root, 'argocd/applications/tengri'), { recursive: true }),
    mkdir(join(root, 'argocd/applications/proompteng'), { recursive: true }),
  ])

  const kubeseal = join(bin, 'kubeseal')
  const yq = join(bin, 'yq')
  await Promise.all([
    writeFile(
      kubeseal,
      `#!/usr/bin/env bun
import { join } from 'node:path'

const root = process.env.TENGRI_SEALED_SECRET_OUTPUT_ROOT
if (!root) throw new Error('missing output root')
const secret = JSON.parse(await Bun.stdin.text())
await Bun.write(
  join(root, 'captures', \`${'${secret.metadata.namespace}'}-${'${secret.metadata.name}'}.json\`),
  JSON.stringify({ args: process.argv.slice(2), secret }),
)
if (await Bun.file(join(root, \`fail-${'${secret.metadata.name}'}\`)).exists()) {
  console.error(\`forced failure for ${'${secret.metadata.name}'}\`)
  process.exit(17)
}
console.log(JSON.stringify({
  apiVersion: 'bitnami.com/v1alpha1',
  kind: 'SealedSecret',
  metadata: secret.metadata,
  spec: {
    encryptedData: Object.fromEntries(Object.keys(secret.stringData).map((key) => [key, \`sealed-${'${key}'}\`])),
    template: { metadata: secret.metadata, type: secret.type },
  },
}))
`,
    ),
    writeFile(
      yq,
      `#!/usr/bin/env bun
const manifest = JSON.parse(await Bun.stdin.text())
manifest.metadata.annotations = {
  ...(manifest.metadata.annotations ?? {}),
  'argocd.argoproj.io/sync-wave': process.env.SYNC_WAVE,
}
console.log(JSON.stringify(manifest))
`,
    ),
  ])
  await Promise.all([chmod(kubeseal, 0o755), chmod(yq, 0o755)])

  let oauthError = 'bad_verification_code'
  const oauthRequests: URLSearchParams[] = []
  const oauthServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      oauthRequests.push(new URLSearchParams(await request.text()))
      return Response.json({ error: oauthError })
    },
  })

  cleanups.push(async () => {
    oauthServer.stop(true)
    await rm(root, { recursive: true, force: true })
  })

  return {
    root,
    bin,
    oauthRequests,
    setOAuthError(error: string) {
      oauthError = error
    },
    oauthTokenUrl: new URL('login/oauth/access_token', oauthServer.url).toString(),
  }
}

async function runGenerator(harness: Harness, overrides: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, generator], {
    env: {
      PATH: `${harness.bin}:${process.env.PATH ?? ''}`,
      HOME: harness.root,
      TENGRI_SEALED_SECRET_OUTPUT_ROOT: harness.root,
      TENGRI_GITHUB_OAUTH_TOKEN_URL: harness.oauthTokenUrl,
      ...validSecrets,
      ...overrides,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, any>
}

describe('seal-tengri-runtime', () => {
  test('validates GitHub OAuth and seals the exact controller and BFF mappings', async () => {
    const harness = await createHarness()
    const result = await runGenerator(harness)

    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(harness.oauthRequests).toHaveLength(1)
    expect(harness.oauthRequests[0].get('client_id')).toBe(validSecrets.GITHUB_CLIENT_ID)
    expect(harness.oauthRequests[0].get('client_secret')).toBe(validSecrets.GITHUB_CLIENT_SECRET)
    expect(harness.oauthRequests[0].get('redirect_uri')).toBe('https://proompteng.ai/api/auth/callback/github')
    expect(harness.oauthRequests[0].get('code')).toStartWith('tengri-credential-preflight-')

    const controller = await readJson(join(harness.root, 'argocd/applications/tengri/sealed-secret.yaml'))
    const bff = await readJson(join(harness.root, 'argocd/applications/proompteng/sealed-secret.yaml'))
    expect(controller.metadata).toEqual({
      name: 'tengri-runtime',
      namespace: 'tengri',
      annotations: { 'argocd.argoproj.io/sync-wave': '-4' },
    })
    expect(Object.keys(controller.spec.encryptedData).sort()).toEqual([
      'TENGRI_INTERNAL_HMAC_SECRET',
      'TENGRI_TICKET_SIGNING_SECRET',
    ])
    expect(bff.metadata).toEqual({ name: 'tengri-bff', namespace: 'proompteng' })
    expect(Object.keys(bff.spec.encryptedData).sort()).toEqual([
      'BETTER_AUTH_SECRET',
      'GITHUB_CLIENT_ID',
      'GITHUB_CLIENT_SECRET',
      'TENGRI_INTERNAL_HMAC_SECRET',
    ])

    const controllerInput = await readJson(join(harness.root, 'captures/tengri-tengri-runtime.json'))
    const bffInput = await readJson(join(harness.root, 'captures/proompteng-tengri-bff.json'))
    expect(controllerInput.args).toContain('--scope')
    expect(controllerInput.args[controllerInput.args.indexOf('--scope') + 1]).toBe('strict')
    expect(controllerInput.secret.stringData).toEqual({
      TENGRI_INTERNAL_HMAC_SECRET: validSecrets.TENGRI_INTERNAL_HMAC_SECRET,
      TENGRI_TICKET_SIGNING_SECRET: validSecrets.TENGRI_TICKET_SIGNING_SECRET,
    })
    expect(bffInput.secret.stringData).toEqual({
      BETTER_AUTH_SECRET: validSecrets.BETTER_AUTH_SECRET,
      GITHUB_CLIENT_ID: validSecrets.GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET: validSecrets.GITHUB_CLIENT_SECRET,
      TENGRI_INTERNAL_HMAC_SECRET: validSecrets.TENGRI_INTERNAL_HMAC_SECRET,
    })
  })

  test('rejects invalid secret input before contacting GitHub or writing manifests', async () => {
    const harness = await createHarness()
    const result = await runGenerator(harness, { TENGRI_INTERNAL_HMAC_SECRET: 'not valid' })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('must contain one or two non-empty base64url keys')
    expect(harness.oauthRequests).toHaveLength(0)
    expect(await Bun.file(join(harness.root, 'argocd/applications/tengri/sealed-secret.yaml')).exists()).toBe(false)
    expect(await Bun.file(join(harness.root, 'argocd/applications/proompteng/sealed-secret.yaml')).exists()).toBe(false)
  })

  test('rejects an invalid GitHub credential pair before sealing', async () => {
    const harness = await createHarness()
    harness.setOAuthError('incorrect_client_credentials')
    const result = await runGenerator(harness)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('GitHub OAuth credential preflight failed: incorrect_client_credentials')
    expect(await Bun.file(join(harness.root, 'captures/tengri-tengri-runtime.json')).exists()).toBe(false)
  })

  test('does not replace either manifest when the second seal fails', async () => {
    const harness = await createHarness()
    const controllerPath = join(harness.root, 'argocd/applications/tengri/sealed-secret.yaml')
    const bffPath = join(harness.root, 'argocd/applications/proompteng/sealed-secret.yaml')
    await Promise.all([
      writeFile(controllerPath, 'controller-sentinel\n'),
      writeFile(bffPath, 'bff-sentinel\n'),
      writeFile(join(harness.root, 'fail-tengri-bff'), ''),
    ])

    const result = await runGenerator(harness)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('forced failure for tengri-bff')
    expect(await readFile(controllerPath, 'utf8')).toBe('controller-sentinel\n')
    expect(await readFile(bffPath, 'utf8')).toBe('bff-sentinel\n')
  })
})
