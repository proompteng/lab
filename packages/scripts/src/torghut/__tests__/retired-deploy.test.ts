import { expect, it } from 'bun:test'
import { fileURLToPath } from 'node:url'

it('rejects the retired deploy command before using tools, including when migrations are skipped', () => {
  const entry = fileURLToPath(new URL('../deploy-service.ts', import.meta.url))
  const result = Bun.spawnSync([process.execPath, entry], {
    env: { ...process.env, PATH: '', TORGHUT_SKIP_MIGRATIONS: 'true' },
  })
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain('deploy:torghut has been retired')
  expect(result.stderr.toString()).toContain('CI, Kargo, and Argo')
  expect(result.stdout.toString()).toBe('')
})
