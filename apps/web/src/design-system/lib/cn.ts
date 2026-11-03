import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * Class merging, taught the design system's own scales.
 *
 * tailwind-merge resolves conflicts by class group, and it infers the group from the class name.
 * A bespoke step like `text-eyebrow` does not look like a size to it, so it is filed under
 * text-*colour* and then **silently dropped** when a real colour follows it:
 *
 *   twMerge('text-eyebrow text-faint')  ->  'text-faint'
 *
 * That is exactly what happened to every table header in this app — the 10.5px step vanished and
 * the headers rendered at the inherited 13px, with no error anywhere to say so. Declaring the
 * custom steps here is the fix, and it also protects the next token somebody adds.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['eyebrow'] }],
    },
  },
});

/** Merge class names, resolving Tailwind conflicts (later classes win). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
