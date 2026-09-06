# 23. Retiring the first implementation

- **Status:** Accepted
- **Date:** 2026-09-06
- **Applies to:** the repository as a whole
- **Depends on:** [ADR 22](0022-dictionary-and-flashcards-as-the-first-product.md)
  for the scope this record closes, [ADR 17](0017-production-disposable-during-prelaunch.md)
  for the disposable-production model that makes stopping inexpensive

## Context

This codebase is complete in one direction and unstarted in the other, and the
gap between them is what this record is about.

**What exists is infrastructure and the machinery around it.** Authentication
issued in-house against Google, with rotating refresh tokens and reuse
detection. A request pipeline with Zod at every boundary, a uniform envelope,
correlation ids and ranked role guards. The dictionary — entries, dialects,
translations, accent-insensitive trigram search — and an admin editor with an
optimistic lock. Export and restore. An asynchronous tier: a queue, a Python
consumer on Lambda performing loudness normalisation and image rendition
ladders, and a reaper. A delivery pipeline deploying both environments from CI
on immutable per-commit tags, with production behind a required reviewer. Two
dozen architecture decisions, 384 unit tests and 17 integration tests against a
real database.

**What does not exist is the product.** Flashcards were never built. The
learning hierarchy was removed by
[ADR 22](0022-dictionary-and-flashcards-as-the-first-product.md) and never
returned. Most consequentially, **the reader-facing application was never
designed** — not deferred, not partly built, but never specified at all.
[ADR 21](0021-the-public-read-path.md) settles the topology that would serve a
reading experience without anything settling the experience itself. What a
learner does on this site has no answer in any document here.

**The ordering is the problem, not the quality of either half.** The
architecture was chosen before the product it serves was defined, and each
decision was sound given what was known when it was made. But the accumulated
result is a large operational surface — a NAT gateway, a load balancer, two
Fargate services, RDS, ElastiCache, a queue and a Lambda, three Terraform
layers, and a release procedure requiring a human `terraform apply` — standing
behind a dictionary whose reading experience is a placeholder page.

Continuing from here means designing the product inside an architecture picked
before the product was known. That constrains the part that is uncertain in
order to preserve the part that is already settled, which is the wrong way
round.

**Nothing is in production to preserve.** Production serves no content, both
environments are torn down between sessions under
[ADR 17](0017-production-disposable-during-prelaunch.md), and the dictionary
content that exists is authored separately and imported. There is no running
system, no user data, and no migration to perform. Stopping costs only the code.

## Decision

- **Development on this repository ends.** It is archived, read-only, and kept
  public. No further features, dependency updates or infrastructure changes.
- **The next version starts from an empty repository**, scoped to one goal:
  the best application for learning Nawat. The stack is chosen to serve that
  goal rather than inherited from this one.
- **The decision records are the durable output and stay published.** The
  architecture documented here was built, deployed and exercised in two
  environments; it remains valid as a reference implementation, and the
  reasoning is more useful than the code.
- **What carries forward is the domain, not the infrastructure.** The content
  model — entries, dialects, translations, locale-parallel columns, slugs as
  canonical identity — was validated against real use and real content.
  [ADR 14](0014-nawat-for-the-language-nahuat-for-the-project.md) on
  orthography, [ADR 15](0015-localized-content.md) on English as a first-class
  learner language, [ADR 16](0016-dictionary-entry-slugs.md) on slugs, and
  [ADR 13](0013-authentication-and-authorization.md) on resolving identity per
  request rather than stamping it into a token are decisions about the problem,
  and they survive a change of stack.
- **The media pipeline's findings carry forward as findings**, not as code:
  that loudness normalisation must follow the channel downmix rather than
  precede it, that an end-to-end run proves the path and not the transform, and
  that publication is better modelled as moving an object between storage
  prefixes than as setting a flag
  ([ADR 20](0020-media-assets-provenance-and-the-approval-gate.md)).

## Consequences

- **The records stop being maintained and start being history.** Every ADR here
  describes what was decided at its date. None will be revised, and a superseding
  decision made in the next version will not appear in this repository.
- **The infrastructure decisions are the least transferable part.** Self-hosting
  on ECS Fargate ([ADR 6](0006-arm64-everywhere.md),
  [ADR 3](0003-terraform-layer-split.md)) was chosen deliberately and worked, but
  its cost-to-benefit is exactly what changes when the goal narrows to the
  learning experience. A reader should take the reasoning and re-run it against
  their own constraints rather than adopt the conclusion.
- **The AWS resources outlive the repository.** The global Terraform layer owns
  a hosted zone, a wildcard certificate, three ECR repositories and the CI roles,
  none of which are destroyed by archiving this repository. Their disposition is
  an operational decision separate from this record.
- **The CI roles lose their caller.** The OIDC trust policies name this
  repository by its immutable numeric id, so archiving stops the workflows that
  assume them; the roles remain until removed deliberately.
- **The unfinished work stays unfinished and visible.** Flashcards, the learning
  hierarchy, monitoring, rate limiting and OpenAPI are specified in places and
  absent in the code. That gap is part of what the repository records.

## Alternatives considered

- **Continue here and design the reader experience in place.** Rejected: the
  product design is the open question, and answering it inside an architecture
  chosen before the question was asked adds a constraint that buys nothing. The
  infrastructure is the part that is finished; it is not the part that needs
  protecting.
- **Rewrite incrementally, replacing pieces within this repository.** Rejected
  because there is nothing to migrate. Incremental replacement earns its cost by
  keeping a running system available throughout; no system is running, no data is
  at risk, and the ceremony would be paid for a benefit that does not exist here.
- **Keep the repository private, or delete it.** Rejected: the decision records
  answer questions that are not answerable from the code alone, and a
  reference implementation that was actually deployed is worth more published
  than withheld.
- **Carry the infrastructure forward and rebuild only the application.**
  Rejected: it presumes the same deployment model suits a product that has not
  been designed yet, which is the specific mistake this record exists to stop
  repeating.
