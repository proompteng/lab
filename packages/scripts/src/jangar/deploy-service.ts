#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'
import { buildImage } from './build-image'

type DeployOptions = {
  registry?: string
  repository?: string
  tag?: string
  kustomizePath?: string
  serviceManifest?: string
  convexNamespace?: string
  convexConfigMap?: string
  convexSecret?: string
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const ensureGhToken = async (): Promise<string> => {
  const envToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  const trimmedEnvToken = envToken?.trim()
  if (trimmedEnvToken) return trimmedEnvToken

  const token = (await capture(['gh', 'auth', 'token'])).trim()
  if (!token) {
    fatal('Missing GitHub token: set GH_TOKEN/GITHUB_TOKEN or run gh auth login (token must include workflow scope)')
  }
  process.env.GH_TOKEN = token
  return token
}

const capture = async (cmd: string[], env?: Record<string, string | undefined>): Promise<string> => {
  const subprocess = Bun.spawn(cmd, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: buildEnv(env),
  })

  subprocess.stdin?.end()

  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])

  if (exitCode !== 0) {
    fatal(`Command failed (${exitCode}): ${cmd.join(' ')}`, stderr)
  }

  return stdout.trim()
}

const fetchHelmV3 = (): { binary: string; tempDir: string } => {
  const version = process.env.HELM_V3_VERSION ?? 'v3.15.4'
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const os = process.platform === 'darwin' ? 'darwin' : 'linux'
  const url = `https://get.helm.sh/helm-${version}-${os}-${arch}.tar.gz`

  const tmpDir = mkdtempSync(join(tmpdir(), 'helm-v3-'))
  const archivePath = join(tmpDir, 'helm.tgz')
  const download = spawnSync('curl', ['-fsSL', url, '-o', archivePath])
  if (download.status !== 0) {
    fatal(`Failed to download helm ${version} from ${url}`, download.stderr?.toString())
  }

  const extract = spawnSync('tar', ['-xzf', archivePath, '-C', tmpDir])
  if (extract.status !== 0) {
    fatal(`Failed to extract helm archive ${archivePath}`, extract.stderr?.toString())
  }

  const binaryPath = join(tmpDir, `${os}-${arch}`, 'helm')
  return { binary: binaryPath, tempDir: tmpDir }
}

const resolveHelmBinary = (): { binary: string; tempDir?: string; shim?: string } => {
  const envBin = process.env.HELM_BIN
  if (envBin) return { binary: envBin }

  const helmPath = Bun.which('helm')
  if (helmPath) {
    const version = spawnSync(helmPath, ['version', '--short'], { encoding: 'utf8' })
    const output = typeof version.stdout === 'string' ? version.stdout.trim() : ''
    if (output.startsWith('v3.')) {
      return { binary: helmPath }
    }
  }

  const misePath = Bun.which('mise')
  if (misePath) {
    const version = (process.env.HELM_V3_VERSION ?? 'v3.15.4').replace(/^v/, '')
    const helmDir = mkdtempSync(join(tmpdir(), 'helm-mise-shim-'))
    const shimPath = join(helmDir, 'helm')
    const script = `#!/usr/bin/env bash\nset -euo pipefail\nexec ${misePath} x helm@${version} -- helm "$@"\n`
    writeFileSync(shimPath, script, { mode: 0o755 })
    const cleanup = () => rmSync(helmDir, { recursive: true, force: true })
    return { binary: shimPath, tempDir: helmDir, shim: 'mise', cleanup }
  }

  const download = fetchHelmV3()
  return download
}

const resolveBuildxVersion = async (): Promise<string> => {
  const envVersion = process.env.BUILDX_VERSION?.trim()
  if (envVersion) return envVersion

  console.log('Fetching latest docker/buildx release information...')
  const response = await fetch('https://api.github.com/repos/docker/buildx/releases/latest', {
    headers: { 'User-Agent': 'proompteng-lab-deploy' },
  })
  if (!response.ok) {
    fatal(`Unable to fetch docker/buildx release metadata: ${response.status} ${response.statusText}`)
  }

  const payload = (await response.json()) as { tag_name?: string }
  const tag = payload?.tag_name?.trim()
  if (!tag) {
    fatal('docker/buildx release metadata did not include a tag_name entry')
  }

  process.env.BUILDX_VERSION = tag
  return tag
}

