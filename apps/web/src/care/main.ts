/*
 * NORTHWIND FREIGHT Driver Care — the owner's approved design (Northwind Freight-Driver-Care.html,
 * 2026-10-06), ported to TypeScript and connected to Driver Relations.
 *
 * Kept from the design: the markup and styles, the letter hop on the headline, the card entrance,
 * the back-arrow form panel, the centered Management Call heading with "NORTHWIND FREIGHT always cares
 * about its drivers.", and its keyboard-accessible dropdown (`enhanceDropdowns`, line for line).
 * Changed: the form posts to the public intake instead of saving a draft. Nothing is written to
 * localStorage, sessionStorage or cookies; no request carries credentials. "Received" is shown
 * only after the server answered 201; a failure keeps every answer and says why.
 */
import type { DriverCareSubmissionInput, DriverRelationTopic } from '@neway/shared';
import { phoneMessage } from '../apply/phone-message';
import { SendError, loadConfig, newSubmissionId, sendRequest, slugFromPath } from './api';
import {
  COMPLIANCE_SUBJECTS,
  COMPLIANCE_SUBJECT_LABELS,
  DRIVER_CARE_MAX_FILES,
  DRIVER_CARE_MAX_FILE_BYTES,
  DRIVER_CARE_MAX_TOTAL_BYTES,
  DRIVER_REFERRAL_BONUS_TEXT,
  MANAGEMENT_CALL_TOPICS,
  MANAGEMENT_CALL_TOPIC_LABELS,
  SERVICES,
  type Service,
} from './forms';
import './care.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`care page: #${id} is missing`);
  return el as T;
};

const root = document.documentElement;
const slug = root.dataset.careSlug ?? slugFromPath(window.location.pathname);
const apiBase = root.dataset.careApi;
if (apiBase) {
  // A hosted copy: the logo lives on the TMS.
  const logo = new URL('/brand/nwf-care-logo.png', apiBase).href;
  document.querySelector('.logo img')?.setAttribute('src', logo);
}

let current: Service | null = null;
/** One per opened form: every retry of it (a second tap, a dropped connection) is the same request. */
let submissionId = newSubmissionId();
let files: File[] = [];
let sending = false;

// ------------------------------------------------------------------------- the design's cards

function renderServices() {
  const grid = $('services');
  grid.replaceChildren();
  SERVICES.forEach((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'service';
    b.dataset.topic = s.topic;
    b.style.setProperty('--delay', `${i * 0.08}s`);
    // The icon paths are constants from forms.ts, never driver input.
    b.innerHTML = `<div class="icon"><svg viewBox="0 0 24 24" aria-hidden="true">${s.icon}</svg></div><h3></h3><p></p><span class="action">${
      s.topic === 'referral' ? `<span class="bonus">${DRIVER_REFERRAL_BONUS_TEXT}</span>` : 'Get started'
    }<span aria-hidden="true">↗</span></span>`;
    b.querySelector('h3')!.textContent = s.name;
    b.querySelector('p')!.textContent = s.desc;
    b.onclick = () => openService(s);
    grid.append(b);
  });
}

const options = (values: readonly string[], labels: Record<string, string>) =>
  values.map((v) => `<option value="${v}">${labels[v]}</option>`).join('');

