// Produces the publishable artifact in packages/rendobar/dist.
//
// The bundler resolves @activepieces/* through workspaceAliases(repoRoot),
// which hardcodes repoRoot/packages/pieces/framework/src and friends, and finds
// repoRoot by walking up for a package.json with a "workspaces" array. So the
// piece has to be bundled from inside an Activepieces tree. .ap-src is one: the
// pinned sparse fetch includes AP's root manifest, whose workspaces list
// already covers packages/pieces/community/*.
//
// So: stage the piece into the pinned clone, bundle there, copy the result
// back. Nothing about our own repo layout has to imitate theirs.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PIECE = join(ROOT, 'packages/rendobar');
const AP = join(ROOT, '.ap-src');
const STAGED = join(AP, 'packages/pieces/community/rendobar');

if (!existsSync(AP)) throw new Error('no .ap-src. Run: npm run ap:fetch');

rmSync(STAGED, { recursive: true, force: true });
mkdirSync(STAGED, { recursive: true });
for (const entry of ['src', 'package.json', 'README.md', 'LICENSE']) {
  cpSync(join(PIECE, entry), join(STAGED, entry), { recursive: true });
}
// preparePieceDistForPublish refuses to run without a dist directory. It fills
// it; it just will not create it.
mkdirSync(join(STAGED, 'dist'), { recursive: true });

// The CLI's JS entry, not its .cmd shim: spawnSync on a .cmd is EINVAL on
// Windows without a shell, and a shell brings quoting problems with it.
execFileSync(
  process.execPath,
  [join(ROOT, 'node_modules/@activepieces/cli/index.js'), 'pieces', 'bundle', STAGED],
  { cwd: ROOT, stdio: 'inherit' },
);

rmSync(join(PIECE, 'dist'), { recursive: true, force: true });
cpSync(join(STAGED, 'dist'), join(PIECE, 'dist'), { recursive: true });

// The bundler rewrites "files" to a fixed list that omits both of these. npm
// force-includes README and LICENSE regardless of "files", so copying them in
// is what gives the package page a body and a licence.
for (const f of ['README.md', 'LICENSE']) {
  copyFileSync(join(PIECE, f), join(PIECE, 'dist', f));
}
// The bundler packs a .tgz beside the output. Publishing happens from the
// directory, so a stray tarball would just be dead weight inside it.
for (const f of readdirSync(join(PIECE, 'dist'))) {
  if (f.endsWith('.tgz')) rmSync(join(PIECE, 'dist', f), { force: true });
}

console.log(`bundled -> packages/rendobar/dist`);
