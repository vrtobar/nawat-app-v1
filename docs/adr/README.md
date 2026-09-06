# Architecture decision records

Short documents recording decisions that were not obvious, together with what
was rejected and why. They exist so a decision can be re-argued later against
the reasoning that produced it, rather than rediscovered.

An ADR is written when a choice has consequences a reader would otherwise have
to reverse-engineer from the code — particularly security boundaries, and
places where two systems share ownership of one resource. Routine choices do
not get one.

They are not updated as the code changes. A decision that is superseded gets a
new record and the old one is marked as such, so the history stays readable.

**This repository is retired and these records are closed** — see
[ADR 23](0023-retiring-the-first-implementation.md). They describe what was
decided at their dates and will not be revised.

Records 3 through 8, and 10 onward, were written after the fact, from the code
and from the decisions' own history. They carry the date of the decision
alongside the date of the record.

| #                                                            | Title                                                     | Status                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [1](0001-ci-iam-boundaries.md)                               | CI/CD IAM boundaries                                      | Accepted                                                                          |
| [2](0002-immutable-image-tags.md)                            | Immutable image tags, and who owns a task definition      | Accepted                                                                          |
| [3](0003-terraform-layer-split.md)                           | Three Terraform layers, split by destroy safety           | Accepted                                                                          |
| [4](0004-cloudfront-origin-and-failover.md)                  | CloudFront origin, TLS, and the maintenance page          | Accepted                                                                          |
| [5](0005-auth0-tenant-separation.md)                         | One Auth0 tenant per environment                          | Superseded by [18](0018-own-authentication-google-only.md)                        |
| [6](0006-arm64-everywhere.md)                                | ARM64 (Graviton) across the whole stack                   | Accepted                                                                          |
| [7](0007-database-connectivity-and-migrations.md)            | Database connectivity and migration execution             | Accepted                                                                          |
| [8](0008-rest-resource-shape.md)                             | Shallow-nested REST resources                             | Accepted                                                                          |
| [9](0009-per-environment-certificates.md)                    | One TLS certificate per environment                       | Accepted                                                                          |
| [10](0010-zod-as-the-payload-contract.md)                    | Zod schemas as the only payload contract                  | Accepted                                                                          |
| [11](0011-polyglot-workers-and-packaging.md)                 | Polyglot queue consumers, packaged as containers          | Partly superseded by [19](0019-asynchronous-tier-anchored-on-media-processing.md) |
| [12](0012-migration-composition-and-index-ownership.md)      | Migration composition and index ownership                 | Accepted                                                                          |
| [13](0013-authentication-and-authorization.md)               | Authentication and authorization model                    | Accepted                                                                          |
| [14](0014-nawat-for-the-language-nahuat-for-the-project.md)  | Nawat for the language, Nahuat for the project            | Accepted                                                                          |
| [15](0015-localized-content.md)                              | Localized content: storage, naming, resolution            | Accepted                                                                          |
| [16](0016-dictionary-entry-slugs.md)                         | Dictionary entry slugs                                    | Accepted                                                                          |
| [17](0017-production-disposable-during-prelaunch.md)         | Production is disposable during pre-launch                | Accepted                                                                          |
| [18](0018-own-authentication-google-only.md)                 | Authentication in-house, Google as the only provider      | Accepted                                                                          |
| [19](0019-asynchronous-tier-anchored-on-media-processing.md) | The asynchronous tier, anchored on media processing       | Accepted                                                                          |
| [20](0020-media-assets-provenance-and-the-approval-gate.md)  | Media assets: provenance, state, and the ADMIN gate       | Accepted                                                                          |
| [21](0021-the-public-read-path.md)                           | The public read path: topology, caching, anonymous access | Accepted                                                                          |
| [22](0022-dictionary-and-flashcards-as-the-first-product.md) | Dictionary and flashcards as the first product            | Accepted                                                                          |
| [23](0023-retiring-the-first-implementation.md)              | Retiring the first implementation                         | Accepted                                                                          |
