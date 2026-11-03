import {
  useId,
  type FormHTMLAttributes,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  Controller,
  FormProvider,
  type Control,
  type ControllerFieldState,
  type ControllerRenderProps,
  type FieldPath,
  type FieldValues,
  type SubmitHandler,
  type UseFormReturn,
} from 'react-hook-form';
import { cn } from '../../lib/cn';
import { FormField, type FormFieldProps } from '../FormField';

export interface FormProps<
  TFieldValues extends FieldValues,
  TContext = unknown,
  TTransformedValues = TFieldValues,
> extends Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit'> {
  form: UseFormReturn<TFieldValues, TContext, TTransformedValues>;
  onSubmit: SubmitHandler<TTransformedValues>;
}

/** `<form>` wired to a react-hook-form instance (provides context to ControlledField). */
export function Form<
  TFieldValues extends FieldValues,
  TContext = unknown,
  TTransformedValues = TFieldValues,
>({
  form,
  onSubmit,
  className,
  children,
  ...rest
}: FormProps<TFieldValues, TContext, TTransformedValues>) {
  return (
    <FormProvider {...form}>
      <form
        noValidate
        onSubmit={form.handleSubmit(onSubmit)}
        className={cn('flex flex-col gap-6', className)}
        {...rest}
      >
        {children}
      </form>
    </FormProvider>
  );
}

export interface FormSectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  /** Two columns at `lg+`; a field can span both with `lg:col-span-2`. */
  children: ReactNode;
}

/** Titled group of fields laid out in a two-column grid at `lg+`. */
export function FormSection({
  title,
  description,
  className,
  children,
  ...rest
}: FormSectionProps) {
  return (
    <section className={cn('flex flex-col gap-4', className)} {...rest}>
      {title || description ? (
        <header>
          {title ? <h3 className="text-lg font-bold text-nw-text">{title}</h3> : null}
          {description ? <p className="mt-0.5 text-xs text-nw-text-3">{description}</p> : null}
        </header>
      ) : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{children}</div>
    </section>
  );
}

/** Right-aligned footer row for the form's actions. Keep destructive actions away from the primary one. */
export function FormActions({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center justify-end gap-2 border-t border-nw-border pt-4', className)}
      {...rest}
    />
  );
}

export type ControlledFieldRenderProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
> = {
  field: ControllerRenderProps<TFieldValues, TName> & { id: string; invalid: boolean };
  fieldState: ControllerFieldState;
};

export interface ControlledFieldProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
> extends Omit<FormFieldProps, 'children' | 'error' | 'htmlFor'> {
  name: TName;
  /** Falls back to the surrounding `<Form>` context. */
  control?: Control<TFieldValues>;
  /** Return a single control element; it receives id / aria wiring from FormField. */
  render: (props: ControlledFieldRenderProps<TFieldValues, TName>) => ReactElement;
}

/** Binds a react-hook-form field to FormField and a control. Error text comes from the resolver. */
export function ControlledField<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
>({ name, control, render, ...fieldProps }: ControlledFieldProps<TFieldValues, TName>) {
  const id = useId();
  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => (
        <FormField htmlFor={id} error={fieldState.error?.message} {...fieldProps}>
          {render({ field: { ...field, id, invalid: Boolean(fieldState.error) }, fieldState })}
        </FormField>
      )}
    />
  );
}
