import { Check, Minus } from 'lucide-react';
import { Checkbox as RadixCheckbox } from 'radix-ui';
import { forwardRef, useId, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { isInvalid } from '../Input/controlStyles';

export type CheckedState = boolean | 'indeterminate';

export interface CheckboxProps extends Omit<
  ComponentPropsWithoutRef<typeof RadixCheckbox.Root>,
  'asChild' | 'checked'
> {
  checked?: CheckedState;
  /** Visible label. Omit inside tables and pass `aria-label` instead. */
  label?: ReactNode;
  description?: ReactNode;
  invalid?: boolean;
}

/** Radix checkbox, 16px. Works with or without a visible label (`aria-label` required without one). */
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  { label, description, invalid, checked, id: idProp, className, ...rest },
  ref,
) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const descriptionId = description ? `${id}-description` : undefined;
  const showInvalid = isInvalid(invalid, rest['aria-invalid']);

  const box = (
    <RadixCheckbox.Root
      ref={ref}
      id={id}
      checked={checked}
      className={cn(
        'peer inline-flex size-4 shrink-0 items-center justify-center rounded-xs bg-nw-field text-nw-on-accent ring-[1.5px] ring-inset ring-nw-border-strong',
        'transition-colors duration-(--duration-base) ease-(--ease-standard)',
        'data-[state=checked]:bg-nw-accent data-[state=checked]:ring-nw-accent',
        'data-[state=indeterminate]:bg-nw-accent data-[state=indeterminate]:ring-nw-accent',
        'disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:ring-nw-urgent-icon',
        !label && className,
      )}
      aria-describedby={rest['aria-describedby'] ?? descriptionId}
      {...rest}
      aria-invalid={showInvalid ? true : rest['aria-invalid']}
    >
      <RadixCheckbox.Indicator className="flex items-center justify-center">
        {checked === 'indeterminate' ? (
          <Minus aria-hidden className="size-3" strokeWidth={3} />
        ) : (
          <Check aria-hidden className="size-3" strokeWidth={3} />
        )}
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );

  if (!label) return box;

  return (
    <div className={cn('flex items-start gap-2', className)}>
      <span className="flex h-5 items-center">{box}</span>
      <div className="min-w-0">
        <label
          htmlFor={id}
          className="cursor-pointer text-sm text-nw-text select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-45"
        >
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="mt-0.5 text-2xs text-nw-text-3">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
});
