import * as React from 'react'

import { cn } from '@/lib/utils'

const Breadcrumb = React.forwardRef<HTMLElement, React.ComponentPropsWithoutRef<'nav'>>(
  ({ className, ...props }, ref) => (
    <nav ref={ref} aria-label="breadcrumb" className={cn('min-w-0', className)} {...props} />
  ),
)
Breadcrumb.displayName = 'Breadcrumb'

const BreadcrumbList = React.forwardRef<HTMLOListElement, React.OlHTMLAttributes<HTMLOListElement>>(
  ({ className, ...props }, ref) => (
    <ol
      ref={ref}
      className={cn('flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground', className)}
      {...props}
    />
  ),
)
BreadcrumbList.displayName = 'BreadcrumbList'

const BreadcrumbItem = React.forwardRef<HTMLLIElement, React.LiHTMLAttributes<HTMLLIElement>>(
  ({ className, ...props }, ref) => (
    <li ref={ref} className={cn('inline-flex min-w-0 items-center gap-1.5', className)} {...props} />
  ),
)
BreadcrumbItem.displayName = 'BreadcrumbItem'

type BreadcrumbLinkProps = React.ComponentPropsWithoutRef<'a'> & { asChild?: boolean }

const BreadcrumbLink = React.forwardRef<HTMLAnchorElement, BreadcrumbLinkProps>(
  ({ className, asChild, children, ...props }, ref) => {
    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<{ className?: string }>
      return React.cloneElement(child, {
        className: cn('truncate text-foreground/80 hover:text-foreground', child.props.className, className),
      })
    }

    return (
      <a ref={ref} className={cn('truncate text-foreground/80 hover:text-foreground', className)} {...props}>
        {children}
      </a>
    )
  },
)
BreadcrumbLink.displayName = 'BreadcrumbLink'

const BreadcrumbPage = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span ref={ref} className={cn('truncate text-foreground', className)} aria-current="page" {...props} />
  ),
)
BreadcrumbPage.displayName = 'BreadcrumbPage'

const BreadcrumbSeparator = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn('text-muted-foreground/60', className)} role="presentation" {...props}>
    /
  </span>
)

export { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator }
