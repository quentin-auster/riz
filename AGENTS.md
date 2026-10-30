# AGENTS.md — riz Engineering Instructions

## Mission
Build riz as a minimal, secure, extensible organization-wide authorization control plane.
Use OpenFGA for relationship-based authorization. Do not implement a new policy engine.

## Architecture
- apps/api: TypeScript, Node.js, central HTTP API
- apps/console: SvelteKit administrative frontend
- sdks/python: Python SDK
- sdks/typescript: TypeScript SDK
- models/openfga: Version-controlled authorization models
- contracts: Shared API contracts
- deploy: Local and production deployment configurations

The SDKs call the riz API. The riz API uses OpenFGA to evaluate application permissions.
Data-provider adapters must preserve native source authorization. Do not copy source-system
privileges into OpenFGA as a substitute for native enforcement.

## Engineering Principles
1. Prefer the smallest implementation that meets the current milestone.
2. Use established libraries only when they eliminate meaningful complexity.
3. Do not introduce new infrastructure without an explicit requirement.
4. Do not duplicate OpenFGA policy evaluation logic.
5. Keep business logic out of route handlers.
6. Use strict typing and explicit error handling.
7. Use shared contracts and cross-language conformance tests.
8. Never trust user identities supplied in unverified request bodies or headers.
9. Never silently substitute privileged service credentials for user credentials.
10. Deny protected operations if authorization is unavailable or indeterminate.
11. Treat authorization model changes as versioned migrations.
12. Require authorization and auditing for permission mutations.
13. Keep SDKs thin and stateless wherever practical.
14. Avoid unnecessary compatibility abstractions before a second implementation requires them.
15. Document every significant architectural decision.

## Work Procedure
For each milestone:
1. Read existing contracts, relevant code, and tests.
2. Identify the smallest implementation satisfying acceptance criteria.
3. Implement the production code.
4. Add or update unit and integration tests.
5. Run linting, type checks, and tests.
6. Verify no security regression or accidental API change.
7. Update documentation.
8. Report implemented files, tests, limitations, and remaining work.

Do not implement future milestones speculatively.
Do not invent credentials, enterprise configurations, or successful integration-test results.

## Security Requirements
- Authenticate callers and bind end-user identities securely.
- Scope every application to approved OpenFGA stores and models.
- Use least-privilege credentials.
- Separate check permissions from administrative mutation permissions.
- Fail closed on authorization outages.
- Never log access tokens or protected data.
- Preserve user-scoped Databricks authorization.
- Add negative permission tests for every new authorization feature.

## Completion Criteria
A milestone is complete only when its acceptance tests pass and the documented interface works
from a clean local environment.
For changes requiring external enterprise systems, complete local contract tests and clearly mark
external integration tests as unverified until run against actual authorized infrastructure.
