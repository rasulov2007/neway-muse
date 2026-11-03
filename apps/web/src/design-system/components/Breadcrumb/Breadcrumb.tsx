import { ChevronRight } from 'lucide-react';
import { Fragment, type ComponentType, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface BreadcrumbItem {
  label: ReactNode;
  href?: string;
}

export type BreadcrumbLinkComponent = ComponentType<{
  to: string;
  className?: string;
  children: ReactNode;
}>;

export interface BreadcrumbProps extends HTMLAttributes<HTMLElement> {
  items: BreadcrumbItem[];
  /** Router link to render for items with an href (defaults to a plain anchor). */
  linkComponent?: BreadcrumbLinkComponent;
}

const linkClass =
  'rounded-xs text-nw-text-3 transition-colors duration-(--duration-fast) hover:text-nw-accent-ink';

/** Path to the current page; the last item is the current page and is not a link. */
export function Breadcrumb({ items, linkComponent: Link, className, ...rest }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className={cn('text-sm', className)} {...rest}>
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <Fragment key={i}>
              <li className="flex items-center">
                {isLast || !item.href ? (
                  <span
                    aria-current={isLast ? 'page' : undefined}
                    className={isLast ? 'text-nw-text' : 'text-nw-text-3'}
                  >
                    {item.label}
                  </span>
                ) : Link ? (
                  <Link to={item.href} className={linkClass}>
                    {item.label}
                  </Link>
                ) : (
                  <a href={item.href} className={linkClass}>
                    {item.label}
                  </a>
                )}
              </li>
              {!isLast ? (
                <li aria-hidden className="flex items-center text-nw-text-3">
                  <ChevronRight className="size-3.5" />
                </li>
              ) : null}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
