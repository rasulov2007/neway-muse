/**
 * NeWay mobile design tokens: the product's Porcelain look (design/porcelain/SPEC.md,
 * porcelain-theme.css) on a phone — Manrope, the teal accent, and the same tokens in light and
 * dark. The layout still follows the owner's four sheets (docs/mobile/reference/*.png).
 *
 * Components take every colour from `color` and `tone`. They are read at render time, and the
 * theme provider (ui/theme.tsx) swaps their values when the appearance changes and redraws the
 * tree, so no component needs a dark variant. A status is never colour alone: StatusPill and
 * StatusSymbol always draw a shape and a word beside the colour.
 */
const light = {
  /** Primary (Porcelain accent, teal): primary buttons, the active tab, links, the logo square. */
  primary: '#0B7A74',
  primaryPressed: '#096660',
  onPrimary: '#FFFFFF',
  /** Soft accent wash: selected rows, chips, the assistant's background. */
  primaryTint: '#E0F1EF',
  /** Accent used as text on the tint. */
  primaryInk: '#075C57',
  link: '#0B7A74',

  background: '#FFFFFF',
  /** The page behind panels on the redesigned screens (Porcelain bg). */
  canvas: '#F3F5F4',
  /** A raised panel on the canvas. */
  panel: '#FFFFFF',
  /** Segmented tracks, read-only inputs, the attention strip on Today. */
  subtle: '#F6F8F7',
  subtlePressed: '#E9EDEB',
  field: '#FFFFFF',

  ink: '#16201F',
  text2: '#4B5856',
  text3: '#66736F',
  disabled: '#AEB8B5',

  divider: '#E2E7E5',
  border: '#E2E7E5',
  borderStrong: '#CCD5D2',
  focus: '#0B7A74',

  success: '#1D6A36',
  successBg: '#E7F5EC',
  successIcon: '#238044',
  warning: '#8A4B00',
  warningBg: '#FFF4DE',
  warningIcon: '#B86E00',
  danger: '#B42318',
  dangerBg: '#FDEDEB',
  dangerIcon: '#C8321F',
  info: '#1F4E8F',
  infoBg: '#E9F0FB',
  infoIcon: '#2C64B5',
  neutral: '#4B5856',
  neutralBg: '#EEF2F1',
  neutralIcon: '#6F7C79',

  overlay: 'rgba(22, 32, 31, 0.40)',
  toast: '#16201F',
  onToast: '#FFFFFF',
  shadow: '#16201F',

  /** The floating tab bar and the "Open load" pill: an ink pill, as on the reference. */
  dock: '#16201F',
  onDock: '#FFFFFF',
  dockMuted: '#AAB6B3',
  /** The dock as frosted glass: the ink at part strength over the blur, and its light rim. */
  dockGlass: 'rgba(22, 32, 31, 0.58)',
  dockGlassRim: 'rgba(255, 255, 255, 0.16)',
  /** Where the phone draws no blur (Android in Expo Go): the same ink, a little stronger, still see-through. */
  dockFrost: 'rgba(22, 32, 31, 0.78)',

  /** The load card stack: front card gradient and the cards peeking behind it. */
  cardFrom: '#0B7A74',
  cardTo: '#075C57',
  cardBack1: '#12938A',
  cardBack2: '#8A63CF',
  onCard: '#FFFFFF',
  onCardMuted: 'rgba(255, 255, 255, 0.78)',
  onCardLine: 'rgba(255, 255, 255, 0.28)',

  /** Ask NeWay: background wash, the orb's glow and its core. */
  auraFrom: '#E0F1EF',
  auraTo: '#FFFFFF',
  orbCore: '#0B7A74',
  orbGlow: '#12938A',
  orbEdge: '#8A63CF',
  orbHighlight: '#BFE8E3',
  tick: '#0B7A74',

  /** The teal hero (the Face ID lock). */
  heroFrom: '#0B7A74',
  heroTo: '#06403C',
  onHero: '#FFFFFF',
  onHeroMuted: 'rgba(255, 255, 255, 0.75)',
};

export type Palette = { [K in keyof typeof light]: string };

const dark: Palette = {
  primary: '#45BDB3',
  primaryPressed: '#5CCAC0',
  onPrimary: '#062321',
  primaryTint: '#17302D',
  primaryInk: '#7FD6CD',
  link: '#7FD6CD',

  background: '#121615',
  canvas: '#0F1312',
  panel: '#181D1C',
  subtle: '#1C2221',
  subtlePressed: '#28302E',
  field: '#141918',

  ink: '#E3E9E7',
  text2: '#AAB6B3',
  text3: '#8D9996',
  disabled: '#4F5A57',

  divider: '#2A3230',
  border: '#2A3230',
  borderStrong: '#3A4441',
  focus: '#45BDB3',

  success: '#92D2A8',
  successBg: '#16261F',
  successIcon: '#4DB77A',
  warning: '#E8C57C',
  warningBg: '#29231A',
  warningIcon: '#D8A443',
  danger: '#F2A097',
  dangerBg: '#2C1C1A',
  dangerIcon: '#E86B5E',
  info: '#A2C0F0',
  infoBg: '#172233',
  infoIcon: '#6B9BE6',
  neutral: '#AAB6B3',
  neutralBg: '#1F2524',
  neutralIcon: '#8D9996',

  overlay: 'rgba(0, 0, 0, 0.60)',
  toast: '#E3E9E7',
  onToast: '#181D1C',
  shadow: '#000000',

  dock: '#1F2625',
  onDock: '#E3E9E7',
  dockMuted: '#8D9996',
  dockGlass: 'rgba(31, 38, 37, 0.62)',
  dockGlassRim: 'rgba(255, 255, 255, 0.10)',
  dockFrost: 'rgba(31, 38, 37, 0.82)',

  cardFrom: '#1F6F69',
  cardTo: '#123F3B',
  cardBack1: '#2FA59C',
  cardBack2: '#8E78DA',
  onCard: '#FFFFFF',
  onCardMuted: 'rgba(255, 255, 255, 0.74)',
  onCardLine: 'rgba(255, 255, 255, 0.24)',

  auraFrom: '#17302D',
  auraTo: '#121615',
  orbCore: '#45BDB3',
  orbGlow: '#2FA59C',
  orbEdge: '#8E78DA',
  orbHighlight: '#7FD6CD',
  tick: '#45BDB3',

  heroFrom: '#123F3B',
  heroTo: '#0B1F1D',
  onHero: '#FFFFFF',
  onHeroMuted: 'rgba(255, 255, 255, 0.72)',
};

