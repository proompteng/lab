import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '..')
const outputRoot = resolve(process.env.TENGRI_SEALED_SECRET_OUTPUT_ROOT ?? repositoryRoot)
const controllerName = process.env.SEALED_SECRETS_CONTROLLER_NAME ?? 'sealed-secrets'
const controllerNamespace = process.env.SEALED_SECRETS_CONTROLLER_NAMESPACE ?? 'sealed-secrets'
const githubOAuthTokenUrl = process.env.TENGRI_GITHUB_OAUTH_TOKEN_URL ?? 'https://github.com/login/oauth/access_token'
const githubOAuthCallbackUrl =
  process.env.TENGRI_GITHUB_OAUTH_CALLBACK_URL ?? 'https://proompteng.ai/api/auth/callback/github'

const required = [
  'BETTER_AUTH_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'TENGRI_INTERNAL_HMAC_SECRET',
  'TENGRI_TICKET_SIGNING_SECRET',
] as const

type RequiredSecret = (typeof required)[number]

const forwardedEnvironment = [
  'PATH',
  'HOME',
  'KUBECONFIG',
  'XDG_CONFIG_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'TENGRI_SEALED_SECRET_OUTPUT_ROOT',
] as const

function subprocessEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const environment = { ...extra }
  for (const name of forwardedEnvironment) {
    const value = process.env[name]
    if (value) environment[name] = value
  }
  return environment
}

function readSecrets(): Record<RequiredSecret, string> {
  const missing = required.filter((name) => !process.env[name])
  if (missing.length > 0) {
    throw new Error(`missing required environment variables: ${missing.join(', ')}`)
  }

  const secrets = Object.fromEntries(required.map((name) => [name, process.env[name] as string])) as Record<
    RequiredSecret,
    string
  >

  if (secrets.BETTER_AUTH_SECRET.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters')
  }

  if (secrets.TENGRI_TICKET_SIGNING_SECRET.length < 32) {
    throw new Error('TENGRI_TICKET_SIGNING_SECRET must contain at least 32 characters')
  }

  const hmacKeys = secrets.TENGRI_INTERNAL_HMAC_SECRET.split(',')
  if (hmacKeys.length < 1 || hmacKeys.length > 2 || hmacKeys.some((key) => !/^[A-Za-z0-9_-]{32,}$/.test(key))) {
    throw new Error('TENGRI_INTERNAL_HMAC_SECRET must contain one or two non-empty base64url keys')
  }

  return secrets
}

async function verifyGitHubOAuthCredentials(clientId: string, clientSecret: string): Promise<void> {
  const response = await fetch(githubOAuthTokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'tengri-sealed-secret-generator',
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: `tengri-credential-preflight-${crypto.randomUUID()}`,
      redirect_uri: githubOAuthCallbackUrl,
    }),
  })

  if (!response.ok) {
    throw new Error(`GitHub OAuth credential preflight returned HTTP ${response.status}`)
  }

  const result = (await response.json()) as { error?: string }
  if (result.error !== 'bad_verification_code') {
    throw new Error(`GitHub OAuth credential preflight failed: ${result.error ?? 'unexpected success response'}`)
  }
}

async function sealSecret(
  namespace: string,
  name: string,
  stringData: Record<string, string>,
  syncWave?: string,
): Promise<string> {
  const secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace },
    type: 'Opaque',
    stringData,
  }

  const child = Bun.spawn(
    [
      'kubeseal',
      '--format',
      'yaml',
      '--scope',
      'strict',
      '--controller-name',
      controllerName,
      '--controller-namespace',
      controllerNamespace,
    ],
    {
      env: subprocessEnvironment(),
      stdin: new Blob([JSON.stringify(secret)]),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const exitCode = await child.exited
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `kubeseal exited with status ${exitCode}`)
  }

  if (!syncWave) {
    return `${stdout.trim()}\n`
  }

  const annotate = Bun.spawn(
    ['yq', '-o=yaml', '.metadata.annotations."argocd.argoproj.io/sync-wave" = strenv(SYNC_WAVE)'],
    {
      env: subprocessEnvironment({ SYNC_WAVE: syncWave }),
      stdin: new Blob([stdout]),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [annotated, annotateError] = await Promise.all([
    new Response(annotate.stdout).text(),
    new Response(annotate.stderr).text(),
  ])
  const annotateExitCode = await annotate.exited
  if (annotateExitCode !== 0) {
    throw new Error(annotateError.trim() || `yq exited with status ${annotateExitCode}`)
  }

  return `${annotated.trim()}\n`
}

const secrets = readSecrets()
await verifyGitHubOAuthCredentials(secrets.GITHUB_CLIENT_ID, secrets.GITHUB_CLIENT_SECRET)
const controllerManifest = await sealSecret(
  'tengri',
  'tengri-runtime',
  {
    TENGRI_INTERNAL_HMAC_SECRET: secrets.TENGRI_INTERNAL_HMAC_SECRET,
    TENGRI_TICKET_SIGNING_SECRET: secrets.TENGRI_TICKET_SIGNING_SECRET,
  },
  '-4',
)
const bffManifest = await sealSecret('proompteng', 'tengri-bff', {
  BETTER_AUTH_SECRET: secrets.BETTER_AUTH_SECRET,
  GITHUB_CLIENT_ID: secrets.GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET: secrets.GITHUB_CLIENT_SECRET,
  TENGRI_INTERNAL_HMAC_SECRET: secrets.TENGRI_INTERNAL_HMAC_SECRET,
})

for (const secret of Object.values(secrets)) {
  if (controllerManifest.includes(secret) || bffManifest.includes(secret)) {
    throw new Error('refusing to write a SealedSecret manifest containing plaintext')
  }
}

const controllerPath = resolve(outputRoot, 'argocd/applications/tengri/sealed-secret.yaml')
const bffPath = resolve(outputRoot, 'argocd/applications/proompteng/sealed-secret.yaml')

await Promise.all([Bun.write(controllerPath, controllerManifest), Bun.write(bffPath, bffManifest)])

console.log(`sealed ${controllerPath}`)
console.log(`sealed ${bffPath}`)
