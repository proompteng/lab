import { MAX_CODEX_IMAGES } from '@/lib/tengri/codex-images'
import { parseWorkspaceFileLink } from './workspace-file-link-model'

type MarkdownNode = {
  type: string
  url?: string
  identifier?: string
  alt?: string
  value?: string
  children?: MarkdownNode[]
}

/** Bound local image requests before rendering; traversal state is fresh for every Markdown document. */
export function remarkWorkspaceImageBudget(options: { basePath?: string } = {}) {
  return (tree: MarkdownNode) => {
    const definitions = new Map<string, string>()
    const identifier = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()
    function collect(node: MarkdownNode) {
      if (node.type === 'definition' && node.identifier && node.url && !definitions.has(identifier(node.identifier)))
        definitions.set(identifier(node.identifier), node.url)
      node.children?.forEach(collect)
    }
    collect(tree)
    const seen = new Set<string>()
    function limit(node: MarkdownNode) {
      node.children = node.children?.map((child) => {
        const url =
          child.type === 'image'
            ? child.url
            : child.type === 'imageReference'
              ? definitions.get(identifier(child.identifier ?? ''))
              : undefined
        const file = url ? parseWorkspaceFileLink(url, options.basePath) : null
        if (file) {
          const duplicate = seen.has(file.path)
          if (duplicate || seen.size >= MAX_CODEX_IMAGES)
            return {
              type: 'text',
              value: `[Image${child.alt ? `: ${child.alt}` : ''} — ${duplicate ? 'repeated image' : 'preview limit reached'}]`,
            }
          seen.add(file.path)
        }
        limit(child)
        return child
      })
    }
    limit(tree)
  }
}
