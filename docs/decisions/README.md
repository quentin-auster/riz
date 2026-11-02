# Architecture decisions

| # | Decision | Read it for |
| --- | --- | --- |
| [0001](0001-store-isolation.md) | Store isolation and cross-application role strategy | Why each application has its own OpenFGA store |
| [0002](0002-model-pinning.md) | Model versioning and pinning | Why requests never resolve "latest model" |
| [0003](0003-end-user-delegation.md) | Delegated end-user identity | How a workload checks on behalf of a verified user |
| [0004](0004-admin-authorization.md) | Authorizing riz's own administration | The `riz-admin` store and admin roles |
| [0005](0005-model-lifecycle.md) | Versioned model lifecycle | Validate, bind and roll back a model |
| [0006](0006-console-session.md) | Console login and session | Why the console is a single replica |
| [0007](0007-databricks-provider.md) | Databricks as a data provider | Keeping Unity Catalog grants out of riz |
| [0008](0008-observability.md) | Metrics and tracing | What is emitted and what is never recorded |
| [0009](0009-multi-replica.md) | Multi-replica deployment | Why API replicas are interchangeable |
| [0010](0010-license-name-dependencies.md) | License, name, and dependency review | Apache-2.0, package names, dependency licenses |

Add a record for every significant architectural decision (`NNNN-short-name.md`, next number)
and a row here.
