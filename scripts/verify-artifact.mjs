// Asserts the published artifact is what we think it is, before it can reach
// the registry.
//
// This exists because the bundle is produced by a vendor tool we do not
// control, from source we do. Every check below corresponds to something that
// was verified by hand once and would otherwise never be verified again.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(process.cwd(), 'packages/rendobar/dist');
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

if (!existsSync(DIST)) throw new Error(`no dist at ${DIST}. Run: npm run bundle`);

const src = readFileSync(join(DIST, 'src/index.js'), 'utf8');
const dist = JSON.parse(readFileSync(join(DIST, 'package.json'), 'utf8'));
const source = JSON.parse(readFileSync(join(process.cwd(), 'packages/rendobar/package.json'), 'utf8'));

// 1. The engine loads <package>/src/index.js directly on older versions,
//    ignoring "main". Publishing a layout it cannot load is silent breakage.
check(dist.main === './src/index.js', `main is ${dist.main}, expected ./src/index.js`);

// 2. Every piece in the catalog publishes with no runtime dependencies: the
//    framework is inlined. A stray dependency here means the host installs a
//    second framework copy alongside its own.
check(Object.keys(dist.dependencies ?? {}).length === 0,
  `dependencies must be empty, got ${JSON.stringify(dist.dependencies)}`);

// 3. Metadata survives bundling. prepare-piece-utils strips several fields and
//    a future version could strip more, which would silently gut the npm page.
for (const field of ['description', 'license', 'homepage', 'keywords', 'repository']) {
  check(dist[field] !== undefined, `published package.json lost "${field}"`);
}
check(dist.version === source.version,
  `dist version ${dist.version} != source ${source.version}`);

// 4. The attribution header must survive minification. The version is inlined
//    as a mangled binding, so the only honest check is that the identifier the
//    header interpolates is the same one bound to this version string.
const header = src.match(/"X-Rendobar-Client":\s*`activepieces\/\$\{([A-Za-z_$][\w$]*)\}`/);
check(header !== null, 'X-Rendobar-Client header not found in the bundle');
if (header) {
  const bound = new RegExp(`(?:^|[^\w$])${header[1].replace(/\$/g, '\$')}\s*=\s*"${source.version.replace(/\./g, '\.')}"`);
  check(bound.test(src),
    `header interpolates ${header[1]} but that binding is not "${source.version}"`);
}

// 5. Nothing that looks like a credential. The bundle inlines third-party code
//    we did not read line by line.
const secretish = src.match(/rb_[A-Za-z0-9]{20,}|(?:api[_-]?key|secret|token)['"]?\s*[:=]\s*['"][A-Za-z0-9]{16,}/gi);
check(secretish === null, `secret-shaped strings in the bundle: ${secretish?.slice(0, 3)}`);

// 6. Only Node builtins may be required at runtime. Anything else is a
//    dependency the bundler externalised and package.json does not declare,
//    which crashes on the host with a missing module.
const builtins = new Set(['assert','buffer','crypto','dns','events','fs','fs/promises','http','http2','https','net','os','path','punycode','querystring','stream','stream/consumers','stream/web','string_decoder','tls','tty','url','util','worker_threads','zlib','child_process','constants','module','process','timers','timers/promises','v8','perf_hooks','async_hooks','readline','vm','diagnostics_channel']);
const required = [...src.matchAll(/require\(["']([^"']+)["']\)/g)]
  .map((m) => m[1].replace(/^node:/, ''))
  .filter((m) => !builtins.has(m));
check(required.length === 0, `bundle requires non-builtin modules at runtime: ${[...new Set(required)].join(', ')}`);

// 7. The tarball is what npm will actually send.
// Ask npm what it would actually send rather than inferring it from "files".
// Run npm's own cli.js under this node rather than the `npm` shim: spawning a
// .cmd on Windows needs a shell, and shell + args is a deprecated injection
// risk. npm_execpath is set for us because this runs as an npm script.
const npmCli = process.env.npm_execpath;
const packed = JSON.parse(
  (npmCli
    ? execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'],
        { cwd: DIST, stdio: ['ignore', 'pipe', 'pipe'] })
    : execFileSync('npm', ['pack', '--dry-run', '--json'],
        { cwd: DIST, stdio: ['ignore', 'pipe', 'pipe'] })
  ).toString(),
)[0];
const names = packed.files.map((f) => f.path).sort();
const expected = ['LICENSE', 'README.md', 'package.json', 'src/i18n/translation.json', 'src/index.js'];
check(JSON.stringify(names) === JSON.stringify(expected),
  `tarball contents changed.\n      got:      ${names.join(', ')}\n      expected: ${expected.join(', ')}`);

if (failures.length) {
  console.error(`\nartifact verification FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  x ${f}`);
  process.exit(1);
}
console.log(`artifact ok: ${dist.name}@${dist.version}, ${names.length} files, ${(packed.size / 1024).toFixed(1)} kB packed`);
