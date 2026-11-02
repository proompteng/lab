import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

export const compilerDependencyBytes = (expected: Readonly<Record<string, string>> | null) => {
  const files = new Map<string, string>()
  const packageRoots = new Map<string, { name: string; version: string }>()
  const retain = (key: string, bytes: Uint8Array) => {
    const hash = createHash('sha256').update(bytes).digest('hex')
    if ((expected !== null && expected[key] !== hash) || (files.has(key) && files.get(key) !== hash))
      throw Error(`Compiler dependency bytes differ from the pinned image: ${key}`)
    files.set(key, hash)
  }
  const plugin: Bun.BunPlugin = {
    name: 'bayn-pinned-compiler-dependencies',
    setup(build) {
      build.onLoad({ filter: /[/\\]node_modules[/\\]/ }, (file) => {
        const marker = '/node_modules/'
        const offset = file.path.lastIndexOf(marker)
        if (offset < 0) throw Error('Compiler dependency has no package root')
        const parts = file.path.slice(offset + marker.length).split('/')
        const name = parts.slice(0, parts[0]?.startsWith('@') ? 2 : 1).join('/')
        const root = file.path.slice(0, offset + marker.length) + name
        let identity = packageRoots.get(root)
        if (identity === undefined) {
          const bytes = readFileSync(root + '/package.json')
          const value: unknown = JSON.parse(bytes.toString('utf8'))
          if (
            typeof value !== 'object' ||
            value === null ||
            !('name' in value) ||
            value.name !== name ||
            !('version' in value) ||
            typeof value.version !== 'string' ||
            !/^[\w.+-]+$/.test(value.version)
          )
            throw Error('Invalid compiler dependency package identity')
          identity = { name, version: value.version }
          retain(`${identity.name}@${identity.version}/package.json`, bytes)
          packageRoots.set(root, identity)
        }
        const contents = readFileSync(file.path)
        retain(`${identity.name}@${identity.version}/${relative(root, file.path)}`, contents)
        return { contents, loader: file.loader }
      })
    },
  }
  return {
    plugin,
    files: () => Object.fromEntries([...files].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))),
    verify: () => {
      for (const [root, identity] of packageRoots)
        retain(`${identity.name}@${identity.version}/package.json`, readFileSync(root + '/package.json'))
      if (
        expected !== null &&
        (Object.keys(expected).length !== files.size || Object.keys(expected).some((key) => !files.has(key)))
      )
        throw Error('Compiler dependency graph differs from the pinned image')
    },
  }
}
