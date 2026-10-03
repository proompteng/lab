import { CST, Lexer, isAlias, isMap, isScalar, isSeq, parseAllDocuments } from 'yaml'

export const SECRET_DOCUMENT_BYTE_BUDGET = 4 * 1024 * 1024
const marker = '[REDACTED_CREDENTIAL]'
export type SecretCaptureMode = 'document' | 'metadata' | 'projection'
type CommandWord = {
  value: string
  literal: boolean
  assignment: boolean
  sourcePositions: number[]
  sourceEnd: number
}
const COMMAND_WORD_LIMIT = 256
const COMMAND_WORD_CHARACTER_LIMIT = 4096

// Recognize simple command words without evaluating expansions or indirect scripts.
// Quotes protect source text from becoming a command boundary; retained words have fixed bounds.
function* commandWords(command: string) {
  const text = command
  let words: CommandWord[] = []
  let ambiguous = false
  let prefix: 'assignments' | 'env' | 'envOperand' | 'arguments' = 'assignments'
  let envOptions = true
  for (let index = 0; index < text.length; ) {
    const continuation = /^\\\r?\n/.exec(text.slice(index, index + 3))
    if (continuation) {
      index += continuation[0].length
      continue
    }
    if (/[;|&\n]/.test(text[index])) {
      yield { words, ambiguous }
      words = []
      ambiguous = false
      prefix = 'assignments'
      envOptions = true
      index += 1
      continue
    }
    if (/\s/.test(text[index])) {
      index += 1
      continue
    }
    if (text[index] === '#') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    // Here-doc bodies are source text, not additional commands recognized by this scanner.
    if (text.startsWith('<<', index)) {
      yield { words, ambiguous: true }
      return
    }
    const start = index
    let quote: string | null = null
    let value = ''
    let literal = true
    const sourcePositions: number[] = []
    let sourceEnd = index
    while (index < text.length) {
      const character = text[index]
      if (!quote && (/[\s;|&]/.test(character) || text.startsWith('<<', index))) break
      index += 1
      if (character === '\\' && quote !== "'" && index < text.length) {
        const continuation = /^\r?\n/.exec(text.slice(index, index + 2))
        if (continuation) {
          index += continuation[0].length
          continue
        }
        // Double quotes only consume escapes for the shell's special characters.
        if (quote === '"' && !/[$`"\\]/.test(text[index])) {
          if (value.length < COMMAND_WORD_CHARACTER_LIMIT) {
            sourcePositions.push(index - 1)
            value += character
            sourceEnd = index
          }
          continue
        }
        if (value.length < COMMAND_WORD_CHARACTER_LIMIT) {
          sourcePositions.push(index - 1)
          value += text[index]
          sourceEnd = index + 1
        }
        index += 1
        continue
      }
      if (character === quote) {
        quote = null
        continue
      }
      if (!quote && (character === '"' || character === "'" || character === '`')) {
        quote = character
        if (character === '`') literal = false
        continue
      }
      if (quote !== "'" && (character === '$' || character === '`')) literal = false
      if (value.length < COMMAND_WORD_CHARACTER_LIMIT) {
        sourcePositions.push(index - 1)
        value += character
        sourceEnd = index
      }
    }
    const raw = text.slice(start, Math.min(index, start + COMMAND_WORD_CHARACTER_LIMIT))
    if (quote || index - start > COMMAND_WORD_CHARACTER_LIMIT) ambiguous = true
    const word = {
      value,
      literal: literal && !quote,
      assignment: /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw),
      sourcePositions,
      sourceEnd,
    }
    // Prefixes need only finite state, so long assignment lists cannot evict the executable.
    if (prefix === 'assignments') {
      if (word.assignment) continue
      if (executableIs(word, 'env')) {
        prefix = 'env'
        continue
      }
      prefix = 'arguments'
    } else if (prefix === 'envOperand') {
      prefix = 'env'
      continue
    } else if (prefix === 'env') {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value)) continue
      if (envOptions && word.literal && ['-', '-i', '--ignore-environment'].includes(word.value)) continue
      if (envOptions && word.literal && ['-u', '--unset', '-C', '--chdir'].includes(word.value)) {
        prefix = 'envOperand'
        continue
      }
      if (envOptions && word.literal && /^(?:--unset=|--chdir=|-u.+|-C.+)/.test(word.value)) continue
      if (envOptions && word.literal && word.value === '--') {
        envOptions = false
        continue
      }
      prefix = 'arguments'
    }
    if (words.length < COMMAND_WORD_LIMIT) words.push(word)
    else ambiguous = true
  }
  yield { words, ambiguous }
}

