import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { Select as RadixSelect } from 'radix-ui';
import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/cn';
import { controlBase, controlSizes, isInvalid, type ControlSize } from '../Input/controlStyles';
import { popoverMotion, popoverSurface } from '../Popover/popoverStyles';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Pick<
  ComponentPropsWithoutRef<'button'>,
  | 'id'
  | 'className'
  | 'aria-label'
  | 'aria-labelledby'
  | 'aria-describedby'
  | 'aria-invalid'
  | 'aria-required'
  | 'onBlur'
> {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  size?: ControlSize;
  /** Error styling. Also applied when `aria-invalid` is set (FormField does this). */
  invalid?: boolean;
  disabled?: boolean;
  required?: boolean;
  /** Renders a hidden native select for form submission. */
  name?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Class name for the popover panel. */
  contentClassName?: string;
}

const scrollButton = 'flex h-6 cursor-default items-center justify-center bg-nw-raised text-nw-text-3';

/** Native-feeling single select (Radix). Keyboard typeahead, portalled list, check mark on the current item. */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    options,
    value,
    defaultValue,
    onValueChange,
    placeholder = 'Select…',
    size = 'md',
    invalid,
    disabled,
    required,
    name,
    open,
    onOpenChange,
    className,
    contentClassName,
    ...triggerProps
  },
  ref,
) {
  const showInvalid = isInvalid(invalid, triggerProps['aria-invalid']);
  // Radix reads an empty-string value as "nothing chosen" and shows the placeholder. When the
  // options carry their own empty choice ("All recruiters", "None", "Unassigned"), that label is
  // what the trigger should say, not a generic "Select…".
  const emptyChoice = options.find((option) => option.value === '')?.label;
  return (
    <RadixSelect.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      disabled={disabled}
      required={required}
      name={name}
      open={open}
      onOpenChange={onOpenChange}
    >
      <RadixSelect.Trigger
        ref={ref}
        className={cn(
          controlBase,
          controlSizes[size],
          'justify-between gap-2 data-[placeholder]:text-nw-text-3',
          className,
        )}
        {...triggerProps}
        aria-invalid={showInvalid ? true : triggerProps['aria-invalid']}
      >
        <span className="min-w-0 flex-1 truncate">
          <RadixSelect.Value placeholder={emptyChoice ?? placeholder} />
        </span>
        <RadixSelect.Icon asChild>
          <ChevronDown aria-hidden className="shrink-0 text-nw-text-3" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className={cn(
            popoverSurface,
            popoverMotion,
            'max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-hidden',
            contentClassName,
          )}
        >
          <RadixSelect.ScrollUpButton className={scrollButton}>
            <ChevronUp aria-hidden className="size-4" />
          </RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport className="scroll-quiet">
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  'relative flex min-h-9 cursor-default items-center border-b border-nw-border py-2 pr-9 pl-3 text-sm text-nw-text outline-none select-none last:border-b-0',
                  'data-[highlighted]:bg-nw-highlight data-[state=checked]:font-semibold',
                  'data-[disabled]:pointer-events-none data-[disabled]:opacity-[0.62]',
                )}
              >
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="absolute right-3 inline-flex items-center text-nw-accent">
                  <Check aria-hidden className="size-4" />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
          <RadixSelect.ScrollDownButton className={scrollButton}>
            <ChevronDown aria-hidden className="size-4" />
          </RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
});
