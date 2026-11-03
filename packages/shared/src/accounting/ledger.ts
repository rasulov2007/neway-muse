/**
 * The general ledger: a chart of accounts, and journal entries that must balance.
 *
 * There is no ledger in `docs/DATABASE.md` — the schema stops at `expense_categories`,
 * `ledger_periods` and the `load_profitability` read model. So this is new, and it is built as the
 * spine rather than a report: every financial event in the system posts through `postingFor`, and
 * `buildEntry` refuses to produce an unbalanced entry at all. An unbalanced entry cannot be
 * constructed, which is a stronger guarantee than validating one after the fact.
 *
 * Money is handled in **integer cents** throughout. Posting `0.1 + 0.2` in floating point and
 * asserting it equals `0.3` is how a ledger silently stops balancing; cents make the balance check
 * exact.
 *
 * Honesty rules:
 *  - A posting into a closed period is refused, never quietly re-dated.
 *  - An event that has already posted does not post twice: `sourceKey` is the idempotency key, and
 *    the same operational event always produces the same key.
 */

// ---------------------------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------------------------

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * Which side increases the account.
 *
 * Assets and expenses rise on the debit side; liabilities, equity and revenue on the credit side.
 * This is what lets a balance be reported as a positive number in the direction the account
 * naturally runs, rather than as a signed figure the reader has to interpret.
 */
export const NORMAL_BALANCE: Record<AccountType, 'debit' | 'credit'> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  revenue: 'credit',
};

export interface Account {
  /** Numeric code, e.g. `1200`. Sorts the chart and groups it by leading digit. */
  code: string;
  name: string;
  type: AccountType;
  /** Parent account code, for the hierarchy. Null for a top-level heading. */
  parent: string | null;
  /** False for headings, which are never posted to directly. */
  postable: boolean;
  /** Where the money physically sits; used by reconciliation. */
  isCash?: boolean;
  description?: string;
}

/**
 * The chart of accounts for a truckload carrier.
 *
 * Deliberately small. Every account here is one this system actually posts to or reports from; a
 * chart padded with accounts nothing touches is a chart nobody trusts. The direct-cost accounts
 * (5xxx) mirror `expense_categories` in the schema so an expense's category maps to exactly one
 * account without a lookup table nobody maintains.
 */