const writeHelmShim = (): { helmDir: string; helmBinary: string; cleanup: () => void } => {
  const helmResolved = resolveHelmBinary()
  if (helmResolved.shim === 'mise') {
    return {
      helmDir: helmResolved.tempDir ?? tmpdir(),
      helmBinary: helmResolved.binary,
      cleanup: () => helmResolved.tempDir && rmSync(helmResolved.tempDir, { recursive: true, force: true }),
    }
  }

  const helmBinary = helmResolved.binary
  const helmDir = mkdtempSync(join(tmpdir(), 'helm-shim-'))
  const shimPath = join(helmDir, 'helm')
  const script = `#!/usr/bin/env bash
set -euo pipefail
args=()
for a in "$@"; do
  if [[ "$a" == "-c" ]]; then
    continue
  fi
  args+=("$a")
done
exec ${helmBinary} "${'${'}args[@]}"
`
  writeFileSync(shimPath, script, { mode: 0o755 })
  const cleanup = () => {
    rmSync(helmDir, { recursive: true, force: true })
    if (helmResolved.tempDir) {
      rmSync(helmResolved.tempDir, { recursive: true, force: true })
    }
  }
  return { helmDir, helmBinary: shimPath, cleanup }
}

const readConvexEnvFromCluster = async (
  namespace: string,
  configMapName: string,
  secretName: string,
): Promise<{
  siteOrigin?: string
  cloudOrigin?: string
  adminKey?: string
}> => {
  const siteOrigin = await capture([
    'kubectl',
    '-n',
    namespace,
    'get',
    'configmap',
    configMapName,
    '-o',
    'jsonpath={.data.CONVEX_SITE_ORIGIN}',
  ])

  const cloudOrigin = await capture([
    'kubectl',
    '-n',
    namespace,
    'get',
    'configmap',
    configMapName,
    '-o',
    'jsonpath={.data.CONVEX_CLOUD_ORIGIN}',
  ])

  const adminKeyBase64 = await capture([
    'kubectl',
    '-n',
    namespace,
    'get',
    'secret',
    secretName,
    '-o',
    'jsonpath={.data.ADMIN_KEY}',
  ])

  const adminKey = adminKeyBase64 ? Buffer.from(adminKeyBase64, 'base64').toString('utf8') : undefined

  return {
    siteOrigin: siteOrigin || undefined,
    cloudOrigin: cloudOrigin || undefined,
    adminKey: adminKey || undefined,
  }
}

