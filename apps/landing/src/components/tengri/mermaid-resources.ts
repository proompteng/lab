// Only pass CSS/configuration values here, never diagram labels or source text.
// DOMPurify does not filter CSS resource URLs.
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

// Mermaid diagram databases expose styles in maps, node/edge data and class defs.
// Inspect those fields before layout, while leaving ordinary label text alone.
export function assertMermaidStyleFields(value: unknown, allStrings = false) {
  const ancestors = new WeakSet<object>()
  const visit = (entry: unknown, css: boolean) => {
    if (typeof entry === 'string') {
      if (css) assertMermaidResourcePolicy(entry)
      return
    }
    if (!entry || typeof entry !== 'object' || ancestors.has(entry)) return
    ancestors.add(entry)
    if (entry instanceof Map || Array.isArray(entry)) {
      for (const child of entry.values()) visit(child, css)
    } else {
      for (const [key, child] of Object.entries(entry)) visit(child, css || /style|css|config/i.test(key))
    }
    ancestors.delete(entry)
  }
  visit(value, allStrings)
}

export function assertMermaidSvgResources(svg: Element) {
  const cssAttributes = new Set([
    'style',
    'fill',
    'stroke',
    'filter',
    'clip-path',
    'mask',
    'cursor',
    'marker',
    'marker-start',
    'marker-mid',
    'marker-end',
  ])
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    if (element.localName === 'style') assertMermaidResourcePolicy(element.textContent ?? '')
    for (const attribute of element.attributes) {
      if (cssAttributes.has(attribute.name)) assertMermaidResourcePolicy(attribute.value)
      if ((attribute.name === 'href' || attribute.name === 'xlink:href') && !attribute.value.startsWith('#')) {
        throw new Error('Diagram resource URLs are disabled')
      }
    }
  }
}
