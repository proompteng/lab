import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compilerDependencyBytes } from './jev-compiler-dependencies'

test('compiler consumes only dependency bytes and package metadata from the pinned image receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-dependency-bytes-'))
  try {
    const directory = join(root, 'node_modules/fixture')
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', exports: './index.js' }),
    )
    await writeFile(join(directory, 'index.js'), 'export const value = "pinned";')
    const entrypoint = join(root, 'entry.ts')
    await writeFile(entrypoint, 'import {value} from "fixture";console.log(value);')
    const recorded = compilerDependencyBytes(null)
    expect((await Bun.build({ entrypoints: [entrypoint], target: 'node', plugins: [recorded.plugin] })).success).toBe(
      true,
    )
    const files = recorded.files()
    expect(Object.keys(files).sort()).toEqual(['fixture@1.0.0/index.js', 'fixture@1.0.0/package.json'])
    const original = compilerDependencyBytes(files)
    expect((await Bun.build({ entrypoints: [entrypoint], target: 'node', plugins: [original.plugin] })).success).toBe(
      true,
    )
    original.verify()
    await writeFile(join(directory, 'index.js'), 'export const value = "ignored dependency drift";')
    expect((await Bun.build({ entrypoints: [entrypoint], target: 'node' })).success).toBe(true)
    const changed = compilerDependencyBytes(files)
    const changedFailure: unknown = await Bun.build({
      entrypoints: [entrypoint],
      target: 'node',
      plugins: [changed.plugin],
    }).catch((cause: unknown) => cause)
    expect(changedFailure).toBeInstanceOf(AggregateError)
    if (changedFailure instanceof AggregateError)
      expect(changedFailure.errors.map(String).join('\n')).toContain('dependency bytes differ')
    await writeFile(join(directory, 'index.js'), 'export const value = "pinned";')
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.1', type: 'module', exports: './index.js' }),
    )
    const metadataFailure: unknown = await Bun.build({
      entrypoints: [entrypoint],
      target: 'node',
      plugins: [compilerDependencyBytes(files).plugin],
    }).catch((cause: unknown) => cause)
    expect(metadataFailure).toBeInstanceOf(AggregateError)
    if (metadataFailure instanceof AggregateError)
      expect(metadataFailure.errors.map(String).join('\n')).toContain('dependency bytes differ')
    await writeFile(entrypoint, 'console.log("graph changed");')
    const omitted = compilerDependencyBytes(files)
    expect((await Bun.build({ entrypoints: [entrypoint], target: 'node', plugins: [omitted.plugin] })).success).toBe(
      true,
    )
    expect(omitted.verify).toThrow('dependency graph differs')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
