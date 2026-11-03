import { RadioGroup as RadixRadioGroup } from 'radix-ui';
import { forwardRef, useId, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { isInvalid } from '../Input/controlStyles';

export interface RadioOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioProps extends Omit<
  ComponentPropsWithoutRef<typeof RadixRadioGroup.Item>,
  'asChild'
> {
  label?: ReactNode;
  description?: ReactNode;
}

/** One option inside a RadioGroup. */
export const Radio = forwardRef<HTMLButtonElement, RadioProps>(function Radio(
  { label, description, id: idProp, className, ...rest },
  ref,
) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const descriptionId = description ? `${id}-description` : undefined;

  const item = (
    <RadixRadioGroup.Item
      ref={ref}
      id={id}
      className={cn(
        'peer inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-nw-field ring-[1.5px] ring-inset ring-nw-border-strong',
        'transition-colors duration-(--duration-base) ease-(--ease-standard)',
        'data-[state=checked]:ring-nw-accent disabled:cursor-not-allowed disabled:opacity-45',
        !label && className,
      )}
      aria-describedby={rest['aria-describedby'] ?? descriptionId}
      {...rest}
    >
      <RadixRadioGroup.Indicator className="flex items-center justify-center after:block after:size-2 after:rounded-full after:bg-nw-accent" />
    </RadixRadioGroup.Item>
  );

  if (!label) return item;

  return (
    <div className={cn('flex items-start gap-2', className)}>
      <span className="flex h-5 items-center">{item}</span>
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

export interface RadioGroupProps extends Omit<
  ComponentPropsWithoutRef<typeof RadixRadioGroup.Root>,
  'asChild'
> {
  /** Render options from data; otherwise compose with `<Radio>` children. */
  options?: RadioOption[];
  /** Accessible name when there is no visible label element. */
  label?: string;
  invalid?: boolean;
}

/** Radix radio group. Arrow keys move selection; vertical by default. */
export const RadioGroup = forwardRef<HTMLDivElement, RadioGroupProps>(function RadioGroup(
  { options, label, invalid, orientation = 'vertical', className, children, ...rest },
  ref,
) {
  const showInvalid = isInvalid(invalid, rest['aria-invalid']);
  return (
    <RadixRadioGroup.Root
      ref={ref}
      orientation={orientation}
      aria-label={label}
      className={cn(
        'flex',
        orientation === 'horizontal' ? 'flex-row flex-wrap gap-x-5 gap-y-2' : 'flex-col gap-2',
        className,
      )}
      {...rest}
      aria-invalid={showInvalid ? true : rest['aria-invalid']}
    >
      {options
        ? options.map((option) => (
            <Radio
              key={option.value}
              value={option.value}
              label={option.label}
              description={option.description}
              disabled={option.disabled}
            />
          ))
        : children}
    </RadixRadioGroup.Root>
  );
});
