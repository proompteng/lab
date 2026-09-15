import { Link } from '@tanstack/react-router'

import { Home } from 'lucide-react'

import { Avatar, AvatarFallback } from '@proompteng/design/ui/avatar'
import { Button } from '@proompteng/design/ui/button'

import type { SessionUser } from '../server/auth/types'

type HeaderProps = {
  user: SessionUser | null
}

export default function Header({ user }: HeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-backdrop-filter:bg-background/75">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/" aria-label="Home">
              <Home className="size-4" />
            </Link>
          </Button>

          <Link to="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <span className="rounded-md border bg-muted px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.28em] text-muted-foreground">
              app
            </span>
            proompteng
          </Link>
        </div>

        <div className="flex items-center gap-2">
          {user ? (
            <>
              <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
                <Avatar className="size-7">
                  <AvatarFallback>{(user.email ?? user.name ?? 'U').slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <span className="max-w-[18ch] truncate">{user.email ?? user.name ?? user.sub}</span>
              </div>
              <Button variant="outline" asChild>
                <a href="/auth/logout">Sign out</a>
              </Button>
            </>
          ) : (
            <Button asChild>
              <a href="/login">Sign in</a>
            </Button>
          )}
        </div>
      </div>
    </header>
  )
}
