// Minimal GIF89a encoder: median-cut quantization + LZW compression.
// No external dependencies. Works in a browser <script> (exposes window.GifEncoder)
// and in Node (module.exports) so it can be unit tested outside the browser.
(function (root) {
  'use strict';

  // ---------- Median-cut color quantizer ----------
  // samples: flat array [r,g,b, r,g,b, ...]
  function buildPalette(samples, maxColors) {
    const pixels = [];
    for (let i = 0; i < samples.length; i += 3) {
      pixels.push([samples[i], samples[i + 1], samples[i + 2]]);
    }
    if (pixels.length === 0) return [[0, 0, 0]];

    let boxes = [pixels];

    function boxRange(box) {
      let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
      for (const p of box) {
        if (p[0] < rMin) rMin = p[0]; if (p[0] > rMax) rMax = p[0];
        if (p[1] < gMin) gMin = p[1]; if (p[1] > gMax) gMax = p[1];
        if (p[2] < bMin) bMin = p[2]; if (p[2] > bMax) bMax = p[2];
      }
      const rRange = rMax - rMin, gRange = gMax - gMin, bRange = bMax - bMin;
      let axis = 0, range = rRange;
      if (gRange > range) { axis = 1; range = gRange; }
      if (bRange > range) { axis = 2; range = bRange; }
      return { axis, range };
    }

    while (boxes.length < maxColors) {
      let splitIdx = -1, splitRange = -1, splitAxis = 0;
      for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].length < 2) continue;
        const { axis, range } = boxRange(boxes[i]);
        if (range > splitRange) { splitRange = range; splitIdx = i; splitAxis = axis; }
      }
      if (splitIdx === -1 || splitRange === 0) break;

      const box = boxes[splitIdx];
      box.sort((a, b) => a[splitAxis] - b[splitAxis]);
      const mid = Math.floor(box.length / 2);
      const boxA = box.slice(0, mid);
      const boxB = box.slice(mid);
      boxes.splice(splitIdx, 1, boxA, boxB);
    }

    return boxes.map(box => {
      let r = 0, g = 0, b = 0;
      for (const p of box) { r += p[0]; g += p[1]; b += p[2]; }
      const n = box.length;
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    });
  }

  function nearestIndex(palette, r, g, b, cache) {
    const key = (r << 16) | (g << 8) | b;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = p[0] - r, dg = p[1] - g, db = p[2] - b;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) { bestDist = dist; best = i; if (dist === 0) break; }
    }
    cache.set(key, best);
    return best;
  }

  // ---------- Bit-packed LZW writer (GIF variant: LSB-first) ----------
  function BitWriter() {
    this.bytes = [];
    this.cur = 0;
    this.bitPos = 0;
  }
  BitWriter.prototype.writeCode = function (code, codeSize) {
    for (let i = 0; i < codeSize; i++) {
      const bit = (code >> i) & 1;
      this.cur |= bit << this.bitPos;
      this.bitPos++;
      if (this.bitPos === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.bitPos = 0;
      }
    }
  };
  BitWriter.prototype.flush = function () {
    if (this.bitPos > 0) {
      this.bytes.push(this.cur);
      this.cur = 0;
      this.bitPos = 0;
    }
  };

  function lzwEncode(minCodeSize, indices) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    const bw = new BitWriter();

    let codeSize, nextCode, dict;
    function reset() {
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
      dict = new Map();
    }
    reset();
    bw.writeCode(clearCode, codeSize);

    if (indices.length === 0) {
      bw.writeCode(eoiCode, codeSize);
      bw.flush();
      return bw.bytes;
    }

    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = prefix * 4096 + k;
      const existing = dict.get(key);
      if (existing !== undefined) {
        prefix = existing;
        continue;
      }
      bw.writeCode(prefix, codeSize);
      dict.set(key, nextCode);
      nextCode++;
      if (nextCode > (1 << codeSize) && codeSize < 12) {
        codeSize++;
      }
      if (nextCode === 4096) {
        bw.writeCode(clearCode, codeSize);
        reset();
      }
      prefix = k;
    }
    bw.writeCode(prefix, codeSize);
    bw.writeCode(eoiCode, codeSize);
    bw.flush();
    return bw.bytes;
  }

  function packSubBlocks(bytes, out) {
    let i = 0;
    while (i < bytes.length) {
      const len = Math.min(255, bytes.length - i);
      out.push(len);
      for (let j = 0; j < len; j++) out.push(bytes[i + j]);
      i += len;
    }
    out.push(0);
  }

  function paletteBits(colorCount) {
    let bits = 1;
    while ((1 << bits) < colorCount) bits++;
    return Math.max(bits, 1);
  }

  // ---------- Public encoder ----------
  // frames: array of { rgba: Uint8ClampedArray|Uint8Array, delayCs: number }
  // width/height: output pixel dimensions (all frames must match)
  // maxColors: palette size, up to 256
  function encodeGif(width, height, frames, opts) {
    opts = opts || {};
    const maxColors = Math.min(256, opts.maxColors || 256);
    const loop = opts.loop === undefined ? 0 : opts.loop;

    // Sample pixels across all frames to build one shared palette.
    const sampleStep = opts.sampleStep || 3;
    const samples = [];
    for (const frame of frames) {
      const px = frame.rgba;
      for (let i = 0; i < px.length; i += 4 * sampleStep) {
        samples.push(px[i], px[i + 1], px[i + 2]);
      }
    }
    let palette = buildPalette(samples, maxColors);
    if (palette.length < 2) palette = palette.concat([[0, 0, 0]]); // GIF requires >=2 table entries in practice
    const bits = paletteBits(palette.length);
    const tableSize = 1 << bits;

    const out = [];
    function pushStr(str) { for (let i = 0; i < str.length; i++) out.push(str.charCodeAt(i)); }
    function push16(n) { out.push(n & 0xff, (n >> 8) & 0xff); }

    // Header
    pushStr('GIF89a');

    // Logical Screen Descriptor
    push16(width);
    push16(height);
    out.push(0x80 | ((bits - 1) << 4) | (bits - 1)); // GCT flag, color res, GCT size
    out.push(0); // background color index
    out.push(0); // pixel aspect ratio

    // Global Color Table (padded to tableSize)
    for (let i = 0; i < tableSize; i++) {
      const c = palette[i] || [0, 0, 0];
      out.push(c[0], c[1], c[2]);
    }

    // Application Extension (NETSCAPE2.0) for looping
    out.push(0x21, 0xff, 0x0b);
    pushStr('NETSCAPE2.0');
    out.push(0x03, 0x01, loop & 0xff, (loop >> 8) & 0xff, 0x00);

    const cache = new Map();
    for (const frame of frames) {
      const px = frame.rgba;
      const indices = new Array(width * height);
      for (let p = 0, i = 0; p < px.length; p += 4, i++) {
        indices[i] = nearestIndex(palette, px[p], px[p + 1], px[p + 2], cache);
      }

      // Graphic Control Extension
      const delayCs = Math.max(2, Math.round(frame.delayCs || 10));
      out.push(0x21, 0xf9, 0x04, 0x04);
      push16(delayCs);
      out.push(0x00, 0x00); // transparent color index (unused), block terminator

      // Image Descriptor
      out.push(0x2c);
      push16(0); push16(0);
      push16(width); push16(height);
      out.push(0x00); // no local color table

      const minCodeSize = Math.max(2, bits);
      out.push(minCodeSize);
      const compressed = lzwEncode(minCodeSize, indices);
      packSubBlocks(compressed, out);
    }

    out.push(0x3b); // trailer

    return new Uint8Array(out);
  }

  const api = { encodeGif, buildPalette };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.GifEncoder = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
