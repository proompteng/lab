import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'

// Preserve package-relative native/WASM assets and only the external runtime dependency closure.
const [source, destination] = process.argv.slice(2)
if (!source || !destination) throw new Error('Usage: copy-runtime-dependencies.mjs <service> <destination>')
const installed = new Map()
const root = resolve(destination, 'node_modules')
mkdirSync(root, { recursive: true })

function locate(name, parent, optional) {
  const require = createRequire(join(parent, 'package.json'))
  for (const search of require.resolve.paths(name) ?? []) {
    const manifest = join(search, name, 'package.json')
    if (existsSync(manifest)) return realpathSync(dirname(manifest))
  }
  if (!optional) throw new Error(`Missing runtime dependency ${name} from ${parent}`)
}

function copy(name, parent, targetModules, optional = false) {
  const directory = locate(name, parent, optional)
  if (directory === undefined) return
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  let target = installed.get(directory)
  if (target === undefined) {
    target = join(root, '.runtime', `${name.replaceAll('/', '+')}@${manifest.version}`)
    if ([...installed.values()].includes(target)) throw new Error(`Conflicting package identity ${name}`)
    installed.set(directory, target)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(directory, target, {
      recursive: true,
      dereference: true,
      filter: (path) => basename(path) !== 'node_modules',
    })
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      copy(dependency, directory, join(target, 'node_modules'), dependency in (manifest.optionalDependencies ?? {}))
    for (const dependency of Object.keys(manifest.peerDependencies ?? {}))
      if (!(dependency in (manifest.dependencies ?? {})) && !(dependency in (manifest.optionalDependencies ?? {})))
        copy(
          dependency,
          directory,
          join(target, 'node_modules'),
          manifest.peerDependenciesMeta?.[dependency]?.optional === true,
        )
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {}))
      if (!(dependency in (manifest.dependencies ?? {})))
        copy(dependency, directory, join(target, 'node_modules'), true)
  }
  const link = join(targetModules, name)
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(relative(dirname(link), target), link, 'dir')
}

for (const name of ['tigerbeetle-node', '@platformatic/kafka']) copy(name, resolve(source), root)
