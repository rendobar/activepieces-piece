/**
 * Catch a piece's translation file drifting behind its source.
 *
 * Activepieces' own generator is authoritative and must be what actually writes
 * `src/i18n/translation.json`: it loads the built piece as a module, so it sees
 * strings this file cannot, notably the ~30 that `createCustomApiCallAction()`
 * contributes from inside the framework. Measured, not assumed: a source-only
 * extractor reproduced 57 of the 81 keys AP generates, so REGENERATING from
 * source would silently delete two dozen legitimate entries.
 *
 * So this only ever reports strings that are in the source and missing from the
 * file. One direction, no writes. A string it fails to see is a missed warning,
 * never a deleted translation.
 *
 * What it looks at mirrors `pathsToValuesToTranslate` in the framework's
 * i18n.ts: `displayName`, `description` and dropdown option `label`. Excluded
 * because the framework does not translate them:
 *   aiMetadata.description   read by models, never shown to a person
 *   outputSchema labels      not in the framework's path list
 *   common/fields.ts         props built at runtime from Rendobar's job schema,
 *                            so those labels are the API's, not the piece's
 */
import { readFileSync } from "node:fs";

/** MAX_KEY_LENGTH_FOR_CORWDIN in @activepieces/shared. */
const MAX_KEY_LENGTH = 512;

/** Blank out a block by name, preserving every other offset in the file. */
function withoutBlock(source, key) {
  const re = new RegExp(`${key}:\\s*\\{`, "g");
  let out = source;
  let m;
  while ((m = re.exec(out)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < out.length; i++) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}" && --depth === 0) break;
    }
    out = out.slice(0, m.index) + " ".repeat(i - m.index + 1) + out.slice(i + 1);
    re.lastIndex = m.index;
  }
  return out;
}

/**
 * Translatable strings in one piece source file.
 *
 * Single-quoted literals only, which is what this codebase uses. A template
 * literal is interpolated at runtime and has no stable key, so it is not
 * translatable; skipping it is correct rather than a gap.
 */
export function stringsFrom(source) {
  const cleaned = withoutBlock(withoutBlock(source, "aiMetadata"), "outputSchema");
  const found = [];
  const pattern = /(?:displayName|description|label):\s*'((?:[^'\\]|\\.)*)'/g;
  for (let m; (m = pattern.exec(cleaned)) !== null; ) {
    const value = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    if (value !== "") found.push(value.slice(0, MAX_KEY_LENGTH));
  }
  return found;
}

/** Source strings with no entry in the translation file. Empty means in step. */
export function missingTranslations(files, translation) {
  const have = new Set(Object.keys(translation));
  const missing = new Set();
  for (const file of files) {
    for (const value of stringsFrom(readFileSync(file, "utf8"))) {
      if (!have.has(value)) missing.add(value);
    }
  }
  return [...missing].sort();
}
