import { useCallback, useState } from 'react';
import { addMonthsClamped, isIsoCalendarDate, validityMonthsFor } from '@neway/shared';

/**
 * Issue date → expiry date, for the document types with a fixed term (owner, 2026-10-08).
 *
 * An annual inspection, an MVR review and a Clearinghouse query are good for 12 months from the
 * day they were done, so entering the issue date fills the expiry. The person can always type a
 * different expiry, and once they have, the form never overwrites it. A type without a fixed term
 * (registration, insurance card, CDL, medical card…) never fills anything.
 */
export interface AutoExpiryState {
  code: string;
  issuedOn: string;
  expiresOn: string;
  /** True once somebody typed an expiry by hand; the form stops filling it from then on. */
  expiryTouched: boolean;
  /** The months the current expiry was filled with, when it was filled rather than typed. */
  filledMonths: number | null;
}

export type AutoExpiryAction =
  | { type: 'code'; code: string }
  | { type: 'issued'; issuedOn: string }
  | { type: 'expires'; expiresOn: string };

function fill(state: AutoExpiryState, validityFor: (code: string) => number | null): AutoExpiryState {
  if (state.expiryTouched) return state;
  const months = validityFor(state.code);
  if (months && isIsoCalendarDate(state.issuedOn)) {
    return { ...state, expiresOn: addMonthsClamped(state.issuedOn, months), filledMonths: months };
  }
  // A value this form filled for another type or another issue date no longer holds.
  if (state.filledMonths !== null) return { ...state, expiresOn: '', filledMonths: null };
  return state;
}

export function autoExpiryReducer(
  state: AutoExpiryState,
  action: AutoExpiryAction,
  validityFor: (code: string) => number | null = validityMonthsFor,
): AutoExpiryState {
  switch (action.type) {
    case 'code':
      return fill({ ...state, code: action.code }, validityFor);
    case 'issued':
      return fill({ ...state, issuedOn: action.issuedOn }, validityFor);
    case 'expires':
      // Typing an expiry takes over; clearing it hands the field back to the issue date.
      return {
        ...state,
        expiresOn: action.expiresOn,
        expiryTouched: action.expiresOn !== '',
        filledMonths: null,
      };
  }
}

/** The hint under the expiry field while the value is the filled one. */
export function autoExpiryHint(state: Pick<AutoExpiryState, 'filledMonths'>): string | null {
  return state.filledMonths
    ? `Filled from the issue date (+${state.filledMonths} months). Change it if the document says otherwise.`
    : null;
}

/** The dialog-side wrapper: the three setters a form needs, and the hint. */
export function useAutoExpiry(initial: { code: string; issuedOn?: string; expiresOn?: string }) {
  const [state, setState] = useState<AutoExpiryState>({
    code: initial.code,
    issuedOn: initial.issuedOn ?? '',
    expiresOn: initial.expiresOn ?? '',
    // An expiry already on the record (an edit) counts as typed: the form must not rewrite it.
    expiryTouched: Boolean(initial.expiresOn),
    filledMonths: null,
  });
  const setCode = useCallback(
    (code: string) => setState((s) => autoExpiryReducer(s, { type: 'code', code })),
    [],
  );
  const setIssuedOn = useCallback(
    (issuedOn: string) => setState((s) => autoExpiryReducer(s, { type: 'issued', issuedOn })),
    [],
  );
  const setExpiresOn = useCallback(
    (expiresOn: string) => setState((s) => autoExpiryReducer(s, { type: 'expires', expiresOn })),
    [],
  );
  return { ...state, setCode, setIssuedOn, setExpiresOn, hint: autoExpiryHint(state) };
}
