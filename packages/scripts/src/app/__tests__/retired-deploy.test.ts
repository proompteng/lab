import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

test.each([
  ['packages/scripts/src/app/deploy-service.ts', 'Module not found'],
  ['app:deploy', 'Script not found'],
])('rejects %s with or without legacy deploy flags before running any tools', (entry, error) => {
  const bin = mkdtempSync(join(tmpdir(), 'app-retired-deploy-'))
  try {
    const commandLog = join(bin, 'commands.log')
    writeFileSync(commandLog, '')
    symlinkSync(process.execPath, join(bin, 'bun'))
    for (const tool of ['git', 'nix', 'crane', 'skopeo', 'kubectl']) {
      writeFileSync(join(bin, tool), '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$COMMAND_LOG"\nexit 1\n', {
        mode: 0o755,
      })
    }

    for (const args of [[], ['--dry-run'], ['--no-apply'], ['--apply']]) {
      const result = Bun.spawnSync([process.execPath, '--no-env-file', 'run', entry, ...args], {
        cwd: repoRoot,
        env: { HOME: bin, PATH: bin, COMMAND_LOG: commandLog },
      })

      expect(readFileSync(commandLog, 'utf8')).toBe('')
      expect(result.exitCode).toBe(1)
      expect(result.stdout.toString()).toBe('')
      expect(result.stderr.toString()).toContain(`${error} "${entry}"`)
    }
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})
