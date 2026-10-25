#!/usr/bin/env bun

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { $ } from 'bun'

type Command = 'status' | 'sync' | 'reconcile' | 'sync-and-reconcile'

type ExternalSecretTarget = {
  namespace: string
  name: string
}

type OnePasswordField = {
  id?: string
  type?: string
  purpose?: string
  label?: string
  value?: string
}

type OnePasswordItem = {
  title?: string
  category?: string
  fields?: OnePasswordField[]
  [key: string]: unknown
}

type ExternalSecretResource = {
  status?: {
    conditions?: Array<{
      type?: string
      status?: string
    }>
  }
}

type QuietCommandOptions = {
  timeoutMs?: number
}

const usage = `Usage:
  bun run scripts/sync-codex-auth-1password.ts status
  bun run scripts/sync-codex-auth-1password.ts sync
  bun run scripts/sync-codex-auth-1password.ts reconcile
  bun run scripts/sync-codex-auth-1password.ts sync-and-reconcile

Synchronizes local Codex auth.json to the canonical 1Password item consumed by
External Secrets, then optionally forces ExternalSecret reconciliation.

Environment:
  CODEX_AUTH_PATH      local auth.json path (default: ~/.codex/auth.json)
  OP_VAULT             1Password vault (default: infra)
  OP_ITEM              1Password item title (default: codex-auth)
  OP_FIELD             1Password field label (default: auth.json)
  OP_STATUS_TIMEOUT_MS max time for each 1Password status probe (default: 15000)
  KUBECTL_TIMEOUT      wait timeout for each ExternalSecret (default: 120s)
`

const command = process.argv[2] as Command | undefined
const validCommands = new Set<Command>(['status', 'sync', 'reconcile', 'sync-and-reconcile'])

if (!command || command === ('help' as Command) || process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(usage)
  process.exit(command ? 0 : 2)
}

if (!validCommands.has(command)) {
  console.error(`Unknown command: ${command}`)
  console.error(usage)
  process.exit(2)
}

const authPath = resolve(process.env.CODEX_AUTH_PATH ?? join(homedir(), '.codex/auth.json'))
const opVault = process.env.OP_VAULT ?? 'infra'
const opItem = process.env.OP_ITEM ?? 'codex-auth'
const opField = process.env.OP_FIELD ?? 'auth.json'
const kubectlTimeout = process.env.KUBECTL_TIMEOUT ?? '120s'
const externalSecrets: ExternalSecretTarget[] = [
  { namespace: 'agents', name: 'codex-auth' },
  { namespace: 'synthesis', name: 'codex-auth' },
  { namespace: 'jangar', name: 'codex-auth' },
  { namespace: 'torghut', name: 'codex-auth' },
  { namespace: 'sag', name: 'codex-auth' },
]

const fatal = (message: string, error?: unknown): never => {
  if (error instanceof Error) {
    console.error(`${message}\n${error.message}`)
  } else if (error) {
    console.error(`${message}\n${String(error)}`)
  } else {
    console.error(message)
  }
  process.exit(1)
}

const parsePositiveInteger = (name: string, value: string): number => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fatal(`${name} must be a positive integer, got '${value}'`)
  }

  return parsed
}

const opStatusTimeoutMs = parsePositiveInteger('OP_STATUS_TIMEOUT_MS', process.env.OP_STATUS_TIMEOUT_MS ?? '15000')

const ensureCli = (binary: string) => {
  if (!Bun.which(binary)) {
    fatal(`Required CLI '${binary}' is not available in PATH`)
  }
}

const runCommandQuiet = async (
  description: string,
  command: string[],
  { timeoutMs = opStatusTimeoutMs }: QuietCommandOptions = {},
): Promise<boolean> => {
  const proc = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' })
  let timedOut = false
  let killTimeout: ReturnType<typeof setTimeout> | undefined
  const timeout = setTimeout(() => {
    timedOut = true
    proc.kill()
    killTimeout = setTimeout(() => proc.kill('SIGKILL'), 1_000)
  }, timeoutMs)

  try {
    const exitCode = await proc.exited
    if (exitCode === 0) {
      return true
    }

    console.log(`${description}: ${timedOut ? 'timed out' : 'unavailable'}`)
    return false
  } catch {
    console.log(`${description}: unavailable`)
    return false
  } finally {
    clearTimeout(timeout)
    if (killTimeout) {
      clearTimeout(killTimeout)
    }
  }
}

const parseAuthJson = (): string => {
  let raw: string
  try {
    raw = readFileSync(authPath, 'utf8')
  } catch (error) {
    fatal(`Failed to read Codex auth file at ${authPath}`, error)
  }

  if (!raw.trim()) {
    fatal(`Codex auth file is empty: ${authPath}`)
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fatal(`Codex auth file must contain a JSON object: ${authPath}`)
    }
  } catch (error) {
    fatal(`Codex auth file contains invalid JSON: ${authPath}`, error)
  }

  return raw.endsWith('\n') ? raw : `${raw}\n`
}

const buildItemTemplate = (authJson: string): OnePasswordItem => ({
  title: opItem,
  category: 'LOGIN',
  fields: [
    {
      id: 'username',
      type: 'STRING',
      purpose: 'USERNAME',
      label: 'username',
      value: 'codex-auth',
    },
    {
      id: 'password',
      type: 'CONCEALED',
      purpose: 'PASSWORD',
      label: 'password',
      value: authJson,
    },
    {
      id: 'auth-json',
      type: 'CONCEALED',
      label: opField,
      value: authJson,
    },
    {
      id: 'notesPlain',
      type: 'STRING',
      purpose: 'NOTES',
      label: 'notesPlain',
      value: 'Canonical Codex auth.json for lab Kubernetes workloads via External Secrets.',
    },
  ],
})

