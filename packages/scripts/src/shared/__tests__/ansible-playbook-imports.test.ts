import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'bun:test'

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const playbooksDir = resolve(repoRoot, 'ansible/playbooks')

test('Ansible playbook imports resolve to tracked files', () => {
  const playbooks = readdirSync(playbooksDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => resolve(playbooksDir, name))

  for (const playbook of playbooks) {
    const content = readFileSync(playbook, 'utf8')
    const imports = content.matchAll(/^\s*(?:ansible\.builtin\.)?import_playbook:\s*['"]?([^'"\s#]+)['"]?/gm)

    for (const [, target] of imports) {
      expect(existsSync(resolve(dirname(playbook), target!))).toBeTrue()
    }
  }
})
