import { Switch as RadixSwitch } from 'radix-ui';
import { forwardRef, useId, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface SwitchProps extends Omit<
  ComponentPropsWithoutRef<typeof RadixSwitch.Root>,
  'asChild'
> {
  label?: ReactNode;
  description?: ReactNode;
}

/** Radix switch (36×20). Use for immediate on/off settings, not for form fields that need a save. */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { label, description, id: idProp, className, ...rest },
  ref,
) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const descriptionId = description ? `${id}-description` : undefined;

  const control = (
    <RadixSwitch.Root
      ref={ref}
      id={id}
      className={cn(
        'peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-nw-border-strong',
        'transition-colors duration-(--duration-base) ease-(--ease-standard)',
        'data-[state=checked]:bg-nw-accent disabled:cursor-not-allowed disabled:opacity-45',
        !label && className,
      )}
      aria-describedby={rest['aria-describedby'] ?? descriptionId}
      {...rest}
    >
      <RadixSwitch.Thumb
        className={cn(
          'block size-4 translate-x-0.5 rounded-full bg-nw-panel',
          'transition-transform duration-(--duration-base) ease-(--ease-standard)',
          'data-[state=checked]:translate-x-4',
        )}
      />
    </RadixSwitch.Root>
  );

  if (!label) return control;

  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <span className="flex h-5 items-center">{control}</span>
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
