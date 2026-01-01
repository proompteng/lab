import * as React from 'react'

import { cn } from '@/lib/utils'

const Pagination = React.forwardRef<HTMLElement, React.ComponentPropsWithoutRef<'nav'>>(
  ({ className, ...props }, ref) => (
    <nav
      ref={ref}
      aria-label="pagination"
      className={cn('flex w-full items-center justify-between text-xs', className)}
      {...props}
    />
  ),
)
Pagination.displayName = 'Pagination'

const PaginationContent = React.forwardRef<HTMLOListElement, React.HTMLAttributes<HTMLOListElement>>(
  ({ className, ...props }, ref) => <ul ref={ref} className={cn('flex items-center gap-1.5', className)} {...props} />,
)
PaginationContent.displayName = 'PaginationContent'

const PaginationItem = React.forwardRef<HTMLLIElement, React.HTMLAttributes<HTMLLIElement>>(
  ({ className, ...props }, ref) => <li ref={ref} className={cn('flex', className)} {...props} />,
)
PaginationItem.displayName = 'PaginationItem'

type PaginationLinkProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  isActive?: boolean
}

const PaginationLink = React.forwardRef<HTMLButtonElement, PaginationLinkProps>(
  ({ className, isActive, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'h-7 rounded-none border px-2 text-xs transition disabled:pointer-events-none disabled:opacity-50',
        isActive
          ? 'border-border bg-muted text-foreground'
          : 'border-transparent bg-transparent text-muted-foreground hover:border-border hover:bg-muted/40',
        className,
      )}
      {...props}
    />
  ),
)
PaginationLink.displayName = 'PaginationLink'

const PaginationPrevious = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ className, ...props }, ref) => (
    <PaginationLink ref={ref} className={cn('min-w-[5rem]', className)} {...props}>
      Prev
    </PaginationLink>
  ),
)
PaginationPrevious.displayName = 'PaginationPrevious'

const PaginationNext = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ className, ...props }, ref) => (
    <PaginationLink ref={ref} className={cn('min-w-[5rem]', className)} {...props}>
      Next
    </PaginationLink>
  ),
)
PaginationNext.displayName = 'PaginationNext'

export { Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious }
