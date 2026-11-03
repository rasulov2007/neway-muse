import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { isInvalid } from '../Input/controlStyles';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Error styling. Also applied when `aria-invalid` is set (FormField does this). */
  invalid?: boolean;
}

/** Multi-line text input. Height follows `rows`; the user can resize vertically. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { rows = 3, invalid, className, ...rest },
  ref,
) {
  const showInvalid = isInvalid(invalid, rest['aria-invalid']);
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        'block w-full min-w-0 resize-y rounded-md bg-nw-field px-2.5 py-2 text-base text-nw-text',
        'ring-1 ring-inset ring-nw-border-strong',
        'min-h-(--control-height-lg) placeholder:text-nw-text-3',
        'transition-[box-shadow,background-color,color] duration-(--duration-base) ease-(--ease-standard)',
        'focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-nw-accent focus-visible:shadow-focus',
        'read-only:bg-nw-subtle read-only:text-nw-text-2',
        'disabled:cursor-not-allowed disabled:bg-nw-subtle disabled:text-nw-text-2',
        'aria-invalid:ring-nw-urgent-icon',
        className,
      )}
      {...rest}
      aria-invalid={showInvalid ? true : rest['aria-invalid']}
    />
  );
});
