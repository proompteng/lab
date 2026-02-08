import { Link } from '@tanstack/react-router'

import { Home, Menu, Network, SquareFunction, StickyNote } from 'lucide-react'

import {
  Avatar,
  AvatarFallback,
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@proompteng/design/ui'

import type { SessionUser } from '../server/auth/types'

type HeaderProps = {
  user: SessionUser | null
}

export default function Header({ user }: HeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-backdrop-filter:bg-background/75">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <Sheet>
            <SheetTrigger render={<Button variant="ghost" size="icon" aria-label="Open navigation" />}>
              <Menu className="size-4" />
            </SheetTrigger>
            <SheetContent side="left" className="p-0">
              <SheetHeader className="border-b px-6 py-5">
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              <nav className="flex flex-col gap-1 px-3 py-3">
                <Link
                  to="/"
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  activeProps={{
                    className:
                      'flex items-center gap-2 rounded-md px-3 py-2 text-sm bg-muted text-foreground transition',
                  }}
                >
                  <Home className="size-4" />
                  Home
                </Link>
                <div className="px-3 pt-3 text-[0.65rem] font-semibold uppercase tracking-[0.28em] text-muted-foreground">
                  Demos
                </div>
                <Link
                  to="/demo/start/server-funcs"
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  activeProps={{
                    className:
                      'flex items-center gap-2 rounded-md px-3 py-2 text-sm bg-muted text-foreground transition',
                  }}
                >
                  <SquareFunction className="size-4" />
                  Server functions
                </Link>
                <Link
                  to="/demo/start/api-request"
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  activeProps={{
                    className:
                      'flex items-center gap-2 rounded-md px-3 py-2 text-sm bg-muted text-foreground transition',
                  }}
                >
                  <Network className="size-4" />
                  API request
                </Link>
                <Link
                  to="/demo/start/ssr"
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  activeProps={{
                    className:
                      'flex items-center gap-2 rounded-md px-3 py-2 text-sm bg-muted text-foreground transition',
                  }}
                >
                  <StickyNote className="size-4" />
                  SSR demos
                </Link>
              </nav>
            </SheetContent>
          </Sheet>

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
