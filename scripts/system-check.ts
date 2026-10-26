// Runs hooks/system.ts against the real system it is on, as the engine would run its processes:
// folders, bytes written and read back (in pieces past 4 MiB), GIF frames, a conversion, a size, a
// removal. The mod's tests stand for the system with a world of their own; this is the system.
//
//     node --experimental-strip-types scripts/system-check.ts
//
// CI runs it on macOS, Ubuntu (with ImageMagick, and Tk on a virtual display) and Windows
// (PowerShell, System.Drawing, Windows Forms). Where the system can show a window by the pointer,
// one opens for a moment.
import { spawn, spawnSync } from 'node:child_process'
import { registerHooks } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The engine's ES2026 base64 methods, for a Node that lacks them.
const proto = Uint8Array.prototype as unknown as { toBase64?: () => string }
proto.toBase64 ??= function (this: Uint8Array) { return Buffer.from(this).toString('base64') }
const ctor = Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array }
ctor.fromBase64 ??= (text: string) => new Uint8Array(Buffer.from(text, 'base64'))

// The mod's imports name no extension, as the engine takes them: Node is told to try `.ts`.
registerHooks({
  resolve (specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (!specifier.startsWith('.')) throw error
      return next(`${specifier}.ts`, context)
    }
  }
})

const { parseBmp } = await import('../hooks/pixels.ts')
const { canShowWindows, convert, detect, makeFolder, readBytes, remove, tempFolder, touch, windowCommand, windowPath, writeBytes, writeFrames } = await import('../hooks/system.ts')

/** The part of the engine's `$` the system layer uses, run for real. */
const $ = {
  env: { get: async (name: string) => process.env[name] },
  process: {
    run: async (argv: string[], init: { env?: Record<string, string>; stdin?: string } = {}) => {
      const result = spawnSync(argv[0]!, argv.slice(1), { input: init.stdin, env: { ...process.env, ...init.env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      if (result.error) throw result.error
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, isStdoutTruncated: false, isStderrTruncated: false }
    }
  }
} as never

let failed = 0
function check (what: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed++
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i])

/** A PNG of `width` by `height`, a gradient, its deflate blocks stored (no compression). */
function png (width: number, height: number) {
  const raw: number[] = []
  for (let y = 0; y < height; y++) {
    raw.push(0)
    for (let x = 0; x < width; x++) raw.push((x * 7) & 255, (y * 5) & 255, ((x + y) * 3) & 255)
  }
  const blocks: number[] = [0x78, 0x01]
  for (let at = 0; at < raw.length; at += 65535) {
    const part = raw.slice(at, at + 65535)
    blocks.push(at + 65535 >= raw.length ? 1 : 0, part.length & 0xff, part.length >> 8, ~part.length & 0xff, (~part.length >> 8) & 0xff, ...part)
  }
  // The zlib stream's Adler-32 of the raw bytes: libpng (ImageMagick's) checks it.
  let a = 1
  let b = 0
  for (const byte of raw) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  blocks.push(b >> 8, b & 0xff, a >> 8, a & 0xff)
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (bytes: number[]) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const u32 = (n: number) => [24, 16, 8, 0].map(s => (n >>> s) & 0xff)
  const chunk = (type: string, body: number[]) => { const head = [...type].map(c => c.charCodeAt(0)); return [...u32(body.length), ...head, ...body, ...u32(crc([...head, ...body]))] }
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...u32(width), ...u32(height), 8, 2, 0, 0, 0]), ...chunk('IDAT', blocks), ...chunk('IEND', [])])
}

/** A PNG of a palette of one see-through colour, `width` by `height`, its deflate blocks stored. */
function palettePng (width: number, height: number) {
  const raw = new Array((width + 1) * height).fill(0)
  const blocks = [0x78, 0x01, 1, raw.length & 0xff, raw.length >> 8, ~raw.length & 0xff, (~raw.length >> 8) & 0xff, ...raw]
  const b = raw.length % 65521
  blocks.push(b >> 8, b & 0xff, 0, 1)
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (bytes: number[]) => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const u32 = (n: number) => [24, 16, 8, 0].map(s => (n >>> s) & 0xff)
  const chunk = (type: string, body: number[]) => { const head = [...type].map(c => c.charCodeAt(0)); return [...u32(body.length), ...head, ...body, ...u32(crc([...head, ...body]))] }
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...u32(width), ...u32(height), 8, 3, 0, 0, 0]), ...chunk('PLTE', [255, 0, 0]), ...chunk('tRNS', [0]), ...chunk('IDAT', blocks), ...chunk('IEND', [])])
}

const root = mkdtempSync(join(tmpdir(), 'inline-images-check-'))
const system = await detect($)
console.log(`system: ${system}; temp folder: ${await tempFolder($)}; working in ${root}`)

const folder = join(root, 'a', 'b')
await makeFolder($, folder)
check('makeFolder makes a folder and those above it', existsSync(folder))

const picture = png(300, 200)
const file = join(folder, 'picture.png')
await writeBytes($, file, picture.toBase64())
check('writeBytes writes the bytes it is given', same(new Uint8Array(readFileSync(file)), picture))

