import { CST, Lexer, isAlias, isMap, isScalar, isSeq, parseAllDocuments } from 'yaml'

export const SECRET_DOCUMENT_BYTE_BUDGET = 4 * 1024 * 1024
const marker = '[REDACTED_CREDENTIAL]'
export type SecretCaptureMode = 'document' | 'metadata' | 'projection'
const normalizeCommand = (command: string) => command.replace(/\\\r?\n/g, ' ')
type CommandWord = { value: string; literal: boolean; assignment: boolean }
const COMMAND_WORD_LIMIT = 256
const COMMAND_WORD_CHARACTER_LIMIT = 4096

// Recognize simple command words without evaluating expansions or indirect scripts.
// Quotes protect source text from becoming a command boundary; retained words have fixed bounds.
function* commandWords(command: string) {
  const text = normalizeCommand(command)
  let words: CommandWord[] = []
  let ambiguous = false
  let prefix: 'assignments' | 'env' | 'envOperand' | 'arguments' = 'assignments'
  let envOptions = true
  for (let index = 0; index < text.length; ) {
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
    while (index < text.length) {
      const character = text[index]
      if (!quote && (/[\s;|&]/.test(character) || text.startsWith('<<', index))) break
      index += 1
      if (character === '\\' && quote !== "'" && index < text.length) {
        if (value.length < COMMAND_WORD_CHARACTER_LIMIT) value += text[index]
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
      if (value.length < COMMAND_WORD_CHARACTER_LIMIT) value += character
    }
    const raw = text.slice(start, Math.min(index, start + COMMAND_WORD_CHARACTER_LIMIT))
    if (quote || index - start > COMMAND_WORD_CHARACTER_LIMIT) ambiguous = true
    const word = { value, literal: literal && !quote, assignment: /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw) }
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
  if (
    get < 0 ||
    (!rawSecret &&
      !args
        .slice(get + 1)
        .some((word) => word.literal && word.value.split(',').some((part) => /^secrets?(?:\/|$)/i.test(part))))
  )
    return null
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
