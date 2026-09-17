#!/usr/bin/env bun
import { resolve } from 'node:path'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log(
    'Usage: bun run release:temporal [--dry-run]\n\nOpen or update the SDK version PR from main using your GitHub CLI login.\nMerge the reviewed PR to publish automatically after CI passes.',
  )
  process.exit(0)
}
if (args.some((arg) => arg !== '--dry-run')) {
  throw new Error('Usage: bun run release:temporal [--dry-run]')
}

const auth = Bun.spawn(['gh', 'auth', 'token', '--hostname', 'github.com'], { stdout: 'pipe', stderr: 'ignore' })
const [authCode, token] = await Promise.all([auth.exited, new Response(auth.stdout).text()])
if (authCode !== 0 || !token.trim()) {
  throw new Error('GitHub CLI authentication is required. Run gh auth login, then retry.')
}

const child = Bun.spawn(
  [
    'bunx',
    '--bun',
    'release-please@17.11.2',
    'release-pr',
    '--repo-url=proompteng/lab',
    '--target-branch=main',
    '--config-file=release-please-config.json',
    '--manifest-file=.release-please-manifest.json',
    '--token=/dev/stdin',
    ...args,
  ],
  { cwd: resolve(import.meta.dir, '../../..'), stdin: new Blob([token.trim()]), stdout: 'inherit', stderr: 'inherit' },
)
process.exitCode = await child.exited