/** The design's extra fields per service, with the brief's rules (owner, 2026-10-06). */
function extraFields(topic: DriverRelationTopic): string {
  switch (topic) {
    case 'management_call':
      return `<label for=callTopic>What would you like to discuss?</label><select id=callTopic name=callTopic required><option value="">Choose a topic</option>${options(
        MANAGEMENT_CALL_TOPICS,
        MANAGEMENT_CALL_TOPIC_LABELS,
      )}</select><label for=callTime>Preferred call time (optional)</label><input id=callTime name=callTime maxlength=150 placeholder="e.g. Tomorrow, 2–4 PM Eastern Time"><p>Include your time zone. Your preferred time is a request, not a confirmed appointment.</p>`;
    case 'pay_statement':
      // No topic dropdown here: the owner removed it. Free text below, two optional fields.
      return '<div class=two><div><label for=weekOf>Week starting (optional)</label><input id=weekOf name=weekOf type=date></div><div><label for=loadNumber>Load number (optional)</label><input id=loadNumber name=loadNumber maxlength=50></div></div>';
    case 'referral':
      return '<label for=driverName>Referral driver name</label><input id=driverName name=driverName required maxlength=100>';
    case 'reimbursement':
      return '<label for="amount">Amount paid ($)</label><input id="amount" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" required><label for="load">Load number (optional)</label><input id="load" name="load" maxlength="50">';
    case 'compliance':
      return `<label for="documentType">What do you need help with?</label><select id="documentType" name="documentType">${options(
        COMPLIANCE_SUBJECTS,
        COMPLIANCE_SUBJECT_LABELS,
      )}</select>`;
    default:
      return '';
  }
}

function openService(s: Service) {
  current = s;
  submissionId = newSubmissionId();
  files = [];
  const call = s.topic === 'management_call';
  const referral = s.topic === 'referral';
  $('modal').classList.toggle('management-call', call);
  $('destination').textContent = s.route;
  $('modalTitle').textContent = s.title;
  $('formIntro').textContent = call ? 'NORTHWIND FREIGHT always cares about its drivers.' : s.desc;
  $<HTMLFormElement>('requestForm').reset();
  $('formError').textContent = '';
  document.querySelector('label[for=phone]')!.textContent = referral ? 'Referral driver phone number' : 'Phone number';
  const details = $<HTMLTextAreaElement>('details');
  details.required = !referral;
  details.hidden = referral;
  (document.querySelector('label[for=details]') as HTMLElement).hidden = referral;
  $('extra').innerHTML = extraFields(s.topic);
  renderFiles();
  enhanceDropdowns();
  setSending(false);
  $('formContent').hidden = false;
  $('saved').hidden = true;
  $('home').hidden = true;
  $('modal').hidden = false;
  // NeWay: the design's footer sits before the form panel in the page; it waits below the overview.
  document.querySelector('footer')!.hidden = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  $('modalTitle').focus({ preventScroll: true });
}

function back() {
  $('modal').hidden = true;
  document.querySelector('footer')!.hidden = false;
  $('home').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (current) document.querySelector<HTMLButtonElement>(`.service[data-topic="${current.topic}"]`)?.focus({ preventScroll: true });
}

// ------------------------------------------------------------------------------- receipts

function renderFiles() {
  const box = $('files');
  if (current?.topic !== 'reimbursement') {
    box.replaceChildren();
    return;
  }
  box.innerHTML = `<label for="receipts">Receipts (optional)</label><p class="files-hint">Photo or PDF, up to ${DRIVER_CARE_MAX_FILES} files, 10 MB each.</p><label class="file-pick" id="receiptsPick"><input id="receipts" type="file" accept="image/jpeg,image/png,image/heic,.heic,application/pdf" multiple><span>Add photo or PDF</span></label><ul class="file-list" id="fileList" aria-live="polite"></ul>`;
  const input = $<HTMLInputElement>('receipts');
  input.onchange = () => {
    const picked = Array.from(input.files ?? []);
    input.value = '';
    $('formError').textContent = '';
    const next = [...files, ...picked];
    if (next.length > DRIVER_CARE_MAX_FILES) {
      $('formError').textContent = `Attach up to ${DRIVER_CARE_MAX_FILES} files.`;
      return;
    }
    if (picked.some((f) => f.size > DRIVER_CARE_MAX_FILE_BYTES)) {
      $('formError').textContent = 'Each file can be up to 10 MB.';
      return;
    }
    if (next.reduce((n, f) => n + f.size, 0) > DRIVER_CARE_MAX_TOTAL_BYTES) {
      $('formError').textContent = 'All files together can be up to 20 MB.';
      return;
    }
    files = next;
    listFiles();
  };
  listFiles();
}

