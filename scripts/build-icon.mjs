import { readFile, writeFile } from 'node:fs/promises';

const resource = new URL('../BTC Indicator.app/Contents/Resources/', import.meta.url);
const blocks = [
  ['icp4', 'icon_16x16.png'],
  ['icp5', 'icon_32x32.png'],
  ['icp6', 'icon_32x32@2x.png'],
  ['ic07', 'icon_128x128.png'],
  ['ic08', 'icon_256x256.png'],
  ['ic09', 'icon_512x512.png'],
  ['ic10', 'icon_512x512@2x.png']
];

const payloads = await Promise.all(blocks.map(async ([type, name]) => [type, await readFile(new URL(`Icon.iconset/${name}`, resource))]));
const length = 8 + payloads.reduce((total, [, png]) => total + 8 + png.length, 0);
const output = Buffer.alloc(length);
output.write('icns', 0, 4, 'ascii');
output.writeUInt32BE(length, 4);
let offset = 8;
for (const [type, png] of payloads) {
  output.write(type, offset, 4, 'ascii');
  output.writeUInt32BE(png.length + 8, offset + 4);
  png.copy(output, offset + 8);
  offset += png.length + 8;
}
await writeFile(new URL('Icon.icns', resource), output);
