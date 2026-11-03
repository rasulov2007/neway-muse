import { Link } from '@tanstack/react-router';
import type { BreadcrumbLinkComponent } from '@/design-system';
import { parseHref } from './links';

/** Router link that accepts an untyped href (used as `linkComponent` and for list rows). */
export const RouterLink: BreadcrumbLinkComponent = ({ to, className, children }) => {
  const parsed = parseHref(to);
  return (
    <Link to={parsed.to as never} search={parsed.search as never} className={className}>
      {children}
    </Link>
  );
};