const executableIs = (word: CommandWord | undefined, name: string) =>
  word?.literal && word.value.split('/').at(-1) === name
const secretApiPath = /^\/api\/v1\/(?:namespaces\/[^/?#]+\/)?secrets(?:\/[^/?#]+)?\/?(?:[?#].*)?$/
const secretResource = (resource: string) => /^secrets?$/i.test(resource.split('/')[0].split('.')[0])

const secretCommandMode = (words: CommandWord[], ambiguous: boolean): SecretCaptureMode | null => {
  if (!executableIs(words[0], 'kubectl')) return null
  const args = words.slice(1)
  const get = args.findIndex((word) => word.literal && word.value === 'get')
  const rawSecret = args.some((word, index) => {
    if (!word.literal) return false
    if (word.value === '--raw') {
      const path = args[index + 1]
      return path?.literal && secretApiPath.test(path.value)
    }
    return word.value.startsWith('--raw=') && secretApiPath.test(word.value.slice('--raw='.length))
  })
  const readsSecret =
    get >= 0 &&
    (rawSecret || args.slice(get + 1).some((word) => word.literal && word.value.split(',').some(secretResource)))
  if (!readsSecret && secretCreationKind(words) === null) return null
  if (ambiguous) return 'projection'
  let mode: SecretCaptureMode = 'metadata'
  for (let position = 0; position < args.length; position += 1) {
    const word = args[position]
    if (/^--template(?:=|$)/.test(word.value)) return 'projection'
    let output: CommandWord | undefined
    if (word.value === '-o' || word.value === '--output') output = args[++position]
    else if (/^(?:--output=|-o.)/.test(word.value))
      output = { ...word, value: word.value.replace(/^(?:--output=|-o=?)/, '') }
    else continue
    if (!word.literal || !output?.literal || !/^(?:json|yaml|wide|name)$/.test(output.value)) return 'projection'
    mode = /^(?:json|yaml)$/.test(output.value) ? 'document' : 'metadata'
  }
  return rawSecret ? 'document' : mode
}

export const secretCaptureMode = (command: string): SecretCaptureMode | null => {
  let mode: SecretCaptureMode | null = null
  for (const candidate of commandWords(command)) {
    const found = secretCommandMode(candidate.words, candidate.ambiguous)
    if (found === 'projection') return found
    if (found === 'document' || (found === 'metadata' && mode === null)) mode = found
  }
  return mode
}
export const isSecretRead = (command: string) => secretCaptureMode(command) !== null

const kubectlGlobalOperand =
  /^(?:--namespace|--context|--kubeconfig|--server|--user|--cluster|--as|--as-group|--cache-dir|--request-timeout|--certificate-authority|--client-certificate|--client-key|--token|--tls-server-name|--v|--vmodule|--log-flush-frequency|--profile|--profile-output|-n|-s|-v)$/
const secretCreationKind = (words: CommandWord[]): 'generic' | 'docker-registry' | 'tls' | null => {
  if (!executableIs(words[0], 'kubectl')) return null
  let path = 0
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]
    if (!word.literal) return null
    if (kubectlGlobalOperand.test(word.value)) {
      index += 1
      continue
    }
    if (word.value.startsWith('-')) continue
    if (path === 2)
      return word.value === 'generic' || word.value === 'docker-registry' || word.value === 'tls' ? word.value : null
    if (word.value !== ['create', 'secret'][path]) return null
    path += 1
  }
  return null
}

const secretLiterals = (words: CommandWord[], ambiguous: boolean) => {
  const literals: { word: CommandWord; valueOffset: number; value: string }[] = []
  const kind = secretCreationKind(words)
  if (kind === null) return literals
  if (ambiguous) throw new Error('Secret creation command exceeded bounded literal capture')
  for (let index = 1; index < words.length; index += 1) {
    const option = words[index]
    if (option.value === '--') break
    let word = option
    let offset = 0
    let keyDelimiter = true
    if (kind === 'docker-registry' && option.value === '--docker-password') {
      const operand = words[++index]
      if (!operand) throw new Error('Secret creation password has no bounded operand')
      word = operand
      keyDelimiter = false
    } else if (kind === 'docker-registry' && option.value.startsWith('--docker-password=')) {
      offset = '--docker-password='.length
      keyDelimiter = false
    } else if (kind === 'generic' && option.value === '--from-literal') {
      const operand = words[++index]
      if (!operand) throw new Error('Secret creation literal has no bounded operand')
      word = operand
    } else if (kind === 'generic' && option.value.startsWith('--from-literal=')) offset = '--from-literal='.length
    else continue
    const delimiter = word.value.indexOf('=', offset)
    if (!option.literal || !word.literal || (keyDelimiter && delimiter <= offset))
      throw new Error('Secret creation literal cannot be safely decoded')
    const valueOffset = keyDelimiter ? delimiter + 1 : offset
    const value = word.value.slice(valueOffset)
    if (value) literals.push({ word, valueOffset, value })
  }
  return literals
}

