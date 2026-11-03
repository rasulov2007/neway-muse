import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Select } from '@/design-system';
import type { AiClientToolCall, AiMessageView } from '@neway/shared';
import { driveConfig } from './cursor';
import { driveStore, type DriveDeps } from './driveStore';
import { fire, setNativeValue } from './dom';
import { riskyVerb } from './risk';
import { runScreenTool, type RunnerHost } from './runner';
import { buildSnapshot, elementFor, formatSnapshot } from './snapshot';

beforeAll(() => {
  driveConfig.animate = false;
});
afterEach(() => {
  document.body.innerHTML = '';
});

const host = (over: Partial<RunnerHost> = {}): RunnerHost => ({
  navigate: vi.fn(async () => {}),
  confirm: vi.fn(async () => true),
  dryRun: false,
  signal: new AbortController().signal,
  waitIfPaused: async () => {},
  step: vi.fn(),
  ...over,
});

const refOf = (name: string) => buildSnapshot(document).items.find((i) => i.name === name || i.name.startsWith(`${name} —`))!.ref;

describe('screen snapshot', () => {
  it('numbers the controls with the names a person reads, dialogs first, without the chat', () => {
    document.body.innerHTML = `
      <main>
        <h1>Invoices</h1>
        <button>Create invoice</button>
        <button aria-label="More actions"><svg></svg></button>
        <label for="num">Invoice #</label><input id="num" value="INV-7" />
        <input placeholder="Search loads" />
        <label><input type="checkbox" checked /> Paid only</label>
        <select aria-label="Status"><option>Open</option><option selected>Paid</option></select>
        <button disabled>Approve</button>
        <button style="display:none">Hidden by style</button>
        <button hidden>Hidden by attribute</button>
        <table><tbody><tr><td>L-100005</td><td>Acme</td><td><button>Open</button></td></tr></tbody></table>
        <div role="status">Saved.</div>
      </main>
      <div role="dialog" aria-label="Record payment"><button>Save payment</button></div>
      <div data-ai-chat><button>Send</button><textarea aria-label="Message"></textarea></div>
      <div role="dialog" aria-label="NeWay AI drawer"><button>Open full page</button><div data-ai-chat><button>New chat</button></div></div>`;
    const s = buildSnapshot(document);
    const names = s.items.map((i) => i.name);
    expect(names[0]).toBe('Save payment');
    expect(s.items[0]!.inDialog).toBe(true);
    expect(s.dialogs).toEqual(['Record payment']);
    expect(names).toContain('Create invoice');
    expect(names).toContain('More actions');
    expect(s.items.find((i) => i.name === 'Invoice #')).toMatchObject({ role: 'textbox', value: 'INV-7' });
    expect(names).toContain('Search loads');
    expect(s.items.find((i) => i.name === 'Paid only')).toMatchObject({ role: 'checkbox', checked: true });
    expect(s.items.find((i) => i.name === 'Status')).toMatchObject({ role: 'select', value: 'Paid', options: ['Open', 'Paid'] });
    expect(s.items.find((i) => i.name === 'Approve')).toMatchObject({ disabled: true });
    expect(names).toContain('Open — row: L-100005 · Acme');
    expect(names.some((n) => n.startsWith('Hidden'))).toBe(false);
    // The chat is never part of what NeWay AI sees or presses.
    expect(names).not.toContain('Send');
    expect(names).not.toContain('Message');
    // ...nor the drawer that holds the chat, header buttons included.
    expect(names).not.toContain('Open full page');
    expect(names).not.toContain('New chat');
    expect(s.headings).toContain('Invoices');
    expect(s.alerts).toContain('Saved.');

    // Refs point back at the elements, tagged on the page, valid for this snapshot.
    const ref = s.items.find((i) => i.name === 'Create invoice')!.ref;
    expect(elementFor(ref)?.textContent).toBe('Create invoice');
    expect(document.querySelector(`[data-ai-ref="${ref}"]`)?.textContent).toBe('Create invoice');
    const text = formatSnapshot(s);
    expect(text).toMatch(/\[\d+\] button "Approve" \(disabled\)/);
    expect(text).toMatch(/Dialogs open: "Record payment"/);
  });

  it('caps the list and says how many were left out', () => {
    document.body.innerHTML = `<main>${Array.from({ length: 160 }, (_, i) => `<button>B${i}</button>`).join('')}</main>`;
    const s = buildSnapshot(document);
    expect(s.items).toHaveLength(150);
    expect(s.more).toBe(10);
  });
});

