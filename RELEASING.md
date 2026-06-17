# Releasing

This repository follows the **org-wide OCTO release process**. The authoritative
design, rationale, and shared automation live in
[`Mininglamp-OSS/.github`](https://github.com/Mininglamp-OSS/.github) — this page
is only the per-repo pointer, so it links rather than duplicates.

> **Monorepo note:** this repo has **two independent release tracks that use
> different tag namespaces**. Read both before tagging — pushing the wrong tag
> triggers the wrong automation.

## SemVer

All releases use [Semantic Versioning](https://semver.org) `MAJOR.MINOR.PATCH`:

- **MAJOR** — breaking changes
- **MINOR** — backward-compatible features
- **PATCH** — backward-compatible fixes

**Pre-release suffixes (e.g. `-rc.1`, `-beta.2`):**

- **Track 2 (npm)** maps any pre-release suffix to the `@next` dist-tag — this is
  implemented in `publish-octo.yml`.
- **Track 1 (GitHub Release)** does **not** currently special-case pre-release
  tags: the pinned `reusable-release-publish@v1` neither sets `prerelease` nor
  `make_latest: false`, so a `-rc` tag would still publish as a **normal (Latest)**
  GitHub Release. Until the reusable handles this, **use stable `vX.Y.Z` tags for
  Track 1** and do not rely on `-rc` tags being treated as GitHub pre-releases.

## Track 1 — GitHub Release + changelog (unscoped `vX.Y.Z` tags)

Drives this repo's drafted GitHub Release and changelog, exactly like the other
OCTO core repos.

- **Changelog (automated):** drafted by **release-drafter**
  (`.github/workflows/release-drafter.yml`, which calls the org
  [`reusable-release-drafter`](https://github.com/Mininglamp-OSS/.github/blob/main/.github/workflows/reusable-release-drafter.yml)).
  PRs are squash-merged, so **release notes are generated from PR titles** — keep
  them in [Conventional Commits](https://www.conventionalcommits.org) form
  (`feat:`, `fix:`, `docs:` …). The local config (`.github/release-drafter.yml`)
  drafts against **unscoped** tags (`tag-template: "v$NEXT_PATCH_VERSION"`); a
  running draft Release is refreshed on every merge to `main`.
- **Cutting it:**
  1. Pick a commit on `main` and confirm its **CI run is green** — copy the
     **run ID** from the Actions URL (`…/actions/runs/<RUN_ID>`); it is the
     release evidence.
  2. Push the **unscoped** tag on that exact commit:
     ```
     git tag -a v1.1.0 -m "Release v1.1.0" <sha>
     git push origin v1.1.0
     ```
  3. **Publish** via the **Release Publish** workflow
     (`.github/workflows/release-publish.yml` → Actions → *Run workflow*),
     passing the tag and the successful CI **run ID**. It calls the org
     [`reusable-release-publish`](https://github.com/Mininglamp-OSS/.github/blob/main/.github/workflows/reusable-release-publish.yml),
     which re-verifies the CI run **succeeded on the tagged commit** before
     promoting the drafted GitHub Release. Pass `draft: true` to stage without
     publishing.

## Track 2 — npm package publish (package-scoped `create-openclaw-octo/vX.Y.Z` tags)

Publishes the `create-openclaw-octo` package to npm. This is **separate from
Track 1** — package-scoped tags do **not** drive the GitHub Release/changelog,
and the unscoped `vX.Y.Z` tags do **not** publish to npm.

> ⚠️ **Pushing a `create-openclaw-octo/v*` tag publishes to npm immediately.**
> `.github/workflows/publish-octo.yml` runs on that tag push (test → build →
> `npm publish`) — there is no separate manual gate; the tag push *is* the npm
> release trigger. To rehearse, use the workflow's **manual dispatch** with the
> version **without** the leading `v`, plus `dry_run: true` — e.g.
> `tag: 1.2.0, dry_run: true`.

- **dist-tag mapping:** `create-openclaw-octo/v1.2.0` → `@latest`; any
  pre-release suffix (e.g. `create-openclaw-octo/v1.2.0-rc.1`) → `@next`.
- The slash prefix scopes the tag to this package so future packages in this
  monorepo can each define their own `<package>/v*` publish workflow without
  collision.

## Org references

- [Workflow architecture — Plane 3: Supply chain / release](https://github.com/Mininglamp-OSS/.github/blob/main/docs/workflow-architecture.md)
- [CI/CD state snapshot](https://github.com/Mininglamp-OSS/.github/blob/main/docs/cicd-state-snapshot.md)
- [`reusable-release-drafter`](https://github.com/Mininglamp-OSS/.github/blob/main/.github/workflows/reusable-release-drafter.yml) · [`reusable-release-publish`](https://github.com/Mininglamp-OSS/.github/blob/main/.github/workflows/reusable-release-publish.yml)
