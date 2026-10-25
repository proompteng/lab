interface BreadcrumbsProps {
  items: string[]
}

export function Breadcrumbs({ items }: BreadcrumbsProps) {
  if (!items.length) return null
  return (
    <nav className="mb-3 text-xs text-slate-400" aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((label) => (
          <li key={label} className="flex items-center gap-1">
            <span className="text-slate-200">{label}</span>
          </li>
        ))}
      </ol>
    </nav>
  )
}
