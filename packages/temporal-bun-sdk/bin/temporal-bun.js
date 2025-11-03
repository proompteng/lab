#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')
const distScript = join(root, 'dist', 'bin', 'temporal-bun.js')

if (!existsSync(distScript)) {
  console.error('temporal-bun CLI is not built. Run `pnpm --filter @proompteng/temporal-bun-sdk run build` first.')
  process.exit(1)
}

await import(pathToFileURL(distScript).href)
