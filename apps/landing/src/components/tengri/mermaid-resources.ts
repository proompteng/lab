// Mermaid applies styles to live temporary SVGs during layout. Check the source
// before rendering as well as the sanitized output; DOMPurify does not filter CSS.
export function assertMermaidResourcePolicy(value: string) {
  const normalized = value
    // Directives/frontmatter may encode CSS characters before Mermaid parses them.
    .replace(/\\u([\da-f]{4})|\\x([\da-f]{2})/gi, (_, unicode: string, hex: string) =>
      String.fromCharCode(Number.parseInt(unicode ?? hex, 16)),
    )
    .replace(/&?#(?:x([\da-f]+)|(\d+));/gi, (_, hex: string, decimal: string) => {
      const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10)
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\ufffd'
    })
    .replace(/\\(?:\r\n|[\n\r\f])/g, '')
    .replace(/\\(?:([\da-f]{1,6})[\t\n\f\r ]?|([^\n\r\f]))/gi, (_, hex: string, escaped: string) => {
      if (!hex) return escaped
      const codePoint = Number.parseInt(hex, 16)
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\ufffd'
    })
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Keep local marker/filter references. Reject ambiguous forms conservatively.
    .replace(/url\s*\(\s*(?:#[\w:.-]+|"#[\w:.-]+"|'#[\w:.-]+')\s*\)/gi, '')

  if (/url\s*\(|@import\b|(?:image(?:-set)?|cross-fade|src)\s*\(/i.test(normalized)) {
    throw new Error('Diagram resource URLs are disabled')
  }
}
