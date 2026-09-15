import type { ReactNode } from 'react'

interface LayoutProps {
  header?: ReactNode
  sidebar: ReactNode
  content: ReactNode
}

export function Layout({ header, sidebar, content }: LayoutProps) {
  return (
    <div className="h-screen overflow-hidden px-4 py-4 grid grid-cols-[16rem_1fr] grid-rows-[auto_1fr] gap-x-2 gap-y-2 text-slate-200">
      {header ? <div className="col-start-1 col-span-2 row-start-1">{header}</div> : null}
      <aside className="col-start-1 row-start-2 space-y-3 flex flex-col min-h-0 overflow-hidden">{sidebar}</aside>
      <section className="col-start-2 row-start-2 min-h-0 flex flex-col overflow-hidden">{content}</section>
    </div>
  )
}
