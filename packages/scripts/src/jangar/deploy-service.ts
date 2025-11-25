#!/usr/bin/env bun

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

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

const capture = async (cmd: string[]): Promise<string> => {
  const subprocess = Bun.spawn(cmd, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
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

  const registry = options.registry ?? process.env.JANGAR_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.JANGAR_IMAGE_REPOSITORY ?? 'lab/jangar'
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = options.tag ?? process.env.JANGAR_IMAGE_TAG ?? defaultTag
  const imageName = `${registry}/${repository}`
  const image = `${registry}/${repository}:${tag}`

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
    options.serviceManifest ?? process.env.JANGAR_SERVICE_MANIFEST ?? 'argocd/applications/jangar/kservice.yaml',
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

  await run('kubectl', ['apply', '-k', kustomizePath])
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy jangar', error))
}

export const __private = { capture, execGit, readConvexEnvFromCluster, updateManifests }
