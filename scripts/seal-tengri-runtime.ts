import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '..')
const controllerName = process.env.SEALED_SECRETS_CONTROLLER_NAME ?? 'sealed-secrets'
const controllerNamespace = process.env.SEALED_SECRETS_CONTROLLER_NAMESPACE ?? 'sealed-secrets'

const required = [
  'BETTER_AUTH_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'TENGRI_INTERNAL_HMAC_SECRET',
  'TENGRI_TICKET_SIGNING_SECRET',
] as const

type RequiredSecret = (typeof required)[number]

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
      env: { ...process.env, SYNC_WAVE: syncWave },
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

const controllerPath = resolve(repositoryRoot, 'argocd/applications/tengri/sealed-secret.yaml')
const bffPath = resolve(repositoryRoot, 'argocd/applications/proompteng/sealed-secret.yaml')

await Promise.all([Bun.write(controllerPath, controllerManifest), Bun.write(bffPath, bffManifest)])

console.log(`sealed ${controllerPath}`)
console.log(`sealed ${bffPath}`)
