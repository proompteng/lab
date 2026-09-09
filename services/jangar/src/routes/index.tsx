import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@proompteng/design/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import { GitPullRequest, Library, LineChart, Search } from 'lucide-react'
import type * as React from 'react'

export const Route = createFileRoute('/')({ component: Home })

type HomeCard = {
  to: string
  title: string
  description: string
  icon: React.ComponentType<{ className?: string }>
}

const homeCards: HomeCard[] = [
  {
    to: '/github/pulls',
    title: 'PR reviews',
    description: 'Review, merge, and inspect repository work.',
    icon: GitPullRequest,
  },
  {
    to: '/atlas/search',
    title: 'Atlas search',
    description: 'Search indexed code and enrichment evidence.',
    icon: Search,
  },
  {
    to: '/library/whitepapers',
    title: 'Whitepapers',
    description: 'Browse generated research artifacts.',
    icon: Library,
  },
  {
    to: '/torghut/trading',
    title: 'Trading',
    description: 'Inspect Torghut trading state and evidence.',
    icon: LineChart,
  },
]

function Home() {
  return (
    <main className="mx-auto w-full max-w-6xl p-6">
      <section className="grid gap-4 md:grid-cols-2">
        {homeCards.map((item) => (
          <Card key={item.to} className="transition-colors hover:bg-accent/40">
            <Link to={item.to} className="block h-full">
              <CardHeader className="flex-row items-center gap-3 border-b">
                <span className="flex size-9 items-center justify-center rounded-md border bg-background">
                  <item.icon className="size-4 text-muted-foreground" />
                </span>
                <div className="space-y-1">
                  <CardTitle className="text-sm">{item.title}</CardTitle>
                  <CardDescription>{item.description}</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="pt-4 text-xs text-muted-foreground">Open {item.title.toLowerCase()}</CardContent>
            </Link>
          </Card>
        ))}
      </section>
    </main>
  )
}
