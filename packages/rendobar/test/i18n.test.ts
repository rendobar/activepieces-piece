/// <reference types="vitest/globals" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { missingTranslations } from '../../../scripts/lib/i18n.mjs';

describe('translation.json', () => {
  it('holds every translatable string the actions and triggers declare', () => {
    const root = join(__dirname, '..', 'src');
    const files = ['lib/actions', 'lib/triggers'].flatMap((dir) =>
      readdirSync(join(root, dir))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => join(root, dir, f)),
    );
    const translation = JSON.parse(readFileSync(join(root, 'i18n', 'translation.json'), 'utf8'));
    expect([...missingTranslations(files, translation)]).toEqual([]);
  });
});