function listFiles() {
  const list = document.getElementById('fileList');
  if (!list) return;
  list.replaceChildren(
    ...files.map((f, i) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `${f.name} · ${Math.max(1, Math.round(f.size / 1024))} KB`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${f.name}`);
      remove.onclick = () => {
        files = files.filter((_, j) => j !== i);
        listFiles();
        $('receipts').focus();
      };
      li.append(name, remove);
      return li;
    }),
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('read'));
    reader.readAsDataURL(file);
  });
}

// ------------------------------------------------------------------------------- sending

/** The server's field names, mapped to the design's inputs. */
const FIELD_FOR: Record<string, string> = {
  name: 'driver',
  truckNumber: 'truck',
  phone: 'phone',
  referralPhone: 'phone',
  referralName: 'driverName',
  details: 'details',
  callTopic: 'callTopic',
  preferredTime: 'callTime',
  weekStart: 'weekOf',
  amount: 'amount',
  subject: 'documentType',
  attachments: 'receipts',
};

const value = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? '';

function clearError(field: HTMLElement & { setCustomValidity?: (m: string) => void }) {
  field.setCustomValidity?.('');
  field.removeAttribute('aria-invalid');
  if (field.tagName === 'SELECT') field.parentElement?.querySelector('.dropdown-trigger')?.removeAttribute('aria-invalid');
}

function markError(id: string, message: string) {
  const field = document.getElementById(id) as HTMLInputElement | null;
  if (!field) return;
  field.setCustomValidity(message);
  field.setAttribute('aria-invalid', 'true');
  if (field.tagName === 'SELECT') field.parentElement?.querySelector('.dropdown-trigger')?.setAttribute('aria-invalid', 'true');
}

async function payload(s: Service): Promise<DriverCareSubmissionInput> {
  const base = {
    submissionId,
    website: (document.querySelector('input[name=website]') as HTMLInputElement).value,
    name: value('driver'),
    truckNumber: value('truck'),
  };
  switch (s.topic) {
    case 'referral':
      return { ...base, topic: 'referral', referralName: value('driverName'), referralPhone: value('phone') };
    case 'complaint_feedback':
      return { ...base, topic: 'complaint_feedback', phone: value('phone'), details: value('details') };
    case 'reimbursement':
      return {
        ...base,
        topic: 'reimbursement',
        phone: value('phone'),
        amount: Number(value('amount')),
        loadNumber: value('load') || null,
        details: value('details'),
        attachments: await Promise.all(files.map(async (f) => ({ fileName: f.name, content: await readAsDataUrl(f) }))),
      };
    case 'pay_statement':
      return {
        ...base,
        topic: 'pay_statement',
        phone: value('phone'),
        details: value('details'),
        weekStart: value('weekOf') || null,
        loadNumber: value('loadNumber') || null,
      };
    case 'compliance':
      return {
        ...base,
        topic: 'compliance',
        phone: value('phone'),
        subject: value('documentType') as (typeof COMPLIANCE_SUBJECTS)[number],
        details: value('details'),
      };
    case 'management_call':
      return {
        ...base,
        topic: 'management_call',
        phone: value('phone'),
        callTopic: value('callTopic') as (typeof MANAGEMENT_CALL_TOPICS)[number],
        preferredTime: value('callTime') || null,
        details: value('details'),
      };
  }
}

function setSending(on: boolean) {
  sending = on;
  const button = $<HTMLButtonElement>('submit');
  button.disabled = on;
  button.textContent = on ? 'Sending…' : current?.topic === 'management_call' ? 'Request a call' : 'Send request';
  if (on) $('requestForm').setAttribute('aria-busy', 'true');
  else $('requestForm').removeAttribute('aria-busy');
}

async function submit(event: Event) {
  event.preventDefault();
  if (sending || !current) return;
  const form = $<HTMLFormElement>('requestForm');
  $('formError').textContent = '';
  const phone = $<HTMLInputElement>('phone');
  phone.setCustomValidity(phoneMessage(phone.value));
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  if (!slug) {
    $('formError').textContent = 'This Driver Care link is no longer active. Please call the office.';
    return;
  }
  setSending(true);
  try {
    const reference = await sendRequest(slug, await payload(current));
    received(current, reference);
  } catch (error) {
    // Not saved: every answer stays where it is, the button comes back.
    if (error instanceof SendError) {
      const named = Object.entries(error.fields).filter(([path]) => FIELD_FOR[path] && document.getElementById(FIELD_FOR[path]!));
      for (const [path, message] of named) markError(FIELD_FOR[path]!, message);
      const fileMessage = error.fields.attachments;
      $('formError').textContent = fileMessage ? `${error.message} ${fileMessage}` : error.message;
      if (named.length > 0) form.reportValidity();
    } else {
      $('formError').textContent = 'Your request was not sent. Your answers are still here; please try again.';
    }
    setSending(false);
  }
}

function received(s: Service, reference: string | null) {
  const call = s.topic === 'management_call';
  const heading = $('saved').querySelector('h2')!;
  heading.textContent = call ? 'NORTHWIND FREIGHT always cares about its drivers.' : 'Your request was received.';
  $('savedText').textContent = call
    ? 'Your call request was received. Your preferred time is a request, not a confirmed appointment: management will contact you to arrange the call.'
    : s.topic === 'referral'
      ? 'NORTHWIND FREIGHT always cares about its drivers.'
      : 'Our Driver Relations team will contact you.';
  const ref = $('savedReference');
  ref.replaceChildren();
  if (reference) {
    const strong = document.createElement('strong');
    strong.textContent = reference;
    ref.append('Your reference: ', strong);
  }
  setSending(false);
  files = [];
  $('formContent').hidden = true;
  $('saved').hidden = false;
  heading.focus();
}

// ---------------------------------------------------------- the design's dropdown, verbatim

function enhanceDropdowns() {
  document.querySelectorAll<HTMLSelectElement>('#extra select').forEach((select) => {
    const wrap = document.createElement('div');
    wrap.className = 'dropdown';
    select.before(wrap);
    wrap.append(select);
    // NeWay: the native select stays for form validation but leaves the tab order and the
    // accessibility tree, so a screen reader meets one control (the button and its listbox), not two.
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'dropdown-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const label = document.querySelector<HTMLLabelElement>('label[for="' + select.id + '"]');
    if (label) {
      label.id = select.id + '-label';
      trigger.setAttribute('aria-labelledby', label.id + ' ' + select.id + '-value');
      label.onclick = () => trigger.focus();
    }
    const value = document.createElement('span');
    value.id = select.id + '-value';
    trigger.append(value);
    const menu = document.createElement('div');
    menu.className = 'dropdown-menu';
    menu.id = select.id + '-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-labelledby', label ? label.id : '');
    menu.hidden = true;
    trigger.setAttribute('aria-controls', menu.id);
    wrap.append(trigger, menu);
    const buttons: HTMLButtonElement[] = [];
    function sync() {
      value.textContent = select.options[select.selectedIndex]?.textContent || 'Choose a topic';
      trigger.classList.toggle('placeholder', !select.value);
      buttons.forEach((b, i) => b.setAttribute('aria-selected', String(select.options[i]!.value === select.value)));
    }
    function close() {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }
    function open() {
      document.querySelectorAll('.dropdown-trigger[aria-expanded=true]').forEach((t) => {
        t.setAttribute('aria-expanded', 'false');
        document.getElementById(t.getAttribute('aria-controls')!)!.hidden = true;
      });
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      const active = buttons[select.selectedIndex] || buttons.find(Boolean);
      active?.focus();
    }
    [...select.options].forEach((option, i) => {
      if (!option.value) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dropdown-option';
      b.textContent = option.textContent;
      b.setAttribute('role', 'option');
      b.onclick = () => {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        sync();
        close();
        trigger.focus();
      };
      b.onkeydown = (e) => {
        const list = buttons.filter(Boolean),
          n = list.indexOf(b);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          list[(n + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]!.focus();
        } else if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          list[e.key === 'Home' ? 0 : list.length - 1]!.focus();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          close();
          trigger.focus();
        } else if (e.key === 'Tab') close();
      };
      buttons[i] = b;
      menu.append(b);
    });
    trigger.onclick = () => (menu.hidden ? open() : close());
    trigger.onkeydown = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        open();
      }
    };
    select.oninvalid = (e) => {
      e.preventDefault();
      open();
    };
    select.onchange = sync;
    wrap.addEventListener('focusout', (e) => {
      if (!wrap.contains(e.relatedTarget as Node | null)) close();
    });
    sync();
  });
}
document.addEventListener('click', (e) => {
  document.querySelectorAll('.dropdown').forEach((w) => {
    if (!w.contains(e.target as Node)) {
      (w.querySelector('.dropdown-menu') as HTMLElement).hidden = true;
      w.querySelector('.dropdown-trigger')!.setAttribute('aria-expanded', 'false');
    }
  });
});

// ---------------------------------------------------------- the design's headline letter hop

let n = 0;
function animate(el: Node) {
  for (const child of [...el.childNodes]) {
    if (child.nodeType === 3) {
      const frag = document.createDocumentFragment();
      for (const ch of child.textContent ?? '') {
        const span = document.createElement('span');
        span.textContent = ch === ' ' ? ' ' : ch;
        span.className = 'letter';
        span.style.setProperty('--delay', `${0.2 + n++ * 0.035}s`);
        frag.append(span);
      }
      child.replaceWith(frag);
    } else animate(child);
  }
}

// ------------------------------------------------------------------------------- start-up

function easternYear(): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric' }).format(new Date());
}

function notice(title: string, text: string, retry: boolean) {
  $('loading').hidden = true;
  $('home').hidden = true;
  $('notice-title').textContent = title;
  $('notice-text').textContent = text;
  $('notice-retry').hidden = !retry;
  $('notice').hidden = false;
}

async function start(): Promise<void> {
  $('notice').hidden = true;
  $('loading').hidden = false;
  const result = slug ? await loadConfig(slug) : ({ ok: false, closed: true } as const);
  if (!result.ok) {
    if (result.closed) notice('This link is no longer active.', 'Please call your dispatcher or the office.', false);
    else notice("We couldn't open Driver Care.", 'Check your connection and try again.', true);
    return;
  }
  $('loading').hidden = true;
  $('home').hidden = false;
}

$('copyright').textContent = `© ${easternYear()} NORTHWIND FREIGHT INC`;
$('close').onclick = back;
$('viewDraft').onclick = back;
$('notice-retry').onclick = () => void start();
$('requestForm').addEventListener('submit', (e) => void submit(e));
// A message on a field (the browser's or the server's) clears when the driver changes that field.
for (const kind of ['input', 'change']) {
  $('requestForm').addEventListener(kind, (e) => {
    const field = e.target as HTMLElement & { setCustomValidity?: (m: string) => void };
    if (field.id !== 'phone') clearError(field);
  });
}
$('phone').addEventListener('input', () => {
  const phone = $<HTMLInputElement>('phone');
  phone.setCustomValidity(phoneMessage(phone.value));
  phone.removeAttribute('aria-invalid');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.defaultPrevented && !$('modal').hidden && !document.querySelector('.dropdown-trigger[aria-expanded=true]')) back();
});
renderServices();
animate($('headline'));
void start();
