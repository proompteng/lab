#!/usr/bin/env bun

import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { execGit } from '../shared/git'
import { parse } from 'yaml'

type FunctionPackage = {
  name: string
  path: string
}

type Options = {
  push: boolean
  registry: string
  tag: string
  extraTag?: string
  configsOnly: boolean
  functionsOnly: boolean
  functions: FunctionPackage[]
}

const DEFAULT_REGISTRY = 'registry.ide-newton.ts.net/lab'
const DEFAULT_TAG = 'latest'

const printUsage = () => {
  console.log(`Usage: bun run packages/scripts/src/crossplane/build-xpkgs.ts [options]

Options:
  --push                 Push built packages to the registry.
  --registry <value>      Registry base (default: ${DEFAULT_REGISTRY}).
  --tag <value>           Tag to push (default: ${DEFAULT_TAG}).
  --extra-tag <value>     Additional tag to push (e.g., commit SHA).
  --tag-sha               Push an extra tag using the current git SHA (12 chars).
  --configs-only          Only build configuration packages.
  --functions-only        Only build function packages.
  --function name=path    Add a function package root (repeatable).
  --help                  Show this help text.

Examples:
  bun run packages/scripts/src/crossplane/build-xpkgs.ts
  bun run packages/scripts/src/crossplane/build-xpkgs.ts --push --tag latest --tag-sha
  bun run packages/scripts/src/crossplane/build-xpkgs.ts --push \
    --function function-map-to-list=../crossplane-functions/map-to-list
`)
}

