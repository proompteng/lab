import { createHash } from 'node:crypto'
import { isBuiltin } from 'node:module'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, posix } from 'node:path'
import { frozenControlOrigin } from '../src/system-assessment/frozen-control-identity'

export const frozenControlSourceRevision = frozenControlOrigin.sourceRevision
export const frozenControlServiceTree = frozenControlOrigin.serviceTree
const namespace = 'bayn-frozen-control'
const virtualRoot = `/${namespace}/`
const root = 'services/bayn/'

/** Authenticate the immutable Nix source input against its original Git tree, without requiring a Git checkout. */
export const readFrozenControlDirectory = (directory: string) => {
  const files = new Map<string, Uint8Array>()
  const objectHash = (kind: 'blob' | 'tree', bytes: Uint8Array) =>
    createHash('sha1').update(`${kind} ${bytes.byteLength}\0`).update(bytes).digest()
  const walk = (path: string, relative: string): Buffer => {
    const entries: { name: string; directory: boolean; mode: string; hash: Buffer }[] = []
    for (const name of readdirSync(path)) {
      const full = join(path, name)
      const stat = lstatSync(full)
      if (stat.isDirectory())
        entries.push({ name, directory: true, mode: '40000', hash: walk(full, relative + name + '/') })
      else if (stat.isFile()) {
        const contents = readFileSync(full)
        files.set(root + relative + name, contents)
        entries.push({
          name,
          directory: false,
          mode: (stat.mode & 0o111) !== 0 ? '100755' : '100644',
          hash: objectHash('blob', contents),
        })
      } else throw Error('Frozen service must contain regular Git blobs only')
    }
    // Git sorts a directory as if its name ended with a slash.
    entries.sort((a, b) =>
      Buffer.compare(Buffer.from(a.name + (a.directory ? '/' : '')), Buffer.from(b.name + (b.directory ? '/' : ''))),
    )
    return objectHash(
      'tree',
      Buffer.concat(entries.flatMap((entry) => [Buffer.from(`${entry.mode} ${entry.name}\0`), entry.hash])),
    )
  }
  if (walk(directory, '').toString('hex') !== frozenControlServiceTree)
    throw Error('Frozen source directory differs from the pinned original Git tree')
  return {
    paths: new Set(files.keys()),
    read: (path: string) => {
      const contents = files.get(path)
      if (contents === undefined) throw Error(`Unknown frozen source path: ${path}`)
      return contents.slice()
    },
  }
}

/** Resolve historical modules from immutable Git objects; never read a similarly named working-tree source. */
export const frozenControlSource = (source: {
  readonly paths: ReadonlySet<string>
  readonly read: (path: string) => Uint8Array
  readonly dependenciesDirectory: string
}) => {
  const hashes = new Map<string, string>()
  const resolve = (path: string) => {
    const normalized = posix.normalize(path)
    if (!normalized.startsWith(root)) throw Error(`Frozen source import escapes the service: ${path}`)
    const selected = [normalized, `${normalized}.ts`, `${normalized}/index.ts`, `${normalized}.json`].find(
      (candidate) => source.paths.has(candidate),
    )
    if (selected === undefined) throw Error(`Missing frozen source module: ${normalized}`)
    return selected
  }
  const plugin: Bun.BunPlugin = {
    name: namespace,
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path.startsWith(virtualRoot))
          return { path: virtualRoot + resolve(args.path.slice(virtualRoot.length)) }
        if (!args.importer.startsWith(virtualRoot)) return
        const importer = args.importer.slice(virtualRoot.length)
        if (args.path.startsWith('.'))
          return { path: virtualRoot + resolve(posix.join(posix.dirname(importer), args.path)) }
        if (isBuiltin(args.path) || args.path === 'tigerbeetle-node' || args.path === '@platformatic/kafka')
          return { path: args.path, external: true }
        return { path: Bun.resolveSync(args.path, source.dependenciesDirectory) }
      })
      build.onLoad({ filter: /^\/bayn-frozen-control\// }, (args) => {
        const path = args.path.slice(virtualRoot.length)
        const contents = source.read(path)
        const digest = createHash('sha256').update(contents).digest('hex')
        const prior = hashes.get(path)
        if (prior !== undefined && prior !== digest) throw Error(`Frozen source bytes changed: ${path}`)
        hashes.set(path, digest)
        return { contents, loader: path.endsWith('.json') ? 'json' : 'ts' }
      })
    },
  }
  return {
    plugin,
    entrypoint: (path: string) => virtualRoot + resolve(path),
    files: () => Object.fromEntries([...hashes].sort(([a], [b]) => a.localeCompare(b))),
    verify: () => {
      for (const [path, hash] of hashes)
        if (createHash('sha256').update(source.read(path)).digest('hex') !== hash)
          throw Error(`Frozen source bytes changed: ${path}`)
    },
  }
}

export const readFrozenControlGitSource = (repository: string) => {
  const git = (args: readonly string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: repository, stdin: 'ignore', stderr: 'pipe' })
    if (result.exitCode !== 0) throw Error(`Cannot read pinned control Git object: ${result.stderr.toString().trim()}`)
    return result.stdout
  }
  if (
    git(['rev-parse', `${frozenControlSourceRevision}^{commit}`])
      .toString()
      .trim() !== frozenControlSourceRevision
  )
    throw Error('Frozen control commit is unavailable')
  if (
    git(['rev-parse', `${frozenControlSourceRevision}:services/bayn`])
      .toString()
      .trim() !== frozenControlServiceTree
  )
    throw Error('Frozen control service tree differs from its pinned source identity')
  const entries = git(['ls-tree', '-rz', frozenControlSourceRevision, '--', root])
    .toString()
    .split('\0')
    .filter(Boolean)
  const objects = new Map<string, string>()
  for (const entry of entries) {
    const separator = entry.indexOf('\t')
    const [mode, kind, object] = entry.slice(0, separator).split(' ')
    const path = entry.slice(separator + 1)
    if (separator < 0 || (mode !== '100644' && mode !== '100755') || kind !== 'blob' || object === undefined)
      throw Error('Frozen service must contain regular Git blobs only')
    objects.set(path, object)
  }
  const retained = new Map<string, Uint8Array>()
  return {
    paths: new Set(objects.keys()),
    read: (path: string) => {
      const object = objects.get(path)
      if (object === undefined) throw Error(`Unknown frozen source path: ${path}`)
      let contents = retained.get(path)
      if (contents === undefined) {
        contents = git(['cat-file', 'blob', object])
        retained.set(path, contents)
      }
      return contents
    },
  }
}
