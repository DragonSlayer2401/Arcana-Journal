# Bundled artwork and card wording

## Illustrated card faces

`public/cards/<stable-card-id>.webp` contains all 78 full-scene portrait illustrations, each 768 × 1152 pixels. The compositions follow the original Rider–Waite–Smith deck illustrated by Pamela Colman Smith for Arthur Edward Waite. The scenes were redrawn using the built-in image-generation tool, guided by the user's reference image and the generated Fool as a style anchor. These are illustrated adaptations, not scans or exact facsimiles. Selected traditionally nude figures use modest drapery.

Visual direction: bold angular shapes, stylized figures, jewel colors, flowing decorative curves, geometric patterns, and textured painted surfaces. The style reference's characters, captions, and artist signature are not included in the generated deck. Names and orientation labels are rendered separately in the interface, so they remain readable when artwork is reversed.

All 78 original source images were checked through Wikimedia Commons image metadata. They identify Pamela Colman Smith, publication in 1910, and public-domain status. `art/references/sources.json` records the individual file pages, exact download addresses, license metadata, dimensions, and checksums. For example, [The Fool source record](https://commons.wikimedia.org/wiki/File:RWS_Tarot_00_Fool.jpg) identifies the original work as public domain in the United States. Use the per-card records for the complete set.

Full-resolution generated working images and their exact prompts are stored locally under `art/generated/`. The distributed source archive includes prompts and the optimized final WebPs; it excludes the large working PNGs and reference scans. `scripts/import-art.mjs` preserves the generated original and encodes the final WebP; it does not generate new imagery. `scripts/check-art.mjs` validates completeness, dimensions, file structure, uniqueness, size, and built service-worker coverage.

The user-supplied style reference remains at `art/references/style-reference.png` for local development only. It is not bundled with the app or release archives, and is not covered by this project's license.

## Original fallback artwork, icons, and meanings

`src/components/CardArtwork.tsx` retains original symbolic SVG scenes as a defensive fallback if a local illustration cannot be decoded. Its celestial card back is also original. App icons are original bundled PNG/SVG files. Platform fonts are used; no font download is required.

The complete card dataset is `src/data/deck.ts`: 22 Major Arcana and 14 cards in each of Wands, Cups, Swords, and Pentacles. Strength is VIII and Justice is XI. All 156 upright and reversed summaries and keyword lists use original wording summarizing traditional tarot associations. They are fixed local data, and never influence random selection.

The project's source, original wording, icons, fallback artwork, and newly generated illustration files are provided under the MIT terms in `LICENSE`, to the extent copyright applies. The public-domain source compositions retain that status. The user's reference image is excluded. Third-party software retains its respective dependency licenses.
