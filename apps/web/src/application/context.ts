import { createContext, useContext } from 'react';
import type { DotAppAnswers, DotAppCompanyBrand, DotAppDriverState, DotAppSignatureView, DotAppStepId, DotAppTemplate } from '@neway/shared';

/** What every field and document card on the page reads and writes. */
export interface FormApi {
  a: DotAppAnswers;
  set: (path: string, value: unknown) => void;
  /** Keys shown as invalid (after Continue or a Fix link). */
  errors: ReadonlySet<string>;
  prefilled: ReadonlySet<string>;
  today: string;
  company: DotAppCompanyBrand;
  state: DotAppDriverState;
  tpl: (key: string) => DotAppTemplate | undefined;
  awaiting: ReadonlySet<string>;
  /** Signature keys the driver signs on this application (from the shared rule). */
  required: ReadonlySet<string>;
  sigs: ReadonlyMap<string, DotAppSignatureView>;
  sigImages: ReadonlyMap<string, string>;
  openSign: (key: string) => void;
  goto: (step: DotAppStepId) => void;
  ssn: {
    onFile: boolean;
    last4: string | null;
    editing: boolean;
    draft: string;
    setDraft: (v: string) => void;
    startEdit: () => void;
  };
  /** ACH bank numbers: never in the answers; "•••• 1234 On file / Change" once sealed. */
  bank: {
    onFile: boolean;
    last4: string | null;
    editing: boolean;
    routing: string;
    account: string;
    set: (field: 'routing' | 'account', v: string) => void;
    startEdit: () => void;
  };
}

const Ctx = createContext<FormApi | null>(null);
export const FormProvider = Ctx.Provider;
export function useForm(): FormApi {
  const f = useContext(Ctx);
  if (!f) throw new Error('useForm outside FormProvider');
  return f;
}
