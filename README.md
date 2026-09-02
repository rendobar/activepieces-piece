<p align="center">
  <a href="https://rendobar.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://cdn.rendobar.com/assets/brand/logo-mark.svg">
      <img alt="Rendobar" src="https://cdn.rendobar.com/assets/brand/logo-mark-black.svg" width="80">
    </picture>
  </a>
</p>

<h1 align="center">@rendobar/piece-rendobar</h1>

<p align="center">
  <strong>Media processing for Activepieces.</strong><br>
  Submit jobs, wait for them without polling, and trigger a flow when one finishes.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@rendobar/piece-rendobar">npm</a> &nbsp;&middot;&nbsp;
  <a href="https://rendobar.com/docs">Docs</a> &nbsp;&middot;&nbsp;
  <a href="https://www.activepieces.com">Activepieces</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@rendobar/piece-rendobar"><img src="https://img.shields.io/npm/v/@rendobar/piece-rendobar?style=flat-square&color=059669&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@rendobar/piece-rendobar"><img src="https://img.shields.io/npm/dm/@rendobar/piece-rendobar?style=flat-square&color=059669" alt="npm downloads"></a>
  <img src="https://img.shields.io/npm/l/@rendobar/piece-rendobar?style=flat-square&color=059669" alt="MIT license">
  <a href="https://github.com/rendobar/activepieces-piece/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/rendobar/activepieces-piece/ci.yml?branch=main&style=flat-square&color=059669&label=ci" alt="CI"></a>
</p>

## Install

Activepieces installs custom pieces from npm by package name. On a self-hosted
instance, add it from **Admin → Pieces → Install**:

```
@rendobar/piece-rendobar
```

Installing custom pieces is a paid feature on Activepieces Cloud.

## What it does

Seven actions and two triggers. `packages/rendobar/README.md` is the reference,
and it is what renders on the npm page.

The part worth knowing about: **Create job pauses the flow on a waitpoint rather
than polling.** Rendobar calls back when the job finishes and the flow resumes,
so a ten minute render costs no execution time while it waits. If a callback URL
cannot be reached, it falls back to polling on its own.

## Repository layout

```
packages/rendobar/     the piece, and the only thing published
scripts/               fetch pinned Activepieces source, generate the version,
                       bundle, verify the artifact
.ap-pin                the Activepieces commit everything compiles against
```

## Developing

```bash
npm ci
npm run ap:fetch
npm run ci
```

See [CONTRIBUTING.md](./CONTRIBUTING.md), which covers why the framework is
fetched rather than installed, why the published package has no dependencies,
and how releases work.

## Licence

MIT. See [LICENSE](./LICENSE).
