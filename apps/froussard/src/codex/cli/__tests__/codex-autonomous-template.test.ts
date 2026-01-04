import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('codex autonomous workflow template', () => {
  it('prioritizes failing step next_prompt for reruns', async () => {
    const content = await readFile(
      resolve(process.cwd(), '../../argocd/applications/froussard/codex-autonomous-workflow-template.yaml'),
      'utf8',
    )

    expect(content).toContain('tasks.gate.outputs.parameters.next_prompt')
    expect(content).toContain('tasks.merge.outputs.parameters.next_prompt')
    expect(content).toContain('Post-deploy verification failed.')
    expect(content).toContain('tasks.judge.outputs.parameters.next_prompt')
  })
})
