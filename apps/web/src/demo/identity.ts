import { DATASET, demoCurrentUser, demoData, demoUsers } from './data';

/**
 * Lets the dataset's idea of "me" be the person who signed in.
 *
 * The demo dataset has its own staff and `demoCurrentUser` is one of them; an empty workspace has
 * nobody, so the attributions the client still writes itself (who attached an invoice, who filed
 * a note) would read "Signed-in user". Called once the account is known: the identity is updated
 * in place, because every module holds the same object, and the person joins the users the
 * pickers offer. Demo mode is left alone — its staff are the fixture the tests rely on.
 *
 * Its own module, imported by the auth provider directly rather than through the package index,
 * so a test that replaces the index with a stub of the few things its page needs is not asked to
 * stub this too.
 */
export function adoptSignedInAccount(account: {
  userId: string;
  name: string;
  email: string;
}): void {
  if (DATASET !== 'empty') return;
  const [firstName = '', ...rest] = account.name.trim().split(/\s+/);
  Object.assign(demoCurrentUser, {
    id: account.userId,
    name: account.name,
    email: account.email,
    firstName,
    lastName: rest.join(' '),
  });
  for (const list of new Set([demoUsers, demoData.users])) {
    if (!list.some((u) => u.id === account.userId)) list.push(demoCurrentUser);
  }
}
