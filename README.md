# Sprite Sheet Packer

Pack sprite frames into a texture atlas — MaxRects packing, automatic transparent-border trimming, padding and extrude — and export the PNG with a Phaser, Godot, TexturePacker or CSS atlas, plus an animated GIF. Runs entirely in your browser.

**Live:** <https://sprite-sheet-packer.slippylabs.com/>

## What it does

- Drop PNG frames (ordered by filename, so `run_01` … `run_08` comes out right), or slice a sheet you already have by cell size.
- Auto-trim the transparent border off each frame, **recording the offset** so it still draws in the right place.
- Padding and extrude, power-of-two and square options.
- An animation preview at your chosen frame rate, read back out of the packed atlas rather than from the sources — so a packing mistake shows up as a sprite that jitters.
- Export the atlas PNG plus Phaser 3 / TexturePacker (hash or array), Godot 4 AtlasTexture regions, CSS sprite classes or plain JSON — and an animated GIF.

## How it works

MaxRects, best-short-side-fit: keep an explicit list of maximal free rectangles rather than a tree, place each sprite in the free rect whose leftover short side is smallest, then split every free rect the placement overlaps and discard the ones contained in another. It beats shelf and guillotine packers on sprite sets, which are exactly the awkward mix of sizes those two handle worst. Candidate bin sizes are tried smallest-first from the total sprite area, then shrink-wrapped.

**No rotation.** A rotated frame packs better and then every consumer has to honour a `rotated` flag that half of them ignore, so the atlas here is always drawn the way up you gave it and the exports say `rotated: false` honestly.

Trimming without recording the offset is the single most common way a packed sheet goes wrong: it looks fine frame by frame and shows up as a walk cycle that slides. A fully transparent frame is kept as a 1×1 rather than dropped, so the frame indices stay lined up with the animation.

Padding and extrude solve the two halves of the same problem — padding separates frames so a filtered sample cannot bleed across, extrude repeats the edge pixel outward so a sample landing just past the edge still finds the sprite's own colour. A tile map needs both.

The GIF export reuses the hand-written GIF89a encoder from `video-to-gif.slippylabs.com`, unchanged.

## Verification

`verify_packer.py` checks the invariants exhaustively and the quality claim relatively.

- **180 pack runs, 3,420 frames** across 6 seeds × 5 counts × 6 option sets: no overlapping blocks, nothing outside the atlas, every input present exactly once — checked over *every pair*.
- **The round trip that matters**: blit every frame into the atlas, read each one back out through the rectangles the export publishes, and compare with the source. **180/180 runs byte for byte.** A wrong trim offset or an off-by-one in the padding cannot survive this.
- 2,850 frames trimmed to exactly the bounding box of their opaque pixels.
- Against **`rectpack`**, an independent MaxRects: it fits the same bin on every multi-frame run it could pack at all; worst atlas area is 1.35× the theoretical minimum.
- All five export formats name the same rectangles as the atlas.

**98,857 checks**, plus a browser test that runs the round trip in a real canvas.
