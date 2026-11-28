import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { compilerDependencyBytes } from './jev-compiler-dependencies'

const args = process.argv.slice(2)
if (args.length !== 6 || args[0] !== '--spec' || args[2] !== '--dependencies' || args[4] !== '--output')
  throw Error('Usage: --spec <variant.json> --dependencies <image-receipt.json> --output <new-directory>')
const specPath = args[1],
  dependencyPath = args[3]
if (specPath === undefined || dependencyPath === undefined || Bun.version !== '1.4.2')
  throw Error('Pinned Bun 1.4.2 required')
const root = resolve(import.meta.dir, '../../..')
if ((await stat(specPath)).size > 65536 || (await stat(dependencyPath)).size > 8 * 1024 * 1024)
  throw Error('Compiler input exceeds its bound')
const specBytes = await readFile(specPath),
  dependencyBytes = await readFile(dependencyPath)
if (specBytes.length > 65536 || dependencyBytes.length > 8 * 1024 * 1024)
  throw Error('Compiler input exceeds its bound')
const spec: unknown = JSON.parse(specBytes.toString()),
  receipt: unknown = JSON.parse(dependencyBytes.toString())
if (
  typeof spec !== 'object' ||
  spec === null ||
  !('sourceRevision' in spec) ||
  !('dependencyReceiptSha256' in spec) ||
  typeof spec.sourceRevision !== 'string' ||
  !/^[a-f0-9]{40}$/.test(spec.sourceRevision) ||
  spec.dependencyReceiptSha256 !== createHash('sha256').update(dependencyBytes).digest('hex') ||
  typeof receipt !== 'object' ||
  receipt === null ||
  !('sourceRevision' in receipt) ||
  receipt.sourceRevision !== spec.sourceRevision ||
  !('compilerFiles' in receipt) ||
  typeof receipt.compilerFiles !== 'object' ||
  receipt.compilerFiles === null
)
  throw Error('Compiler receipt must match the exact source and file digest')
const compilerFiles: Record<string, string> = {}
for (const [name, hash] of Object.entries(receipt.compilerFiles)) {
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid compiler dependency digest')
  compilerFiles[name] = hash
}
if (Object.keys(compilerFiles).length === 0) throw Error('Compiler dependency closure is empty')
const readGit = (args: readonly string[]) => {
  const child = Bun.spawnSync(['git', ...args], { cwd: root, stdin: 'ignore', stderr: 'ignore' })
  if (child.exitCode !== 0) throw Error('Cannot verify compiler source')
  return child.stdout.toString().trim()
}
if (
  readGit(['rev-parse', 'HEAD']) !== spec.sourceRevision ||
  readGit([
    'status',
    '--porcelain',
    '--untracked-files=normal',
    '--',
    'services/bayn',
    'docs/bayn/jev-migration-acceptance-v2.json',
    '.npmrc',
    'bunfig.toml',
    'tsconfig.base.json',
    'bun.lock',
    'package.json',
    'patches',
  ]) !== ''
)
  throw Error('Compiler requires exact committed clean inputs')
const dependencies = compilerDependencyBytes(compilerFiles)
const compiled = await Bun.build({
  entrypoints: [join(root, 'services/bayn/tools/jev-instruction-variant.ts')],
  target: 'bun',
  plugins: [dependencies.plugin],
  define: { __BAYN_VARIANT_SOURCE_ROOT__: JSON.stringify(root) },
})
if (!compiled.success || compiled.outputs.length !== 1 || compiled.outputs[0] === undefined)
  throw Error('Verified compiler bundle failed')
dependencies.verify()
const temporary = await mkdtemp(join(tmpdir(), 'bayn-verified-compiler-'))
try {
  const path = join(temporary, 'compiler.mjs')
  await writeFile(path, new Uint8Array(await compiled.outputs[0].arrayBuffer()), { mode: 0o600 })
  const tool: unknown = await import(path)
  if (
    typeof tool !== 'object' ||
    tool === null ||
    !('runVariantCompiler' in tool) ||
    typeof tool.runVariantCompiler !== 'function'
  )
    throw Error('Verified compiler entry point is missing')
  tool.runVariantCompiler()
} finally {
  await rm(temporary, { recursive: true, force: true })
}
