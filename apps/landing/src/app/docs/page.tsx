import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Documentation Hub | Proompteng',
  description: 'Find onboarding guides, API references, and governance documentation on docs.proompteng.ai.',
  robots: {
    index: false,
    follow: true,
  },
}

export default function DocsPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col items-start gap-4 px-6 py-16">
      <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">documentation hub</p>
      <h1 className="text-3xl font-semibold tracking-tight">Docs moved</h1>
      <p className="text-muted-foreground">
        Our documentation now lives at{' '}
        <Link
          href="https://docs.proompteng.ai"
          className="font-medium text-primary underline"
          target="_blank"
          rel="noreferrer"
        >
          docs.proompteng.ai
        </Link>
        . You will find onboarding guides, API references, and governance playbooks there.
      </p>
      <Link
        href="https://docs.proompteng.ai"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center justify-center rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow transition hover:bg-primary/90"
      >
        Visit documentation
      </Link>
    </main>
  )
}