const checkLiteralBudget = (values: string[]) => {
  if (values.length > COMMAND_WORD_LIMIT || values.reduce((total, value) => total + value.length, 0) > 65_536)
    throw new Error('Secret creation literals exceeded bounded value capture')
}

export const maskKubernetesSecretCreationCommand = (command: string) => {
  const spans: { start: number; end: number }[] = []
  const appendSpan = (span: { start: number; end: number }) => {
    if (spans.length >= COMMAND_WORD_LIMIT) throw new Error('Secret literal source exceeded bounded span capture')
    spans.push(span)
  }
  const values: string[] = []
  for (const candidate of commandWords(command)) {
    for (const literal of secretLiterals(candidate.words, candidate.ambiguous)) {
      const start = literal.word.sourcePositions[literal.valueOffset]
      if (start === undefined) throw new Error('Secret creation literal source cannot be safely located')
      appendSpan({ start, end: literal.word.sourceEnd })
      values.push(literal.value)
      checkLiteralBudget(values)
    }
  }
  if (values.length) {
    const known = new RegExp(
      [...new Set(values)]
        .sort((left, right) => right.length - left.length)
        .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|'),
      'g',
    )
    for (const candidate of commandWords(command)) {
      if (candidate.ambiguous) throw new Error('Secret literal command echo exceeded bounded source capture')
      // Keep the creation's executable, resource and key names intact, even when a literal has the same value.
      if (secretCreationKind(candidate.words) !== null) continue
      for (const word of candidate.words.slice(1)) {
        for (const match of word.value.matchAll(known)) {
          const start = word.sourcePositions[match.index]
          if (start === undefined) throw new Error('Secret literal echo source cannot be safely located')
          appendSpan({ start, end: word.sourcePositions[match.index + match[0].length] ?? word.sourceEnd })
        }
      }
    }
  }
  const chunks: string[] = []
  let cursor = 0
  for (const span of spans.sort((left, right) => left.start - right.start)) {
    chunks.push(command.slice(cursor, span.start), marker)
    cursor = span.end
  }
  chunks.push(command.slice(cursor))
  const text = chunks.join('')
  return { text, values, maskedValues: spans.length }
}

export const maskKubernetesSecretCreationArgs = (args: string[]) => {
  const words = ['kubectl', ...args].slice(0, COMMAND_WORD_LIMIT).map((value) => ({
    value: value.slice(0, COMMAND_WORD_CHARACTER_LIMIT),
    literal: true,
    assignment: false,
    sourcePositions: [],
    sourceEnd: 0,
  }))
  const literals = secretLiterals(
    words,
    args.length + 1 > COMMAND_WORD_LIMIT || args.some((value) => value.length > COMMAND_WORD_CHARACTER_LIMIT),
  )
  const values = literals.map((literal) => literal.value)
  checkLiteralBudget(values)
  const masked = new Map(
    literals.map((literal) => [literal.word, literal.word.value.slice(0, literal.valueOffset) + marker]),
  )
  return {
    args: args.map((value, index) => masked.get(words[index + 1]) ?? value),
    values,
    maskedValues: literals.length,
  }
}

export const secretCreationCredentialValues = (values: string[]) =>
  values.flatMap((value) => [value, Buffer.from(value).toString('base64'), encodeURIComponent(value)])

const preflightSecretSyntax = (text: string) => {
  let tokens = 0
  let flow = 0
  let lineStart = true
  let indent = 0
  let inlineSequences = 0
  const indents = [0]
  for (const token of new Lexer().lex(text)) {
    if (++tokens > 65_536) throw new Error('Secret document token budget exceeded')
    const type = CST.tokenType(token)
    if (type === 'alias') throw new Error('Secret documents with aliases are not exported')
    if (type === 'newline') {
      lineStart = true
      indent = 0
      inlineSequences = 0
      continue
    }
    if (lineStart && type === 'space') {
      indent += token.length
      continue
    }
    if (lineStart && type !== 'comment' && type !== 'doc-mode') {
      while (indents.length > 1 && indent < indents[indents.length - 1]) indents.pop()
      if (indent > indents[indents.length - 1]) indents.push(indent)
      lineStart = false
    }
    if (type === 'flow-map-start' || type === 'flow-seq-start') flow += 1
    if (type === 'flow-map-end' || type === 'flow-seq-end') flow = Math.max(0, flow - 1)
    if (type === 'seq-item-ind') inlineSequences += 1
    if (flow + indents.length + inlineSequences > 64) throw new Error('Secret document structure budget exceeded')
  }
}

