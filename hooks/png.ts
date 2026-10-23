// PNG decoding, without a converter: every colour type, bit depth and the Adam7 interlace, to 8-bit
// RGBA. What lets a PNG be drawn in cells, or sent as pixels, on a system with no sips or ImageMagick.
import { unzlib } from './inflate'
import type { Pixels } from './pixels'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export const isPng = (bytes: Uint8Array) => SIGNATURE.every((byte, i) => bytes[i] === byte)

// Adam7: each pass's first column and row, and its steps across and down.
const PASSES = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const

/** Undoes the filter of each scanline in place: None, Sub, Up, Average, Paeth. */
function unfilter (data: Uint8Array, start: number, lineBytes: number, rows: number, pixelBytes: number) {
  let previous: Uint8Array | undefined
  for (let y = 0; y < rows; y++) {
    const at = start + y * (lineBytes + 1)
    const type = data[at]!
    const line = data.subarray(at + 1, at + 1 + lineBytes)
    for (let x = 0; x < lineBytes; x++) {
      const left = x >= pixelBytes ? line[x - pixelBytes]! : 0
      const up = previous ? previous[x]! : 0
      const upLeft = previous && x >= pixelBytes ? previous[x - pixelBytes]! : 0
      let add = 0
      if (type === 1) add = left
      else if (type === 2) add = up
      else if (type === 3) add = (left + up) >> 1
      else if (type === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      } else if (type !== 0) throw new Error('a bad PNG filter')
      line[x] = (line[x]! + add) & 0xff
    }
    previous = line
  }
}

/** A PNG decoded to 8-bit RGBA. Rejects one past `maxPixels`, before inflating it. */
export function decodePng (bytes: Uint8Array, maxPixels = 4096 * 4096): Pixels {
  if (!isPng(bytes)) throw new Error('not a PNG file')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0
  let height = 0
  let depth = 0
  let colour = 0
  let interlace = 0
  let palette: Uint8Array | undefined
  let alphas: Uint8Array | undefined
  const parts: Uint8Array[] = []
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = view.getUint32(at + 8)
      height = view.getUint32(at + 12)
      depth = body[8]!
      colour = body[9]!
      interlace = body[12]!
    } else if (type === 'PLTE') palette = body
    else if (type === 'tRNS') alphas = body
    else if (type === 'IDAT') parts.push(body)
    else if (type === 'IEND') break
    at += 12 + length
  }
  if (width === 0 || height === 0) throw new Error('a PNG with no header')
  if (width * height > maxPixels) throw new Error('a PNG too large to decode')
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour]
  if (!channels) throw new Error(`a PNG of colour type ${colour}`)
  const bitsPerPixel = channels * depth
  const pixelBytes = Math.max(1, bitsPerPixel >> 3)

  const packed = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  parts.reduce((at, part) => (packed.set(part, at), at + part.length), 0)
  const passes = interlace ? PASSES : [[0, 0, 1, 1] as const]
  const sizes = passes.map(([x0, y0, dx, dy]) => [Math.ceil((width - x0) / dx), Math.ceil((height - y0) / dy)] as const)
  const expected = sizes.reduce((sum, [w, h]) => sum + (w && h ? h * (1 + Math.ceil((w * bitsPerPixel) / 8)) : 0), 0)
  const data = unzlib(packed, expected)

  const rgba = new Uint8Array(width * height * 4)
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1
  // The transparent grey or colour of a type 0 or 2 image, at its own depth.
  const key = alphas && (colour === 0 || colour === 2) ? Array.from({ length: colour === 0 ? 1 : 3 }, (_, i) => (alphas![i * 2]! << 8) | alphas![i * 2 + 1]!) : undefined
  let at = 0
  passes.forEach(([x0, y0, dx, dy], pass) => {
    const [w, h] = sizes[pass]!
    if (w === 0 || h === 0) return
    const lineBytes = Math.ceil((w * bitsPerPixel) / 8)
    unfilter(data, at, lineBytes, h, pixelBytes)
    for (let y = 0; y < h; y++) {
      const line = data.subarray(at + y * (lineBytes + 1) + 1, at + (y + 1) * (lineBytes + 1))
      // The common cases, 8-bit RGB and RGBA with no key colour, copied straight.
      if (depth === 8 && (colour === 6 || (colour === 2 && !key))) {
        for (let x = 0; x < w; x++) {
          const out = ((y0 + y * dy) * width + x0 + x * dx) * 4
          const from = x * channels
          rgba[out] = line[from]!
          rgba[out + 1] = line[from + 1]!
          rgba[out + 2] = line[from + 2]!
          rgba[out + 3] = colour === 6 ? line[from + 3]! : 255
        }
        continue
      }
      // Sample `c` of pixel `x`, at the image's depth.
      const sample = (x: number, c: number) => {
        if (depth === 8) return line[x * channels + c]!
        if (depth === 16) return (line[(x * channels + c) * 2]! << 8) | line[(x * channels + c) * 2 + 1]!
        const bitAt = (x * channels + c) * depth
        return (line[bitAt >> 3]! >> (8 - depth - (bitAt & 7))) & ((1 << depth) - 1)
      }
      const byte = (value: number) => (depth === 16 ? value >> 8 : Math.round(value * scale))
      for (let x = 0; x < w; x++) {
        const out = ((y0 + y * dy) * width + x0 + x * dx) * 4
        if (colour === 3) {
          const index = sample(x, 0)
          rgba[out] = palette?.[index * 3] ?? 0
          rgba[out + 1] = palette?.[index * 3 + 1] ?? 0
          rgba[out + 2] = palette?.[index * 3 + 2] ?? 0
          rgba[out + 3] = alphas?.[index] ?? 255
          continue
        }
        // Grey (with or without alpha) has one colour sample; the rest three.
        const isGrey = colour === 0 || colour === 4
        const r = sample(x, 0)
        const g = isGrey ? r : sample(x, 1)
        const b = isGrey ? r : sample(x, 2)
        const opaque = key && r === key[0] && (isGrey || (g === key[1] && b === key[2])) ? 0 : 255
        rgba[out] = byte(r)
        rgba[out + 1] = byte(g)
        rgba[out + 2] = byte(b)
        rgba[out + 3] = colour === 4 ? byte(sample(x, 1)) : colour === 6 ? byte(sample(x, 3)) : opaque
      }
    }
    at += h * (lineBytes + 1)
  })
  return { width, height, data: rgba }
}
