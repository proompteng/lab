#!/usr/bin/env bun

import { resolve } from 'node:path'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'

const main = async () => {
  ensureCli('go')

  const configPath = resolve(repoRoot, process.env.FACTEUR_CONSUMER_CONFIG ?? 'services/facteur/config/example.yaml')

  console.log(`Starting facteur consumer with config ${configPath}`)

  await run('go', ['run', '.', 'consume', '--config', configPath], {
    cwd: resolve(repoRoot, 'services/facteur'),
  })
}

main().catch((error) => fatal('Failed to start facteur consumer', error))
