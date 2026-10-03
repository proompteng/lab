import { CST, Lexer, isAlias, isMap, isScalar, isSeq, parseAllDocuments } from 'yaml'

export const SECRET_DOCUMENT_BYTE_BUDGET = 4 * 1024 * 1024
const marker = '[REDACTED_CREDENTIAL]'
export type SecretCaptureMode = 'document' | 'metadata' | 'projection'
const normalizeCommand = (command: string) => command.replace(/\\\r?\n/g, ' ')
export const isSecretRead = (command: string) =>
  /(?:^|[;|&]\s*|\n\s*)(?:[^\s;|&"']*\/)?kubectl\b[^;|&\n]*\bget\b[^;|&\n]*\bsecrets?(?=[\s,/"']|$)/i.test(
    normalizeCommand(command).trim(),
  )
export const secretCaptureMode = (command: string): SecretCaptureMode | null => {
  if (!isSecretRead(command)) return null
  const normalized = normalizeCommand(command).replace(/(^|\s)(["'])(--output|-o)\2(?=\s|=)/g, '$1$3')
  const flags = [...normalized.matchAll(/(?:^|\s)(?:--output(?:=|\s|$)|-o(?=[=\s"'$a-z]|$))/g)]
  if (!flags.length) return /(?:^|\s)["']?--template(?:["'=\s]|$)/.test(normalized) ? 'projection' : 'metadata'
  const literals = [
    ...normalized.matchAll(
      /(?:^|\s)(?:--output(?:=|\s+)|-o[=\s]*)(?:"(json|yaml|wide|name)"|'(json|yaml|wide|name)'|(json|yaml|wide|name))(?=\s|$|[;|&<>])/g,
    ),
  ]
  if (literals.length !== flags.length) return 'projection'
  const last = literals.at(-1)!
  const output = last[1] || last[2] || last[3]
  return /^(?:json|yaml)$/.test(output) ? 'document' : 'metadata'
}

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