const parseArgs = (): Options => {
  const args = process.argv.slice(2)
  const options: Options = {
    push: false,
    registry: DEFAULT_REGISTRY,
    tag: DEFAULT_TAG,
    configsOnly: false,
    functionsOnly: false,
    functions: [],
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--help') {
      printUsage()
      process.exit(0)
    }
    if (arg === '--push') {
      options.push = true
      continue
    }
    if (arg === '--configs-only') {
      options.configsOnly = true
      continue
    }
    if (arg === '--functions-only') {
      options.functionsOnly = true
      continue
    }
    if (arg === '--tag-sha') {
      options.extraTag = execGit(['rev-parse', '--short=12', 'HEAD'])
      continue
    }
    if (arg === '--registry' && args[i + 1]) {
      options.registry = args[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--registry=')) {
      options.registry = arg.split('=')[1] ?? options.registry
      continue
    }
    if (arg === '--tag' && args[i + 1]) {
      options.tag = args[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--tag=')) {
      options.tag = arg.split('=')[1] ?? options.tag
      continue
    }
    if (arg === '--extra-tag' && args[i + 1]) {
      options.extraTag = args[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--extra-tag=')) {
      options.extraTag = arg.split('=')[1] ?? options.extraTag
      continue
    }
    if (arg === '--function' && args[i + 1]) {
      const raw = args[i + 1]
      i += 1
      const [name, rawPath] = raw.split('=')
      if (!name || !rawPath) {
        fatal(`Invalid --function '${raw}'. Expected name=path.`)
      }
      const resolvedPath = rawPath.startsWith('/') ? rawPath : resolve(repoRoot, rawPath)
      options.functions.push({ name, path: resolvedPath })
      continue
    }
    if (arg.startsWith('--function=')) {
      const raw = arg.split('=')[1] ?? ''
      const [name, rawPath] = raw.split('=')
      if (!name || !rawPath) {
        fatal(`Invalid --function '${raw}'. Expected name=path.`)
      }
      const resolvedPath = rawPath.startsWith('/') ? rawPath : resolve(repoRoot, rawPath)
      options.functions.push({ name, path: resolvedPath })
      continue
    }

    fatal(`Unknown argument: ${arg}`)
  }

  if (options.configsOnly && options.functionsOnly) {
    fatal('Cannot combine --configs-only with --functions-only.')
  }

  return options
}

const findLatestXpkg = async (dir: string) => {
  const entries = await readdir(dir)
  const candidates = entries.filter((entry) => entry.endsWith('.xpkg'))
  if (candidates.length === 0) {
    fatal(`No .xpkg files found in ${dir}. Did the build succeed?`)
  }
  if (candidates.length === 1) {
    return resolve(dir, candidates[0])
  }

  const stats = await Promise.all(
    candidates.map(async (entry) => ({
      entry,
      stat: await stat(resolve(dir, entry)),
    })),
  )
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
  return resolve(dir, stats[0].entry)
}

const buildPackage = async (root: string) => {
  await run('crossplane', ['xpkg', 'build', '--package-root=.', '--ignore=**/examples/**'], {
    cwd: root,
  })
  return findLatestXpkg(root)
}

const readFunctionMetadata = async (root: string) => {
  const pkgPath = resolve(root, 'package', 'crossplane.yaml')
  try {
    const raw = await readFile(pkgPath, 'utf8')
    const doc = parse(raw) as { kind?: string; metadata?: { name?: string } } | null
    if (!doc || doc.kind !== 'Function') {
      return null
    }
    return { name: doc.metadata?.name ?? '' }
  } catch {
    return null
  }
}

const discoverFunctionPackages = async (): Promise<FunctionPackage[]> => {
  const functionsRoot = resolve(repoRoot, 'packages/crossplane/functions')
  let entries: string[]
  try {
    entries = await readdir(functionsRoot)
  } catch {
    return []
  }

  const packages: FunctionPackage[] = []
  for (const entry of entries) {
    const root = resolve(functionsRoot, entry)
    const stats = await stat(root)
    if (!stats.isDirectory()) continue
    const metadata = await readFunctionMetadata(root)
    if (!metadata) continue
    packages.push({ name: metadata.name || entry, path: root })
  }
  return packages
}

const resolveFunctionPackages = async (options: Options) => {
  if (options.functions.length > 0) return options.functions
  return discoverFunctionPackages()
}

const buildFunctionPackage = async (fnPackage: FunctionPackage, tag: string) => {
  ensureCli('docker')
  const runtimeImage = `local/${fnPackage.name}:${tag}`
  await run('docker', ['build', '.', '-t', runtimeImage], { cwd: fnPackage.path })
  await run('crossplane', ['xpkg', 'build', '-f', 'package', `--embed-runtime-image=${runtimeImage}`], {
    cwd: fnPackage.path,
  })
  return findLatestXpkg(resolve(fnPackage.path, 'package'))
}

const pushPackage = async (xpkgPath: string, registry: string, name: string, tag: string) => {
  await run('crossplane', ['xpkg', 'push', '-f', xpkgPath, `${registry}/${name}:${tag}`], {
    cwd: repoRoot,
  })
}

const buildConfigurations = async (options: Options) => {
  const crossplaneRoot = resolve(repoRoot, 'packages/crossplane')
  const entries = await readdir(crossplaneRoot)
  const configs = entries.filter((entry) => entry.startsWith('configuration-'))

  if (configs.length === 0) {
    console.warn(`No configuration packages found under ${crossplaneRoot}.`)
    return
  }

  for (const name of configs) {
    const root = resolve(crossplaneRoot, name)
    const xpkgPath = await buildPackage(root)
    if (!options.push) {
      console.log(`Built ${name}: ${xpkgPath}`)
      continue
    }

    await pushPackage(xpkgPath, options.registry, name, options.tag)
    if (options.extraTag) {
      await pushPackage(xpkgPath, options.registry, name, options.extraTag)
    }
  }
}

const buildFunctions = async (options: Options) => {
  const functionPackages = await resolveFunctionPackages(options)
  if (functionPackages.length === 0) {
    console.warn('No function packages found. Use --function name=path to add them.')
    return
  }

  for (const fnPackage of functionPackages) {
    const xpkgPath = await buildFunctionPackage(fnPackage, options.tag)
    if (!options.push) {
      console.log(`Built ${fnPackage.name}: ${xpkgPath}`)
      continue
    }

    await pushPackage(xpkgPath, options.registry, fnPackage.name, options.tag)
    if (options.extraTag) {
      await pushPackage(xpkgPath, options.registry, fnPackage.name, options.extraTag)
    }
  }
}

const main = async () => {
  const options = parseArgs()
  ensureCli('crossplane')

  if (!options.functionsOnly) {
    await buildConfigurations(options)
  }

  if (!options.configsOnly) {
    await buildFunctions(options)
  }
}

if (import.meta.main) {
  main().catch((error) => {
    fatal('Failed to build Crossplane packages.', error)
  })
}
