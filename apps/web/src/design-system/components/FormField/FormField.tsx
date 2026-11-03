import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/cn';
import { StatusSymbol } from '../Badge/StatusSymbol';

export interface FormFieldProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label?: ReactNode;
  description?: ReactNode;
  /** Inline validation message; also sets `aria-invalid` on a single child control. */
  error?: ReactNode;
  required?: boolean;
  /** Id of the control. Generated (and injected into a single child) when omitted. */
  htmlFor?: string;
  children: ReactNode;
}

type InjectedProps = {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-required'?: boolean;
};

/**
 * Label above, control, helper text and inline error below. When the child is a single element
 * it receives `id`, `aria-describedby`, `aria-invalid` and `aria-required` automatically.
 */
export function FormField({
  label,
  description,
  error,
  required = false,
  htmlFor,
  className,
  children,
  ...rest
}: FormFieldProps) {
  const generatedId = useId();
  const id = htmlFor ?? generatedId;
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, descriptionId].filter(Boolean).join(' ') || undefined;

  let control: ReactNode = children;
  const only = Children.count(children) === 1 ? Children.only(children) : null;
  if (only && isValidElement<InjectedProps>(only)) {
    const existing = only.props['aria-describedby'];
    control = cloneElement(only, {
      id: only.props.id ?? id,
      'aria-describedby': [existing, describedBy].filter(Boolean).join(' ') || undefined,
      'aria-invalid': error ? true : only.props['aria-invalid'],
      'aria-required': required ? true : only.props['aria-required'],
    });
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)} {...rest}>
      {label ? (
        <label htmlFor={id} className="text-xs font-semibold text-nw-text-2">
          {label}
          {required ? (
            <span aria-hidden className="ml-0.5 text-nw-urgent-text">
              *
            </span>
          ) : null}
        </label>
      ) : null}
      {control}
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1 text-2xs font-medium text-nw-urgent-text"
        >
          <StatusSymbol family="urgent" size={14} className="mt-px text-nw-urgent-icon" />
          <span>{error}</span>
        </p>
      ) : description ? (
        <p id={descriptionId} className="text-2xs text-nw-text-3">
          {description}
        </p>
      ) : null}
      {error && description ? (
        <p id={descriptionId} className="sr-only">
          {description}
        </p>
      ) : null}
    </div>
  );
}

export type FormFieldElement = ReactElement<InjectedProps>;
