import { FileText, Folder, FolderOpen } from 'lucide-react'
import * as React from 'react'

import { cn } from '@/lib/utils'

export type FileTreeNode = {
  name: string
  path: string
  children: FileTreeNode[]
  file?: unknown
}

type FileTreeViewProps = {
  nodes: FileTreeNode[]
  selectedPath: string | null
  onSelect: (path: string) => void
}

const collectFolderPaths = (nodes: FileTreeNode[]) => {
  const paths: string[] = []
  const walk = (items: FileTreeNode[]) => {
    for (const node of items) {
      if (node.children.length > 0) {
        paths.push(node.path)
        walk(node.children)
      }
    }
  }
  walk(nodes)
  return paths
}

export function FileTreeView({ nodes, selectedPath, onSelect }: FileTreeViewProps) {
  const autoExpanded = React.useMemo(() => collectFolderPaths(nodes), [nodes])
  const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(() => new Set(autoExpanded))

  React.useEffect(() => {
    setExpandedPaths((prev) => {
      if (prev.size === 0) return new Set(autoExpanded)
      const next = new Set(prev)
      for (const path of autoExpanded) {
        next.add(path)
      }
      return next
    })
  }, [autoExpanded])

  const togglePath = React.useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  return (
    <div className="space-y-1 text-[11px]" role="tree" aria-label="Worktree files" data-testid="file-tree">
      {nodes.map((node) => (
        <FileTreeItem
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          expandedPaths={expandedPaths}
          onSelect={onSelect}
          onToggle={togglePath}
        />
      ))}
    </div>
  )
}

type FileTreeItemProps = {
  node: FileTreeNode
  depth: number
  selectedPath: string | null
  expandedPaths: Set<string>
  onSelect: (path: string) => void
  onToggle: (path: string) => void
}

function FileTreeItem({ node, depth, selectedPath, expandedPaths, onSelect, onToggle }: FileTreeItemProps) {
  const hasChildren = node.children.length > 0
  const isFile = Boolean(node.file)
  const isSelected = isFile && node.path === selectedPath
  const isExpanded = hasChildren ? expandedPaths.has(node.path) : false
  const Icon = isFile ? FileText : isExpanded ? FolderOpen : Folder

  const handleClick = () => {
    if (isFile) {
      onSelect(node.path)
      return
    }
    if (hasChildren) {
      onToggle(node.path)
    }
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-selected={isSelected || undefined}
        data-tree-path={node.path}
        data-tree-type={isFile ? 'file' : 'dir'}
        onClick={handleClick}
        className={cn(
          'flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          isSelected && 'bg-muted/60 text-foreground',
        )}
        style={{ paddingLeft: `${depth * 12}px` }}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{node.name}</span>
      </button>
      {hasChildren && isExpanded ? (
        <div className="ml-2 border-l border-border pl-2">
          {node.children.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
