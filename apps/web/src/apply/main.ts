/*
 * NWF driver application — design behaviour, phone-ready.
 *
 * The design's <script> (design/apply/Driver-Application-Mobile.html), ported to TypeScript line for
 * line. Lines marked PHONE are the design's phone fixes. `sendApplication` is the one seam: it posts
 * to /api/v1/public/apply/:slug. Around the design script sit only the parts the design file did
 * not need: reading the link (company name, short name, logo, consent wording) before the page
 * appears, and the two notices (link switched off, page could not load).
 *
 * No framework and no library in this entry; nothing is written to localStorage, sessionStorage
 * or cookies, and no request carries credentials.
 */
import type { PublicApplyConfig } from '@neway/shared';
import {
  SendError,
  initials,
  loadConfig,
  newSubmissionId,
  postApplication,
  readAttribution,
  slugFromPath,
} from './api';
import { phoneMessage } from './phone-message';
import './apply.css';

function $<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`apply page: ${selector} is missing`);
  return found;
}

// ------------------------------------------------------------------------- the link's settings

// A copy of this page hosted elsewhere (owner, 2026-10-05) names its link on <html data-apply-slug>.
const slug =
  document.documentElement.dataset.applySlug ?? slugFromPath(window.location.pathname);
const attribution = readAttribution();
// One per filled-in form: every retry of this form reuses it; "Back to form" starts a new one.
let submissionId = newSubmissionId();

/** Every clock in the product is US Eastern. */
function easternYear(): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric' }).format(
    new Date(),
  );
}

function applyConfig(config: PublicApplyConfig): void {
  const shown = config.shortName ?? config.companyName;
  document.title = `Drive with ${shown} · Apply`;
  $('.brand strong').textContent = config.companyName;
  $('.eyebrow').textContent = `DRIVE WITH ${shown}`.toUpperCase();

  const logo = $('.brand-logo');
  const img = $<HTMLImageElement>('.brand-logo img');
  const showInitials = () => {
    img.remove();
    if (logo.querySelector('.initials')) return;
    const mark = document.createElement('span');
    mark.className = 'initials';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = initials(config.companyName);
    logo.append(mark);
  };
  if (config.logoUrl) {
    img.alt = config.companyName;
    img.addEventListener('error', showInitials, { once: true });
    img.src = new URL(
      config.logoUrl,
      document.documentElement.dataset.applyApi || window.location.href,
    ).href;
  } else {
    showInitials();
  }

  // The link's consent sentence, then the design's Privacy Policy link to the link's address.
  const sentence = $('.consent span');
  const privacy = $<HTMLAnchorElement>('.consent a');
  privacy.href = config.privacyPolicyUrl;
  sentence.textContent = `${config.consentText} `;
  sentence.append(privacy);

  const [left, right] = Array.from(document.querySelectorAll('footer span'));
  if (left) left.textContent = `© ${easternYear()} ${config.companyName}`;
  if (right) right.textContent = `${shown} · Driver recruiting`;
}

function showNotice(title: string, text: string, retry: boolean): void {
  $('main:not(.notice)').hidden = true;
  $('footer').hidden = true;
  $('.brand').hidden = true;
  $('#notice-title').textContent = title;
  $('#notice-text').textContent = text;
  $('#notice-retry').hidden = !retry;
  $('header').hidden = false;
  $('#notice').hidden = false;
}

async function open(): Promise<void> {
  const result = slug ? await loadConfig(slug) : { ok: false as const, closed: true };
  if (!result.ok) {
    if (result.closed) {
      showNotice('This link is no longer active.', 'Please contact the company directly.', false);
    } else {
      showNotice(
        "We couldn't open the application.",
        'Check your connection and try again.',
        true,
      );
    }
    return;
  }
  applyConfig(result.config);
  $('#notice').hidden = true;
  $('.brand').hidden = false;
  // Shown only now, so the headline's letter-hop starts when the page appears.
  $('header').hidden = false;
  $('main:not(.notice)').hidden = false;
  $('footer').hidden = false;
}

