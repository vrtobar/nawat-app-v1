# Nawat

_An interactive dictionary and learning companion._

A language learning app for Nawat — a critically endangered indigenous
language of El Salvador with roughly 100 remaining speakers.

## Note

This repository is the first version of the project and is no longer developed.
It documents the original architecture — AWS ECS and Fargate, Terraform, and
authentication built in-house — which remains valid as a reference
implementation. Development has since moved to a separate codebase.

The reasoning is in
[ADR 23](docs/adr/0023-retiring-the-first-implementation.md).

## About

This project aims to make learning Nawat accessible through an interactive,
gamified experience — preserving the language for future generations.

**On the spelling.** "Nawat" is the orthography the revitalization movement in
El Salvador standardised on, and it is what this project uses everywhere it is
read — the language, the title, this repository. The domain and the
infrastructure keep the older and more widely recognised "Nahuat" —
`nahuat.com` and the AWS resource names — because the domain is registered and
live, and its recognisability is worth something to a project that wants to be
found by people searching the older form. The rule and the reasoning behind it
are in
[ADR 14](docs/adr/0014-nawat-for-the-language-nahuat-for-the-project.md).

## Tech Stack

| Layer          | Technology                               |
| -------------- | ---------------------------------------- |
| Frontend       | Next.js 16, Tailwind CSS, shadcn/ui      |
| Backend        | NestJS, TypeScript                       |
| Database       | PostgreSQL 16, Prisma                    |
| Cache          | ElastiCache (Valkey)                     |
| Infrastructure | AWS, Terraform                           |
| Auth           | Auth.js + Google, tokens issued in-house |

## Development

Setup and the local gotchas worth knowing are in
[docs/local-development.md](docs/local-development.md).

Architecture decisions — what was chosen, what was rejected, and why — are in
[docs/adr/](docs/adr/README.md).

## Status

**Retired.** Version 1 is complete and archived. Everything described here —
authentication, the dictionary, the media pipeline and the delivery pipeline —
was built and ran in both environments. Flashcards and the learning hierarchy
were not built; see [ADR 22](docs/adr/0022-dictionary-and-flashcards-as-the-first-product.md)
and [ADR 23](docs/adr/0023-retiring-the-first-implementation.md).

## Licensing

**Application code** is licensed under the [MIT License](LICENSE).

**Language content** (dictionary entries, translations, audio recordings)
is licensed under [CC BY-NC 4.0](LICENSE-CONTENT). Freely available for
research, education, and community use. Commercial use requires permission.