describe('risky presses', () => {
  it.each([
    ['Approve', 'approve'],
    ['Approve all', 'approve'],
    ['Post payment', 'post'],
    ['Pay', 'pay'],
    ['Record payment', 'record payment'],
    ['Send to RTS', 'send'],
    ['Submit', 'submit'],
    ['Issue invoice', 'issue'],
    ['Delete', 'delete'],
    ['Remove driver', 'remove'],
    ['Void', 'void'],
    ['Cancel load', 'cancel load'],
    ['Reopen statement', 'reopen'],
    ['Sign', 'sign'],
    ['Transfer', 'transfer'],
    ['Apply', 'apply'],
    ['Disable user', 'disable'],
  ])('%s is risky', (name, verb) => expect(riskyVerb(name)).toBe(verb));

  it.each(['Cancel', 'Close', 'Create invoice', 'Payments', 'Approved', 'Issues', 'Apply filters', 'Save', 'Next'])('%s is not', (name) => expect(riskyVerb(name)).toBeNull());

  it('a tab is never risky', () => expect(riskyVerb('Pay', 'tab')).toBeNull());
});

function Controlled({ onValue }: { onValue?: (v: string) => void }) {
  const [v, setV] = useState('');
  return (
    <main>
      <label htmlFor="note">Note</label>
      <input
        id="note"
        value={v}
        onChange={(e) => {
          setV(e.target.value);
          onValue?.(e.target.value);
        }}
      />
      <output>Typed: {v}</output>
    </main>
  );
}

describe('native value setter', () => {
  it('updates a React-controlled input', () => {
    const onValue = vi.fn();
    render(<Controlled onValue={onValue} />);
    const input = screen.getByLabelText('Note') as HTMLInputElement;
    act(() => {
      setNativeValue(input, 'Detention 2h');
      fire(input, 'input');
    });
    expect(onValue).toHaveBeenLastCalledWith('Detention 2h');
    expect(screen.getByText('Typed: Detention 2h')).toBeInTheDocument();
  });
});

