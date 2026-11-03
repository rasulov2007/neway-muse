import { z } from 'zod';

/**
 * "Ask NeWay" in the driver app (mobile M6): a driver asks about their OWN pay and work.
 *
 * The server resolves the driver from the session, reads only that driver's statements, loads and
 * receipts, and answers. With the company's Anthropic key it asks NeWay AI (no tools, the facts
 * passed in); without one, or when the model fails, the answer is built from the same facts for
 * the common questions. Money figures always come from stored statements, never recomputed.
 */
export const DriverAssistantAskSchema = z
  .object({
    question: z.string().trim().min(1, 'Ask a question').max(1000),
    /** The last few turns on the phone, so a follow-up ("and last week?") makes sense. */
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(4000) }).strict())
      .max(10)
      .optional(),
  })
  .strict();
export type DriverAssistantAskInput = z.input<typeof DriverAssistantAskSchema>;

export interface DriverAssistantFact {
  label: string;
  value: string;
}

export interface DriverAssistantAnswer {
  answer: string;
  /** `ai`: NeWay AI wrote it from the driver's data; `data`: built on the server from the data alone. */
  source: 'ai' | 'data';
  /** The figures the answer rests on, shown under it as small rows. */
  facts: DriverAssistantFact[];
  /** Follow-up questions the app offers as chips. */
  suggestions: string[];
  /** False when the server has no AI key: the app says answers cover the common questions only. */
  aiConfigured: boolean;
}

export interface DriverAssistantTranscript {
  text: string;
}

/** The languages a driver may speak to Ask NeWay; the answer comes back in the same one. */
export const DRIVER_ASSISTANT_LANGUAGES = ['en', 'ru', 'uz'] as const;
export type DriverAssistantLanguage = (typeof DRIVER_ASSISTANT_LANGUAGES)[number];

export const DRIVER_ASSISTANT_LANGUAGE_NAME: Record<DriverAssistantLanguage, string> = { en: 'English', ru: 'Russian', uz: 'Uzbek' };

/** BCP-47 tag for the phone's speech voice. */
export const DRIVER_ASSISTANT_SPEECH_TAG: Record<DriverAssistantLanguage, string> = { en: 'en-US', ru: 'ru-RU', uz: 'uz-UZ' };

const UZ_WORDS =
  /\b(qachon|qayer|qancha|qanday|keyingi|nechta|necha|menga|mening|sizning|yuk|yukim|maosh|oylik|hafta|haftalik|mil|qoldi|qolgan|bormi|kerak|uchun|bo'ladi|to'lov|pikap|dispetcher|yetkazish|manzil|nima|kim|bugun|ertaga)\b/i;
/** Letters only Uzbek Cyrillic has (ў қ ғ ҳ). */
const UZ_CYRILLIC = /[ўқғҳЎҚҒҲ]/;
/**
 * Uzbek words a speech engine writes in plain Russian letters (Meta heard "Кинги пикап качон. Нича
 * мил колди." for "Keyingi pikap qachon? Necha mil qoldi?"). No Russian word is in this list.
 */
const UZ_CYRILLIC_WORDS =
  /(^|[^а-яё])(качон|канча|кейинги|кинги|киенги|кенги|нича|неча|колди|колган|юким|маош|маошим|хафта|хафтада|учун|керак|бугун|эртага|менинг|сизнинг|каерда|каерга|диспетчерим|нима|ким|йук|йўк|булади|тўлов|тулов)([^а-яё]|$)/i;
/** Uzbek Latin apostrophe letters: oʻ gʻ (turned comma), or o'/g' inside a word ("to'lov", not "dog's" or "o'clock"). */
const UZ_LATIN = /[og][ʻ‘]|[a-z][og]['’`][a-rt-z]|\bg['’`][a-z]|\bo['’`](?!clock)[a-rt-z]/i;

/**
 * Which language a question (or an answer) is in, from its own words. Russian vs Uzbek written in
 * Cyrillic is told apart by Uzbek-only letters; Latin Uzbek by its apostrophe letters and common
 * words. Everything else is English.
 */
export function spokenLanguage(text: string): DriverAssistantLanguage {
  const s = text.trim();
  if (!s) return 'en';
  if (/[Ѐ-ӿ]/.test(s)) return UZ_CYRILLIC.test(s) || UZ_CYRILLIC_WORDS.test(s) ? 'uz' : 'ru';
  if (UZ_LATIN.test(s) || UZ_WORDS.test(s)) return 'uz';
  return 'en';
}

/**
 * POST /driver/assistant/voice (hackathon, Meta Muse): one recording in, the words heard and the
 * answer out, in the language the driver spoke. Timings are the server's own, for the demo.
 */
export interface DriverAssistantVoiceAnswer {
  transcript: string;
  language: DriverAssistantLanguage;
  /** Who turned the recording into words: Meta Muse (muse-voice-transcribe-1.0) or the company's Azure Speech. */
  transcribedBy: 'meta' | 'azure';
  answer: DriverAssistantAnswer;
  timings: { transcribeMs: number; answerMs: number };
}

/** Starter questions on the empty assistant screen. */
export const DRIVER_ASSISTANT_STARTERS = [
  'How much is my pay this week?',
  'What was deducted last week?',
  'When is my next pay?',
  'Which loads counted for pay?',
  'How many miles did I drive?',
  'How do I upload a POD?',
] as const;
