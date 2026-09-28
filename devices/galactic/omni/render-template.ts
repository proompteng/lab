import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tailscalePlaceholder = '__GALACTIC_TAILSCALE_AUTH_KEY__'
const joinTokenPlaceholder = '__GALACTIC_OMNI_JOIN_TOKEN__'
const expectedMachineCount = 3

export type TemplateSecrets = {
  tailscaleAuthKey: string
  omniJoinToken: string
}

const uniqueMatch = (input: string, pattern: RegExp, name: string): string => {
  const values = new Set(Array.from(input.matchAll(pattern), (match) => match[1]))

  if (values.size !== 1) {
    throw new Error(`expected exactly one unique ${name}, found ${values.size}`)
  }

  return values.values().next().value as string
}

const validateSecret = (value: string, name: string): string => {
  if (!value || /\s/.test(value)) {
    throw new Error(`${name} must be a non-empty token without whitespace`)
  }

  return value
}

export const extractSecrets = (rawExport: string): TemplateSecrets => ({
  tailscaleAuthKey: validateSecret(
    uniqueMatch(rawExport, /TS_AUTHKEY=([^\s]+)/g, 'Tailscale auth key'),
    'Tailscale auth key',
  ),
  omniJoinToken: validateSecret(uniqueMatch(rawExport, /jointoken=([^&\s]+)/g, 'Omni join token'), 'Omni join token'),
})

const count = (input: string, value: string): number => input.split(value).length - 1

export const renderTemplate = (template: string, secrets: TemplateSecrets): string => {
  if (count(template, tailscalePlaceholder) !== expectedMachineCount) {
    throw new Error(`expected ${expectedMachineCount} Tailscale placeholders`)
  }

  if (count(template, joinTokenPlaceholder) !== expectedMachineCount) {
    throw new Error(`expected ${expectedMachineCount} Omni join-token placeholders`)
  }

  const rendered = template
    .replaceAll(tailscalePlaceholder, validateSecret(secrets.tailscaleAuthKey, 'Tailscale auth key'))
    .replaceAll(joinTokenPlaceholder, validateSecret(secrets.omniJoinToken, 'Omni join token'))

  if (rendered.includes(tailscalePlaceholder) || rendered.includes(joinTokenPlaceholder)) {
    throw new Error('rendered template still contains secret placeholders')
  }

  return rendered
}

const valueAfter = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag)
  if (index === -1) return undefined

  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)

  return value
}

const main = () => {
  const args = process.argv.slice(2)
  const scriptDirectory = dirname(fileURLToPath(import.meta.url))
  const templatePath = resolve(valueAfter(args, '--template') ?? resolve(scriptDirectory, 'cluster-template.yaml'))
  const outputArgument = valueAfter(args, '--output')

  if (!outputArgument || !isAbsolute(outputArgument)) {
    throw new Error('--output must be an absolute path')
  }

  const secretsFrom = valueAfter(args, '--secrets-from')
  const exportedSecrets = secretsFrom ? extractSecrets(readFileSync(resolve(secretsFrom), 'utf8')) : undefined
  const secrets: TemplateSecrets = {
    tailscaleAuthKey: process.env.GALACTIC_TAILSCALE_AUTH_KEY ?? exportedSecrets?.tailscaleAuthKey ?? '',
    omniJoinToken: process.env.GALACTIC_OMNI_JOIN_TOKEN ?? exportedSecrets?.omniJoinToken ?? '',
  }

  const rendered = renderTemplate(readFileSync(templatePath, 'utf8'), secrets)
  writeFileSync(outputArgument, rendered, { encoding: 'utf8', mode: 0o600 })
  chmodSync(outputArgument, 0o600)

  const patchName = 'image-factory-registry.yaml'
  const sourcePatch = resolve(dirname(templatePath), patchName)
  const outputPatch = resolve(dirname(outputArgument), patchName)
  if (sourcePatch !== outputPatch) copyFileSync(sourcePatch, outputPatch)

  process.stdout.write(`Rendered secret-bearing Omni template to ${outputArgument} with mode 0600\n`)
}

if (import.meta.main) main()