export const CHART_OF_ACCOUNTS: readonly Account[] = [
  // 1000 — assets
  { code: '1000', name: 'Assets', type: 'asset', parent: null, postable: false },
  { code: '1100', name: 'Cash', type: 'asset', parent: '1000', postable: false },
  {
    code: '1110',
    name: 'Operating account',
    type: 'asset',
    parent: '1100',
    postable: true,
    isCash: true,
  },
  {
    code: '1200',
    name: 'Accounts receivable',
    type: 'asset',
    parent: '1000',
    postable: true,
    description: 'What customers and brokers owe on issued invoices.',
  },
  { code: '1300', name: 'Prepaid expenses', type: 'asset', parent: '1000', postable: true },
  {
    code: '1250',
    name: 'Factoring reserve receivable',
    type: 'asset',
    parent: '1000',
    postable: true,
    description: 'Reserve or holdback RTS keeps on funded invoices until the broker pays; released or charged later.',
  },
  {
    code: '1400',
    name: 'Driver escrow held',
    type: 'asset',
    parent: '1000',
    postable: true,
    description: 'Escrow withheld from settlements and owed back to the driver.',
  },

  // 2000 — liabilities
  { code: '2000', name: 'Liabilities', type: 'liability', parent: null, postable: false },
  {
    code: '2100',
    name: 'Accounts payable',
    type: 'liability',
    parent: '2000',
    postable: true,
    description: 'What the carrier owes vendors on posted bills.',
  },
  { code: '2200', name: 'Accrued expenses', type: 'liability', parent: '2000', postable: true },
  {
    code: '2300',
    name: 'Driver settlements payable',
    type: 'liability',
    parent: '2000',
    postable: true,
  },
  { code: '2310', name: 'Payroll payable', type: 'liability', parent: '2000', postable: true },
  {
    code: '2320',
    name: 'Payroll taxes payable',
    type: 'liability',
    parent: '2000',
    postable: true,
  },

  // 3000 — equity
  { code: '3000', name: 'Equity', type: 'equity', parent: null, postable: false },
  { code: '3100', name: 'Retained earnings', type: 'equity', parent: '3000', postable: true },

  // 4000 — revenue
  { code: '4000', name: 'Revenue', type: 'revenue', parent: null, postable: false },
  { code: '4100', name: 'Linehaul revenue', type: 'revenue', parent: '4000', postable: true },
  { code: '4110', name: 'Fuel surcharge', type: 'revenue', parent: '4000', postable: true },
  { code: '4200', name: 'Detention', type: 'revenue', parent: '4000', postable: true },
  { code: '4210', name: 'Layover', type: 'revenue', parent: '4000', postable: true },
  { code: '4300', name: 'Lumper reimbursed', type: 'revenue', parent: '4000', postable: true },
  { code: '4400', name: 'TONU', type: 'revenue', parent: '4000', postable: true },
  { code: '4500', name: 'Other revenue', type: 'revenue', parent: '4000', postable: true },

  // 5000 — direct costs, mirroring expense_categories
  { code: '5000', name: 'Direct costs', type: 'expense', parent: null, postable: false },
  { code: '5100', name: 'Fuel', type: 'expense', parent: '5000', postable: true },
  { code: '5200', name: 'Driver pay', type: 'expense', parent: '5000', postable: true },
  { code: '5300', name: 'Maintenance', type: 'expense', parent: '5000', postable: true },
  { code: '5400', name: 'Tolls', type: 'expense', parent: '5000', postable: true },
  { code: '5500', name: 'Lumper', type: 'expense', parent: '5000', postable: true },

  // 6000 — operating expenses
  { code: '6000', name: 'Operating expenses', type: 'expense', parent: null, postable: false },
  { code: '6100', name: 'Insurance', type: 'expense', parent: '6000', postable: true },
  { code: '6200', name: 'Permits and licensing', type: 'expense', parent: '6000', postable: true },
  { code: '6300', name: 'Equipment lease', type: 'expense', parent: '6000', postable: true },
  { code: '6400', name: 'Staff payroll', type: 'expense', parent: '6000', postable: true },
  { code: '6500', name: 'Payroll taxes', type: 'expense', parent: '6000', postable: true },
  { code: '6600', name: 'Factoring fees', type: 'expense', parent: '6000', postable: true, description: 'What the factor charged: the fee on each funding, plus holiday and other fees.' },
  {
    code: '6700',
    name: 'Recruiting and hiring',
    type: 'expense',
    parent: '6000',
    postable: true,
    description: 'What it cost to find, check, bring in and start drivers: the candidate costs Recruiting posts.',
  },
  { code: '6900', name: 'Other operating', type: 'expense', parent: '6000', postable: true },
];

const ACCOUNT_BY_CODE = new Map(CHART_OF_ACCOUNTS.map((a) => [a.code, a]));

export function accountFor(code: string): Account | null {
  return ACCOUNT_BY_CODE.get(code) ?? null;
}

/** `expense_categories.code` → the account it posts to. */
/**
 * A bill or an expense names its category, and the two vocabularies in use are not the same.
 *
 * `EXPENSE_ACCOUNT` is keyed by the category's NAME (`maintenance`), but the records carry the
 * account CODE (`5300`) - which is what the screens, the imports and the dashboard use. Looking a
 * code up in a map of names silently missed every time and posted the money to "other operating",
 * so a repair, a toll and an insurance premium all landed in the same bucket and the category the
 * person chose was thrown away. This accepts either and only falls back when it recognises
 * neither.
 */
export function expenseAccountFor(categoryCodeOrName: string): string {
  const key = String(categoryCodeOrName ?? '').trim();
  if (EXPENSE_ACCOUNT[key]) return EXPENSE_ACCOUNT[key]!;
  const byCode = Object.values(EXPENSE_ACCOUNT).find((code) => code === key);
  return byCode ?? EXPENSE_ACCOUNT.other ?? '6900';
}