const updateManifests = (
  kustomizePath: string,
  servicePath: string,
  imageName: string,
  tag: string,
  digest: string | undefined,
  rolloutTimestamp: string,
) => {
  const kustomization = readFileSync(kustomizePath, 'utf8')
  const imagePattern = new RegExp(`(name:\\s+${escapeRegExp(imageName)}\\s*\\n\\s*newTag:\\s*)(.+)`, 'm')
  let updatedKustomization = kustomization.replace(imagePattern, (_, prefix) => `${prefix}${tag}`)

  if (digest) {
    const digestPattern = new RegExp(
      `(name:\\s+${escapeRegExp(imageName)}\\s*\\n\\s*newTag:\\s*[^\\n]+\\n\\s*digest:\\s*)(.+)`,
      'm',
    )
    if (digestPattern.test(updatedKustomization)) {
      updatedKustomization = updatedKustomization.replace(digestPattern, (_, prefix) => `${prefix}${digest}`)
    } else {
      updatedKustomization = updatedKustomization.replace(
        new RegExp(`(name:\\s+${escapeRegExp(imageName)}\\s*\\n\\s*newTag:\\s*[^\\n]+)`),
        `$1\n    digest: ${digest}`,
      )
    }
  }
  if (kustomization === updatedKustomization) {
    console.warn('Warning: jangar kustomization was not updated; pattern may have changed.')
  } else {
    writeFileSync(kustomizePath, updatedKustomization)
    console.log(`Updated ${kustomizePath} with tag ${tag}`)
  }

  const service = readFileSync(servicePath, 'utf8')
  const updatedService = service.replace(/(deploy\.knative\.dev\/rollout:\s*")([^"\n]*)("?)/, `$1${rolloutTimestamp}$3`)
  if (service === updatedService) {
    console.warn('Warning: jangar service rollout annotation was not updated; pattern may have changed.')
  } else {
    writeFileSync(servicePath, updatedService)
    console.log(`Updated ${servicePath} rollout annotation to ${rolloutTimestamp}`)
  }
}

const buildEnv = (env?: Record<string, string | undefined>) =>
  Object.fromEntries(
    Object.entries(env ? { ...process.env, ...env } : process.env).filter(([, value]) => value !== undefined),
  ) as Record<string, string>

const runConvexDeploy = async (env: Record<string, string | undefined>, envFile?: string) => {
  const args = ['convex', 'deploy', '--yes']
  if (envFile) {
    args.push('--env-file', envFile)
  }

  console.log(`$ bunx ${args.join(' ')}`.trim())
  const subprocess = Bun.spawn(['bunx', ...args], {
    cwd: resolve(repoRoot, 'services/jangar'),
    env: buildEnv(env),
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const exitCode = await subprocess.exited
  if (exitCode !== 0) {
    fatal(`Command failed (${exitCode}): bunx ${args.join(' ')}`)
  }
}

export const main = async (options: DeployOptions = {}) => {
  ensureCli('kubectl')
  ensureCli('kustomize')
  ensureCli('curl')
  ensureCli('tar')
  await ensureGhToken()

  const registry = options.registry ?? process.env.JANGAR_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.JANGAR_IMAGE_REPOSITORY ?? 'lab/jangar'
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = options.tag ?? process.env.JANGAR_IMAGE_TAG ?? defaultTag
  const imageName = `${registry}/${repository}`
  const image = `${registry}/${repository}:${tag}`

  const buildxVersion = await resolveBuildxVersion()
  console.log(`Using docker/buildx ${buildxVersion}`)

  await buildImage({ registry, repository, tag })

  ensureCli('convex')
  const convexNamespace = options.convexNamespace ?? process.env.CONVEX_NAMESPACE ?? 'convex'
  const convexConfigMap = options.convexConfigMap ?? process.env.CONVEX_CONFIGMAP ?? 'convex-backend-config'
  const convexSecret = options.convexSecret ?? process.env.CONVEX_SECRET ?? 'convex-backend-secrets'

  const clusterConvexEnv = await readConvexEnvFromCluster(convexNamespace, convexConfigMap, convexSecret)

  const convexUrlFromCluster =
    clusterConvexEnv.cloudOrigin ?? clusterConvexEnv.siteOrigin?.replace(/\/?http$/, '') ?? clusterConvexEnv.siteOrigin

  const adminKeyFromCluster = clusterConvexEnv.adminKey
  const deployKeyFromEnv = process.env.CONVEX_DEPLOY_KEY

  const convexEnv = {
    CONVEX_SITE_ORIGIN: clusterConvexEnv.siteOrigin ?? process.env.CONVEX_SITE_ORIGIN,
    CONVEX_CLOUD_ORIGIN: clusterConvexEnv.cloudOrigin ?? process.env.CONVEX_CLOUD_ORIGIN,
    CONVEX_SELF_HOSTED_URL: process.env.CONVEX_SELF_HOSTED_URL ?? convexUrlFromCluster,
    CONVEX_URL: process.env.CONVEX_URL ?? convexUrlFromCluster,
    CONVEX_ADMIN_KEY: process.env.CONVEX_ADMIN_KEY ?? adminKeyFromCluster,
    CONVEX_SELF_HOSTED_ADMIN_KEY:
      process.env.CONVEX_SELF_HOSTED_ADMIN_KEY ?? process.env.CONVEX_ADMIN_KEY ?? adminKeyFromCluster,
    CONVEX_DEPLOY_KEY: deployKeyFromEnv,
    CONVEX_DEPLOYMENT: process.env.CONVEX_DEPLOYMENT,
  }

  const useSelfHosted = Boolean(convexEnv.CONVEX_SELF_HOSTED_URL && convexEnv.CONVEX_SELF_HOSTED_ADMIN_KEY)
  if (useSelfHosted || convexEnv.CONVEX_SELF_HOSTED_URL) {
    convexEnv.CONVEX_DEPLOYMENT = undefined
    convexEnv.CONVEX_DEPLOY_KEY = undefined
  }

  if (!convexEnv.CONVEX_SELF_HOSTED_ADMIN_KEY && !convexEnv.CONVEX_DEPLOY_KEY) {
    fatal(
      'Missing Convex admin/deploy key; ensure convex-backend-secrets exists or set CONVEX_SELF_HOSTED_ADMIN_KEY/CONVEX_DEPLOY_KEY',
    )
  }

  if (!convexEnv.CONVEX_SITE_ORIGIN && !convexEnv.CONVEX_SELF_HOSTED_URL && !convexEnv.CONVEX_URL) {
    fatal(
      'Missing Convex endpoint; ensure convex-backend-config exists or set CONVEX_SELF_HOSTED_URL/CONVEX_SITE_ORIGIN',
    )
  }

  console.log(
    `Using Convex endpoint ${convexEnv.CONVEX_SELF_HOSTED_URL ?? convexEnv.CONVEX_SITE_ORIGIN} from namespace ${convexNamespace}`,
  )

  let convexEnvFile: string | undefined
  if (useSelfHosted) {
    const tmpDir = mkdtempSync(`${tmpdir()}/jangar-convex-`)
    convexEnvFile = resolve(tmpDir, 'convex.env')
    const lines = [
      `CONVEX_SELF_HOSTED_URL=${convexEnv.CONVEX_SELF_HOSTED_URL ?? ''}`,
      `CONVEX_SELF_HOSTED_ADMIN_KEY=${convexEnv.CONVEX_SELF_HOSTED_ADMIN_KEY ?? ''}`,
    ]
    if (convexEnv.CONVEX_SITE_ORIGIN) lines.push(`CONVEX_SITE_ORIGIN=${convexEnv.CONVEX_SITE_ORIGIN}`)
    if (convexEnv.CONVEX_CLOUD_ORIGIN) lines.push(`CONVEX_CLOUD_ORIGIN=${convexEnv.CONVEX_CLOUD_ORIGIN}`)
    writeFileSync(convexEnvFile, `${lines.join('\n')}\n`, { mode: 0o600 })

    try {
      await runConvexDeploy(convexEnv, convexEnvFile)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  } else {
    await runConvexDeploy(convexEnv)
  }

  const repoDigest = inspectImageDigest(image)
  const digest = repoDigest.includes('@') ? repoDigest.split('@')[1] : repoDigest
  console.log(`Image digest: ${repoDigest}`)

  const kustomizePath = resolve(
    repoRoot,
    options.kustomizePath ?? process.env.JANGAR_KUSTOMIZE_PATH ?? 'argocd/applications/jangar',
  )
  const serviceManifest = resolve(
    repoRoot,
    options.serviceManifest ?? process.env.JANGAR_SERVICE_MANIFEST ?? 'argocd/applications/jangar/deployment.yaml',
  )

  // Persist image tag and rollout marker in Git before applying
  updateManifests(
    `${kustomizePath}/kustomization.yaml`,
    serviceManifest,
    imageName,
    tag,
    digest,
    new Date().toISOString(),
  )

  const { helmDir, helmBinary, cleanup } = writeHelmShim()
  const renderEnv = { PATH: `${helmDir}:${process.env.PATH ?? ''}`, HELM_BIN: helmBinary }
  const rendered = await capture(['kustomize', 'build', kustomizePath, '--enable-helm'], renderEnv)
  const tmpDir = mkdtempSync(`${tmpdir()}/jangar-render-`)
  const tmpPath = resolve(tmpDir, 'manifests.yaml')
  try {
    writeFileSync(tmpPath, rendered)
    await run('kubectl', ['apply', '-f', tmpPath])
  } finally {
    cleanup()
    try {
      rmSync(tmpPath, { force: true })
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy jangar', error))
}

export const __private = { capture, execGit, readConvexEnvFromCluster, updateManifests }
