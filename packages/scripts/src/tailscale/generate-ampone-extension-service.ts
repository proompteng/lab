#!/usr/bin/env bun

import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { ensureCli, fatal, repoRoot } from '../shared/cli'

const DEFAULT_OP_TAILSCALE_AUTH_PATH = 'op://infra/tailscale auth key/authkey'
const DEFAULT_TEMPLATE_PATH = resolve(repoRoot, 'devices/ampone/manifests/tailscale-extension-service.template.yaml')
const DEFAULT_OUTPUT_PATH = resolve(repoRoot, 'devices/ampone/manifests/tailscale-extension-service.yaml')
const AUTHKEY_PLACEHOLDER = '${TAILSCALE_AUTHKEY}'

const capture = async (cmd: string[]) => {
  const subprocess = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])

  if (exitCode !== 0) {
    fatal(`Command failed (${exitCode}): ${cmd.join(' ')}`, stderr || stdout)
  }

  return stdout
}

const parseArgs = () => {
  const args = Bun.argv.slice(2)
  if (args.length > 1) {
    fatal('Usage: generate-ampone-extension-service.ts [output-path]')
  }
  if (args[0]?.startsWith('-')) {
    fatal(`Unknown flag '${args[0]}'`)
  }
  const outputPath = args[0] ? resolve(process.cwd(), args[0]) : DEFAULT_OUTPUT_PATH
  return { outputPath }
}

const readAuthKey = async () => {
  ensureCli('op')
  const opPath = process.env.AMPONE_TAILSCALE_AUTHKEY_OP_PATH ?? DEFAULT_OP_TAILSCALE_AUTH_PATH
  const value = (await capture(['op', 'read', opPath])).trim().replace(/\r/g, '')
  if (!value) {
    fatal(`Tailscale auth key is empty. Check 1Password path: ${opPath}`)
  }
  return value
}

const readTemplate = async (templatePath: string) => {
  try {
    return await Bun.file(templatePath).text()
  } catch (error) {
    fatal(`Failed to read template: ${templatePath}`, error)
  }
}

const main = async () => {
  const { outputPath } = parseArgs()
  const templatePath = process.env.AMPONE_TAILSCALE_TEMPLATE_PATH ?? DEFAULT_TEMPLATE_PATH
  const authKey = await readAuthKey()
  const template = await readTemplate(templatePath)

  if (!template.includes(AUTHKEY_PLACEHOLDER)) {
    fatal(`Template missing ${AUTHKEY_PLACEHOLDER}: ${templatePath}`)
  }

  const rendered = template.replace(AUTHKEY_PLACEHOLDER, authKey)
  if (rendered.includes(AUTHKEY_PLACEHOLDER)) {
    fatal(`Failed to render ${AUTHKEY_PLACEHOLDER} into ${outputPath}`)
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  await Bun.write(outputPath, rendered)
  chmodSync(outputPath, 0o600)

  console.log(`Wrote Tailscale ExtensionServiceConfig to ${outputPath}`)
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to generate Tailscale extension service config', error))
}