export const EXPENSE_ACCOUNT: Record<string, string> = {
  fuel: '5100',
  driver_pay: '5200',
  maintenance: '5300',
  tolls: '5400',
  lumper: '5500',
  insurance: '6100',
  permits: '6200',
  lease: '6300',
  /** Candidate costs posted from Recruiting (owner, 2026-10-01). */
  recruiting: '6700',
  other: '6900',
};

/** `charge_types.code` → the revenue account it credits. */
export const REVENUE_ACCOUNT: Record<string, string> = {
  linehaul: '4100',
  fuel_surcharge: '4110',
  detention: '4200',
  layover: '4210',
  lumper: '4300',
  stop_charge: '4500',
  tonu: '4400',
  other: '4500',
};

// ---------------------------------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------------------------------

export interface JournalLine {
  accountCode: string;
  /** Integer cents. Exactly one of `debit` / `credit` is non-zero on a line. */
  debit: number;
  credit: number;
  memo?: string;
}

/** What in the operational world caused this entry. */
export const JOURNAL_SOURCES = [
  'invoice_issued',
  'invoice_void',
  'payment_received',
  'bill_posted',
  'bill_paid',
  'expense_recorded',
  'settlement_finalized',
  'settlement_paid',
  'payroll_finalized',
  'payroll_paid',
  'adjustment',
] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];

export interface JournalEntry {
  id: string;
  /** YYYY-MM-DD. Decides which ledger period the entry lands in. */
  onDate: string;
  source: JournalSource;
  /**
   * Idempotency key: the same operational event always produces the same key, so a replayed event
   * is refused rather than posting the money twice.
   */
  sourceKey: string;
  /** The operational record this came from, for the drill-through. */
  reference: { type: string; id: string; label: string } | null;
  memo: string;
  lines: JournalLine[];
  /** Integer cents. Equal to the credit total by construction. */
  totalCents: number;
  postedAt: string;
  postedBy: string;
}

export interface EntryDraft {
  onDate: string;
  source: JournalSource;
  sourceKey: string;
  reference?: JournalEntry['reference'];
  memo: string;
  lines: Array<{ accountCode: string; debit?: number; credit?: number; memo?: string }>;
}

export type BuildEntryResult =
  | { ok: true; entry: Omit<JournalEntry, 'id' | 'postedAt' | 'postedBy'> }
  | { ok: false; error: string };

/**
 * Builds a journal entry, or refuses.
 *
 * The refusals are the point. An entry that does not balance, posts to a heading account, names an
 * account that does not exist, or puts a debit and a credit on the same line is not a valid entry,
 * and returning one anyway would put the ledger permanently out of balance with no way to find the
 * moment it happened.
 */
export function buildEntry(draft: EntryDraft): BuildEntryResult {
  if (draft.lines.length < 2) {
    return { ok: false, error: 'A journal entry needs at least two lines' };
  }

  const lines: JournalLine[] = [];
  let debits = 0;
  let credits = 0;

  for (const line of draft.lines) {
    const debit = Math.round(line.debit ?? 0);
    const credit = Math.round(line.credit ?? 0);

    if (debit < 0 || credit < 0) {
      return {
        ok: false,
        error: `Negative amount on ${line.accountCode}; reverse the sides instead`,
      };
    }
    if (debit === 0 && credit === 0) continue;
    if (debit > 0 && credit > 0) {
      return {
        ok: false,
        error: `Line on ${line.accountCode} has both a debit and a credit; split it into two lines`,
      };
    }

    const account = ACCOUNT_BY_CODE.get(line.accountCode);
    if (!account) return { ok: false, error: `No account ${line.accountCode} in the chart` };
    if (!account.postable) {
      return {
        ok: false,
        error: `${account.code} ${account.name} is a heading and cannot be posted to`,
      };
    }

    lines.push({ accountCode: line.accountCode, debit, credit, memo: line.memo });
    debits += debit;
    credits += credit;
  }

  if (lines.length < 2) {
    return { ok: false, error: 'A journal entry needs at least two lines with an amount' };
  }
  if (debits !== credits) {
    return {
      ok: false,
      error: `Entry does not balance: debits ${debits} ≠ credits ${credits} (cents)`,
    };
  }
  if (debits === 0) {
    return { ok: false, error: 'A journal entry cannot be for zero' };
  }

  return {
    ok: true,
    entry: {
      onDate: draft.onDate,
      source: draft.source,
      sourceKey: draft.sourceKey,
      reference: draft.reference ?? null,
      memo: draft.memo,
      lines,
      totalCents: debits,
    },
  };
}

