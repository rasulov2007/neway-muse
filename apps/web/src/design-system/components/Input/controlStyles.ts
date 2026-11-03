export type ControlSize = 'sm' | 'md' | 'lg';

/**
 * Chrome shared by text inputs and input-like triggers (select, combobox, date picker).
 * Porcelain input: field fill, 1px inset border-strong, radius 8; focus is a 1.5px accent inset
 * plus a 3px tint halo; error is a 1px urgent-icon outline; read-only is subtle fill + text-2.
 */
export const controlBase =
  'flex w-full min-w-0 items-center rounded-md bg-nw-field text-left text-nw-text ' +
  'ring-1 ring-inset ring-nw-border-strong ' +
  'transition-[box-shadow,background-color,color] duration-(--duration-base) ease-(--ease-standard) ' +
  'focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-nw-accent focus-visible:shadow-focus ' +
  'read-only:bg-nw-subtle read-only:text-nw-text-2 ' +
  'disabled:cursor-not-allowed disabled:bg-nw-subtle disabled:text-nw-text-2 ' +
  'aria-invalid:ring-nw-urgent-icon';

/* Inputs and selects are 36px (SPEC §6 `--nw-input-height`); `sm` stays at the small control height. */
export const controlSizes: Record<ControlSize, string> = {
  sm: 'h-(--control-height-sm) px-2 text-sm [&_svg]:size-3.5',
  md: 'h-(--control-height-lg) px-2.5 text-base [&_svg]:size-[15px]',
  lg: 'h-10 px-3 text-base [&_svg]:size-4',
};

/** Min-height variants for controls that grow (multi-select chips). */
export const controlMinHeights: Record<ControlSize, string> = {
  sm: 'min-h-(--control-height-sm)',
  md: 'min-h-(--control-height-lg)',
  lg: 'min-h-10',
};

/** Wrapper-level states for composite controls (a div around an input or trigger). */
export const controlWrapperStates =
  'has-[:focus-visible]:ring-[1.5px] has-[:focus-visible]:ring-nw-accent has-[:focus-visible]:shadow-focus ' +
  'has-[:read-only]:bg-nw-subtle has-[:read-only]:text-nw-text-2 ' +
  'data-invalid:ring-nw-urgent-icon ' +
  'data-disabled:cursor-not-allowed data-disabled:bg-nw-subtle data-disabled:text-nw-text-2';

export type AriaInvalid = boolean | 'true' | 'false' | 'grammar' | 'spelling' | undefined;

/** True when either the `invalid` prop or an `aria-invalid` attribute (e.g. from FormField) is set. */
export function isInvalid(invalid: boolean | undefined, ariaInvalid: AriaInvalid): boolean {
  return Boolean(invalid) || ariaInvalid === true || ariaInvalid === 'true';
}
