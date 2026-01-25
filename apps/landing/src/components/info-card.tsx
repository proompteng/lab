import { Icon, type IconName } from '@/components/icon'
import { cn } from '@/lib/utils'

export default function InfoCard({
  icon,
  title,
  text,
  className,
}: {
  icon?: IconName
  title: string
  text: string
  className?: string
}) {
  return (
    <article
      className={cn(
        'group relative overflow-hidden rounded-xl border bg-card p-6 text-card-foreground',
        'transition-transform transition-colors duration-300 ease-out will-change-transform',
        'hover:-translate-y-0.5 hover:shadow-md hover:border-ring/30',
        'motion-reduce:transform-none motion-reduce:transition-none motion-reduce:hover:translate-y-0',
        className,
      )}
    >
      {/* Decorative glow */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300',
          "before:absolute before:inset-0 before:rounded-[inherit] before:content-['']",
          'before:bg-[radial-gradient(120px_60px_at_85%_25%,_rgba(255,255,255,0.05),_transparent)]',
          'group-hover:opacity-100',
        )}
      />
      {/* Subtle color wash on hover (blue → pink) */}
      <div
        aria-hidden
        className={cn(
          'absolute inset-0 z-0 opacity-0 transition-opacity duration-300',
          'bg-gradient-to-br from-indigo-500/8 via-blue-500/5 to-indigo-600/10',
          'group-hover:opacity-70',
        )}
      />

      {/* Sheen sweep */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden motion-reduce:hidden">
        <div
          className={cn(
            'absolute -inset-y-8 -left-1/3 w-2/3 rotate-12',
            'bg-gradient-to-r from-transparent via-zinc-700/5 to-transparent',
            'opacity-0 translate-x-0 transition-all duration-700 ease-out',
            'group-hover:opacity-100 group-hover:translate-x-[100%]',
          )}
        />
      </div>

      {/* Content */}
      <h3 className="relative z-[1] text-base font-semibold">{title}</h3>
      <p className="relative z-[1] mt-1 text-sm text-muted-foreground">{text}</p>

      {/* Icon - oversized, vertically centered; only left half visible */}
      {icon ? (
        <div
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-0 -translate-y-1/2 translate-x-1/2 text-muted-foreground/10 group-hover:text-muted-foreground/15 z-0 transition-transform duration-700 ease-out group-hover:translate-x-[35%] motion-reduce:transition-none motion-reduce:translate-x-1/2"
        >
          <Icon name={icon} className="size-[180px] sm:size-[220px] md:size-[260px]" strokeWidth={1.25} />
        </div>
      ) : null}

      {/* Underline accent on hover */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-ring/40 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
    </article>
  )
}
