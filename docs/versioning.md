# Versioning and releases

## Versions

One version number, `vX.Y.Z`, covers everything released together: the `@riz/sdk` npm
package, the `riz-sdk` Python package (still named `riz` in its manifest until RIZ-045
renames it; see ADR 0010), and the API and console container images. It follows
[SemVer](https://semver.org/). Before `1.0.0`, minor releases may include breaking changes;
they are called out in `CHANGELOG.md`.

## HTTP API

- The API is versioned in the path (`/v1/...`). Within a major version we only make
  compatible changes: new endpoints, new optional request fields, new response fields.
  Clients must ignore response fields they do not know.
- A breaking change ships under a new path prefix (`/v2`), and `/v1` keeps working beside it.
- **Deprecation**: a deprecated endpoint or field is announced in `CHANGELOG.md` in the
  release that deprecates it, and is removed no sooner than six months and one minor release
  later, and only in a new major version.
- The authorization model is versioned separately, as migrations (see ADR 0002 and 0005).

## Release artifacts

Pushing a stable tag such as `v1.2.3` runs `.github/workflows/release.yml` (pre-release tags
like `v1.2.3-rc1` do not trigger it). The tagged commit must be on `main`, or the run fails.
The workflow does not run tests itself: tag only a commit whose CI on `main` is green. For
the API and console images it:

1. builds from the tagged commit with the base image pinned by digest and layer timestamps
   fixed to the commit time (`SOURCE_DATE_EPOCH`);
2. pushes to `ghcr.io/<owner>/riz-api` and `ghcr.io/<owner>/riz-console` with an SBOM and
   max-mode provenance attached;
3. signs each image digest with keyless [cosign](https://docs.sigstore.dev/). The SBOM and
   provenance are BuildKit attestations attached to the image, not separately signed.

Verify an image:

```
cosign verify ghcr.io/<owner>/riz-api:<version> \
  --certificate-identity-regexp '^https://github.com/<owner>/<repo>/\.github/workflows/release\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Limits

- The release workflow has not been run: it is **unverified** until the first tag is pushed.
- Bit-for-bit reproducibility is not verified. Timestamps and base image are pinned, but
  `apk` and `pnpm` network fetches are not otherwise locked; rebuild twice and compare
  digests before claiming it.
- SDK packages are not published by this workflow (RIZ-045).
