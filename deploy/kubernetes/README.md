# Kubernetes manifests

Stateless API replicas and a single console, for a cluster that already has Postgres and
OpenFGA. Those two are external dependencies and are not managed here.

| File | Holds |
| --- | --- |
| `namespace.yaml` | the `riz` namespace |
| `api.yaml` | API config, Deployment (2 replicas), Service, PodDisruptionBudget, example HPA |
| `console.yaml` | console config, Deployment (1 replica), Service |

Probes: the API's liveness is `/health/live` (no dependencies) and readiness is
`/health/ready` (Postgres and OpenFGA), so an outage drains pods instead of restarting them.
The console has no health route and uses TCP probes.

## Before applying

1. Edit the placeholders in the two ConfigMaps: `OPENFGA_API_URL`, `RIZ_OIDC_ISSUERS`, and
   the console's `OIDC_*` values. Hosts ending in `.invalid` are placeholders.
2. Build and publish the images (`deploy/api.Dockerfile`, `deploy/console.Dockerfile`) and
   change the `image:` fields, or load local ones as below.
3. Create the secrets. Nothing secret is committed:

```
kubectl create namespace riz
kubectl -n riz create secret generic riz-api --from-literal=database-url='postgres://riz:<password>@<host>:5432/riz'
kubectl -n riz create secret generic riz-console --from-literal=oidc-client-secret='<secret>'
```

Run `pnpm --filter @riz/api migrate` (or let the first replica start; replicas serialize
migrations with a lock) against the database before sending traffic.

## Apply on a local kind cluster

```
docker build -f deploy/api.Dockerfile -t riz-api:local .
docker build -f deploy/console.Dockerfile -t riz-console:local .
kind create cluster --name riz
kind load docker-image riz-api:local riz-console:local --name riz
kubectl apply -f deploy/kubernetes/namespace.yaml
kubectl apply -f deploy/kubernetes/
kubectl -n riz rollout status deploy/riz-api
```

From kind on Docker Desktop, Postgres and OpenFGA published on the host are reachable as
`host.docker.internal`; use that in `database-url` and `OPENFGA_API_URL`.

## Status

- Schema validity is checked by kubeconform in CI.
- Applying to kind is **unverified**: it has not been run, and the placeholders must be set
  to real dependencies for the pods to become ready.
- The HPA needs a metrics-server, which kind does not ship.
- The console's in-memory sessions (ADR 0006) are why it is one replica.
