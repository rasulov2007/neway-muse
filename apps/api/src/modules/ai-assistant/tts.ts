import { createHash } from 'node:crypto';

/**
 * Read aloud, on the server (owner, 2026-10-22): Windows has no Uzbek voice, and most NeWay AI
 * answers are Uzbek, so the browser's own speech could not read them. These are the pure parts:
 * which language, which voice, what text, and the SSML Azure is sent.
 */

export type TtsLang = 'uz' | 'ru' | 'en';

export const TTS_MAX_CHARS = 4000;

/** Voices for the languages NeWay AI answers in. Uzbek comes from the account (male by default). */
export const TTS_VOICES: Record<Exclude<TtsLang, 'uz'>, string> = {
  en: 'en-US-AvaMultilingualNeural',
  ru: 'ru-RU-SvetlanaNeural',
};

const LOCALES: Record<TtsLang, string> = { uz: 'uz-UZ', ru: 'ru-RU', en: 'en-US' };

/** "uz", "uz-UZ", "RU" … → the language; anything else → undefined (detected from the text). */
export function normaliseLang(lang: string | undefined | null): TtsLang | undefined {
  const prefix = (lang ?? '').trim().slice(0, 2).toLowerCase();
  return prefix === 'uz' || prefix === 'ru' || prefix === 'en' ? prefix : undefined;
}

const UZ_WORDS = /\b(va|uchun|qiling|qilish|qildim|bo['ʻʼ‘’]l\w*|bu|emas|kerak|yo['ʻʼ‘’]q|haqida|bilan|ham|lekin|yoki|hozir|barcha|mavjud|soni|ro['ʻʼ‘’]yxat\w*|haydovchi\w*|yuk\w*)\b/gi;

/** Uzbek (Latin), Russian (any Cyrillic) or English, from the text itself. */
export function detectLang(text: string): TtsLang {
  const cyrillic = (text.match(/[а-яё]/gi) ?? []).length;
  const latin = (text.match(/[a-z]/gi) ?? []).length;
  if (cyrillic > 0 && cyrillic >= latin) return 'ru';
  // oʻ / gʻ and the modifier apostrophe are Uzbek Latin's own letters. A plain ' is not proof
  // ("dog's"), so o'/g' with an ASCII apostrophe counts only through the words below.
  if (/[oOgG][ʻ‘]|[ʼʻ]/.test(text)) return 'uz';
  if ((text.match(UZ_WORDS) ?? []).length >= 1) return 'uz';
  return 'en';
}

export function voiceFor(lang: TtsLang, voiceUz: string): string {
  return lang === 'uz' ? voiceUz : TTS_VOICES[lang];
}

/** Markdown and table syntax out, words in. Simple on purpose: what a person would read aloud. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, '')
    .replace(/^\s*\|(.*)\|\s*$/gm, (_, row: string) => `${row.split('|').map((c) => c.trim()).filter(Boolean).join(', ')}.`)
    .replace(/\|/g, ', ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/[*_~]/g, '')
    .replace(/^-{3,}$/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function buildSsml(text: string, lang: TtsLang, voice: string): string {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${LOCALES[lang]}"><voice name="${xmlEscape(voice)}">${xmlEscape(text)}</voice></speak>`;
}

export const ttsCacheKey = (voice: string, text: string) => createHash('sha256').update(`${voice}\n${text}`).digest('hex');

/** A small least-recently-used cache of finished audio, bounded by entries and by bytes. */
export class AudioCache {
  private readonly entries = new Map<string, Buffer>();
  private bytes = 0;

  constructor(
    private readonly maxEntries = 100,
    private readonly maxBytes = 32 * 1024 * 1024,
  ) {}

  get(key: string): Buffer | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    // Touch: the newest use goes to the end.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  set(key: string, audio: Buffer): void {
    if (audio.length > this.maxBytes) return;
    const old = this.entries.get(key);
    if (old) {
      this.bytes -= old.length;
      this.entries.delete(key);
    }
    this.entries.set(key, audio);
    this.bytes += audio.length;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string;
      this.bytes -= this.entries.get(oldest)!.length;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
