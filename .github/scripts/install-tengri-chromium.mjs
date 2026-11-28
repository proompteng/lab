import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function run(command, args, capture = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error || result.status}`)
  return result.stdout
}

if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This installer requires Linux x64')
const plan = run('bunx', ['playwright', 'install', '--dry-run', 'chromium'], true)
const browsers = plan.split('\n\n').filter((block) => /^Chrome (for Testing|Headless Shell) /.test(block))
if (browsers.length !== 2) throw new Error('Expected the pinned Chrome and headless shell in the Playwright plan')
const temporary = mkdtempSync(join(tmpdir(), 'tengri-chromium-'))
try {
  for (const [index, browser] of browsers.entries()) {
    const directory = /Install location:\s+(\S+)/.exec(browser)?.[1]
    const source = /Download url:\s+(\S+)/.exec(browser)?.[1]
    if (!directory || !source) throw new Error('Incomplete Playwright browser plan')
    const url = new URL(source)
    if (
      url.origin !== 'https://cdn.playwright.dev' ||
      !/^\/builds\/cft\/[\d.]+\/linux64\/chrome(-headless-shell)?-linux64\.zip$/.test(url.pathname)
    )
      throw new Error('Unrecognized pinned Chrome download')
    const official = `https://storage.googleapis.com/chrome-for-testing-public/${url.pathname.slice('/builds/cft/'.length)}`
    const archive = join(temporary, `${index}.zip`)
    run('curl', [
      '--fail',
      '--location',
      '--retry',
      '3',
      '--proto',
      '=https',
      '--proto-redir',
      '=https',
      '--output',
      archive,
      official,
    ])
    mkdirSync(directory, { recursive: true })
    run('unzip', ['-q', '-o', archive, '-d', directory])
    writeFileSync(join(directory, 'INSTALLATION_COMPLETE'), '')
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
run('bunx', ['playwright', 'install', '--with-deps', 'chromium'])