const buildUpdatedItemTemplate = (existingItem: OnePasswordItem | null, authJson: string): OnePasswordItem => {
  if (!existingItem) {
    return buildItemTemplate(authJson)
  }

  const fields = Array.isArray(existingItem.fields) ? existingItem.fields : []
  const existingField = fields.find(
    (field) => field.label === opField || field.id === 'auth-json' || field.id === opField,
  )
  const passwordField = fields.find((field) => field.id === 'password' || field.purpose === 'PASSWORD')

  if (existingField) {
    existingField.type = 'CONCEALED'
    existingField.label = opField
    existingField.value = authJson
  } else {
    fields.push({
      id: 'auth-json',
      type: 'CONCEALED',
      label: opField,
      value: authJson,
    })
  }

  if (passwordField) {
    passwordField.type = 'CONCEALED'
    passwordField.purpose = 'PASSWORD'
    passwordField.label = 'password'
    passwordField.value = authJson
  }

  return {
    ...existingItem,
    title: existingItem.title ?? opItem,
    fields,
  }
}

const withTemplate = async (itemTemplate: OnePasswordItem, callback: (templatePath: string) => Promise<void>) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'codex-auth-1password-'))
  const templatePath = join(tempDir, 'item.json')

  try {
    writeFileSync(templatePath, `${JSON.stringify(itemTemplate, null, 2)}\n`, { mode: 0o600 })
    chmodSync(templatePath, 0o600)
    await callback(templatePath)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

const requireOp = async () => {
  ensureCli('op')
  try {
    await $`op vault get ${opVault} --format json`.quiet()
  } catch (error) {
    fatal(`1Password CLI cannot access vault '${opVault}'. Run: op signin`, error)
  }
}

const getExistingItem = async (): Promise<OnePasswordItem | null> => {
  let itemJson: string
  try {
    itemJson = await $`op item get ${opItem} --vault ${opVault} --format json`.text()
  } catch {
    return null
  }

  try {
    return JSON.parse(itemJson) as OnePasswordItem
  } catch (error) {
    fatal(`Failed to parse existing 1Password item JSON for op://${opVault}/${opItem}`, error)
  }
}

const syncItem = async () => {
  await requireOp()
  const authJson = parseAuthJson()
  const existingItem = await getExistingItem()
  const itemTemplate = buildUpdatedItemTemplate(existingItem, authJson)

  await withTemplate(itemTemplate, async (templatePath) => {
    if (existingItem) {
      await $`op item edit ${opItem} --vault ${opVault} --template ${templatePath}`.quiet()
      console.log(`1Password item updated: op://${opVault}/${opItem}/${opField}`)
      return
    }

    await $`op item create --vault ${opVault} --template ${templatePath}`.quiet()
    console.log(`1Password item created: op://${opVault}/${opItem}/${opField}`)
  })
}

const getExternalSecretReady = async ({ namespace, name }: ExternalSecretTarget): Promise<string> => {
  try {
    const output = await $`kubectl -n ${namespace} get externalsecret ${name} -o json`.text()
    const resource = JSON.parse(output) as ExternalSecretResource
    return resource.status?.conditions?.find((condition) => condition.type === 'Ready')?.status ?? ''
  } catch {
    return ''
  }
}

const checkStatus = async () => {
  let ready = true

  if (Bun.which('op')) {
    const vaultAvailable = await runCommandQuiet('1Password vault', ['op', 'vault', 'get', opVault, '--format', 'json'])
    if (vaultAvailable) {
      const itemPresent = await runCommandQuiet('1Password item', [
        'op',
        'item',
        'get',
        opItem,
        '--vault',
        opVault,
        '--format',
        'json',
      ])
      const fieldPresent = await runCommandQuiet('1Password field', [
        'op',
        'read',
        '--no-newline',
        `op://${opVault}/${opItem}/${opField}`,
      ])
      ready = ready && itemPresent && fieldPresent
    } else {
      ready = false
    }
  } else {
    console.log('1Password CLI: missing')
    ready = false
  }

  if (Bun.which('kubectl')) {
    for (const externalSecret of externalSecrets) {
      const status = await getExternalSecretReady(externalSecret)
      if (status === 'True') {
        console.log(`ExternalSecret ${externalSecret.namespace}/${externalSecret.name}: Ready`)
      } else {
        console.log(`ExternalSecret ${externalSecret.namespace}/${externalSecret.name}: NotReady`)
        ready = false
      }
    }
  } else {
    console.log('kubectl: missing')
    ready = false
  }

  if (!ready) {
    process.exitCode = 1
  }
}

const reconcileExternalSecrets = async () => {
  ensureCli('kubectl')
  const forceSync = Math.floor(Date.now() / 1000).toString()

  for (const externalSecret of externalSecrets) {
    await $`kubectl -n ${externalSecret.namespace} annotate externalsecret ${externalSecret.name} force-sync=${forceSync} --overwrite`.quiet()
    await $`kubectl -n ${externalSecret.namespace} wait --for=condition=Ready externalsecret/${externalSecret.name} --timeout=${kubectlTimeout}`.quiet()
    console.log(`ExternalSecret reconciled: ${externalSecret.namespace}/${externalSecret.name}`)
  }
}

if (command === 'status') {
  await checkStatus()
} else if (command === 'sync') {
  await syncItem()
} else if (command === 'reconcile') {
  await reconcileExternalSecrets()
} else {
  await syncItem()
  await reconcileExternalSecrets()
}