$('#notice-retry').addEventListener('click', () => {
  $('#notice-retry').hidden = true;
  $('#notice-text').textContent = 'Loading…';
  void open();
});

// --------------------------------------------------------------------------- the design script

const form = $<HTMLFormElement>('form');
let startedAt: number | null = null,
  timerInterval: number | undefined = undefined;
const clock = $('#timer');
const result = $('#result');
// The position is three choices (owner, 2026-10-05); the first radio stands in for the group.
const fields = ['name', 'phone', 'experience'].map(
  (n) => form.elements.namedItem(n) as HTMLInputElement,
);
const positionRadios = Array.from(
  form.querySelectorAll<HTMLInputElement>('input[name="position"]'),
);
fields.push(positionRadios[0]!);
const positionValue = () => positionRadios.find((radio) => radio.checked)?.value ?? '';
for (const radio of positionRadios)
  radio.addEventListener('change', () => positionRadios[0]!.setCustomValidity(''));
const consent = form.elements.namedItem('consent') as HTMLInputElement;

function updateTimer() {
  const elapsed = Math.floor((performance.now() - (startedAt ?? 0)) / 1000);
  const remaining = Math.max(0, 30 - elapsed);
  clock.textContent =
    remaining > 0 ? remaining + ' seconds remaining' : 'Take your time — keep going.';
}
function startTimer() {
  if (startedAt !== null) return;
  startedAt = performance.now();
  updateTimer();
  timerInterval = window.setInterval(updateTimer, 250);
}
// PHONE: the clock starts on the first field touched, not only "Full name" — on a phone many
// people tap Phone first (or autofill), and the success screen then said "0 seconds".
fields.forEach((field) => field.addEventListener('focus', startTimer));

// PHONE: a real phone check, shown through the browser's own message like every other field.
// US/Canada numbers (10 digits, or 11 starting with 1), or a full international number with +.
const phone = form.elements.namedItem('phone') as HTMLInputElement;
phone.addEventListener('input', () => phone.setCustomValidity(phoneMessage(phone.value)));

function updateProgress() {
  const completed = [
    (form.elements.namedItem('name') as HTMLInputElement).value.trim().length > 1,
    (form.elements.namedItem('phone') as HTMLInputElement).validity.valid &&
      (form.elements.namedItem('phone') as HTMLInputElement).value.length > 0,
    !!(form.elements.namedItem('experience') as HTMLInputElement).value,
    !!positionValue(),
  ].filter(Boolean).length;
  $('#count').textContent = completed + ' / 4';
  document
    .querySelectorAll('.progress i')
    .forEach((el, i) => el.classList.toggle('done', i < completed));
}
form.addEventListener('input', () => {
  updateProgress();
  result.textContent = '';
});

// PHONE: the keyboard's "next" key moves to the next field instead of submitting a half-filled
// form; on the last field it moves to the consent box (which also closes the keyboard).
fields.forEach((field, i) =>
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    const next = fields[i + 1] ?? consent;
    next.focus();
    if (next === consent) next.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }),
);

/** The server's field names, mapped to the design's inputs. */
const serverFields: Record<string, HTMLInputElement> = {
  fullName: fields[0]!,
  phone,
  experience: fields[2]!,
  position: fields[3]!,
  consent,
};
// A message the server put on a field stays until the driver changes that field. (The phone field
// already replaces its message on every input with the design's own check.)
for (const field of [fields[0]!, fields[2]!, fields[3]!, consent]) {
  field.addEventListener(field === consent ? 'change' : 'input', () => field.setCustomValidity(''));
}

/**
 * Saves the application. Resolves when it is saved; rejects with an Error whose message is shown
 * to the driver.
 */
