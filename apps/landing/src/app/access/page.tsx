import { headers } from 'next/headers'
import Link from 'next/link'
import { AccessPanel } from '@/components/tengri/access-panel'
import { getTengriIdentity } from '@/lib/tengri/auth'

export const dynamic = 'force-dynamic'

export default async function AccessPage() {
  const identity = await getTengriIdentity(await headers())
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-10 text-zinc-100">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Tengri access</h1>
          <Link href="/" className="text-sm text-zinc-400 underline">
            Desktop
          </Link>
        </header>
        {identity ? <AccessPanel /> : <p>Sign in on the desktop with GitHub and your passkey to manage access.</p>}
      </div>
    </main>
  )
}
