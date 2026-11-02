import Link from 'next/link'
import { ArrowLeft, FileQuestion } from 'lucide-react'
import { TengriMark } from '@/components/tengri/tengri-mark'

export default function NotFound() {
  return (
    <main className="relative isolate flex min-h-dvh items-center justify-center overflow-hidden bg-zinc-950 px-6 py-16 text-zinc-100">
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-20 bg-[url('/tengri/wallpaper.webp')] bg-cover bg-center"
      />
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-zinc-950/70 backdrop-blur-2xl" />
      <section
        aria-labelledby="not-found-title"
        className="w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/80 shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-white/[0.08] px-5 py-4 text-label-14">
          <TengriMark />
          <span>Tengri</span>
          <span className="ml-auto text-label-12 text-zinc-500">404</span>
        </div>
        <div className="px-7 py-9">
          <FileQuestion aria-hidden="true" className="mb-5 size-10 text-zinc-500" strokeWidth={1.25} />
          <h1 id="not-found-title" className="text-heading-20">
            Nothing at this address.
          </h1>
          <p className="mt-3 text-copy-14 text-zinc-400">This page may have moved, or the link may be incorrect.</p>
          <Link
            href="/"
            className="mt-7 inline-flex min-h-10 items-center gap-2 rounded-lg bg-zinc-100 px-4 text-label-14 text-zinc-950 transition-colors hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-400"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Back to Tengri
          </Link>
        </div>
      </section>
    </main>
  )
}
