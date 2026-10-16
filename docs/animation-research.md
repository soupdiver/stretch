# Word morph implementation notes

## References

- Local `../35-opencode-stretch/cc-stretch/hooks/grow.ts`: normalized-word LCS anchors and seam-outward reveal; its terminal renderer inserts whole words rather than fading them.
- [Torph animation details](https://www.mintlify.com/lochie/torph/advanced/animation-details): FLIP measurement, neighboring-anchor motion, and a 400ms transition.
- [Building split text animations](https://web.dev/articles/building/split-text-animations): reduced-motion progressive enhancement and keeping the underlying text readable.
- [Range.getClientRects](https://developer.mozilla.org/en-US/docs/Web/API/Range/getClientRects): measure actual text geometry without permanent word wrappers.

## Browser adaptation

`src/morph.ts` measures text-node ranges before and after the existing DOM swap. An aria-hidden, pointer-transparent, closed-shadow overlay paints individual words. Normalized LCS matches stay opaque and slide; unmatched words follow their nearest anchor and fade/reveal with a seam-distance stagger. Real text remains in the accessibility tree. Animation effects temporarily hide its glyphs without changing DOM attributes, so mutation snapshots remain valid.

Safe normal-flow block heights animate alongside the word motion. Inline selection spans never acquire block layout or height constraints. Original nodes are still moved, never cloned or rewritten.

Only one overlay runs globally. Concurrent batch swaps fall back immediately; there are no later-paragraph overlays to drift under earlier height changes. A frame-level position guard cancels if external layout changes move the active block. Resize, scroll, new pointer/keyboard interaction, restoration, mutations, detachment, motion-preference changes, and WAAPI failures also remove effects and listeners. Cleanup has a bounded fallback timer.

Work is bounded to 180 tokens per representation, 240 descendant elements/text nodes, and 12,000 characters. Offscreen, transformed, clipped, RTL/vertical, generated-content, shadowed, fragmented-word, and otherwise unsupported geometry falls back to normal swaps. Anchor font/color styling uses the destination representation; changed punctuation crossfades while moving.

## Local verification artifacts

Ignored `test-results/morph/` contains the ad hoc extension/browser scripts, JSON evidence, mid-transition screenshots, and a playable local `demo.html` comparison with its bundled `demo.js`. These are not formal tests or release/store artifacts. The extension checks use the existing article fixture and mocked Anthropic replies; successful final runs use fresh profiles and DNS-blocked external hosts.
