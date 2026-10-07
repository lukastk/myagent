// No network, browser, credentials or Pi session. Node >=22.18 (native TS stripping).
// Run: node --test extensions/web/test-images.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { resizeImage, formatDimensionNote } from './lib/image-resize.ts';

const input = (buffer, format) => ({
  type: 'image', data: buffer.toString('base64'), mimeType: `image/${format}`,
});

for (const format of ['png', 'jpeg', 'webp']) {
  test(`${format}: encode/decode, unchanged fast path and actual extension resize`, async () => {
    const source = await sharp({
      create: { width: 320, height: 160, channels: 3, background: '#336699' },
    }).toFormat(format).toBuffer();
    const meta = await sharp(source).metadata();
    assert.equal(meta.format, format);
    assert.equal(meta.width, 320);
    assert.equal(meta.height, 160);

    const unchanged = await resizeImage(input(source, format));
    assert.equal(unchanged.wasResized, false);
    assert.deepEqual(Buffer.from(unchanged.buffer), source);
    assert.equal(unchanged.mimeType, `image/${format}`);
    assert.equal(formatDimensionNote(unchanged), '');

    const resized = await resizeImage(input(source, format), {
      maxWidth: 80, maxHeight: 80, maxBytes: 20 * 1024,
    });
    assert.equal(resized.wasResized, true);
    assert.equal(resized.originalWidth, 320);
    assert.equal(resized.originalHeight, 160);
    assert.equal(resized.width, 80);
    assert.equal(resized.height, 40);
    assert(resized.buffer.length <= 20 * 1024);
    assert.deepEqual(Buffer.from(resized.data, 'base64'), Buffer.from(resized.buffer));
    const output = await sharp(Buffer.from(resized.buffer)).metadata();
    assert.equal(resized.mimeType, `image/${output.format}`);
    assert.equal(output.width, 80);
    assert.equal(output.height, 40);
    assert.match(formatDimensionNote(resized), /Original: 320x160, Resized: 80x40/);
    const { data } = await sharp(Buffer.from(resized.buffer)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    // Lossy JPEG/WebP are legitimate candidates; the decoded colour must survive.
    for (const [i, expected] of [0x33, 0x66, 0x99].entries()) {
      assert(Math.abs(data[i] - expected) <= 8);
    }
  });
}

test('PNG alpha is preserved by the unchanged fast path', async () => {
  const source = await sharp({
    create: { width: 8, height: 8, channels: 4, background: '#33669980' },
  }).png().toBuffer();
  const result = await resizeImage(input(source, 'png'));
  assert.deepEqual(Buffer.from(result.buffer), source);
  assert.equal((await sharp(Buffer.from(result.buffer)).metadata()).hasAlpha, true);
});

test('byte pressure forces real compression even when dimensions already fit', async () => {
  const pixels = Buffer.alloc(512 * 256 * 3);
  let state = 123456789;
  for (let i = 0; i < pixels.length; i++) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    pixels[i] = state >>> 24;
  }
  const source = await sharp(pixels, { raw: { width: 512, height: 256, channels: 3 } }).png().toBuffer();
  assert(source.length > 100 * 1024);
  const result = await resizeImage(input(source, 'png'), { maxBytes: 100 * 1024 });
  assert.equal(result.wasResized, true);
  assert(result.buffer.length <= 100 * 1024);
  const meta = await sharp(Buffer.from(result.buffer)).metadata();
  assert.equal(meta.width, result.width);
  assert.equal(meta.height, result.height);
  assert(result.width > 0 && result.height > 0);
});

test('system libvips can rasterise SVG through the extension image pipeline', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#336699"/></svg>');
  const result = await resizeImage(input(svg, 'svg+xml'), { maxWidth: 50, maxHeight: 50 });
  assert.equal(result.wasResized, true);
  assert.equal(result.width, 50);
  assert.equal(result.height, 25);
  assert(['image/png', 'image/jpeg', 'image/webp'].includes(result.mimeType));
  assert.equal((await sharp(Buffer.from(result.buffer)).metadata()).width, 50);
});

test('invalid image data fails loudly', async () => {
  await assert.rejects(resizeImage(input(Buffer.from('not an image'), 'png')), /unsupported image format/i);
});
