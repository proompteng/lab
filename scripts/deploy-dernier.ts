#!/usr/bin/env bun

import { Buffer } from 'node:buffer'
import { $ } from 'bun'

$.throws(true)

if (!process.env.DOCKER_BUILDKIT) {
  process.env.DOCKER_BUILDKIT = '1'
}

function splitArgs(value: string | undefined) {
  return value
    ? value
        .split(/\s+/)
        .map((part) => part.trim())
        .filter(Boolean)
    : []
}

function shellEscape(part: string) {
  return /[^A-Za-z0-9_@%+=:,./-]/.test(part) ? `'${part.replace(/'/g, `'\\''`)}'` : part
}

async function run(parts: string[]) {
  console.log('$', parts.join(' '))
  await $`${{ raw: parts.map(shellEscape).join(' ') }}`
}

const registry = process.env.DERNIER_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
const repository = process.env.DERNIER_IMAGE_REPOSITORY ?? 'lab/dernier'
const manifestTag = process.env.DERNIER_MANIFEST_TAG ?? 'latest'
const branchName = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim().replace(/\//g, '-')
const shortSha = (await $`git rev-parse --short HEAD`.text()).trim()
const tag = process.env.DERNIER_IMAGE_TAG ?? `${branchName}-${shortSha}`
const image = `${registry}/${repository}:${tag}`

const context = process.env.DERNIER_BUILD_CONTEXT ?? 'services/dernier'
const dockerfile = process.env.DERNIER_DOCKERFILE ?? 'services/dernier/Dockerfile'
const namespace = process.env.DERNIER_KN_NAMESPACE ?? 'dernier'
const service = process.env.DERNIER_KN_SERVICE ?? 'dernier'
const knBinary = process.env.DERNIER_KN_BIN ?? 'kn'
const secretName = process.env.DERNIER_SECRET_NAME ?? 'dernier-secrets'

const buildArgs = splitArgs(process.env.DERNIER_BUILD_ARGS)
const knExtraArgs = splitArgs(process.env.DERNIER_KN_EXTRA_ARGS)

const fetchSecretValue = async (key: string) => {
  const output = await $`kubectl get secret ${secretName} --namespace ${namespace} -o json`.text()
  const payload = JSON.parse(output)
  const encoded = payload?.data?.[key]
  if (!encoded) {
    throw new Error(`Secret ${secretName} in namespace ${namespace} is missing key ${key}`)
  }
  const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim()
  if (!decoded) {
    throw new Error(`Secret ${secretName} key ${key} decoded to empty value`)
  }
  console.log(`Loaded ${key} from secret/${secretName}`)
  return decoded
}

if (!process.env.RAILS_MASTER_KEY) {
  process.env.RAILS_MASTER_KEY = await fetchSecretValue('RAILS_MASTER_KEY')
}

if (!process.env.SECRET_KEY_BASE) {
  process.env.SECRET_KEY_BASE = await fetchSecretValue('SECRET_KEY_BASE')
}

const buildParts = ['docker', 'build', '-f', dockerfile, '-t', image, ...buildArgs]
if (process.env.RAILS_MASTER_KEY) {
  buildParts.push('--secret', 'id=rails_master_key,env=RAILS_MASTER_KEY')
}
buildParts.push(context)
await run(buildParts)

await run(['docker', 'push', image])

if (manifestTag) {
  const manifestRef = `${registry}/${repository}:${manifestTag}`
  await run(['docker', 'tag', image, manifestRef])
  await run(['docker', 'push', manifestRef])
  console.log(`Updated manifest tag ${manifestRef}`)
}

const inspect = await $`docker image inspect --format '{{ index .RepoDigests 0 }}' ${image}`.text()
const digest = inspect.trim()
if (!digest || !digest.includes('@sha256:')) {
  throw new Error(`Could not resolve digest for ${image}`)
}
console.log(`Resolved image digest: ${digest}`)

const deployParts = [knBinary, 'service', 'update', service, '-n', namespace, '--image', digest, ...knExtraArgs]
await run(deployParts)

console.log(`Updated Knative service ${service} in namespace ${namespace}`)
