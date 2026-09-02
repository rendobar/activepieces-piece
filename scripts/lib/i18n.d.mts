/**
 * Types for activepieces-i18n.mjs, which stays plain JS like its siblings in
 * scripts/. Hand written rather than generated: two functions, and a .d.ts is
 * cheaper than making one script file the only TypeScript in this directory.
 */

/** Translatable strings in one piece source file. */
export function stringsFrom(source: string): string[];

/** Source strings with no entry in the translation map. Empty means in step. */
export function missingTranslations(
  files: string[],
  translation: Record<string, string>,
): string[];