describe('cursor runner', () => {
  it('presses a button: its handler runs', async () => {
    const onClick = vi.fn();
    render(
      <main>
        <button onClick={onClick}>Create invoice</button>
      </main>,
    );
    const out = await runScreenTool({ name: 'screen_click', input: { ref: refOf('Create invoice') } }, host());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(out.isError).toBe(false);
    expect(out.content).toMatch(/^Clicked ‘Create invoice’\./);
    expect(out.content).toContain('--- screen ---');
  });

  it('refuses a disabled control and a ref that is gone', async () => {
    const onClick = vi.fn();
    render(
      <main>
        <button disabled onClick={onClick}>
          Save
        </button>
      </main>,
    );
    const out = await runScreenTool({ name: 'screen_click', input: { ref: refOf('Save') } }, host());
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/disabled/);
    expect(onClick).not.toHaveBeenCalled();
    const gone = await runScreenTool({ name: 'screen_click', input: { ref: 99 } }, host());
    expect(gone.isError).toBe(true);
    expect(gone.content).toMatch(/gone/);
  });

  it('asks before a risky press, and Dry run never presses it', async () => {
    const onClick = vi.fn();
    render(
      <main>
        <button onClick={onClick}>Approve</button>
      </main>,
    );
    const dry = await runScreenTool({ name: 'screen_click', input: { ref: refOf('Approve') } }, host({ dryRun: true }));
    expect(dry.content).toMatch(/^dry run: would press ‘Approve’/);
    expect(onClick).not.toHaveBeenCalled();

    const refused = host({ confirm: vi.fn(async () => false) });
    const no = await runScreenTool({ name: 'screen_click', input: { ref: refOf('Approve') } }, refused);
    expect(refused.confirm).toHaveBeenCalledWith(expect.objectContaining({ verb: 'approve', name: 'Approve' }));
    expect(no.isError).toBe(true);
    expect(onClick).not.toHaveBeenCalled();

    await runScreenTool({ name: 'screen_click', input: { ref: refOf('Approve') } }, host());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('types into a controlled field character by character', async () => {
    const onValue = vi.fn();
    render(<Controlled onValue={onValue} />);
    const out = await runScreenTool({ name: 'screen_type', input: { ref: refOf('Note'), text: 'Lumper $80' } }, host());
    expect(out.content).toMatch(/^Typed “Lumper \$80” into ‘Note’\./);
    expect(onValue).toHaveBeenCalledTimes('Lumper $80'.length);
    await waitFor(() => expect(screen.getByText('Typed: Lumper $80')).toBeInTheDocument());
  });

  it('chooses an option in a native select and in the design-system Select', async () => {
    const onNative = vi.fn();
    const onDs = vi.fn();
    render(
      <main>
        <select aria-label="Terms" onChange={(e) => onNative(e.target.value)} defaultValue="15">
          <option value="15">Net 15</option>
          <option value="30">Net 30</option>
        </select>
        <Select aria-label="Payer" options={[{ value: 'company', label: 'Company' }, { value: 'driver', label: 'Driver' }]} onValueChange={onDs} />
      </main>,
    );
    const a = await runScreenTool({ name: 'screen_select', input: { ref: refOf('Terms'), option: 'net 30' } }, host());
    expect(a.isError).toBe(false);
    expect(onNative).toHaveBeenCalledWith('30');
    const b = await runScreenTool({ name: 'screen_select', input: { ref: refOf('Payer'), option: 'Driver' } }, host());
    expect(b.content).toMatch(/^Chose ‘Driver’ in ‘Payer’/);
    expect(onDs).toHaveBeenCalledWith('driver');
  });

  it('runs the steps the server handed over, posts the results, and Stop reports the rest as cancelled', async () => {
    const onClick = vi.fn();
    render(
      <main>
        <button onClick={onClick}>Approve</button>
      </main>,
    );
    const ref = refOf('Approve');
    const message = (id: string, pending?: AiClientToolCall[]): AiMessageView => ({ id, role: 'assistant', text: '', cards: [], model: null, attachments: [], createdAt: '', ...(pending ? { pendingClientTools: pending } : {}) });
    const post = vi.fn<DriveDeps['post']>(async () => ({ messages: [message('m1')] }));
    const run = driveStore.start(
      message('m1', [
        { id: 't1', name: 'screen_click', input: { ref } },
        { id: 't2', name: 'screen_read', input: {} },
      ]),
      { conversationId: 'c1', dryRun: false, post, onMessage: vi.fn() },
    );
    // The risky press waits for the person; they press Stop instead.
    await waitFor(() => expect(driveStore.get().phase).toBe('confirm'));
    driveStore.stop();
    await run;
    expect(onClick).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    const body = post.mock.calls[0]![1];
    expect(body.stop).toBe(true);
    expect(body.results.map((r) => [r.tool_use_id, r.is_error])).toEqual([
      ['t1', true],
      ['t2', true],
    ]);
    expect(driveStore.get().phase).toBe('done');
    driveStore.dismiss();
  });

  it('opens a page with the router', async () => {
    const h = host();
    document.body.innerHTML = '<main><h1>Loads</h1></main>';
    const out = await runScreenTool({ name: 'screen_open', input: { to: '/loads' } }, h);
    expect(h.navigate).toHaveBeenCalledWith('/loads');
    expect(out.content).toMatch(/^Opened \/loads\./);
    const bad = await runScreenTool({ name: 'screen_open', input: { to: 'https://example.com' } }, h);
    expect(bad.isError).toBe(true);
  });
});
