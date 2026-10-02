import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { AuthContext } from './auth'
import type { AgentsShellConfig } from './config'

export type ToolAuditContext = { requestId: string; toolCallId: string; tool: string }

export const toolAuditContext = new AsyncLocalStorage<ToolAuditContext>()

const SECRET_KEY =
  /(?:authorization|cookie|password|passwd|passphrase|secret|token|apikey|accesskey|privatekey|credential)s?$/i
const SECRET_OPTION =
  /^(?:--?[\w-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|credential|authorization|cookie)[\w-]*|--(?:oauth2-bearer|from-literal|patch|overrides|cert|proxy-cert)|--?(?:[\w-]+-)?pass(?:in|out)?)$/i
const VALUELESS_SECRET_OPTION =
  /^--(?:password-stdin|skip-password|no-password|ask-password|junk-session-cookies|no-cookies|keep-session-cookies)$/i
const SHELL_INPUT =
  /[<>()?#{}*[\]]|<<|(?<!\|)\|(?!\|)|[<>]\(|\$|`|\/dev\/(?:stdin|fd\/\d+)\b|\/proc\/(?:self|\d+)\/fd\/\d+\b|--(?:password|passwd|passphrase)-(?:stdin|fd)\b|-hmac-stdin\b|(?<![\w-])--?(?:[\w-]+[-_])?pass(?:in|out)?(?:=|\s+)(?:[\w-]+:)?(?:stdin|fd:\d+)\b|\b(?:kubectl|k)\b[^\r\n;|&]*?(?:-f|--filename)(?:=|\s+)-(?=\s|$)|\bcurl\b[^\r\n;|&]*?(?:--config(?:=|\s+)|-K(?:=|\s*)?)-(?=\s|$)|\bcurl\b[^\r\n;|&]*?\s(?:--(?:data(?:-[\w-]+)?|json|form(?:-string)?)(?:=|\s|$)|-[dF])|(?:^|\s)--(?:post-(?:data|file)|body(?:-(?:data|file))?)(?:=|\s|$)|\b(?:http|https|xh|xhs)\b[^\r\n;|&]*?\s--raw(?:=|\s|$)|\bgh\b[^\r\n;|&]*?\b(?:auth|secrets?)\b|\bgh\b[^\r\n;|&]*?\bapi\b[^\r\n;|&]*?\s(?:--(?:raw-field|field|input)(?:=|\s|$)|-[fF])|\bopenssl\b[^\r\n;|&]*?\bpasswd\b|\bgit(?:\s+[^\r\n;|&]*?\bcredential\b|-credential(?:-[\w-]+)?\b)|\b(?:sh|bash|dash|ksh|zsh|fish|python(?:\d(?:\.\d+)?)?)(?=\s)[^\r\n;|&]*?\s(?:--command(?:=|\s|$)|-[A-Za-z]*c)|\b(?:node|bun)(?=\s)[^\r\n;|&]*?\s(?:--(?:eval|print)(?:=|\s|$)|-[A-Za-z]*[ep])|\b(?:eval|trap|alias)(?:\s|$)|(?:^|\s)--(?:url-query|request-target)(?:=|\s|$)|(?:\b|-o)(?:proxy|remote|local|knownhosts)command(?:=|\s)/i
const COMPACT_CREDENTIAL_OPTION = /^-[puUbEaNP]$/
const CURL_SHORT_FLAGS = '012346aBfgGhiIjJklLMnNOpqRsSvVZ:'
const KUBECTL_GLOBAL_OPERAND =
  /^(?:--(?:context|namespace|kubeconfig|cluster|server|user|token|as|as-group|as-uid|request-timeout|cache-dir|client-certificate|client-key|certificate-authority|v|vmodule)|-[nsv])$/
const CONTAINER_GLOBAL_OPERAND =
  /^(?:--(?:config|context|host|log-level|tlscacert|tlscert|tlskey|cdi-spec-dir|cgroup-manager|conmon|connection|events-backend|hooks-dir|identity|imagestore|module|network-config-dir|out|root|runroot|runtime|runtime-flag|storage-driver|storage-opt|tmpdir|url|volumepath)|-[cHil])$/
const OMITTED_BODY = /^(?:patch|content|task|acceptanceCriteria|stdin|stdout|stderr|payload|_meta)$/i
const MAX_PAYLOAD_BYTES = 12_000
const MAX_FIELD_BYTES = 4_000
const PRIVATE_KUBERNETES_KIND = /(?:^|[{\s,])["']?kind["']?\s*:\s*["']?((?:Secret|AgentRun)(?:List)?)["']?(?=[\s,}]|$)/i
const CREDENTIAL_COMMAND = /^(?:curl|mysql|mariadb|sshpass|ssh-keygen|redis-cli|kubectl|openssl|docker|podman)$/
const SHELL_WORD = /(?:\\.|[^\s;|&"'\\]|"(?:\\.|[^"\\])*"|'[^']*')+/g

const normalizeShellWord = (word: string) => word.replaceAll(/["'\\]/g, '')
const commandName = (word: string) => {
  const name = normalizeShellWord(word).split('/').at(-1) ?? ''
  return name === 'k' ? 'kubectl' : name
}
const curlShortOperandIndex = (token: string) => {
  if (!token.startsWith('-') || token.startsWith('--')) return -1
  for (let index = 1; index < token.length; index++) {
    if (!CURL_SHORT_FLAGS.includes(token[index])) return index
  }
  return -1
}
const usesShellInput = (text: string) => {
  if (/[\r\n]/.test(text) || text.length > MAX_FIELD_BYTES || SHELL_INPUT.test(normalizeShellWord(text))) return true
  if (/\b(?:cx-codex-run|codex)\b/.test(normalizeShellWord(text))) return true
  const words = text.match(SHELL_WORD) ?? []
  if (
    words.some((word) => commandName(word) === 'curl') &&
    words.some((word) => {
      const token = normalizeShellWord(word)
      const index = curlShortOperandIndex(token)
      return index > 0 && ['d', 'F'].includes(token[index])
    })
  )
    return true
  return words.some((word) => {
    const words = normalizeShellWord(word).match(SHELL_WORD) ?? []
    return words.length > 1 && words.some((value) => CREDENTIAL_COMMAND.test(commandName(value)))
  })
}

const shortCredentialOptions = (command: string) => {
  const [executable = '', operation] = normalizeShellWord(command).trim().split(/\s+/)
  const name = commandName(executable)
  if (name === 'curl') return ['-u', '-U', '-b', '-E', '--user', '--proxy-user']
  if (name === 'mysql' || name === 'mariadb' || name === 'sshpass') return ['-p']
  if (name === 'ssh-keygen') return ['-N', '-P']
  if (name === 'redis-cli') return ['-a']
  if (name === 'kubectl' && operation === 'patch') return ['-p']
  if (name === 'openssl') {
    return [
      '-hmac',
      '-macopt',
      '-kdfopt',
      '-pkeyopt',
      '-pkeyopt_passin',
      '-sigopt',
      '-k',
      '-K',
      '-psk',
      '-psk_identity',
      '-srppass',
      '-srpuser',
    ]
  }
  if ((name === 'docker' || name === 'podman') && operation === 'login') return ['-p']
  return []
}

const argumentRedactor = (command: string) => {
  const words = command.match(SHELL_WORD) ?? []
  const executable = normalizeShellWord(words[0] ?? '')
  let name = commandName(executable)
  const globalOperand =
    name === 'kubectl'
      ? KUBECTL_GLOBAL_OPERAND
      : name === 'docker' || name === 'podman'
        ? CONTAINER_GLOBAL_OPERAND
        : undefined
  command = normalizeShellWord(command)
  let options = shortCredentialOptions(command)
  let wrapper = /(?:^|\/)sshpass(?:\s|$)/.test(command)
  let wrapperOperand = false
  let inspectOperation = globalOperand !== undefined
  let operationOperand = false
  let redactNext = false
  const inspect = (token: string) => {
    if (!inspectOperation) return
    if (operationOperand) operationOperand = false
    else if (globalOperand?.test(token)) operationOperand = true
    else if (!token.startsWith('-')) {
      inspectOperation = false
      options = shortCredentialOptions(`${executable} ${token}`)
    }
  }
  for (const word of words.slice(1)) inspect(normalizeShellWord(word))
  return <T>(word: T): T | string => {
    if (redactNext) {
      redactNext = false
      operationOperand = false
      return '[REDACTED]'
    }
    if (typeof word !== 'string') return word
    const token = normalizeShellWord(word)
    inspect(token)
    if (VALUELESS_SECRET_OPTION.test(token)) return word
    const separator = token.indexOf('=')
    if (separator > 0 && SECRET_OPTION.test(token.slice(0, separator))) {
      return `${token.slice(0, separator)}=[REDACTED]`
    }
    const option = options.find(
      (value) =>
        token === value ||
        token.startsWith(`${value}=`) ||
        (COMPACT_CREDENTIAL_OPTION.test(value) && token.startsWith(value)),
    )
    if (option) {
      if (token === option) {
        redactNext = true
        return word
      }
      return `${option}[REDACTED]`
    }
    if (token.startsWith('-') && !token.startsWith('--')) {
      const operandIndex = name === 'curl' ? curlShortOperandIndex(token) : null
      for (let index = 2; index < token.length; index++) {
        if (operandIndex !== null && index !== operandIndex) continue
        if (!options.some((value) => COMPACT_CREDENTIAL_OPTION.test(value) && value[1] === token[index])) continue
        if (index === token.length - 1) {
          redactNext = true
          return word
        }
        return `${token.slice(0, index + 1)}[REDACTED]`
      }
    }
    if (SECRET_OPTION.test(token)) {
      redactNext = true
      return word
    }
    if (wrapperOperand) wrapperOperand = false
    else if (wrapper && ['-f', '-d', '-P'].includes(token)) wrapperOperand = true
    else if (wrapper && !token.startsWith('-')) {
      wrapper = false
      name = commandName(word)
      options = shortCredentialOptions(word)
    }
    if (name === 'curl') {
      const url = token.replace(/^((?:--url=)?(?:[a-z][a-z0-9+.-]*:\/\/)?)[^/?#\s]+@/i, '$1[REDACTED]@')
      if (url !== token) return url
    }
    return word
  }
}

const redactShortOptions = (text: string) => {
  let redact = argumentRedactor('')
  let previousEnd = 0
  return text.replace(SHELL_WORD, (word: string, offset: number) => {
    if (/[;|&\r\n]/.test(text.slice(previousEnd, offset))) redact = argumentRedactor('')
    previousEnd = offset + word.length
    const redacted = redact(word)
    if (redacted !== word) return redacted
    const name = commandName(word)
    if (CREDENTIAL_COMMAND.test(name)) redact = argumentRedactor(name)
    return word
  })
}

const bodyOmission = (kind: unknown) => {
  switch (typeof kind === 'string' ? kind.toLowerCase() : '') {
    case 'secret':
    case 'secrets':
    case 'secretlist':
    case 'sec':
      return '[OMITTED_KUBERNETES_SECRET]'
    case 'agentrun':
    case 'agentruns':
    case 'agentrunlist':
      return '[OMITTED_AGENT_RUN]'
    default:
      return undefined
  }
}

const redactText = (value: string, secrets: string[]) => {
  if (value === '[REDACTED]') return value
  if (usesShellInput(value)) return '[OMITTED_SHELL_INPUT]'
  const omitted = bodyOmission(value.match(PRIVATE_KUBERNETES_KIND)?.[1])
  if (omitted) return omitted
  let text = value
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]')
  return redactShortOptions(text)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=~-]+/gi, '[REDACTED]')
    .replace(/((?:authorization|(?:set-)?cookie)\s*:\s*)[^"'\r\n]+/gi, '$1[REDACTED]')
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?):\/\/[^\s"'<>]+/gi, '[REDACTED_CONNECTION]')
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g,
      '[REDACTED]',
    )
    .replace(
      /((?:^|[\s"'({,;])[\w-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|credential|authorization|cookie)[\w-]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@?#]+@/gi, '$1[REDACTED]@')
    .replace(
      /((?:^|\s)(?:--(?:oauth2-bearer|from-literal|patch|overrides|cert|proxy-cert)|--?(?:[\w-]+-)?pass(?:in|out)?)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s;]+)/g,
      '$1[REDACTED]',
    )
    .replace(/(^|[^A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '$1[REDACTED_EMAIL]')
}

export const sanitizeAuditPayload = (payload: Record<string, unknown>, omitToolArguments = false) => {
  const secrets = Object.entries(process.env)
    .filter(
      ([key, value]) =>
        /(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|DATABASE_URL|DB_URL|CONNECTION_STRING)/i.test(
          key,
        ) &&
        value &&
        value.length >= 4,
    )
    .flatMap(([, value]) => (value ? [value, encodeURIComponent(value)] : []))
    .sort((a, b) => b.length - a.length)
  let remaining = MAX_PAYLOAD_BYTES
  let truncated = false
  const sanitize = (value: unknown, depth: number, command = ''): unknown => {
    if (remaining <= 0 || depth > 4) {
      truncated = true
      return '[TRUNCATED]'
    }
    if (typeof value === 'string') {
      if (value.length > MAX_FIELD_BYTES) {
        truncated = true
        remaining -= Buffer.byteLength(JSON.stringify('[TRUNCATED]'))
        return '[TRUNCATED]'
      }
      const text = redactText(value, secrets)
      const limit = Math.min(remaining, MAX_FIELD_BYTES)
      let end = text.length
      if (Buffer.byteLength(JSON.stringify(text)) > limit) {
        truncated = true
        let low = 0
        let high = end
        while (low < high) {
          const mid = Math.ceil((low + high) / 2)
          if (Buffer.byteLength(JSON.stringify(`${text.slice(0, mid)}[TRUNCATED]`)) <= limit) low = mid
          else high = mid - 1
        }
        end = low
      }
      const result = end < text.length ? `${text.slice(0, end)}[TRUNCATED]` : text
      remaining -= Buffer.byteLength(JSON.stringify(result))
      return result
    }
    if (Array.isArray(value)) {
      const result: unknown[] = []
      const redact = argumentRedactor(command)
      for (const item of value.slice(0, 20)) {
        if (remaining <= 0) break
        result.push(sanitize(redact(item), depth + 1))
      }
      if (result.length < value.length) truncated = true
      return result
    }
    if (value !== null && typeof value === 'object') {
      const omitted = 'kind' in value ? bodyOmission(value.kind) : undefined
      if (omitted) return omitted
      const owningCommand = 'command' in value && typeof value.command === 'string' ? value.command : command
      const args =
        'args' in value && Array.isArray(value.args) ? value.args.filter((item) => typeof item === 'string') : []
      const privateInput = usesShellInput(`${owningCommand} ${args.join(' ')}`)
      const result: Record<string, unknown> = {}
      const entries = Object.entries(value)
      for (const [key, item] of entries.slice(0, 30)) {
        if (remaining <= 0) break
        const loggedKey = redactText(key, secrets).slice(0, 128)
        remaining -= Buffer.byteLength(JSON.stringify(loggedKey)) + 1
        result[loggedKey] = SECRET_KEY.test(key.replaceAll(/[^a-z]/gi, ''))
          ? '[REDACTED]'
          : privateInput && /^(?:command|args)$/i.test(key)
            ? '[OMITTED_SHELL_INPUT]'
            : OMITTED_BODY.test(key) || (omitToolArguments && /^(?:arguments|args|command|agentRunName)$/i.test(key))
              ? '[OMITTED]'
              : sanitize(item, depth + 1, key === 'args' ? owningCommand : '')
      }
      if (Object.keys(result).length < entries.length) truncated = true
      return result
    }
    remaining -= 8
    return typeof value === 'number' || typeof value === 'boolean' || value === null ? value : null
  }
  const result = sanitize(payload, 0)
  return { payload: result, payloadTruncated: truncated }
}

export const writeAuditLog = (
  config: AgentsShellConfig,
  event: string,
  auth: AuthContext | null,
  payload: Record<string, unknown>,
  context = toolAuditContext.getStore() ?? null,
) => {
  const omitToolArguments = context !== null
  const sanitized = sanitizeAuditPayload(payload, omitToolArguments)
  const line = JSON.stringify({
    msg: 'agents-shell audit',
    schemaVersion: 1,
    ts: new Date().toISOString(),
    event,
    ...context,
    subjectHash: auth?.subject ? createHash('sha256').update(auth.subject).digest('hex') : null,
    ...sanitized,
  })
  try {
    console.log(line)
  } catch {
    console.warn('[agents-shell] stdout audit write failed')
  }
  if (!config.auditLogPath) return
  try {
    mkdirSync(dirname(config.auditLogPath), { recursive: true })
    appendFileSync(config.auditLogPath, `${line}\n`)
  } catch {
    console.warn('[agents-shell] file audit write failed')
  }
}
