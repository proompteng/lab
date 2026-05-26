import type { SynthesisItem } from '~/server/schema'

export type CompanySymbol = (typeof knownCompanySymbols)[number]

export const knownCompanySymbols = [
  'AAPL',
  'AMD',
  'AMZN',
  'ARM',
  'ASML',
  'AVGO',
  'COIN',
  'CRM',
  'GOOG',
  'GOOGL',
  'IBM',
  'INTC',
  'JPM',
  'META',
  'MSFT',
  'MU',
  'NFLX',
  'NOW',
  'NVDA',
  'ORCL',
  'PLTR',
  'QCOM',
  'SMCI',
  'TSLA',
  'TSM',
] as const

const knownCompanySymbolSet = new Set<string>(knownCompanySymbols)
const symbolPattern = /(^|[^A-Za-z0-9])\$?([A-Z]{2,5})(?=$|[^A-Za-z0-9])/g

export type TextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'symbol'; text: string; symbol: string; href: string }

export const normalizeCompanySymbol = (value: string) => {
  const symbol = value.trim().replace(/^\$+/, '').toUpperCase()
  return knownCompanySymbolSet.has(symbol) ? symbol : null
}

export const companyPath = (symbol: string) => `/companies/${symbol.toUpperCase()}`

export const extractCompanySymbols = (text: string) => {
  const symbols: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(symbolPattern)) {
    const symbol = normalizeCompanySymbol(match[2] ?? '')
    if (!symbol || seen.has(symbol)) continue
    seen.add(symbol)
    symbols.push(symbol)
  }
  return symbols
}

export const segmentCompanySymbols = (text: string): TextSegment[] => {
  const segments: TextSegment[] = []
  let lastIndex = 0
  for (const match of text.matchAll(symbolPattern)) {
    const prefix = match[1] ?? ''
    const token = match[2] ?? ''
    const symbol = normalizeCompanySymbol(token)
    const tokenStart = (match.index ?? 0) + prefix.length
    const tokenEnd = tokenStart + (match[0]?.slice(prefix.length).length ?? token.length)
    if (!symbol) continue
    if (tokenStart > lastIndex) segments.push({ kind: 'text', text: text.slice(lastIndex, tokenStart) })
    segments.push({ kind: 'symbol', text: text.slice(tokenStart, tokenEnd), symbol, href: companyPath(symbol) })
    lastIndex = tokenEnd
  }
  if (lastIndex < text.length) segments.push({ kind: 'text', text: text.slice(lastIndex) })
  return segments.length ? segments : [{ kind: 'text', text }]
}

export const symbolsFromSynthesisItem = (item: SynthesisItem) => {
  const text = [
    item.title,
    item.synthesis,
    item.summary,
    item.whyValuable,
    item.observedText,
    ...item.takeaways,
    ...item.evidence,
    ...item.topicTags,
    ...item.sourcePosts.flatMap((source) => [source.observedText, source.authorHandle, source.authorName]),
    ...item.factChecks.flatMap((factCheck) => [factCheck.claim, factCheck.explanation]),
  ]
    .filter(Boolean)
    .join(' ')
  return extractCompanySymbols(text)
}
