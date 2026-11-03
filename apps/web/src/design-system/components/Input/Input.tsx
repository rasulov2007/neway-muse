import { forwardRef, type ChangeEvent, type FocusEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { formatMoneyInput, formatUsPhone } from '../../lib/inputMasks';
import {
  controlBase,
  controlSizes,
  controlWrapperStates,
  isInvalid,
  type ControlSize,
} from './controlStyles';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  size?: ControlSize;
  /** Leading icon or short text (a search icon, "$"). */
  prefix?: ReactNode;
  /** Trailing icon or short text ("mi", "%"). */
  suffix?: ReactNode;
  /** Error styling. Also applied when `aria-invalid` is set (FormField does this). */
  invalid?: boolean;
  /**
   * A money amount: written as 500.00 when the field is left. On by default for a "$" prefix
   * (owner, 2026-10-13); pass false to keep what was typed.
   */
  money?: boolean;
}

/** Single-line text input, 36px by default. With `prefix`/`suffix` the chrome moves to a wrapper. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', prefix, suffix, invalid, className, disabled, type = 'text', money, ...props },
  ref,
) {
  const showInvalid = isInvalid(invalid, props['aria-invalid']);
  const ariaInvalid = showInvalid ? true : props['aria-invalid'];
  const isMoney = money ?? prefix === '$';
  const rest = {
    ...props,
    // The browser does not offer to save or fill business addresses into the person's own Google
    // profile (owner, 2026-10-20): an unrecognised token turns Chrome's address autofill off for
    // the field. Fields that want it (sign-in, passwords) say so with their own autoComplete.
    autoComplete: props.autoComplete ?? 'nw-no-autofill',
    // A US phone is written (555) 010-1431 as it is typed (owner, 2026-10-13).
    onChange:
      type === 'tel' && props.onChange
        ? (event: ChangeEvent<HTMLInputElement>) => {
            const formatted = formatUsPhone(event.target.value);
            if (formatted !== event.target.value) event.target.value = formatted;
            props.onChange?.(event);
          }
        : props.onChange,
    // Money is written with its cents when the field is left: 500 → 500.00.
    onBlur:
      isMoney && props.onChange
        ? (event: FocusEvent<HTMLInputElement>) => {
            const formatted = formatMoneyInput(event.target.value);
            if (formatted !== event.target.value) {
              event.target.value = formatted;
              props.onChange?.(event as unknown as ChangeEvent<HTMLInputElement>);
            }
            props.onBlur?.(event);
          }
        : props.onBlur,
  };

  if (!prefix && !suffix) {
    return (
      <input
        ref={ref}
        type={type}
        disabled={disabled}
        className={cn(controlBase, controlSizes[size], 'placeholder:text-nw-text-3', className)}
        {...rest}
        aria-invalid={ariaInvalid}
      />
    );
  }

  return (
    <div
      data-invalid={showInvalid || undefined}
      data-disabled={disabled || undefined}
      className={cn(
        controlBase,
        controlSizes[size],
        controlWrapperStates,
        'gap-1.5 focus-visible:outline-0',
        className,
      )}
    >
      {prefix ? (
        <span className="flex shrink-0 items-center text-nw-text-3 [&_svg]:size-[15px]">{prefix}</span>
      ) : null}
      <input
        ref={ref}
        type={type}
        disabled={disabled}
        className="input-bare h-full w-full min-w-0 flex-1 bg-transparent text-inherit outline-none placeholder:text-nw-text-3 disabled:cursor-not-allowed"
        {...rest}
        aria-invalid={ariaInvalid}
      />
      {suffix ? (
        <span className="flex shrink-0 items-center text-nw-text-3 [&_svg]:size-[15px]">{suffix}</span>
      ) : null}
    </div>
  );
});