const looksLikeSecret = (text: string) =>
  /(?:["']kind["']\s*:\s*["']Secret(?:List)?["']|(?:^|\n)[\t ]*kind:[\t ]*(?:&[\w-]+[\t ]+)?["']?Secret(?:List)?\b)/.test(
    text,
  )

// Parse syntax nodes only: never resolve aliases, construct user objects or call custom serializers.
// Source ranges retain all ordinary formatting and metadata outside the credential value itself.
export const maskKubernetesSecretText = (
  text: string,
  mode: SecretCaptureMode | null = null,
  allowDiagnostics = false,
) => {
  const secretSource = mode !== null
  if (!text.trim() || (!secretSource && !looksLikeSecret(text))) return { text, maskedValues: 0 }
  if (mode === 'projection') throw new Error('Secret output projection omitted from centralized capture')
  if (allowDiagnostics && /^(?:(?:Error from server|error:|Warning:|No resources found)[^\n]*(?:\n|$))+$/.test(text))
    return { text, maskedValues: 0 }
  if (Buffer.byteLength(text) > SECRET_DOCUMENT_BYTE_BUDGET) throw new Error('Secret document byte budget exceeded')
  preflightSecretSyntax(text)
  const documents = parseAllDocuments(text, { strict: true, uniqueKeys: true })
  if (documents.some((doc) => doc.errors.length)) {
    if (!secretSource) return { text, maskedValues: 0 }
    throw new Error('Secret document could not be safely parsed')
  }
  const replacements: Array<{ start: number; end: number }> = []
  let nodes = 0
  let aliases = false
  let recognizedKind = false
  const visit = (node: unknown, depth: number, secretItem = false) => {
    nodes += 1
    if (nodes > 65_536 || depth > 64) throw new Error('Secret document structure budget exceeded')
    if (isAlias(node)) {
      aliases = true
      return
    }
    if (isSeq(node)) {
      for (const item of node.items) visit(item, depth + 1)
      return
    }
    if (!isMap(node)) return
    const get = (name: string) => node.items.find((pair) => isScalar(pair.key) && pair.key.value === name)?.value
    const kindNode = get('kind')
    const kind = isScalar(kindNode) ? kindNode.value : null
    if (typeof kind === 'string') recognizedKind = true
    const redact = (value: unknown) => {
      if (value === null || value === undefined || (isScalar(value) && value.value == null)) return
      if (isAlias(value)) {
        aliases = true
        return
      }
      if (!isScalar(value) && !isMap(value) && !isSeq(value)) throw new Error('Unsupported Secret credential node')
      if (!value.range) throw new Error('Secret credential source range missing')
      replacements.push({ start: value.range[0], end: value.range[1] })
    }
    if (kind === 'Secret' || secretItem) {
      for (const field of ['data', 'stringData']) {
        const data = get(field)
        if (isMap(data)) for (const pair of data.items) redact(pair.value)
        else redact(data)
      }
    }
    for (const pair of node.items) {
      visit(pair.key, depth + 1)
      if (kind === 'SecretList' && isScalar(pair.key) && pair.key.value === 'items' && isSeq(pair.value))
        for (const item of pair.value.items) visit(item, depth + 1, true)
      else visit(pair.value, depth + 1)
    }
  }
  for (const doc of documents) visit(doc.contents, 0)
  if (aliases && (secretSource || replacements.length))
    throw new Error('Secret documents with aliases are not exported')
  if (secretSource && !recognizedKind && !replacements.length) {
    // JSONPath/template projections can be bare credentials without a kind/data wrapper.
    // Default kubectl tables contain only public resource metadata and byte counts.
    if (mode === 'metadata') return { text, maskedValues: 0 }
    throw new Error('Secret document has no verifiable resource kind; partial capture omitted')
  }
  replacements.sort((a, b) => a.start - b.start || b.end - a.end)
  let offset = 0
  let result = ''
  let maskedValues = 0
  for (const range of replacements) {
    if (range.start < offset) continue
    result += text.slice(offset, range.start) + JSON.stringify(marker)
    if (text.slice(range.start, range.end).endsWith('\n')) result += '\n'
    offset = range.end
    maskedValues += 1
  }
  return { text: result + text.slice(offset), maskedValues }
}
