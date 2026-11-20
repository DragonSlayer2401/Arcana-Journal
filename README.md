# Arcana Journal

A tarot PWA built with React, TypeScript, and Vite. It includes 78 illustrated Rider–Waite–Smith scenes, upright and reversed meanings, one-card/three-card/custom spreads, and individual reveals. Guests keep a journal on their device. An optional account syncs readings across browsers and devices. Three cards and upright-only draws are the defaults.

Open **Deck** to browse all 78 illustrations by Major Arcana or suit. Search by card name and tap a card to read both its upright and reversed keywords and meanings. The library works offline once the app reports offline readiness.

Reading (`/`), Deck (`/deck`), and Journal (`/journal`) each have their own URL. Refresh or bookmark any page, or move between pages using browser Back and Forward. After offline setup, the service worker serves the app at each URL. On a fresh online visit, Cloudflare Pages serves the app using its [single-page application routing](https://developers.cloudflare.com/pages/configuration/serving-pages/#single-page-application-spa-rendering).

Cloudflare serves the static build. Firebase Authentication handles optional email/password accounts, and Cloud Firestore stores each account's journal. Draws and card illustrations work on the device. The Firebase Spark plan covers these services within its free quotas.

## Run it

Install [Node.js](https://nodejs.org/) 22.12 or later (Node 24 LTS is suitable), then open a terminal in this folder:

```sh
npm ci
npm run dev
```

Open the local address printed by Vite. A fresh checkout without a lockfile can use `npm install`; the delivered project includes a lockfile, so prefer `npm ci`.

```sh
npm run typecheck
npm run format:check
npm test
npm run build
npm run preview
```

`npm run build` checks TypeScript and the full illustrated deck, creates `dist`, generates the versioned service worker, and verifies that all 78 images are included in its cache manifest. **Deploy the entire resulting `dist` folder.** Running `vite build` directly omits these checks and the service-worker generation step. `npm run dev` intentionally does not install a service worker; use the production preview to test offline behavior.

The generated worker also has a focused, dependency-free lifecycle harness:

```sh
node --test scripts/test-sw.mjs
```

It checks complete-asset readiness, offline navigation, cache repair, rejected substituted content, version changes, and safe update activation. It builds temporary fixtures without changing the project's `dist` directory.

For browser automation:

```sh
npx playwright install chromium webkit
npm run test:browser
npm run test:update
```

Build first with `npm run build`. The browser suites start their own local production servers. The main suite uses Chromium and WebKit, with desktop and iPhone viewport emulation. The update suite uses a test-only server to simulate a deployment; no update test switches ship in the app. These are desktop browser checks, not a physical iPhone test.

## Random selection

`src/domain/random.ts` contains the selection code and does not import the UI or card meanings. Its only entropy source is `globalThis.crypto.getRandomValues()`. The optional question is journal text; it is never passed to the draw function.

For each integer bound `n`, the implementation validates an integer in `[1, 2 ** 32]`, reads an unsigned 32-bit value, and calculates:

```ts
const limit = Math.floor(2 ** 32 / n) * n;
// Keep reading until value < limit.
return value % n;
```

Rejection eliminates modulo bias. This uses ordinary JavaScript numbers, without truncating `2 ** 32` through bitwise arithmetic. Each reading makes a fresh copy of all 78 IDs, applies one Fisher–Yates shuffle using those unbiased bounded integers, and takes the requested 1–10 cards. Cards cannot repeat inside a spread. Across readings, repeats—including an identical full spread—are allowed. Nothing balances outcomes or favors a suit, arcana, or meaning.

Reversals are disabled by default. If enabled, every selected card receives a separate unbiased `secureRandomInt(2)` orientation decision. The draw event stores the complete identities, order, and orientations before any reveal. Reveal, detail, history, and reload operations reuse that saved result. New draws require the explicit New Reading action; rapid taps are guarded synchronously. If Web Crypto is missing or fails, the application reports an error without a weaker fallback.

The accurate description is **cryptographically secure random draws with unbiased shuffling**. This is not a claim of independently verified physical or quantum randomness. Tests exercise the algorithm with controlled entropy, not a frequency simulation or artificially even results. Production exposes no test entropy switch.

## Data and artwork

`src/data/deck.ts` includes all 22 Major Arcana and 56 Minor Arcana: Wands, Cups, Swords, and Pentacles, each Ace–Ten, Page, Knight, Queen, King. IDs are stable and unique. Meanings use original concise wording summarizing traditional associations, with distinct fixed upright and reversed entries.

All 78 card faces are bundled locally as 768 × 1152 WebP illustrations in `public/cards/`, keyed by the stable card IDs. They reinterpret the public-domain Rider–Waite–Smith scenes by Pamela Colman Smith in the user's supplied visual direction: angular forms, jewel tones, flowing patterns, and painted texture. They were created ahead of time with the built-in image-generation tool. There is no runtime image generation, interpretation service, API key, or extra fee to use these bundled images. Each card's complete portrait is visible; reversed artwork rotates while names and meanings stay upright. Original symbolic SVG artwork remains available as a defensive loading fallback.

The source/license record is `art/references/sources.json`, and generation prompts are retained in `art/generated/*.prompt.txt`. The user's style reference and full-resolution working images are kept outside `public/` and are excluded from release archives. See `ASSETS.md`, `art/STYLE.md`, and `LICENSE` for provenance and reuse details. Dependency licenses remain their respective authors' licenses.

## Journal accounts and backups

Open **Journal** to create an account or sign in. New accounts use the guest journal on this device until you open the verification email and choose **Check verification**. Once verified, new readings sync to your account. Select the trusted-device option at sign-in to keep cached account readings and pending changes through a browser restart. On a shared device, keep this option off and wait for changes to sync before closing the tab or signing out.

Guest journals stay in the browser profile and site address that created them. To sync existing readings, including those drawn while awaiting verification, open the verified account on that device, choose **Import this device’s journal**, review the destination email and counts, and confirm. The original guest readings remain available when signed out. If Safari and the installed Home Screen app contain different readings, repeat the import in each. Keep the current production address when deploying an update.

**Export journal** downloads a versioned JSON file with every reading in the selected journal, including its original date, question, ordered cards, orientations, and reveal progress. Account export needs a connection to fetch all pages. Choose **Import journal** to preview and merge a backup. Repeating an import preserves previous entries and combines reveal progress. Older readings with matching IDs and different spreads or questions are preserved individually. Anyone with access to a backup can read it. **Copy Reading** shares one spread as readable text.

Deleting a guest reading affects this browser only. Deleting an account reading syncs the deletion to the account’s devices. Guest storage and trusted offline caches can be lost when someone clears browser data.

### Firebase setup for this deployment

The app uses the Firebase project `arcana-journal`. Enable **Email/Password** under Authentication, authorize `arcana-journal.jacobskip7.workers.dev` for email redirects, and create the **Standard** Firestore database with ID `(default)` in production mode. The web configuration ships with the app. The rules in `firestore.rules` require a verified email and restrict access to the account that owns the readings.

Before enabling accounts on the live site, publish the rules in **Firestore → Rules**, or use the Firebase CLI from this directory while signed in to the project.

```sh
firebase deploy --only firestore:rules --project arcana-journal
```

The account and security-rule integration tests run against local emulators in a Chromium browser. With the Firebase CLI, Java 21, and the Playwright Chromium browser installed, run:

```sh
firebase emulators:exec --only auth,firestore --project demo-arcana-journal "npm run test:cloud"
```

Build with `npm run build` and publish `dist` to the existing Cloudflare Workers static-assets deployment at [Arcana Journal](https://arcana-journal.jacobskip7.workers.dev). The Pages instructions below apply to new Pages installations.

## Offline behavior and updates

`scripts/build-sw.mjs` enumerates the actual built assets and derives the cache version from their paths and contents. The worker caches the application shell, compiled code, styles, card data/artwork, manifest, and icons. Each downloaded asset's SHA-256 digest must match the build before installation succeeds. `src/pwa.ts` asks the controlling worker to confirm that every required cache entry is present before the interface reports offline readiness. A missing or failed asset does not produce a ready status. Readiness is rechecked when the app regains focus or comes online.

After **Ready for offline use** appears, guests can draw, reveal, and revisit saved readings offline. Trusted-device accounts can use cached readings and sync changes after reconnecting. Asset caching needs one successful online load first, including a launch of the Home Screen app if it uses separate storage. Browsers can evict cached data.

Navigation and built assets are served from the active worker's own versioned cache. Updates install in the background and wait for all old app tabs/windows to close. There is no automatic `skipWaiting`, forced reload, or draw on update. When the interface announces an available update, finish your reading, close every Arcana Journal Safari tab and the standalone app, then reopen. Persisted identities and orientations remain unchanged. A simple refresh may keep the old worker active; closing all clients allows the new one to activate.

HTTPS is required for the deployed PWA. Localhost is permitted for development. Opening `dist/index.html` as a file or serving an ordinary unencrypted LAN address is not a valid PWA test. These service-worker restrictions are documented by [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers).

## Deploy free on Cloudflare Pages

This is a static site with no Pages Functions. Cloudflare Pages' included `pages.dev` address supplies HTTPS; no domain purchase is needed. The project fits the [Pages Free plan's static asset limits](https://developers.cloudflare.com/pages/platform/limits/).

1. In this project directory, run `npm ci` and `npm run build`.
2. Sign in to a free [Cloudflare account](https://dash.cloudflare.com/) and open **Workers & Pages**.
3. Create an application, select **Pages**, and choose **Direct Upload** / **Drag and drop your files**. Dashboard wording can vary; choose upload of prebuilt assets.
4. For a new installation, give the project a name, for example `arcana-journal` (availability determines the final address). If updating an existing installation, keep its current Pages project and production address.
5. Drag the **`dist` folder** into the upload area, or select it. Its root must contain `index.html`, `sw.js`, `manifest.webmanifest`, icons, `cards/`, and `assets/`. Do not upload the source project, `node_modules`, or an extra parent folder. The provided `release/ArcanaJournal-cloudflare.zip` contains this same ready-to-upload directory content.
6. Choose **Deploy site** / **Save and Deploy** and wait for success. Open the supplied `https://<project-name>.pages.dev` address.
7. Wait until the application reports **Ready for offline use**, then test a reading and a reload.

For updates, rebuild and use **Create a new deployment** in the same Pages project to upload the new `dist`. Keeping the same production address preserves the storage origin and access to existing history. This applies to the Arcana Journal rebrand too: update the existing project rather than creating or renaming its address just to match the new app name. Direct Upload projects cannot later switch to Git integration; automatic Git deployments require a new project. These steps follow [Cloudflare's Direct Upload guide](https://developers.cloudflare.com/pages/get-started/direct-upload/).

Optional terminal deployment, using browser login rather than an application API key:

```sh
npx wrangler login
npx wrangler pages deploy dist
```

The app itself does not need Wrangler, Cloudflare credentials, or any environment variables. No deployment has occurred merely by building this folder.

## Add to your iPhone Home Screen

1. On the iPhone, open the deployed **HTTPS** address in **Safari** while online.
2. Wait for **Ready for offline use**.
3. Tap **Share** (or Safari's page menu, then Share), then **Add to Home Screen**.
4. Turn **Open as Web App** on when shown, and tap **Add**.
5. Open Arcana Journal from the new Home Screen icon while still online and wait for **Ready for offline use** there too.
6. Try a reading, close and reopen the app, then test in Airplane Mode with Wi-Fi also disabled.

If Add to Home Screen is missing, use **Edit Actions** in the Share menu to add it. These steps follow [Apple's iPhone web app installation guide](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios).

## Verification and manual iPhone checks

Focused automated tests cover deck composition, rejection and boundary behavior, all six Fisher–Yates choice sequences for three cards, uniqueness within spreads, non-mutation, legitimate repeats, orientation behavior, and the reading lifecycle. See [VERIFICATION.md](VERIFICATION.md) for the executed checks, results, and remaining device checks.

Before relying on the installed app, run these checks on a physical iPhone; desktop mobile emulation does not verify iOS installation, Safari storage policy, VoiceOver, or actual safe-area rendering:

- Use Safari and the Home Screen app in portrait and landscape. Check the notch/home indicator, readable text, no horizontal page scroll, 1/3/10-card layouts, and text zoom.
- With VoiceOver, choose a spread, edit the question, draw, reveal each card, open and close details, copy a reading, visit the journal, and delete an entry. Check focus and announcement order.
- Enable iOS Reduce Motion and verify the interface remains comfortable and usable.
- Draw a spread, reveal one card, reload, and reopen from history. Check all identities, order, orientations, and saved reveal state remain the same.
- Once **Ready for offline use** appears in the installed app, enable Airplane Mode and disable Wi-Fi, fully close and reopen it, draw a new reading, and open card meanings. Reconnect afterward.
- Deploy an update while a reading is open. Confirm it remains unchanged, close all Arcana Journal clients, and reopen to receive the update with the saved reading intact.
- Check Copy Reading using iOS's actual clipboard permission behavior. If permission is denied, use the copy fallback presented by the app.

Tests do not establish a physical randomness certificate or promise frequency balance. They verify the specified algorithm and prevent regressions in the user flows that could accidentally redraw cards.

# Arcana-Journal