export const palettes: Record<'light' | 'dark', Palette> = { light, dark };

export type Scheme = 'light' | 'dark';

/** The live palette. Values change in place when the appearance changes (applyScheme). */
export const color: Palette = { ...light };

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'moving';

/** Each tone: its word colour, its soft background, and the colour of its symbol. */
export const tone: Record<StatusTone, { fg: string; bg: string; icon: string }> = {
  success: { fg: '', bg: '', icon: '' },
  warning: { fg: '', bg: '', icon: '' },
  danger: { fg: '', bg: '', icon: '' },
  info: { fg: '', bg: '', icon: '' },
  neutral: { fg: '', bg: '', icon: '' },
  moving: { fg: '', bg: '', icon: '' },
};

let current: Scheme = 'light';

/** Swaps the live palette. The theme provider redraws the tree afterwards. */
export function applyScheme(scheme: Scheme): void {
  current = scheme;
  Object.assign(color, palettes[scheme]);
  Object.assign(tone.success, { fg: color.success, bg: color.successBg, icon: color.successIcon });
  Object.assign(tone.warning, { fg: color.warning, bg: color.warningBg, icon: color.warningIcon });
  Object.assign(tone.danger, { fg: color.danger, bg: color.dangerBg, icon: color.dangerIcon });
  Object.assign(tone.info, { fg: color.info, bg: color.infoBg, icon: color.infoIcon });
  Object.assign(tone.neutral, { fg: color.neutral, bg: color.neutralBg, icon: color.neutralIcon });
  // Moving (arrow circle) is the Porcelain "moving" family.
  Object.assign(tone.moving, { fg: color.info, bg: color.infoBg, icon: color.infoIcon });
}
applyScheme('light');

/**
 * A colour between two token colours (#RRGGBB), t from 0 to 1: the wordmark's letters step along
 * the accent gradient this way, so every letter still comes from the palette.
 */
export function mixColor(from: string, to: string, t: number): string {
  const a = from.replace('#', '');
  const b = to.replace('#', '');
  if (a.length !== 6 || b.length !== 6) return from;
  const ch = (i: number) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t);
  return '#' + [0, 2, 4].map((i) => ch(i).toString(16).padStart(2, '0')).join('');
}

export function currentScheme(): Scheme {
  return current;
}

export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

/** Page gutter: the sheets keep 16 px either side. */
export const gutter = space.lg;

export const radius = {
  sm: 6,
  md: 8,
  /** Porcelain panels. */
  lg: 10,
  /** The redesigned cards and sheets. */
  xl: 20,
  xxl: 28,
  pill: 999,
} as const;

/** Large touch targets: nothing pressable is shorter than this. */
export const touch = 48;

/** Manrope by weight (loaded in the root layout; the system font until it has loaded). */
export const fontFamily: Record<string, string> = {
  '400': 'Manrope_400Regular',
  '500': 'Manrope_500Medium',
  '600': 'Manrope_600SemiBold',
  '700': 'Manrope_700Bold',
  '800': 'Manrope_800ExtraBold',
};

export const type = {
  hero: { fontSize: 34, lineHeight: 40, fontWeight: '800' as const },
  display: { fontSize: 26, lineHeight: 32, fontWeight: '700' as const },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' as const },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '700' as const },
  subheading: { fontSize: 16, lineHeight: 22, fontWeight: '600' as const },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400' as const },
  bodyStrong: { fontSize: 16, lineHeight: 22, fontWeight: '600' as const },
  /** List row and timeline titles: a touch under body, as on the sheets. */
  rowTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600' as const },
  small: { fontSize: 14, lineHeight: 20, fontWeight: '400' as const },
  smallStrong: { fontSize: 14, lineHeight: 20, fontWeight: '600' as const },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' as const },
  captionStrong: { fontSize: 12, lineHeight: 16, fontWeight: '600' as const },
  overline: { fontSize: 11, lineHeight: 14, fontWeight: '700' as const, letterSpacing: 0.8 },
  money: { fontSize: 32, lineHeight: 38, fontWeight: '700' as const },
} as const;

export type TypeVariant = keyof typeof type;

/** Menus, dialogs, sheets, toasts, the dock and the number cards carry a shadow; flat sections never do. */
export const elevation = {
  get overlay() {
    return { shadowColor: color.shadow, shadowOpacity: 0.16, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 8 };
  },
  get card() {
    return { shadowColor: color.shadow, shadowOpacity: 0.14, shadowRadius: 18, shadowOffset: { width: 0, height: 10 }, elevation: 6 };
  },
};
