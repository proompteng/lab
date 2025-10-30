#!/usr/bin/env bun

const imageName = process.env.VECTEUR_IMAGE_NAME ?? 'registry.ide-newton.ts.net/lab/vecteur'
const dockerfile = process.env.VECTEUR_DOCKERFILE ?? 'services/vecteur/Dockerfile'
const contextPath = process.env.VECTEUR_CONTEXT_PATH ?? 'services/vecteur'
const defaultTag = process.env.VECTEUR_DEFAULT_TAG ?? '18-trixie'
const targetArch = process.env.VECTEUR_TARGET_ARCH ?? 'arm64'

const [tagArg] = Bun.argv.slice(2)
const tag = tagArg ?? defaultTag
const fullImageName = `${imageName}:${tag}`

function configSummary() {
  return { fullImageName, dockerfile, contextPath, targetArch }
}

async function run(cmd: string, args: string[]) {
  console.log(['$', cmd, ...args].join(' '))
  const proc = Bun.spawn([cmd, ...args], { stdout: 'inherit', stderr: 'inherit' })
  await proc.exited
  if (proc.exitCode !== 0) {
    throw new Error(`Command failed (${proc.exitCode}): ${cmd} ${args.join(' ')}`)
  }
}

async function main() {
  console.log('Building vecteur image with configuration:', configSummary())
  await run('docker', [
    'buildx',
    'build',
    '--platform',
    `linux/${targetArch}`,
    '-t',
    fullImageName,
    '-f',
    dockerfile,
    '--push',
    contextPath,
  ])
  console.log(`Docker image built and pushed successfully: ${fullImageName}`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