check('readBytes reads a file\'s first bytes', same(await readBytes($, file, 0, 32), picture.subarray(0, 32)))

const big = new Uint8Array(5 * 1024 * 1024 + 123).map((_, i) => (i * 31 + (i >> 9)) & 255)
const bigFile = join(root, 'big.bin')
writeFileSync(bigFile, big)
const piece = 2 * 1024 * 1024
const pieces = new Uint8Array(big.length)
for (let at = 0; at < big.length; at += piece) pieces.set((await readBytes($, bigFile, at, piece)).subarray(0, big.length - at), at)
check('readBytes reads a 5 MiB file whole, in 2 MiB pieces', same(pieces, big))

const frames = join(root, 'frames')
await makeFolder($, frames)
await writeFrames($, frames, [Uint8Array.of(1, 2, 3, 4).toBase64(), Uint8Array.of(5, 6, 7, 8).toBase64()])
check('writeFrames writes each frame to its own file', same(new Uint8Array(readFileSync(join(frames, '1.rgba'))), Uint8Array.of(5, 6, 7, 8)), readdirSync(frames).join(' '))

try {
  const size = await convert($, file, join(root, 'small.bmp'), 'bmp', 100)
  check('convert answers the picture\'s own size', size.width === 300 && size.height === 200, `${size.width}x${size.height}`)
  const bmp = new Uint8Array(readFileSync(join(root, 'small.bmp')))
  const view = new DataView(bmp.buffer, bmp.byteOffset)
  check('convert writes a BMP shrunk to the side asked for', bmp[0] === 0x42 && bmp[1] === 0x4d && view.getInt32(18, true) === 100, `${view.getInt32(18, true)} wide`)
  await convert($, file, join(root, 'small.jpg'), 'jpeg', 100)
  const jpeg = new Uint8Array(readFileSync(join(root, 'small.jpg')))
  check('convert writes a JPEG', jpeg[0] === 0xff && jpeg[1] === 0xd8, `${jpeg.length} bytes`)
  await convert($, file, join(root, 'same.png'), 'png', 1000)
  const out = new Uint8Array(readFileSync(join(root, 'same.png')))
  check('convert never enlarges a smaller picture', new DataView(out.buffer, out.byteOffset).getUint32(16) === 300)
  // A small palette PNG with a see-through colour: not resized, it is still made a BMP the cells
  // read (24 or 32 bits), its see-through pixel kept where the converter keeps alpha.
  const icon = join(root, 'icon.png')
  writeFileSync(icon, palettePng(8, 8))
  await convert($, icon, join(root, 'icon.bmp'), 'bmp', 800)
  const pixels = parseBmp(new Uint8Array(readFileSync(join(root, 'icon.bmp'))))
  check('convert makes a small palette PNG a BMP the cells read', pixels.width === 8, `${pixels.width}x${pixels.height}, alpha ${pixels.data[3]}`)
} catch (error) {
  check('convert', false, error instanceof Error ? error.message : String(error))
}

// The window by the pointer: its program, told in a file, opens the window with a spinner, then
// fills it with the picture and says `shown`; a picture it cannot read it says so of, and it ends
// when told.
if (await canShowWindows($)) {
  const commands = join(root, 'window.txt')
  writeFileSync(commands, '')
  const command = await windowCommand($, commands, 200)
  const child = spawn(command.argv[0]!, command.argv.slice(1), { env: { ...process.env, ...command.env } })
  let out = ''
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { out += chunk })
  const ended = new Promise(resolve => child.on('exit', resolve))
  const said = async (pattern: RegExp, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end && !pattern.test(out); ) await new Promise(resolve => setTimeout(resolve, 50))
    return pattern.test(out)
  }
  const tell = (number: number, verb: string, path = '', width = 0, height = 0) => writeFileSync(commands, `${number}\n${verb}\n${path}\n${width}\n${height}\nend\n`)
  check('the window\'s program starts and reads its commands', await said(/^ready$/m, 60_000), out.trim().split('\n').filter(line => line !== '.')[0]?.slice(0, 200))
  tell(1, 'show', '', 300, 200)
  await new Promise(resolve => setTimeout(resolve, 300))
  tell(2, 'show', (await windowPath($, file)) ?? file, 300, 200)
  check('the window shows the picture, in the window its spinner opened', await said(/^shown 2$/m, 10_000))
  tell(3, 'show', (await windowPath($, join(root, 'missing.png'))) ?? '')
  check('the window says which picture it cannot read', await said(/^error 3: /m, 10_000))
  tell(4, 'hide')
  await new Promise(resolve => setTimeout(resolve, 300))
  tell(5, 'quit')
  check('the window\'s program ends when told', await Promise.race([ended.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 10_000))]) as boolean)
  child.kill()
} else {
  console.log('skip the window by the pointer: this system cannot show one here')
}

await touch($, folder)
check('touch leaves the folder there', existsSync(folder))

await remove($, join(root, 'a'))
check('remove takes a folder and all in it', !existsSync(join(root, 'a')))
await remove($, join(root, 'not-there'))
check('remove of what is not there is no error', true)

await remove($, root)
console.log(failed === 0 ? 'all checks passed' : `${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
