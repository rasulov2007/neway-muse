import { Link } from '@tanstack/react-router';
import type { AnchorHTMLAttributes, ReactNode, Ref } from 'react';

export interface RouterLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** Route path (or path + search string) as a plain string. */
  to: string;
  children?: ReactNode;
  ref?: Ref<HTMLAnchorElement>;
  /** Only mark the link active on an exact path match (default: prefix match). */
  exact?: boolean;
}

/**
 * TanStack `<Link>` that accepts an untyped path. Pages pass it to `Breadcrumb` as
 * `linkComponent`; the shell uses it for navigation built from `NAVIGATION`.
 */
export function RouterLink({ to, exact, ...rest }: RouterLinkProps) {
  return <Link to={to as '/'} activeOptions={{ exact: exact ?? false }} {...rest} />;
}
