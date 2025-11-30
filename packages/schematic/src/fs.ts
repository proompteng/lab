import { mkdir, writeFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { GeneratedFile } from './templates/tanstackStartService'

export type WriteOptions = {
  dryRun?: boolean
  force?: boolean
  root?: string
}

export const writeFiles = async (files: GeneratedFile[], options: WriteOptions = {}) => {
  const root = options.root ?? process.cwd()
  const collisions: string[] = []

  for (const file of files) {
    const target = resolve(root, file.path)
    if (!options.force) {
      try {
        await access(target, constants.F_OK)
        collisions.push(target)
      } catch {
        // file missing: ok
      }
    }
  }

  if (collisions.length > 0) {
    throw new Error(`Refusing to overwrite existing files: ${collisions.join(', ')}`)
  }

  if (options.dryRun) {
    return
  }

  for (const file of files) {
    const target = resolve(root, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.contents, 'utf8')
    if (file.executable) {
      await Bun.spawn(['chmod', '+x', target]).exited
    }
  }
}
