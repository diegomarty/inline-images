// DEFLATE (RFC 1951) and the zlib wrapper around it (RFC 1950): what a PNG's image data is packed
// with. The hooks environment declares no DecompressionStream, so the mod inflates on its own.

/** A Huffman code: how many codes of each length, and the symbols in code order. */
type Huffman = { counts: Uint16Array; symbols: Uint16Array }

function huffman (lengths: Uint8Array): Huffman {
  const counts = new Uint16Array(16)
  for (const length of lengths) counts[length]!++
  counts[0] = 0
  const offsets = new Uint16Array(16)
  for (let i = 1; i < 16; i++) offsets[i] = offsets[i - 1]! + counts[i - 1]!
  const symbols = new Uint16Array(lengths.length)
  lengths.forEach((length, symbol) => {
    if (length !== 0) symbols[offsets[length]!++] = symbol
  })
  return { counts, symbols }
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
// The order the code lengths of a dynamic block's code-length code come in.
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

const FIXED_LITERALS = huffman(Uint8Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)))
const FIXED_DISTANCES = huffman(new Uint8Array(30).fill(5))

/** Inflates raw DEFLATE data, into a buffer grown as needed (`expected` bytes to start with). */
export function inflate (data: Uint8Array, expected = data.length * 4): Uint8Array {
  let out = new Uint8Array(Math.max(1024, expected))
  let size = 0
  let at = 0
  // The bits read ahead, lowest first, and how many.
  let held = 0
  let count = 0

  const room = (more: number) => {
    if (size + more <= out.length) return
    const grown = new Uint8Array(Math.max(out.length * 2, size + more))
    grown.set(out.subarray(0, size))
    out = grown
  }
  const bits = (wanted: number) => {
    while (count < wanted) {
      if (at >= data.length) throw new Error('truncated deflate data')
      held |= data[at++]! << count
      count += 8
    }
    const value = held & ((1 << wanted) - 1)
    held >>>= wanted
    count -= wanted
    return value
  }
  const decode = ({ counts, symbols }: Huffman) => {
    let code = 0
    let first = 0
    let index = 0
    for (let length = 1; length < 16; length++) {
      code |= bits(1)
      const count = counts[length]!
      if (code - first < count) return symbols[index + code - first]!
      index += count
      first = (first + count) << 1
      code <<= 1
    }
    throw new Error('a bad Huffman code')
  }

  for (let last = 0; !last;) {
    last = bits(1)
    const type = bits(2)
    if (type === 0) {
      // Stored: byte-aligned LEN and NLEN, then LEN bytes as they are. The bits read ahead past the
      // block's header are whole bytes of it, given back.
      at -= count >> 3
      held = 0
      count = 0
      const length = data[at]! | (data[at + 1]! << 8)
      at += 4
      room(length)
      out.set(data.subarray(at, at + length), size)
      size += length
      at += length
      continue
    }
    let literals = FIXED_LITERALS
    let distances = FIXED_DISTANCES
    if (type === 2) {
      const literalCount = bits(5) + 257
      const distanceCount = bits(5) + 1
      const codeCount = bits(4) + 4
      const codeLengths = new Uint8Array(19)
      for (let i = 0; i < codeCount; i++) codeLengths[ORDER[i]!] = bits(3)
      const codes = huffman(codeLengths)
      const lengths = new Uint8Array(literalCount + distanceCount)
      for (let i = 0; i < lengths.length;) {
        const symbol = decode(codes)
        if (symbol < 16) {
          lengths[i++] = symbol
          continue
        }
        const [repeat, value] = symbol === 16 ? [3 + bits(2), lengths[i - 1] ?? 0] : symbol === 17 ? [3 + bits(3), 0] : [11 + bits(7), 0]
        lengths.fill(value, i, i + repeat)
        i += repeat
      }
      literals = huffman(lengths.subarray(0, literalCount))
      distances = huffman(lengths.subarray(literalCount))
    } else if (type !== 1) {
      throw new Error('a bad deflate block')
    }
    for (;;) {
      const symbol = decode(literals)
      if (symbol < 256) {
        room(1)
        out[size++] = symbol
        continue
      }
      if (symbol === 256) break
      const lengthAt = symbol - 257
      const length = LENGTH_BASE[lengthAt]! + bits(LENGTH_EXTRA[lengthAt]!)
      const distanceAt = decode(distances)
      const distance = DISTANCE_BASE[distanceAt]! + bits(DISTANCE_EXTRA[distanceAt]!)
      if (distance > size) throw new Error('a deflate distance past the start')
      room(length)
      for (let i = 0; i < length; i++, size++) out[size] = out[size - distance]!
    }
  }
  return out.subarray(0, size)
}

/** Inflates zlib data: two bytes of header, then DEFLATE (the checksum after it is not checked). */
export function unzlib (data: Uint8Array, expected?: number) {
  if (data.length < 2 || (data[0]! & 0x0f) !== 8 || ((data[0]! << 8) | data[1]!) % 31 !== 0) throw new Error('not zlib data')
  return inflate(data.subarray(2), expected)
}
