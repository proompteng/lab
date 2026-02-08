import { createFileRoute } from '@tanstack/react-router'

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@proompteng/design/ui'

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>) => ({
    next: typeof search.next === 'string' ? search.next : undefined,
  }),
  component: Login,
})

function Login() {
  const { next } = Route.useSearch()
  const href = next ? `/auth/login?next=${encodeURIComponent(next)}` : '/auth/login'

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto flex min-h-screen max-w-2xl items-center px-6 py-16">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Authenticate with your proompteng SSO to access the control plane.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Button size="lg" asChild>
              <a href={href}>Continue with SSO</a>
            </Button>
            <p className="text-xs text-muted-foreground">
              If you are stuck in a redirect loop, clear cookies for{' '}
              <code className="font-mono">app.proompteng.ai</code>
              and try again.
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
