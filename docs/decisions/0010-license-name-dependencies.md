# 0010 — License, name, and dependency review

Reviewed 2026-11-01 for RIZ-044.

## Decision

- riz ships under **Apache-2.0** (`LICENSE`, unmodified standard text). No `NOTICE` file:
  Apache-2.0 requires one only when we redistribute third-party NOTICE content, and the
  source packages bundle no dependencies. Revisit when RIZ-046 publishes the container images
  built from `deploy/*.Dockerfile`, which do bundle dependencies.
- **npm**: keep `@riz/sdk`. The unscoped name `riz` is taken (`riz@0.0.1`, unrelated, last
  published 2022). No package exists under `@riz/`, but scope ownership could not be
  confirmed from here.
- **PyPI**: `riz` is taken (an unrelated programming language, `riz@0.1`). Publish the
  Python SDK as **`riz-sdk`** (it returned 404 on 2026-11-01; PyPI may still reject a name
  that normalizes to an existing one). The import name stays `import riz`; only
  `[project].name` in `sdks/python/pyproject.toml` changes, and that change belongs to
  RIZ-045.
- **Manifests**: no package manifest declares a `license` field yet, so published packages
  would show none. RIZ-045 must add `Apache-2.0` to `sdks/python/pyproject.toml` and
  `sdks/typescript/package.json`. `LICENSE` keeps the stock appendix placeholder
  (`Copyright [yyyy] [name of copyright owner]`); the copyright holder is Quentin Auster.

## Dependency licenses

Production JavaScript (`pnpm licenses list --prod --recursive`, 65 packages):

| License | Packages |
| --- | --- |
| MIT | 45 |
| Apache-2.0 | 15 (OpenFGA SDK and syntax transformer, OpenTelemetry) |
| ISC | 3 |
| BSD-3-Clause | 2 |

Python SDK runtime tree (`uv tree --no-dev`, read from installed metadata):

| Package | License |
| --- | --- |
| httpx, httpcore, idna | BSD-3-Clause |
| anyio, h11 | MIT |
| typing-extensions | PSF-2.0 |
| certifi | MPL-2.0 |

All are compatible with Apache-2.0. Most are permissive (MIT, BSD, ISC, Apache-2.0,
PSF-2.0); `certifi` is MPL-2.0 (file-level copyleft). It is an unmodified, separately
installed dependency, so it places no obligation on riz's own source. Do not vendor or
patch it.

Not covered: dev-only dependencies (not distributed), and the OS and runtime layers of the
container images (RIZ-046 must include them in its SBOM). OpenFGA itself is Apache-2.0 and
runs as a separate service.

## Unverified

- **Trademark**: no trademark search was run. "riz" is a short common word and the name of
  at least two unrelated software projects. Check USPTO/EUIPO classes 9 and 42 before v1.0.
- **`@riz` npm scope**: an empty `npm search` and a 403 from npmjs.com do not prove the
  scope is free. Create the `riz` npm org (or confirm ownership) before RIZ-045. If it
  cannot be claimed, fall back to an unscoped `riz-sdk`.
- **Names agreed** by the maintainer (2026-11-01): `@riz/sdk` and `riz-sdk`. Nothing is
  published yet; claiming the scope and PyPI name happens in RIZ-045.
