import Link from 'next/link'

import { Button } from '@proompteng/design/ui'

const NAV_ITEMS = [
  { href: '#platform', label: 'platform' },
  { href: '#governance', label: 'governance' },
  { href: '#playbook', label: 'playbook' },
  { href: '#faq', label: 'faq' },
]

export default function Navbar() {
  return (
    <nav aria-label="primary" className="flex flex-wrap items-center justify-between gap-4 py-6">
      <Link href="/" className="text-xl font-semibold tracking-tight text-foreground transition hover:text-primary">
        proompteng
      </Link>
      <div className="hidden flex-1 items-center justify-center gap-6 text-sm text-muted-foreground md:flex">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-full px-3 py-1 transition hover:bg-secondary/60 hover:text-foreground"
          >
            {item.label}
          </Link>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Link
          className="text-sm text-muted-foreground transition hover:text-foreground"
          href="https://docs.proompteng.ai"
          target="_blank"
          rel="noreferrer"
        >
          docs
        </Link>
        <Button asChild size="sm" variant="default">
          <a href="mailto:greg@proompteng.ai">talk to us</a>
        </Button>
      </div>
    </nav>
  )
}
