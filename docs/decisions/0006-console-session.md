# 0006 — Console login and session

## Decision

The console is a server-rendered SvelteKit app. It logs users in with the OIDC
**authorization-code flow with PKCE (S256)**, state and nonce, and verifies the ID token
(signature, issuer, audience, expiry, nonce) with `jose`.

- The browser holds only an opaque, random, `httpOnly`, `SameSite=Lax`, `Secure` (except on
  `localhost`) session cookie. The access token lives in the console server's memory and is
  forwarded as `Authorization: Bearer` to the riz API (`apiJson`). It is not in page data,
  cookies, or logs; token-endpoint error bodies are never put in errors.
- Every route except `/login` and `/auth/callback` redirects to `/login` without a session.
- Every non-GET request must carry this console's own `Origin` (covers JSON as well as the
  form posts SvelteKit checks itself). Responses are `Cache-Control: no-store`.
- The console never talks to OpenFGA or Postgres, and makes no authorization decision of
  its own: what a user may see or do is whatever the API returns (403/404).

Configuration: `RIZ_API_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, and
optionally `OIDC_CLIENT_SECRET`, `OIDC_AUDIENCE`.

## Limits

- Sessions are in memory (`shortcut:` single replica, lost on restart); a session ends at
  the ID token's expiry and there is no refresh.
- **The API cannot yet authenticate a user's token as an administrator.** In
  `RIZ_AUTH_MODE=oidc` every verified token gets only the `check` scope (ADR 0004), so a
  console login against the current API reaches pages but every admin call is 403. The
  console is tested against a mock OIDC provider and a stubbed API; login against a real
  IdP and the real API is **unverified**.
