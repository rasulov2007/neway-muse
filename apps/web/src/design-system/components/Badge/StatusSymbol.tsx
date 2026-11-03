import type { SVGAttributes } from 'react';
import { cn } from '../../lib/cn';

/**
 * Porcelain status symbols (design/porcelain/icons/*.svg), inlined so the theme colours apply.
 *
 * The shape is drawn in `currentColor`, so the parent sets the family colour (normally
 * `text-nw-<family>-icon`); the glyph inside a filled shape uses `--nw-status-glyph`.
 * Every status is a symbol plus a word — never the symbol alone (SPEC §7 Status, §13).
 */
export type StatusSymbolFamily =
  | 'urgent'
  | 'warning'
  | 'done'
  | 'moving'
  | 'neutral'
  | 'inShop'
  | 'info';

export interface StatusSymbolProps extends Omit<SVGAttributes<SVGSVGElement>, 'children'> {
  family: StatusSymbolFamily;
  /** Pixel size: 13 in pills, 14 in text form and lists. */
  size?: number;
}

const glyphFill = 'fill-nw-status-glyph';
const glyphStroke = 'stroke-nw-status-glyph';

export function StatusSymbol({ family, size = 14, className, ...rest }: StatusSymbolProps) {
  const common = {
    width: size,
    height: size,
    'aria-hidden': true,
    focusable: false,
    className: cn('shrink-0', className),
    ...rest,
  } as const;

  switch (family) {
    case 'urgent':
      return (
        <svg viewBox="0 0 16 16" {...common}>
          <path fill="currentColor" d="M5.1 .8h5.8l4.3 4.3v5.8l-4.3 4.3H5.1L.8 10.9V5.1z" />
          <rect x="7.1" y="3.7" width="1.8" height="5.4" rx=".9" className={glyphFill} />
          <circle cx="8" cy="11.6" r="1.1" className={glyphFill} />
        </svg>
      );
    case 'warning':
      return (
        <svg viewBox="0 0 16 16" {...common}>
          <path fill="currentColor" d="M8 .3l7.7 7.7L8 15.7.3 8z" />
          <rect x="7.15" y="4.2" width="1.7" height="4.8" rx=".85" className={glyphFill} />
          <circle cx="8" cy="11.1" r="1.05" className={glyphFill} />
        </svg>
      );
    case 'done':
      return (
        <svg viewBox="0 0 16 16" {...common}>
          <circle cx="8" cy="8" r="7.5" fill="currentColor" />
          <path
            d="M4.6 8.3l2.3 2.3 4.5-4.6"
            fill="none"
            className={glyphStroke}
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'moving':
      return (
        <svg viewBox="0 0 16 16" {...common}>
          <circle cx="8" cy="8" r="7.5" fill="currentColor" />
          <path
            d="M4.3 8h6.6M8.2 5.2L11 8l-2.8 2.8"
            fill="none"
            className={glyphStroke}
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'inShop':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          {...common}
        >
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      );
    case 'info':
      return (
        <svg viewBox="0 0 16 16" {...common}>
          <circle cx="8" cy="8" r="7.5" fill="currentColor" />
          <rect x="7.15" y="7" width="1.7" height="4.8" rx=".85" className={glyphFill} />
          <circle cx="8" cy="4.7" r="1.05" className={glyphFill} />
        </svg>
      );
    case 'neutral':
    default:
      return (
        <svg viewBox="0 0 16 16" {...common}>
          <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M5.3 8h5.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
  }
}
