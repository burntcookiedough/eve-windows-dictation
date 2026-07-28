# Eve cactus resource provenance

- Created: 2026-07-28 (Asia/Calcutta)
- Gate: 5B
- Source master: `eve-cactus-master.png`
- Source-master canvas: 2048 x 2048 RGBA PNG
- Generator: OpenAI built-in image generation
- Reference role: the tracked Gate 5 application board supplied only the calm,
  monochrome product context and its small title-bar cactus direction.
- Privacy: synthetic asset; no personal data or user content.

## Generation prompt

> Create one original, compact cactus symbol for Eve, a trustworthy Windows dictation
> application. Use a single centered upright cactus silhouette with a short central
> trunk and two deliberately asymmetric rounded arms, one slightly higher and slimmer.
> Keep it sturdy, quiet, friendly, and recognizable at 16 pixels. Use a crisp, flat,
> warm-white, vector-friendly shape on a uniform magenta chroma-key background with
> approximately 12% optical padding. Do not add text, a pot, face, needles, interior
> detail, outline, border, glow, halo, shadow, badge, or watermark, and do not copy a
> familiar cactus mark.

## Master preparation

The generated 1254 x 1254 chroma-key source was processed locally with the installed
OpenAI image-generation chroma-key helper. The resulting alpha mask was cropped to its
nontransparent bounds, normalized to solid `#F4F4F5`, proportionally resized, and
centered on a transparent 2048 x 2048 canvas with 12% top and bottom safe padding.
Generated sources and intermediate files remain outside the repository.

## Reproducible derivatives

`../scripts/build-icons.mjs` is the only derivative generator. It uses the locked
Electron `nativeImage` implementation and no new dependency. It creates:

- the standard application PNG and nine-entry Windows ICO;
- a dark glyph for light taskbars;
- a light glyph for dark taskbars; and
- a two-tone High Contrast glyph.

The ICO entries are 16, 20, 24, 32, 40, 48, 64, 128, and 256 pixels. Run
`bun run build:icons` to regenerate them and
`bun run build:icons -- --check` to prove that tracked derivatives are current.

This is an originality record, not a formal trademark opinion. A pre-release
name/mark-similarity and legal review remains deferred.
