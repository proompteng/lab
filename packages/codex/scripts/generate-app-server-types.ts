import { spawnSync } from 'node:child_process'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const target = fileURLToPath(new URL('../src/app-server', import.meta.url))
const temporary = await mkdtemp(join(dirname(target), '.app-server-'))
try {
  const result = spawnSync('codex', ['app-server', 'generate-ts', '--experimental', '--out', temporary], {
    stdio: 'inherit',
  })
  if (result.status !== 0) throw result.error ?? new Error(`Codex type generation exited with ${result.status}`)
  await rm(target, { recursive: true, force: true })
  await rename(temporary, target)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
