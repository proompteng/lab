import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '..')

type RepositoryConfig = {
  type?: string
  url?: string
  directory?: string
}

type PackageJson = {
  name?: string
  version?: string
  description?: string
  license?: string
  type?: string
  homepage?: string
  bugs?: string | { url?: string }
  bin?: Record<string, string>
  files?: string[]
  publishConfig?: { access?: string }
  repository?: RepositoryConfig
}

const normalizePath = (value: string) => value.replace(/^\.\//, '').replace(/\/$/, '')

const isSemver = (value: string) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)

const main = async () => {
  const packagePath = resolve(root, 'package.json')
  const data = await readFile(packagePath, 'utf8')
  const pkg = JSON.parse(data) as PackageJson
  const errors: string[] = []

  if (pkg.name !== '@proompteng/agentctl') {
    errors.push('package.json name must be @proompteng/agentctl')
  }

  if (!pkg.version || !isSemver(pkg.version)) {
    errors.push('package.json version must be a semver string')
  }

  if (!pkg.description || !pkg.description.trim()) {
    errors.push('package.json description must be set')
  }

  if (pkg.license !== 'MIT') {
    errors.push('package.json license must be MIT')
  }

  if (pkg.type !== 'module') {
    errors.push('package.json type must be module')
  }

  if (pkg.homepage !== 'https://github.com/proompteng/lab/tree/main/services/jangar/agentctl') {
    errors.push('package.json homepage must point to the agentctl directory')
  }

  const bugsUrl = typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs?.url
  if (bugsUrl !== 'https://github.com/proompteng/lab/issues') {
    errors.push('package.json bugs must point to https://github.com/proompteng/lab/issues')
  }

  if (pkg.repository?.type !== 'git') {
    errors.push('package.json repository.type must be git')
  }

  if (pkg.repository?.url !== 'https://github.com/proompteng/lab.git') {
    errors.push('package.json repository.url must be https://github.com/proompteng/lab.git')
  }

  if (pkg.repository?.directory !== 'services/jangar/agentctl') {
    errors.push('package.json repository.directory must be services/jangar/agentctl')
  }

  const binPath = pkg.bin?.agentctl
  if (!binPath) {
    errors.push('package.json bin.agentctl must be set')
  } else if (normalizePath(binPath) !== 'dist/agentctl.js') {
    errors.push('package.json bin.agentctl must be dist/agentctl.js')
  }

  const files = (pkg.files ?? []).map((value) => normalizePath(value))
  if (!files.includes('dist')) {
    errors.push('package.json files must include dist')
  }
  if (!files.includes('README.md')) {
    errors.push('package.json files must include README.md')
  }

  if (pkg.publishConfig?.access !== 'public') {
    errors.push('package.json publishConfig.access must be public')
  }

  if (errors.length > 0) {
    console.error('agentctl npm metadata validation failed:')
    for (const error of errors) {
      console.error(`- ${error}`)
    }
    process.exit(1)
  }

  console.log('agentctl npm metadata validated')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
