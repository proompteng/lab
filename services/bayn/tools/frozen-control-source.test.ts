import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { compilerDependencyBytes } from './jev-compiler-dependencies'
import { frozenControlSource } from './frozen-control-source'

test('offline control compilation consumes pinned source and dependency bytes, independent of live source names', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'bayn-frozen-source-'))
  try {
    const dependency = join(temporary, 'node_modules/pinned')
    await mkdir(dependency, { recursive: true })
    await writeFile(
      join(dependency, 'package.json'),
      JSON.stringify({ name: 'pinned', version: '1.2.3', type: 'module', exports: './index.js' }),
    )
    await writeFile(join(dependency, 'index.js'), 'export const fee = 7;')
    const files = new Map([
      [
        'services/bayn/src/main.ts',
        'import {profit} from "./policy"; export const result = profit(100); if (import.meta.main) console.log(result);',
      ],
      [
        'services/bayn/src/policy.ts',
        'import {fee} from "pinned"; import costs from "./costs.json"; export const profit = (gross: number) => gross - fee - costs.fixed;',
      ],
      ['services/bayn/src/costs.json', '{"fixed":13}'],
    ])
    const source = frozenControlSource({
      paths: new Set(files.keys()),
      dependenciesDirectory: temporary,
      read: (path) => {
        const contents = files.get(path)
        if (contents === undefined) throw Error(`Missing test source ${path}`)
        return new TextEncoder().encode(contents)
      },
    })
    const dependencies = compilerDependencyBytes(null)
    const built = await Bun.build({
      root: temporary,
      entrypoints: [source.entrypoint('services/bayn/src/main.ts')],
      target: 'node',
      plugins: [source.plugin, dependencies.plugin],
    })
    expect(built.success).toBe(true)
    const output = built.outputs[0]
    if (output === undefined) throw Error('Missing compiled control')
    const path = join(temporary, 'control.mjs')
    await writeFile(path, new Uint8Array(await output.arrayBuffer()))
    const result: unknown = await import(path)
    expect(result).toMatchObject({ result: 80 })
    const launched = Bun.spawnSync([process.execPath, path])
    expect(launched.exitCode).toBe(0)
    expect(launched.stdout.toString().trim()).toBe('80')
    expect(source.files()).toEqual(
      Object.fromEntries(
        [...files].map(([path, content]) => [path, createHash('sha256').update(content).digest('hex')]),
      ),
    )
    expect(Object.keys(dependencies.files()).sort()).toEqual(['pinned@1.2.3/index.js', 'pinned@1.2.3/package.json'])
    source.verify()
    dependencies.verify()
    files.set('services/bayn/src/policy.ts', 'export const profit = () => 999;')
    expect(source.verify).toThrow('Frozen source bytes changed')
    expect(() => source.entrypoint('services/bayn/../../apps/live.ts')).toThrow('escapes the service')
    expect(() => source.entrypoint('services/bayn/src/missing.ts')).toThrow('Missing frozen source module')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
