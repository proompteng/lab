#!/usr/bin/env bun

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const chromeExecutable = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const defaultProfile =
  process.env.CHROME_DEFAULT_PROFILE ?? join(homedir(), 'Library/Application Support/Google/Chrome/Default')
const userDataDir =
  process.env.CHROME_DEVTOOLS_USER_DATA ?? join(homedir(), 'Library/Application Support/Google/Chrome DevTools')
const remoteDebugPort = Number.parseInt(process.env.CHROME_REMOTE_DEBUG_PORT ?? '', 10) || 9222

function assertPathExists(path: string, message: string) {
  if (!existsSync(path)) {
    console.error(message)
    process.exit(1)
  }
}

async function run(cmd: string, args: string[]) {
  console.log(['$', cmd, ...args].join(' '))
  const proc = Bun.spawn([cmd, ...args], { stdout: 'inherit', stderr: 'inherit' })
  await proc.exited
  if (proc.exitCode !== 0) {
    throw new Error(`Command failed (${proc.exitCode}): ${cmd} ${args.join(' ')}`)
  }
}

async function seedProfile() {
  mkdirSync(userDataDir, { recursive: true })
  const targetProfile = join(userDataDir, 'Default')

  if (existsSync(targetProfile)) {
    console.log(`Reusing existing DevTools profile at: ${targetProfile}`)
    return
  }

  console.log('Seeding DevTools profile from Default (one-time)...')
  await run('cp', ['-R', defaultProfile, targetProfile])
}

async function main() {
  assertPathExists(chromeExecutable, `Chrome executable not found at ${chromeExecutable}. Set CHROME_PATH to override.`)
  assertPathExists(
    defaultProfile,
    `Default profile not found at ${defaultProfile}. Set CHROME_DEFAULT_PROFILE if needed.`,
  )

  await seedProfile()

  const args = [
    `--user-data-dir=${userDataDir}`,
    '--profile-directory=Default',
    `--remote-debugging-port=${remoteDebugPort}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]

  console.log('Launching Chrome with remote debugging for MCP...')
  console.log([chromeExecutable, ...args].join(' '))

  const proc = Bun.spawn([chromeExecutable, ...args], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  await proc.exited
  process.exit(proc.exitCode ?? 0)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
