# Verification record

## Server rendering review, November 22, 2026

All six App Router pages returned HTTP 200 with their route-specific title, description and primary heading when JavaScript was disabled. The initial HTML included all 78 deck entries, the reading and account forms, and an anonymous loading state for the journal. The server bundle excludes Firebase Auth and Firestore. The browser loads Firestore when a verified account opens its journal.

TypeScript and the production build passed. The build included 137 required offline assets. All 214 unit tests, 11 service-worker tests, 90 browser tests, the deployment-update test and 81 Firebase emulator integration tests passed.

## Vercel build, November 22, 2026

A local Linux build using Vercel’s Next.js adapter produced six SSR functions. Each served HTML and a React Server Component response for its route. All 129 entries in the service worker’s cache manifest matched the packaged files by SHA-256, including all 78 card illustrations and both offline responses for each route.

## Next.js App Router migration, November 22, 2026

The production build renders all six application routes on demand. With JavaScript disabled, direct requests show the reading form, all 78 deck entries, the journal heading and each account form. Browser authentication and journal restoration run after hydration.

- TypeScript, 214 Vitest tests and nine generated service worker tests passed.
- All 90 Playwright checks passed across desktop Chromium, mobile Chromium and mobile WebKit. The separate deployment-update test also passed.
- The production worker verifies 131 offline assets. A browser kept its unsaved draft while navigating offline and restored saved readings across a deployment update.
- All 44 Firebase SDK integration scenarios and 37 account UI workflows passed against the local Auth and Firestore emulators.
- The packaged Node.js release served the deck over HTTP and supplied every asset with its expected digest.

## Earlier Vite build, November 19, 2026

Verified locally on Windows on November 19, 2026. Mobile checks used browser emulation.

## Passed automated checks

- `npm run build`: TypeScript check, all 78 illustration checks, Vite production compilation, and generation of the content-versioned service worker succeeded. All 87 required runtime assets are included in the offline cache manifest.
- `npm run format:check`: all source and documentation files passed formatting checks.
- `npm test`: 68 Vitest tests and 7 generated-worker tests passed (75 total).
- `npm run test:browser`: 33 Playwright tests passed across desktop Chromium, Chromium with an iPhone 13 viewport, and WebKit with an iPhone 13 viewport.
- `npm run test:update`: 1 Chromium deployment-update workflow passed using a separate test-only server.

The algorithm tests use controlled Web Crypto samples only in test code. They check exact rejection boundaries and all six valid Fisher–Yates choice sequences for a three-card deck, rather than using a small frequency experiment as evidence of fairness.

Reading workflows confirm complete results are saved before reveal; identities, order, orientations, and reveal state survive details, rerenders, history navigation, and reloads. Synchronous duplicate submissions and rapid double clicks produce one reading. New Reading explicitly unlocks a new draw, including after deleting the active reading. Default upright mode and independent optional reversals are covered. Missing secure randomness and storage/clipboard failures are covered.

The browser tests used the actual compiled production application and actual browser Web Crypto. They verified offline reloads, new offline draws, saved readings and meanings offline, detection of an evicted cache entry, repair after reconnection, manifest/icons, no third-party runtime requests, 320/375/430px viewport widths without horizontal page overflow, ten-card layouts, and reduced-motion handling. All 78 illustrated cards decoded successfully from the offline cache at 768 × 1152 pixels in each browser project. Long card captions remained unclipped and upright at 200% text size on a 320px screen. Desktop and mobile screenshots were inspected, including settled card flips and readable labels.

The complete optimized illustrated deck is 14.51 MiB. Each generated scene was visually reviewed against its Rider–Waite–Smith source; corrections were made where needed. These are stylized adaptations, with modest drapery on selected traditionally nude figures. File validation checks dimensions, completeness, duplicate bytes, matching production files, and service-worker inclusion; those structural checks alone do not establish visual accuracy.

Deck library checks covered all 78 entries, search combined with suit filtering, both meanings in a card dialog, and returning to a partially revealed reading. Browsing used zero random samples. Mobile browser tests opened a card and read its meanings offline after a reload. Direct visits and online and offline refreshes on `/deck` and `/journal` restored the matching page. Back and Forward dismissed open dialogs and preserved the exact saved spread and reveal state.

The update test verified that two open app windows keep an update waiting, the active page does not reload, the complete reading stays unchanged, the new worker activates only after both windows close, and the same saved reading reopens afterward. Old-version cache cleanup was also checked.

The service-worker harness additionally checks hash-verified installation, incomplete cache rejection, substituted response bodies, cache preservation after installation failure, and content-dependent version changes.

## Remaining device checks

Desktop WebKit emulation is not iPhone Safari certification. On your physical iPhone, follow the README checklist for Safari and Home Screen installation, actual safe areas and text zoom, VoiceOver, iOS clipboard handling, and a cold launch in Airplane Mode after the installed app reports offline readiness. These need your device and deployed HTTPS address.

No frequency-balance requirement, repeat suppression, physical randomness verification, or quantum randomness claim is made.
