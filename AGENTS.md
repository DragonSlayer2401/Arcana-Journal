# Agent entry guide

## Project overview

Arcana Journal is a Next.js App Router application for tarot readings, deck browsing, and private
journaling. It uses React, TypeScript, SCSS, and Firebase Authentication and Firestore. Guests can
use the journal offline. Verified accounts can sync readings across devices.

Use npm with the checked-in `package-lock.json`. Install dependencies with `npm ci`.
Vitest and Testing Library cover feature behavior. Node’s test runner covers the service worker and
Firebase emulator scenarios. Playwright checks the production app in desktop and mobile browsers.
Prettier owns formatting.

## General rules

- Follow direct user instructions over repository guidance. These rules apply throughout the repo;
  check for more specific `AGENTS.md` instructions in directories you work on.
- Edit files only when the user requests implementation or file changes. Investigation, review,
  brainstorming, and planning are read-only unless the user also authorizes edits.
- Inspect the working tree before editing. Preserve unrelated local changes; do not revert,
  overwrite, or reformat them. Do not commit, push, open PRs, or change Git history unless requested.
  Do not run destructive commands unless the user explicitly requests them.
- Read the relevant code and documentation before choosing an approach. Keep changes within the
  requested scope and preserve behavior and structure unless the task requires changing them.
- Search existing code for reusable behavior. Choose its owner using the architecture standard.
- Keep UI semantic and keyboard accessible, meeting WCAG 2.2 AA. Preserve server/client boundaries
  and never expose credentials or sensitive data in source, logs, or reports.
- Protect saved readings, journal backups, and account history. Use isolated browser storage for
  tests and the local Firebase emulators for cloud verification.
- Clarify ambiguous requirements before risky or broad changes. Explain material concerns and
  recommend a better approach before implementing a problematic proposal.

## Documentation routing

Keep one file per standard under `docs/`. Group project layout and feature ownership under
`docs/architecture/`. Keep the coding, services, and testing guides at the top level of `docs/`.

Read the standard that matches the task alongside the affected implementation and tests. For topics
without a standard yet, inspect the relevant code and configuration.

| Work                                                                             | Standard                                                                     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Choosing a top-level folder for project code                                     | [Project folder layout](docs/architecture/architecture.md) (in review)       |
| Writing or reviewing functions, identifiers, or filenames                        | [Coding standards](docs/coding.md) (in review)                               |
| Defining features and sub-features or choosing where shared feature code belongs | [Feature structure and ownership](docs/architecture/features.md) (in review) |
| Adding or changing API endpoints, uncached requests, or API helpers              | [APIs and services](docs/services.md) (in review)                            |
| Writing, organizing, or reviewing automated tests                                | [Automated feature tests](docs/testing.md) (in review)                       |

For setup commands, consult the root README and `package.json` as needed. Write standards for the
intended refactor using illustrative examples such as Weather. Use the current implementation to
verify claims about existing behavior and to trace consumers during a migration.

## Handling conflicts

- Documentation defines intended standards and contracts; code and tests show current behavior.
  When they disagree, report the discrepancy and determine whether it is stale guidance, a defect,
  or an intentional exception. Do not silently treat either as permission for a broader rewrite.
- Use current configuration to verify tooling and commands. Treat dated investigations, verification
  reports, and archived policy sections as historical evidence, not automatically as current rules.
- If a conflict leaves the requested behavior or safe scope unclear, ask before the affected change.
  Continue independent work that is already authorized.
- When an authorized change alters a documented contract, update its owning document within scope.
  Keep documentation routes current when documentation is added or moved. Do not reorganize unrelated
  documentation as part of a code change.

## Completion requirements

- Check the final diff against the request and preserve unrelated work.
- Run the owning tests after behavior changes, then `npm test`, `npm run typecheck`,
  `npm run format:check`, and `npm run build`. Verify UI changes at desktop and mobile sizes.
  See the README for browser, offline-update, and Firebase emulator commands. Report targeted tests,
  full regression, formatting, build, and applicable browser or data checks separately. Identify
  anything not run and why.
- For documentation-only changes, verify claims, linked files and headings, and formatting. Runtime
  tests, builds, and browser checks are unnecessary unless executable behavior also changes.
- Summarize what changed, why, verification results, and unresolved issues. Respect requested review
  checkpoints before proceeding to another phase.