/** True when an entry balances. Cheap enough to assert on read as well as on write. */
export function entryBalances(entry: Pick<JournalEntry, 'lines'>): boolean {
  let debits = 0;
  let credits = 0;
  for (const line of entry.lines) {
    debits += line.debit;
    credits += line.credit;
  }
  return debits === credits && debits > 0;
}

// ---------------------------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------------------------

export interface AccountBalance {
  account: Account;
  debits: number;
  credits: number;
  /** Signed in the account's natural direction: positive means it runs the way it should. */
  balance: number;
}

/**
 * Balances per account over a set of entries.
 *
 * Reported in the account's natural direction so a reader never has to remember whether a positive
 * liability means the carrier owes more or less.
 */
export function accountBalances(
  entries: readonly JournalEntry[],
  filter?: (entry: JournalEntry) => boolean,
): AccountBalance[] {
  const totals = new Map<string, { debits: number; credits: number }>();
  for (const entry of entries) {
    if (filter && !filter(entry)) continue;
    for (const line of entry.lines) {
      const current = totals.get(line.accountCode) ?? { debits: 0, credits: 0 };
      current.debits += line.debit;
      current.credits += line.credit;
      totals.set(line.accountCode, current);
    }
  }

  return [...totals.entries()]
    .map(([code, sums]) => {
      const account = ACCOUNT_BY_CODE.get(code);
      if (!account) return null;
      const natural = NORMAL_BALANCE[account.type];
      return {
        account,
        debits: sums.debits,
        credits: sums.credits,
        balance: natural === 'debit' ? sums.debits - sums.credits : sums.credits - sums.debits,
      };
    })
    .filter((row): row is AccountBalance => row !== null)
    .sort((a, b) => a.account.code.localeCompare(b.account.code));
}

export interface TrialBalance {
  rows: AccountBalance[];
  totalDebits: number;
  totalCredits: number;
  /** Zero on a healthy ledger. Anything else is a defect, not a rounding artefact. */
  difference: number;
  balanced: boolean;
}

export function trialBalance(
  entries: readonly JournalEntry[],
  filter?: (entry: JournalEntry) => boolean,
): TrialBalance {
  const rows = accountBalances(entries, filter);
  const totalDebits = rows.reduce((sum, r) => sum + r.debits, 0);
  const totalCredits = rows.reduce((sum, r) => sum + r.credits, 0);
  return {
    rows,
    totalDebits,
    totalCredits,
    difference: totalDebits - totalCredits,
    balanced: totalDebits === totalCredits,
  };
}

// ---------------------------------------------------------------------------------------------
// Ledger periods
// ---------------------------------------------------------------------------------------------

export const PERIOD_STATUSES = ['open', 'closing', 'closed', 'locked'] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

export interface LedgerPeriod {
  /** `2026-09`. */
  id: string;
  year: number;
  month: number;
  status: PeriodStatus;
  closedAt: string | null;
  closedBy: string | null;
}

export function periodIdFor(onDate: string): string {
  return onDate.slice(0, 7);
}

export interface PostingCheck {
  allowed: boolean;
  reason: string | null;
}

/**
 * Whether an entry may post on this date.
 *
 * A closed period rejects the posting outright rather than re-dating it into the open one. Silently
 * moving a transaction to a month it did not happen in is how a set of books stops describing the
 * business; the caller is told to raise an adjustment instead.
 */
export function canPost(onDate: string, periods: readonly LedgerPeriod[]): PostingCheck {
  const period = periods.find((p) => p.id === periodIdFor(onDate));
  if (!period) return { allowed: true, reason: null };
  if (period.status === 'open') return { allowed: true, reason: null };
  if (period.status === 'closing') {
    return {
      allowed: true,
      reason: `${period.id} is closing; post now or the entry will need an adjustment`,
    };
  }
  return {
    allowed: false,
    reason: `${period.id} is ${period.status}. Raise an adjustment in an open period instead of posting into a closed one.`,
  };
}
