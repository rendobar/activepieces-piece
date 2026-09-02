// Fetches the Activepieces packages this piece compiles against, at a pinned
// commit, into .ap-src.
//
// Why a clone at all: the piece uses framework APIs that npm does not carry.
// @activepieces/pieces-framework on npm is frozen at 0.38.0's predecessor
// 0.32.0 (last published 2026-06-17), and building against it fails with 15
// errors — ExecutionType, resumePayload, streamUtils and streaming: true are
// all missing. Those are the waitpoint pause and the streaming upload, which
// is most of what this piece is.
//
// Why pinned and not main: a moving upstream makes a green build unreproducible
// and turns someone else's refactor into our red CI. Bump .ap-pin deliberately.
//
// Why sparse and blobless: the four packages we need are 5.3 MB and fetch in
// about two seconds. A full clone is neither.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DEST = join(ROOT, '.ap-src');
const REMOTE = 'https://github.com/activepieces/activepieces.git';

// The transitive closure of @activepieces/* that pieces-framework and
// pieces-common actually import. Verified by walking their package.json deps.
const PATHS = [
  'packages/pieces/framework',
  'packages/pieces/common',
  'packages/core/utils',
  'packages/core/piece-types',
];

const pin = readFileSync(join(ROOT, '.ap-pin'), 'utf8').trim();
if (!/^[0-9a-f]{40}$/.test(pin)) {
  throw new Error(`.ap-pin must be a full 40-character commit sha, got: ${pin}`);
}

const git = (args, cwd = DEST) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

if (existsSync(DEST)) {
  // Already at the pin? Nothing to do. Keeps local runs and warm CI caches fast.
  try {
    if (git(['rev-parse', 'HEAD']) === pin) {
      console.log(`ap-src already at ${pin.slice(0, 12)}`);
      process.exit(0);
    }
  } catch {
    // Not a usable repo. Fall through and re-create it.
  }
  rmSync(DEST, { recursive: true, force: true });
}

mkdirSync(DEST, { recursive: true });
git(['init', '-q', '.']);
git(['remote', 'add', 'origin', REMOTE]);
git(['sparse-checkout', 'init', '--cone']);
git(['sparse-checkout', 'set', ...PATHS]);
// Fetching a bare sha needs the server to allow it. GitHub does.
git(['fetch', '--depth', '1', '--filter=blob:none', 'origin', pin]);
git(['checkout', '-q', 'FETCH_HEAD']);

for (const p of PATHS) {
  if (!existsSync(join(DEST, p, 'package.json'))) {
    throw new Error(`sparse checkout missing ${p}; the pin may predate that path`);
  }
}
console.log(`ap-src at ${pin.slice(0, 12)}`);