async function sendApplication(answers: {
  name: string;
  phone: string;
  experience: string;
  position: string;
  consent: boolean;
  website: string;
  completedInSeconds: number;
}): Promise<void> {
  if (!slug) throw new Error('This application link is no longer active.');
  try {
    await postApplication(slug, {
      submissionId,
      fullName: answers.name,
      phone: answers.phone,
      experience: answers.experience,
      position: answers.position,
      consent: true,
      website: answers.website,
      // The number the page shows; over an hour it is not a timing worth keeping.
      completedInSeconds: answers.completedInSeconds <= 3600 ? answers.completedInSeconds : null,
      attribution,
    });
  } catch (error) {
    if (error instanceof SendError) {
      const named = Object.entries(error.fields).filter(([path]) => path in serverFields);
      for (const [path, message] of named) serverFields[path]!.setCustomValidity(message);
      if (named.length > 0) form.reportValidity();
    }
    throw error;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector<HTMLButtonElement>('.submit')!;
  if (button.disabled) return;
  const seconds =
    startedAt === null ? 0 : Math.max(1, Math.round((performance.now() - startedAt) / 1000));
  clearInterval(timerInterval);
  button.disabled = true;
  button.innerHTML = '<span class="spinner" aria-hidden="true"></span>Sending…';
  form.setAttribute('aria-busy', 'true');
  result.textContent = '';
  try {
    await sendApplication({
      name: fields[0]!.value,
      phone: fields[1]!.value,
      experience: fields[2]!.value,
      position: positionValue(),
      consent: consent.checked,
      website: (form.elements.namedItem('website') as HTMLInputElement).value,
      completedInSeconds: seconds,
    });
  } catch (error) {
    // Not saved: every answer stays, the button comes back, the clock keeps running.
    form.removeAttribute('aria-busy');
    button.disabled = false;
    button.textContent = 'Apply now';
    result.textContent =
      error instanceof Error ? error.message : 'Something went wrong. Try again.';
    if (startedAt !== null) timerInterval = window.setInterval(updateTimer, 250);
    return;
  }
  // Saved: the design's success, unchanged.
  clock.textContent = 'Completed in ' + seconds + ' ' + (seconds === 1 ? 'second' : 'seconds');
  $('#duration').textContent =
    'It took you ' + seconds + ' ' + (seconds === 1 ? 'second.' : 'seconds.');
  form.hidden = true;
  $('.card-head').hidden = true;
  $('.progress').hidden = true;
  $('#success').hidden = false;
  form.removeAttribute('aria-busy');
  $('#again').focus();
});
$('#again').addEventListener('click', () => {
  $('#success').hidden = true;
  form.hidden = false;
  // PHONE: "Back to form" starts a clean, new application rather than showing the sent one.
  form.reset();
  phone.setCustomValidity('');
  for (const field of Object.values(serverFields)) field.setCustomValidity('');
  submissionId = newSubmissionId();
  updateProgress();
  clearInterval(timerInterval);
  startedAt = null;
  clock.textContent = 'About 30 seconds to apply';
  $('.card-head').hidden = false;
  $('.progress').hidden = false;
  const button = form.querySelector<HTMLButtonElement>('.submit')!;
  button.disabled = false;
  button.textContent = 'Apply now';
  button.focus();
});

const card = $('main:not(.notice) .card');
const canHover = matchMedia('(hover:hover) and (pointer:fine)');
const reducedMotion = matchMedia('(prefers-reduced-motion:reduce)');
card.addEventListener('pointermove', (event) => {
  if (!canHover.matches || reducedMotion.matches) return;
  const bounds = card.getBoundingClientRect();
  const x = event.clientX - bounds.left,
    y = event.clientY - bounds.top;
  card.style.setProperty('--pointer-x', x + 'px');
  card.style.setProperty('--pointer-y', y + 'px');
  card.style.setProperty('--tilt-x', (0.5 - y / bounds.height) * 2 + 'deg');
  card.style.setProperty('--tilt-y', (x / bounds.width - 0.5) * 2 + 'deg');
});
card.addEventListener('pointerleave', () => {
  card.style.setProperty('--tilt-x', '0deg');
  card.style.setProperty('--tilt-y', '0deg');
});

void open();
