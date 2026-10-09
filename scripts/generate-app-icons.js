// scripts/generate-app-icons.js
// Regenera los iconos de la app (icon-192.png, icon-512.png,
// apple-touch-icon.png) a partir del logo actual "M" (mediador-icon.svg)
// -- los PNG existentes todavia tenian el logo viejo de "Puente Digital"
// (una "P"), que quedo sin actualizar cuando la marca paso a "Mediador".
// No hay ninguna libreria de imagenes instalada en el proyecto (sharp,
// canvas, etc.), asi que esto rasteriza las formas a mano (rect
// redondeado + la polilinea de la M con stroke grueso) y arma el PNG
// directo con zlib (ya viene con Node), sin dependencias nuevas.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [0x0f, 0x15, 0x17]; // #0F1517
const STROKE = [0x22, 0xc7, 0xb8]; // #22C7B8
const VIEWBOX = 32;
const STROKE_WIDTH = 2.75;
const RADIUS = 8;
// puntos de la polilinea de la M, ya resueltos desde el path SVG original:
// "M8.5 22.5V10l7.5 7.5 7.5-7.5v12.5"
const POINTS = [
  [8.5, 22.5],
  [8.5, 10],
  [16, 17.5],
  [23.5, 10],
  [23.5, 22.5],
];

function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const abLenSq = abx * abx + aby * aby;
  let t = abLenSq === 0 ? 0 : (apx * abx + apy * aby) / abLenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + abx * t, cy = ay + aby * t;
  return Math.hypot(px - cx, py - cy);
}

function roundedRectCoverage(x, y, w, h, r) {
  // x,y es el centro del pixel; devuelve 1 adentro, 0 afuera (el bg llena
  // todo el icono con esquinas redondeadas, igual que el SVG original)
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx, dy = y - cy;
  return Math.hypot(dx, dy) <= r ? 1 : 0;
}

function renderIcon(size) {
  const scale = size / VIEWBOX;
  const scaledPoints = POINTS.map(([x, y]) => [x * scale, y * scale]);
  const halfStroke = (STROKE_WIDTH * scale) / 2;
  const radius = RADIUS * scale;
  const SS = 4; // supersampling por eje -> 16 muestras por pixel, suficiente para un icono chico
  const buf = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgCoverage = 0;
      let strokeCoverage = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          bgCoverage += roundedRectCoverage(x, y, size, size, radius);
          let minDist = Infinity;
          for (let i = 0; i < scaledPoints.length - 1; i++) {
            const [ax, ay] = scaledPoints[i];
            const [bx, by] = scaledPoints[i + 1];
            minDist = Math.min(minDist, distToSegment(x, y, ax, ay, bx, by));
          }
          if (minDist <= halfStroke) strokeCoverage++;
        }
      }
      const total = SS * SS;
      bgCoverage /= total;
      strokeCoverage /= total;
      // el stroke va ENCIMA del fondo -- se mezcla primero el bg sobre
      // transparente, despues el stroke sobre eso (mismo orden que el SVG:
      // <rect> primero, <path> despues)
      let r = BG[0] * bgCoverage, g = BG[1] * bgCoverage, b = BG[2] * bgCoverage, a = bgCoverage;
      r = STROKE[0] * strokeCoverage + r * (1 - strokeCoverage);
      g = STROKE[1] * strokeCoverage + g * (1 - strokeCoverage);
      b = STROKE[2] * strokeCoverage + b * (1 - strokeCoverage);
      a = strokeCoverage + a * (1 - strokeCoverage);
      const idx = (py * size + px) * 4;
      buf[idx] = Math.round(r);
      buf[idx + 1] = Math.round(g);
      buf[idx + 2] = Math.round(b);
      buf[idx + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

// ---- encoder PNG minimo (sin dependencias) ----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePng(rgba, size) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = chunk('IHDR', ihdrData);

  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // sin filtro
    rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = chunk('IDAT', zlib.deflateSync(raw, { level: 9 }));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function writeIcon(size, outPath) {
  const rgba = renderIcon(size);
  const png = encodePng(rgba, size);
  fs.writeFileSync(outPath, png);
  console.log(`${outPath} (${size}x${size}, ${png.length} bytes)`);
}

const root = path.join(__dirname, '..', 'public');
writeIcon(192, path.join(root, 'icons', 'icon-192.png'));
writeIcon(512, path.join(root, 'icons', 'icon-512.png'));
writeIcon(180, path.join(root, 'apple-touch-icon.png'));
