# Arcana Journal

Arcana Journal is a server-rendered Next.js tarot PWA built with React and TypeScript. It includes 78 illustrated Rider–Waite–Smith scenes, upright and reversed meanings, one-card/three-card/custom spreads, and individual reveals. Guests keep a journal on their device. An optional account syncs readings across browsers and devices. Three cards and upright-only draws are the defaults.

Open **Deck** to browse all 78 illustrations by Major Arcana or suit. Search by card name and tap a card to read its upright and reversed meanings. With JavaScript disabled, you can submit the filters and expand each card to read both meanings in the server-rendered page. The library also works offline once the app reports offline readiness.

Open [Arcana Journal on Vercel](https://arcana-journal-theta.vercel.app/).

The Next.js App Router renders Reading (`/`), Deck (`/deck`), Journal (`/journal`), and the three account forms (`/login`, `/signup`, `/reset-password`) on each direct request. Each page supplies its own title, description and public content. The initial HTML includes the reading form, the 78-card library, the journal loading state or the requested account form. After hydration, Firebase Authentication restores the browser session. Firestore loads when a verified account opens its journal. Draws and private readings stay on the device or in the signed-in account.

## Project layout

- `src/features/Tarot/` owns the deck and card artwork components. Its Reading and DeckCatalog features implement the draw and browse workflows.
- `src/features/Journal/` owns the shared journal session, history, guest storage, account sync, and backup transfer.
- `src/features/Account/` owns sign-in, signup, password reset, verification, and journal lock controls.
- `src/app/` connects public URLs and page metadata to those features. Firebase adapters and account and journal operations live under `src/services/`.

Feature styles live in the owning feature’s `assets/` folder. Feature tests live in `__tests__/` folders alongside the workflows they cover. The end-to-end checks that span the app live in `tests/`.

## Run it

Install [Node.js](https://nodejs.org/) 24.12.0 or later, then run these commands from the project folder.

```sh
npm ci
npm run dev
```

The development server opens at [127.0.0.1:3000](http://127.0.0.1:3000).

```sh
npm run typecheck
npm run format:check
npm test
npm run build
npm run preview
```

`npm run build` validates the artwork, compiles the production app to `.next/`, captures the six public routes for offline use and writes the versioned worker to `public/sw.js`. The local production preview uses its own port so its service worker only controls that origin. Use `npm start` to run the production server on your host. [Open the local preview](http://127.0.0.1:4173).

The generated worker also has a focused, dependency-free lifecycle harness:

```sh
node --test scripts/test-sw.mjs
```

It checks complete-asset readiness, offline navigation, cache repair, rejected substituted content, version changes, and safe update activation. The tests use temporary build fixtures.

For browser automation:

```sh
npx playwright install chromium webkit
npm run test:browser
npm run test:update
```

Build first with `npm run build`. The browser suites start their own local production servers. The main suite uses Chromium and WebKit, with desktop and iPhone viewport emulation. The update suite uses a test-only server to simulate a deployment; no update test switches ship in the app. These are desktop browser checks, not a physical iPhone test.

## Random selection

`src/features/Tarot/features/Reading/utils/random.ts` contains the selection code and does not import the UI or card meanings. Its only entropy source is `globalThis.crypto.getRandomValues()`. The optional question is journal text; it is never passed to the draw function.

For each integer bound `n`, the implementation validates an integer in `[1, 2 ** 32]`, reads an unsigned 32-bit value, and calculates:

```ts
const limit = Math.floor(2 ** 32 / n) * n;
// Keep reading until value < limit.
return value % n;
```

Rejection eliminates modulo bias. This uses ordinary JavaScript numbers, without truncating `2 ** 32` through bitwise arithmetic. Each reading makes a fresh copy of all 78 IDs, applies one Fisher–Yates shuffle using those unbiased bounded integers, and takes the requested 1–10 cards. Cards cannot repeat inside a spread. Across readings, repeats—including an identical full spread—are allowed. Nothing balances outcomes or favors a suit, arcana, or meaning.

Reversals are disabled by default. If enabled, every selected card receives a separate unbiased `secureRandomInt(2)` orientation decision. The draw event stores the complete identities, order, and orientations before any reveal. Reveal, detail, history, and reload operations reuse that saved result. Select **New Reading**, **Reading** in the navigation bar, or the Arcana Journal logo to return to the draw form. The spread stays in your journal. Rapid taps on **Draw Cards** produce a single reading. If Web Crypto is missing or fails, the application reports an error without a weaker fallback.

The accurate description is **cryptographically secure random draws with unbiased shuffling**. This is not a claim of independently verified physical or quantum randomness. Tests exercise the algorithm with controlled entropy, not a frequency simulation or artificially even results. Production exposes no test entropy switch.

## Data and artwork

`src/features/Tarot/data/deck.ts` includes all 22 Major Arcana and 56 Minor Arcana: Wands, Cups, Swords, and Pentacles, each Ace–Ten, Page, Knight, Queen, King. IDs are stable and unique. Meanings use original concise wording summarizing traditional associations, with distinct fixed upright and reversed entries.

All 78 card faces are bundled locally as 768 × 1152 WebP illustrations in `public/cards/`, keyed by the stable card IDs. They reinterpret the public-domain Rider–Waite–Smith scenes by Pamela Colman Smith in the user's supplied visual direction: angular forms, jewel tones, flowing patterns, and painted texture. They were created ahead of time with the built-in image-generation tool. There is no runtime image generation, interpretation service, API key, or extra fee to use these bundled images. Each card's complete portrait is visible; reversed artwork rotates while names and meanings stay upright. Original symbolic SVG artwork remains available as a defensive loading fallback.

The source/license record is `art/references/sources.json`, and generation prompts are retained in `art/generated/*.prompt.txt`. The user's style reference and full-resolution working images are kept outside `public/` and are excluded from release archives. See `ASSETS.md`, `art/STYLE.md`, and `LICENSE` for provenance and reuse details. Dependency licenses remain their respective authors' licenses.

## Journal accounts and backups

Choose **Sign in** (`/login`) or **Create account** (`/signup`) to open a dialog over your current screen. Close it or press Escape to return to your reading, Deck filters, or Journal. Opening either address directly shows the dialog over Journal. **Forgot password?** switches the dialog to password reset, and `/reset-password` also opens as a standalone form.

New accounts use the guest journal on this device until you follow the verification link in your email and choose **Check verification** in Journal. Once verified, new readings sync to your account. Select the trusted-device option at sign-in to keep cached account readings and pending changes through a browser restart. On a shared device, keep this option off and wait for changes to sync before closing the tab or signing out.

On a trusted device, choose **Lock journal** on the Journal page and wait for **Journal locked** before handing it over. A saved lock covers the app’s other tabs and survives reopening the browser. If the browser cannot save the lock, the lock screen tells you that only this tab is locked. Use your device’s screen lock before handing it over in that case. Firebase keeps the account signed in so its queued changes can sync. Anyone with access to the browser profile’s stored data can still read the local cache.

To withdraw device trust, sign out and sign in again with the trusted-device option off. The app removes that account’s offline Firestore journal. If a tab is still using it, let its changes sync and close it. If changes are waiting on this device, reopen the trusted journal to sync or recover them. The memory-only journal shows an explanation and **Retry offline journal removal** while cleanup is incomplete.

A memory-only session restored from an older version may ask you to confirm removal because another sign-in could have granted trust since then. A trusted session can reopen its cache offline using its last verified Firebase token. When Firebase reports that the email needs verification again, open journals return to verification and the shared journal lock stays in effect.

If **Sign-out incomplete** appears, the journal is hidden in that tab. Restore browser storage access and choose **Retry sign out** to finish removing the persisted session.

Trusted sign-in and sign-out need browser support for coordinating changes across tabs. If your browser blocks that access, use **Lock journal** for an existing trusted session. On a signed-out device, you can leave the trusted-device option off.

To unlock, reconnect and enter the original account’s password. If you forgot it, choose **Send password reset email** on the lock screen. Follow the link in the account’s inbox, then return to the journal and enter the new password.

The trusted journal keeps an account-specific recovery copy of draws and card reveals that are waiting to sync. If a reading needs recovery after you unlock, choose **Recover unsynced readings**, review the destination and confirm the import. If the browser cannot save a recovery copy, keep the tab holding the reading open until it syncs. You can also choose **Download unsynced readings** before locking to save a backup.

If another tab asks you to wait before signing out, return to the tab holding the changes and check its sync status. In browsers that cannot coordinate sign-out across tabs, keep the original tab open and sign back into the same account to recover a reading held in memory. If the journal reports that a recovery copy could not be read or removed, restore browser storage access and choose **Retry sync**.

Guest journals stay in the browser profile and site address that created them. To sync existing readings, including those drawn while awaiting verification, open the verified account on that device, choose **Import this device’s journal**, review the destination email and counts, and confirm. The original guest readings remain available when signed out. If Safari and the installed Home Screen app contain different readings, repeat the import in each. Keep the current production address when deploying an update.

Guest deletion and clearing apply to the spreads you confirmed. A spread added or replaced in another tab is kept. **Clear History** also erases guest recovery copies on this device, even when the journal is empty. If the browser reports an incomplete clear, restore storage access and choose **Clear History** again.

If guest changes could not be saved, choose **Export journal** before closing the tab. If you have already signed in, choose **Download guest backup**. The guest backup combines your unsaved changes with the latest saved guest readings. It keeps separate draws with matching spreads and leaves out untouched readings another tab deleted. You can import the file after reloading, or use **Import this device’s journal** to preview those readings for your account.

**Export journal** downloads a versioned JSON file with each reading’s original date, question, ordered cards, orientations, and reveal progress. An account download is labeled **cloud and this tab**. It includes all cloud pages and recovery copies available in the exporting tab. If another tab reports unsynced readings, sync or recover them there before exporting. A suspended or storage-restricted tab may need to be reopened to include its changes. If some local copies are unreadable, you can download a partial backup of the available unsynced readings and retry after restoring storage access. If this browser cannot check saved deletions, **Export available readings** labels the download **unchecked deletions**. It may include a reading waiting to be deleted. Restore storage access and reopen the journal to finish syncing those deletions.

Choose **Import journal** to preview and merge a backup. Backup dates use UTC. A legacy file date without a time zone is read as UTC, and a date with an offset keeps its original instant. Previously synced legacy readings retain the instant recorded by the device that uploaded them. Repeating an import combines reveal progress. For different readings with a shared legacy ID, the journal keeps the original ID alongside the new ID assigned to the collision. This lets the merged file restore onto either original journal. Anyone with access to a backup can read it. **Copy Reading** shares one spread as readable text.

Account imports check for earlier deletions of the same reading, including deletions confirmed in another tab. If a deletion is pending, let it finish syncing and retry. If the browser cannot check, the preview explains the risk and asks whether to continue. When you choose to recover unsynced readings with that check unavailable, the app keeps an account-specific recovery copy. Once storage access returns and deletions finish syncing, choose **Recover unsynced readings** again to complete recovery.

Account **Clear History** checks every page before asking you to confirm the number of synced readings. Readings added, updated or replaced after that review stay in the journal. If you confirm an import while a clear is running, the clear can stop partway through to protect the imported readings. Review the remaining journal before confirming another clear. If a tab closed during a clear, a checked export warns you when Firestore still shows that clear in progress. You can retry the checked export or choose **Export available readings** for a backup labeled **unchecked deletions**.

Deleting a guest reading affects this browser only. For an account reading, Firebase verifies the selected spread before deleting it across devices. A replacement that reuses its ID is kept. Trusted browsers can save a confirmed offline deletion and finish it when the same account reconnects. If the browser asks you to keep the tab open, leave it open until the deletion syncs. Reopening the journal also checks interrupted deletions before removing their recovery copies. Guest storage and trusted offline caches can be lost when someone clears browser data.

When upgrading, let **Clear History** and queued changes finish in older tabs before recovering readings or reusing a reading ID on another device. Reopen the updated app for recovery. Firebase processes previously submitted writes in the format used by the version that created them.

### Firebase setup for this deployment

The app uses the Firebase project `arcana-journal`. Enable **Email/Password** under Authentication and create the **Standard** Firestore database with ID `(default)` in production mode. The web configuration ships with the app. The rules in `firestore.rules` require a verified email and restrict access to the account that owns the readings.

Verification and password-reset emails return to `/journal` on the hostname that requested them. The production hostname `arcana-journal-theta.vercel.app` belongs in **Authentication → Settings → Authorized domains** in Firebase. If you test email actions on a Vercel preview, authorize that preview hostname too. [Firebase email action domains](https://firebase.google.com/docs/auth/web/passing-state-in-email-actions)

Publish `firestore.rules` before releasing the frontend. The rules allow the optional, immutable `sourceId` used to restore readings whose legacy IDs collided. They also cover the account-specific document that coordinates imports with **Clear History**. Publish the rules in **Firestore → Rules**, or run the following command from this directory while signed in to the project.

```sh
firebase deploy --only firestore:rules --project arcana-journal
```

The account and security-rule integration tests use the local Firebase emulators. Install the Firebase CLI, Java 21, and both Playwright browsers (`npx playwright install chromium webkit`), then run:

```sh
firebase emulators:exec --only auth,firestore --project demo-arcana-journal "npm run test:cloud"
```

## Offline behavior and updates

`scripts/build-sw.mjs` enumerates the actual built assets and derives the cache version from their paths and contents. The worker caches the application shell, compiled code, styles, card data/artwork, manifest, and icons. Each downloaded asset's SHA-256 digest must match the build before installation succeeds. `src/utils/pwa.ts` asks the controlling worker to confirm that every required cache entry is present before the interface reports offline readiness. A missing or failed asset does not produce a ready status. Readiness is rechecked when the app regains focus or comes online.

After **Ready for offline use** appears, guests can draw, reveal, and revisit saved readings offline. Trusted-device accounts can use cached readings and sync changes after reconnecting. Asset caching needs one successful online load first, including a launch of the Home Screen app if it uses separate storage. Browsers can evict cached data.

Online navigation uses the running Next.js server. When offline, the worker can restore a public page and its matching JavaScript, CSS and card assets from the active build. Updates install in the background and wait for all old app tabs/windows to close. There is no automatic `skipWaiting`, forced reload, or draw on update. When the interface announces an available update, finish your reading, close every Arcana Journal Safari tab and the standalone app, then reopen. Persisted identities and orientations remain unchanged. A simple refresh may keep the old worker active; closing all clients allows the new one to activate.

Service workers require HTTPS in production and also work on localhost. [Service worker requirements](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)

## Deploy on Vercel

Use the repository root as the Vercel project’s **Root Directory**. This branch’s `vercel.json` selects Next.js, runs `npm run build` to generate the SSR routes and offline assets, and uses the `.next` output directory. [Vercel project configuration](https://vercel.com/docs/project-configuration/vercel-json)

If the site address changes, export guest readings from the old address and import the backup at the new one. Sign in to the same account to open readings already synced to Firebase.

To verify a deployment, open `/deck` directly, wait for **Ready for offline use**, then take the browser offline and reload. The deck should still show all 78 cards.

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
