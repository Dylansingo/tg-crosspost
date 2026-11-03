import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([length, typeBuf, data, checksum]);
}

function png(width, height, red, green, blue) {
  const raw = Buffer.alloc((1 + width * 3) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const index = row + 1 + x * 3;
      raw[index] = red;
      raw[index + 1] = green;
      raw[index + 2] = blue;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 8×8 baseline JPEG. Synthetic, no third-party artwork. A previous 1×1
// stand-in used a DQT libvips will not decode, so the demo could not render it.
const jpeg = Buffer.from(
  '/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAB//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ALAAKOD/2Q==',
  'base64',
);

mkdirSync(root, { recursive: true });
writeFileSync(path.join(root, 'single.jpg'), jpeg);
writeFileSync(path.join(root, 'album-1.png'), png(16, 16, 180, 40, 40));
writeFileSync(path.join(root, 'album-2.png'), png(16, 16, 40, 140, 70));
writeFileSync(path.join(root, 'album-3.png'), png(16, 16, 40, 70, 160));
writeFileSync(path.join(root, 'story.png'), png(9, 16, 240, 200, 80));
console.log('Wrote sample images to', root);
