// Mod tests, run against the engine itself: `claude plugin test .`
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { Budget } from './budget'
import { countFrames, decodeGif, shrink } from './gif'
import { decodePng } from './png'

// A PNG of one red pixel.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const SCREEN = { columns: 120, rows: 40, isFullscreen: true }

/** A GIF 2×1 of a red and a blue palette, one frame per entry of `frames`, each all of one palette index. */
function gif (frames: number[], delay = 20) {
  const bytes = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 2, 0, 1, 0, 0x80, 0, 0, 255, 0, 0, 0, 0, 255]
  for (const index of frames) {
    // The graphic control extension, then the image: clear, the index twice, end, in 3-bit codes.
    bytes.push(0x21, 0xf9, 4, 0, delay, 0, 0, 0)
    const code = 4 | (index << 3) | (index << 6) | (5 << 9)
    bytes.push(0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0, 2, 2, code & 0xff, code >> 8, 0)
  }
  bytes.push(0x3b)
  return Uint8Array.from(bytes)
}

/** A 24-bit bottom-up BMP of one pixel, `0xRRGGBB`, as sips writes one. */
function bmp (color: number) {
  const bytes = new Uint8Array(58)
  const view = new DataView(bytes.buffer)
  bytes.set([0x42, 0x4d])
  view.setUint32(2, bytes.length, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, 1, true)
  view.setInt32(22, 1, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  bytes.set([color & 0xff, (color >> 8) & 0xff, color >> 16], 54)
  return bytes.toBase64()
}

/**
 * A PNG of a palette, `width` by `height`, every pixel index 0, its deflate blocks stored; with a
 * tRNS chunk (index 0 see-through) where `isSeeThrough`.
 */
function palettePng (width: number, height: number, isSeeThrough: boolean) {
  const raw = new Uint8Array((width + 1) * height)
  const blocks: number[] = [0x78, 0x01]
  for (let at = 0; at < raw.length; at += 65535) {
    const length = Math.min(65535, raw.length - at)
    blocks.push(at + length >= raw.length ? 1 : 0, length & 0xff, length >> 8, ~length & 0xff, (~length >> 8) & 0xff)
    for (let i = 0; i < length; i++) blocks.push(0)
  }
  // Adler-32 of zeros: a is 1, b is the count.
  const b = raw.length % 65521
  blocks.push(b >> 8, b & 0xff, 0, 1)
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (bytes: number[]) => { let c = 0xffffffff; for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const u32 = (n: number) => [24, 16, 8, 0].map(s => (n >>> s) & 0xff)
  const chunk = (type: string, body: number[]) => { const head = [...type].map(c => c.charCodeAt(0)); return [...u32(body.length), ...head, ...body, ...u32(crc([...head, ...body]))] }
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...u32(width), ...u32(height), 8, 3, 0, 0, 0]), ...chunk('PLTE', [255, 255, 255]), ...(isSeeThrough ? chunk('tRNS', [0]) : []), ...chunk('IDAT', blocks), ...chunk('IEND', [])]).toBase64()
}

const FOUR_MIB = 4 * 1024 * 1024
const decoded = (base64: string) => Uint8Array.fromBase64(base64)

/** `base64`'s bytes followed by zeros up to `size`: a file that large, as the mod reads it. */
const padded = (base64: string, size: number) => {
  const bytes = new Uint8Array(size)
  bytes.set(decoded(base64))
  return bytes.toBase64()
}

/**
 * Everything beneath the mod: the session, its files (base64, by path, each with its mtime), the
 * processes it runs (head, dd, base64, sips, git) and what the engine draws. Like the engine's,
 * `fs.read` rejects a file of 4 MiB or more, and `fs.stat` one that is not there.
 */
function world (on: On, { env = { TERM_PROGRAM: 'ghostty' } as Record<string, string>, files = {} as Record<string, string>, tracked = [] as string[], sizes = {} as Record<string, { width: number; height: number }>, dirs = {} as Record<string, number>, now = 0, uname = 'Darwin', missing = [] as string[], window = 'shown' as 'shown' | 'error' | 'unreadable' | 'crash', startMs = 0, tui = 'fullscreen' as string | null } = {}) {
  const clock = mock.clock(on, { now })
  const asked = { sessionId: 0, promptReads: 0 }
  mock.env(on, env)
  const session = { id: 's-1' }
  // The prompt box: what is typed in it so far. The folders made.
  const box = { text: '' }
  const made = new Set<string>()
  const mtimes: Record<string, number> = {}
  const runs: { argv: string[]; stdin?: string }[] = []
  const reads: string[] = []
  const exists: string[] = []
  const stats: string[] = []
  const blits: { requestId: string; key: string; source?: unknown; cells?: string }[] = []
  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  // PowerShell, as the mod runs it: told the paths in the environment, known by what its script does.
  const scripts: string[] = []
  const powershell = (argv: string[], vars: Record<string, string>, stdin?: string) => {
    const bytes = decoded(argv.at(-1)!)
    const script = String.fromCharCode(...Array.from({ length: bytes.length / 2 }, (_, i) => bytes[i * 2]! | (bytes[i * 2 + 1]! << 8)))
    scripts.push(script)
    const path = vars.INLINE_IMAGES_PATH!
    if (script.includes('New-Item')) made.add(path)
    else if (script.includes('Remove-Item')) delete files[path]
    else if (script.includes('ReadToEnd')) files[path] = stdin!.trim()
    else if (script.includes('OpenRead')) return ok(decoded(files[path] ?? '').subarray(Number(vars.INLINE_IMAGES_AT), Number(vars.INLINE_IMAGES_AT) + Number(vars.INLINE_IMAGES_COUNT)).toBase64())
    else if (script.includes('.Save(')) files[vars.INLINE_IMAGES_OUT!] = vars.INLINE_IMAGES_FORMAT === 'bmp' ? bmp(0xff0000) : PNG
    else if (script.includes('$image.Width')) {
      const size = sizes[path] ?? { width: 1, height: 1 }
      return ok(`${size.width} ${size.height}`)
    }
    return ok()
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => {
    asked.sessionId++
    return { value: session.id }
  })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.read', () => {
    asked.promptReads++
    return { value: { text: box.text, cursor: box.text.length } }
  })
  on('session.root', () => ({ value: '/project/app' }))
  on('session.cwd', () => ({ value: '/project/app' }))
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    runs.push({ argv, stdin: e.init?.stdin })
    // wslpath takes a moment, as a process does: a pointer can leave meanwhile.
    if (argv[0] === 'wslpath') await clock.sleep(30)
    if (missing.includes(argv[0]!)) return { value: { exitCode: 127, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === 'id') return ok('501\n')
    if (argv[0] === 'mkdir') made.add(argv.at(-1)!)
    if (argv[0] === 'rm') {
      delete files[argv.at(-1)!]
      made.delete(argv.at(-1)!)
    }
    if (argv[0] === 'uname') return ok(`${uname}\n`)
    // A path with no Windows form (as one wslpath cannot reach) prints nothing.
    if (argv[0] === 'wslpath') return argv[2]!.includes('/nowin/') ? { value: { exitCode: 1, stdout: '', stderr: 'wslpath: no such path\n', isStdoutTruncated: false, isStderrTruncated: false } } : ok(`\\\\wsl.localhost\\Ubuntu${argv[2]!.replaceAll('/', '\\')}\n`)
    if (argv[0] === 'powershell' || argv[0] === 'powershell.exe') return powershell(argv, e.init?.env ?? {}, e.init?.stdin)
    if (argv[0] === 'git') return ok(tracked.join('\0'))
    if (argv[0] === 'sips' && argv[1] === '-g') {
      const size = sizes[argv.at(-1)!] ?? { width: 1, height: 1 }
      return ok(`${argv.at(-1)}\n  pixelWidth: ${size.width}\n  pixelHeight: ${size.height}\n`)
    }
    // ImageMagick: `magick identify` (or `identify`) tells a size; `magick` (or `convert`) writes `PNG:out` or `BMP:out`.
    if ((argv[0] === 'magick' && argv[1] === 'identify') || argv[0] === 'identify') {
      const size = sizes[argv.at(-1)!.replace(/\[0\]$/, '')] ?? { width: 1, height: 1 }
      return ok(`${size.width} ${size.height}`)
    }
    if (argv[0] === 'magick' || argv[0] === 'convert') {
      const [format, out] = argv.at(-1)!.split(/:(.*)/) as [string, string]
      files[out] = format === 'BMP' ? bmp(0xff0000) : PNG
      return ok()
    }
    if (argv[0] === 'sips') {
      const out = argv[argv.indexOf('--out') + 1]!
      files[out] = argv[3] === 'bmp' ? bmp(0xff0000) : PNG
      return ok()
    }
    if (argv[0] === 'sh' && argv[2]?.includes('base64 --decode >') && e.init?.stdin) files[argv[3]!] = e.init.stdin
    // `head -c <count> <file> | base64`: the file's first bytes.
    if (argv[0] === 'sh' && argv[2]?.startsWith('head -c')) return ok(decoded(files[argv[3]!] ?? '').subarray(0, Number(argv[4])).toBase64())
    // `tail -c +<from> <file> | head -c <count> | base64`: bytes from <from>, counted from 1.
    if (argv[0] === 'sh' && argv[2]?.startsWith('tail ')) {
      const [file, count, from] = [argv[3]!, Number(argv[4]), Number(argv[5])]
      return ok(decoded(files[file]!).subarray(from - 1, from - 1 + count).toBase64())
    }
    return ok()
  })
  on('fs.exists', ($, e) => {
    const path = local(e.path)
    exists.push(path)
    return { value: path in files }
  })
  const lists: string[] = []
  const local = (path: string) => path.replace(/^.*?\/(?=[A-Za-z]:[\\/])/, '')
  const children = (dir: string, paths: string[]) => paths.filter(path => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'))
  on('fs.list', ($, e) => {
    lists.push(local(e.path))
    return listOf(local(e.path))
  })
  const listOf = (dir: string) => ({
    value: [
      ...children(dir, Object.keys(files)).map(path => ({ name: path.slice(dir.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
      ...children(dir, Object.keys(dirs)).map(path => ({ name: path.slice(dir.length + 1), kind: 'dir' as const, size: 0, mtimeMs: dirs[path]!, isLink: false }))
    ]
  })
  on('fs.stat', ($, e) => {
    const path = local(e.path)
    stats.push(path)
    if (made.has(path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    if (!(path in files)) throw new Error(`ENOENT: ${path}`)
    return { value: { kind: 'file' as const, size: decoded(files[path]!).length, mtimeMs: mtimes[path] ?? 0, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const path = local(e.path)
    reads.push(path)
    if (!(path in files)) throw new Error(`ENOENT: ${path}`)
    if (decoded(files[path]!).length >= FOUR_MIB) throw new Error('over 4 MiB')
    return { value: { base64: files[path]! } }
  })
  // The settings: the interface the session runs in.
  on('settings.read', ($, e) => {
    return ({ value: tui === null ? {} : { tui } }) as never
  })
  // What the mod writes, by path.
  const written: Record<string, string> = {}
  on('fs.write', ($, e) => {
    written[local(e.path)] = e.text
    return { value: undefined }
  })
  // The window's program (window.ts), one a session: it says `.`, then `ready` (`startMs` on), and
  // reads its commands every 40 ms, doing the latest; a picture it shows it says `shown <n>` of, one
  // it cannot read `error <n>: …`. Or it cannot run at all, for want of a display.
  const windows: { argv: string[]; env: Record<string, string>; isEnded: boolean }[] = []
  const shows: { verb: string; path: string; width: number; height: number }[] = []
  on('process.spawn', async function * ($, e) {
    const started = { argv: [...e.argv], env: { ...e.env }, isEnded: false }
    windows.push(started)
    try {
      yield { stream: 'stdout' as const, text: '.\n' }
      if (window === 'error') {
        yield { stream: 'stdout' as const, text: 'error: no display\n' }
        return { value: { code: 1, signal: null } }
      }
      if (startMs > 0) await clock.sleep(startMs)
      yield { stream: 'stdout' as const, text: 'ready\n' }
      // One that ends on its own once ready.
      if (window === 'crash') return { value: { code: 1, signal: null } }
      let last = 0
      for (;;) {
        const lines = (written[local(started.env.INLINE_IMAGES_COMMANDS ?? '')] ?? '').split('\n')
        const number = Number(lines[0])
        if (lines[5] === 'end' && number > last) {
          last = number
          const [, verb = '', path = '', width, height] = lines
          if (verb === 'quit') return { value: { code: 0, signal: null } }
          shows.push({ verb, path, width: Number(width), height: Number(height) })
          if (verb === 'show' && path) yield { stream: 'stdout' as const, text: window === 'unreadable' ? `error ${number}: cannot read the image\n` : `shown ${number}\n` }
        }
        await clock.sleep(40)
        yield { stream: 'stdout' as const, text: '.\n' }
      }
    } finally {
      started.isEnded = true
    }
  })
  on('ui.blit', ($, e) => {
    blits.push(e as never)
    return { value: {} }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  return { clock, runs, reads, exists, stats, lists, blits, files, mtimes, tracked, session, asked, box, scripts, windows, shows, written }
}

const startSession = ($: Engine) => $.session.start({ cwd: '/project/app', surface: 'terminal', isInteractive: true })

const readResult = ($: Engine, output: unknown, onScreen: { first: number; last: number; of: number } | null = { first: 0, last: 1, of: 2 }) =>
  $.ui.mount({
    plugin: 'inline-images',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'tu-1',
    props: { tool_use_id: 'tu-1', tool: 'Read', output, isErrored: false, onScreen },
    viewport: SCREEN
  })

const image = (base64: string, type = 'image/png', originalSize = decoded(base64).length) => ({ type: 'image', file: { base64, type, originalSize } })

test('decodes every frame of a GIF, with its delay', () => {
  const { width, height, frames } = decodeGif(gif([0, 1], 30))
  expect([width, height, frames.length]).toEqual([2, 1, 2])
  expect([...frames[0]!.data]).toEqual([255, 0, 0, 255, 255, 0, 0, 255])
  expect([...frames[1]!.data]).toEqual([0, 0, 255, 255, 0, 0, 255, 255])
  expect(frames.map(frame => frame.delay)).toEqual([300, 300])
})

test('plays a frame asking for no delay at the pace browsers do', () => {
  expect(decodeGif(gif([0], 0)).frames[0]!.delay).toBe(100)
})

test('shrinks a picture to fit, averaging what each pixel covers', () => {
  const { width, height, data } = shrink(decodeGif(gif([0])).frames[0]!, 1, 1)
  expect([width, height, ...data]).toEqual([1, 1, 255, 0, 0, 255])
})

test('a picture Claude reads shows under its row, from the file it read', async ($, on) => {
  world(on, { files: { '/project/app/shot.png': PNG } })
  await startSession($)
  await $.ui.mount({ plugin: 'inline-images', surface: 'terminal', component: 'ToolUse', requestId: 'tu-1', props: { tool_use_id: 'tu-1', tool: 'Read', input: { file_path: '/project/app/shot.png' }, isRunning: false, isErrored: false, isInterrupted: false }, viewport: SCREEN })
  const row = await readResult($, image(PNG))
  expect(await row.find({ key: 'engine' })).toBeDefined()
  expect(await row.find({ type: 'Image' })).toMatchObject({ props: { source: { file: '/project/app/shot.png', format: 'png' }, columns: 1, rows: 1, alt: 'shot.png' } })
})

test('a picture whose file is gone shows from the bytes Claude read', async ($, on) => {
  const w = world(on)
  await startSession($)
  const row = await readResult($, image(PNG))
  expect(await row.find({ type: 'Image' })).toMatchObject({ props: { source: { format: 'png' } } })
  const written = w.runs.find(run => run.argv[2]?.includes('base64 --decode >'))
  expect(written?.stdin).toBe(PNG)
})

test('a GIF plays while it shows, each frame swapped in after its delay', async ($, on) => {
  const w = world(on)
  await startSession($)
  const row = await readResult($, image(gif([0, 1]).toBase64(), 'image/gif'))
  const drawn = await row.find({ type: 'Image' })
  expect(drawn).toMatchObject({ props: { source: { format: 'rgba', width: 2, height: 1 } } })
  // Both frames written to files the terminal reads, in one process.
  expect(w.runs.find(run => run.argv[2]?.includes('.rgba'))?.stdin?.split('\n').filter(Boolean)).toHaveLength(2)
  await w.clock.advance(200)
  expect(w.blits).toHaveLength(1)
  expect(w.blits[0]).toMatchObject({ requestId: 'tu-1', source: { file: expect.stringMatching(/\/1\.rgba$/) } })
  await w.clock.advance(200)
  expect(w.blits[1]).toMatchObject({ source: { file: expect.stringMatching(/\/0\.rgba$/) } })
})

test('a GIF off screen does not play', async ($, on) => {
  const w = world(on)
  await startSession($)
  await readResult($, image(gif([0, 1]).toBase64(), 'image/gif'), null)
  await w.clock.advance(1000)
  expect(w.blits).toHaveLength(0)
})

test('a terminal that cannot draw pictures gets them in colored cells', async ($, on) => {
  world(on, { env: { TERM_PROGRAM: 'Apple_Terminal' } })
  await startSession($)
  const row = await readResult($, image(gif([0, 1]).toBase64(), 'image/gif'))
  expect(await row.find({ type: 'Raster' })).toMatchObject({ props: { columns: 1, rows: 1 } })
  expect(await row.find({ type: 'Image' })).toBeUndefined()
})

test('a local picture an answer links to shows under it; a link to no file draws nothing', async ($, on) => {
  world(on, { files: { '/project/app/out/chart.png': PNG } })
  await startSession($)
  const reply = (text: string, requestId: string) => $.ui.mount({ plugin: 'inline-images', surface: 'terminal', component: 'AssistantMessage', requestId, props: { text, isFirstOfReply: true }, viewport: SCREEN })
  const linked = await reply('Here it is: ![the chart](./out/chart.png)', 'a-1')
  expect(await linked.find({ type: 'Image' })).toMatchObject({ props: { source: { file: '/project/app/out/chart.png' }, alt: 'chart.png' } })
  const missing = await reply('See ![none](missing.png) and ![web](https://example.com/a.png)', 'a-2')
  expect(await missing.find({ type: 'Image' })).toBeUndefined()
  expect(await missing.find({ type: 'Text', text: /no preview/ })).toBeUndefined()
})

/** `/images <args>`, as the person types it. */
const images = ($: Engine, args: string) =>
  $.command.run({ command: 'images', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

const answer = ($: Engine, text: string, requestId = 'a-1', onScreen: { first: number; last: number; of: number } | null = { first: 0, last: 9, of: 10 }) =>
  $.ui.mount({ plugin: 'inline-images', surface: 'terminal', component: 'AssistantMessage', requestId, props: { text, isFirstOfReply: true, onScreen }, viewport: SCREEN })

test('a picture an answer only names gets a chip beside the block that names it, found under the working folder by its name', async ($, on) => {
  world(on, { files: { '/project/app/docs/media/leads.gif': gif([0, 1]).toBase64() }, tracked: ['docs/media/leads.gif', 'src/index.ts'] })
  await startSession($)
  const row = await answer($, 'The README has two:\n\n1. Imagen: `leads.gif` (2,6 MB), in `docs/media/`\n2. And `other.png`, which is not there.')
  expect((await row.findAll({ type: 'Markdown' })).map(block => block.props.text)).toEqual([
    'The README has two:',
    '1. Imagen: `leads.gif` (2,6 MB), in `docs/media/`',
    '2. And `other.png`, which is not there.'
  ])
  expect(await row.find({ key: 'ref:0' })).toMatchObject({ type: 'Client', props: { module: 'hooks/chip.tsx', props: { label: 'leads.gif' } } })
  // Beside the list item that names it.
  expect(JSON.stringify(await row.find({ key: 'block-1' }))).toContain('"ref:0"')
  expect(await row.find({ key: 'ref:1' })).toBeUndefined()
  expect(await row.find({ type: 'Image' })).toBeUndefined()
})

test('the pointer on a chip opens its picture in a card over the answer; leaving closes it, a click opens the file', { options: { click: true } }, async ($, on) => {
  const w = world(on, { files: { '/project/app/shot.png': PNG } })
  await startSession($)
  const row = await answer($, 'First.\n\nSecond.\n\nI saved it as shot.png.', 'a-1', { first: 0, last: 9, of: 10 })
  // Each block's probe says how tall it was laid out: rows 0-1, 3-4 and 6.
  for (const [i, rows] of [2, 2, 1].entries()) await row.post({ rows }, { in: `probe:${i}` })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  // The card is 4 rows (the border, a one-row picture, the caption): over the rows above the third block.
  expect(await row.find({ key: 'card' })).toMatchObject({ props: { position: 'absolute', top: 2 } })
  expect(await row.find({ type: 'Image' })).toMatchObject({ props: { source: { file: '/project/app/shot.png' }, alt: 'shot.png' } })
  // As wide as its caption, every cell beside the one-cell picture written: the answer does not show through.
  expect(await row.find({ key: 'frame' })).toMatchObject({ props: { width: 10 } })
  expect(await row.find({ type: 'Text', text: '   ' })).toBeDefined()
  expect(await row.find({ type: 'Text', text: '    ' })).toBeDefined()
  expect(await row.find({ type: 'Text', text: 'shot.png' })).toBeDefined()
  await row.pointer({ type: 'leave', x: 0, y: 0, in: 'ref:0' })
  expect(await row.find({ key: 'card' })).toBeUndefined()
  await row.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'ref:0' })
  await row.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'ref:0' })
  expect(w.runs.some(run => run.argv[0] === 'open' && run.argv[1] === '/project/app/shot.png')).toBe(true)
})

test('with clicks off, the pointer on a chip still opens its card; a click opens nothing and leaves the card open', async ($, on) => {
  const w = world(on, { files: { '/project/app/shot.png': PNG } })
  await startSession($)
  const row = await answer($, 'First.\n\nSecond.\n\nI saved it as shot.png.', 'a-1', { first: 0, last: 9, of: 10 })
  for (const [i, rows] of [2, 2, 1].entries()) await row.post({ rows }, { in: `probe:${i}` })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  expect(await row.find({ key: 'card' })).toBeDefined()
  await row.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'ref:0' })
  await row.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'ref:0' })
  expect(w.runs.some(run => run.argv[0] === 'open')).toBe(false)
  expect(await row.find({ key: 'card' })).toBeDefined()
})

test('a card with too few rows above its block opens over the rows below it', async ($, on) => {
  world(on, { files: { '/project/app/shot.png': PNG } })
  await startSession($)
  // The answer's top scrolled away: no rows above it on screen to count on.
  const row = await answer($, 'See shot.png here.\n\nAnd more.\n\nAnd more still.\n\nThe end.', 'a-1', { first: 1, last: 19, of: 20 })
  for (const [i, rows] of [2, 4, 4, 4].entries()) await row.post({ rows }, { in: `probe:${i}` })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  expect(await row.find({ key: 'card' })).toMatchObject({ props: { top: 2 } })
})

test('a picture embedded in an answer shows under its paragraph, its markdown not written as well', async ($, on) => {
  world(on, { files: { '/project/app/out/chart.png': PNG } })
  await startSession($)
  const row = await answer($, 'Here it is:\n\n![the chart](out/chart.png)\n\nDone.')
  expect((await row.findAll({ type: 'Markdown' })).map(block => block.props.text)).toEqual(['Here it is:', 'Done.'])
  expect(JSON.stringify(await row.find({ key: 'block-1' }))).toContain('"Image"')
})

test('a picture the answer embeds gets no chip of its own', async ($, on) => {
  world(on, { files: { '/project/app/out/chart.png': PNG } })
  await startSession($)
  const row = await answer($, 'Here: ![chart](out/chart.png), saved as out/chart.png')
  expect(await row.find({ type: 'Image' })).toBeDefined()
  expect(await row.find({ key: 'ref:0' })).toBeUndefined()
})

// --- What the review found, each kept fixed.

const readRow = ($: Engine, id: string, path: string) =>
  $.ui.mount({ plugin: 'inline-images', surface: 'terminal', component: 'ToolUse', requestId: id, props: { tool_use_id: id, tool: 'Read', input: { file_path: path }, isRunning: false, isErrored: false, isInterrupted: false }, viewport: SCREEN })

const resultRow = ($: Engine, id: string, output: unknown) =>
  $.ui.mount({ plugin: 'inline-images', surface: 'terminal', component: 'ToolResult', requestId: id, props: { tool_use_id: id, tool: 'Read', output, isErrored: false, onScreen: { first: 0, last: 1, of: 2 } }, viewport: SCREEN })

test('a picture over 4 MiB is drawn: a PNG from its header alone, a GIF read in pieces', async ($, on) => {
  const big = padded(PNG, 5 * 1024 * 1024)
  const bigGif = padded(gif([0, 1]).toBase64(), 5 * 1024 * 1024)
  const w = world(on, { files: { '/project/app/big.png': big, '/project/app/big.gif': bigGif } })
  await startSession($)
  await readRow($, 'tu-1', '/project/app/big.png')
  const png = await resultRow($, 'tu-1', image(PNG, 'image/png', decoded(big).length))
  expect(await png.find({ type: 'Image' })).toMatchObject({ props: { source: { file: '/project/app/big.png', format: 'png' } } })
  expect(w.reads).not.toContain('/project/app/big.png')
  await readRow($, 'tu-2', '/project/app/big.gif')
  const anim = await resultRow($, 'tu-2', image(gif([0, 1]).toBase64(), 'image/gif', decoded(bigGif).length))
  expect(await anim.find({ type: 'Image' })).toMatchObject({ props: { source: { format: 'rgba', width: 2, height: 1 } } })
  // Three pieces of 2 MiB: the first through head, the rest through tail.
  expect(w.runs.filter(run => /^(head|tail) /.test(run.argv[2] ?? '') && run.argv[3] === '/project/app/big.gif' && run.argv[4] === String(2 * 1024 * 1024))).toHaveLength(3)
})

test('a picture that cannot be read is not tried again on every redraw, but is once its file is there', async ($, on) => {
  const w = world(on)
  await startSession($)
  const text = 'Here: ![chart](out/chart.png)'
  await answer($, text, 'a-1')
  await answer($, text, 'a-2')
  await answer($, text, 'a-3')
  expect(w.stats.filter(path => path === '/project/app/out/chart.png')).toHaveLength(1)
  // The file written later: looked at again once the last look is old, and drawn.
  w.files['/project/app/out/chart.png'] = PNG
  await w.clock.advance(4000)
  // Its drawing looks again and reads the picture; a drawing waiting on it draws again with it.
  const row = await answer($, text, 'a-4')
  await w.clock.advance(10)
  expect(await row.find({ type: 'Image' })).toMatchObject({ props: { source: { file: '/project/app/out/chart.png' } } })
})

test('a GIF is shrunk as it is decoded, its frames counted first', () => {
  expect(countFrames(gif([0, 1, 0]))).toBe(3)
  const told: number[][] = []
  const { frames } = decodeGif(gif([0, 1]), 500, (width, height, count) => {
    told.push([width, height, count])
    return 1
  })
  expect(told).toEqual([[2, 1, 2]])
  expect(frames.map(frame => [frame.width, frame.height])).toEqual([[1, 1], [1, 1]])
  expect([...frames[1]!.data]).toEqual([0, 0, 255, 255])
})

test("after /clear, a pasted [Image #1] is the new session's", async ($, on) => {
  const folder = '/tmp/claude-501/-project-app'
  const w = world(on, { files: { [`${folder}/s-2/images`]: '', [`${folder}/s-2/images/1.png`]: PNG } })
  await startSession($)
  const sent = (requestId: string) => $.ui.mount({ plugin: 'inline-images', surface: 'terminal', component: 'UserMessage', requestId, props: { text: 'look [Image #1]', origin: { kind: 'composer' }, isExpanded: false }, viewport: SCREEN })
  await sent('m-1')
  await w.clock.advance(4000)
  // A /clear: the session ends, the process goes on under another id, with no session.start.
  await $.session.end({ reason: 'clear', sessionId: 's-1', resume: { id: 's-1' } })
  w.session.id = 's-2'
  await sent('m-2')
  await w.clock.advance(10)
  const row = await sent('m-3')
  expect(await row.find({ type: 'Image' })).toMatchObject({ props: { source: { file: `${folder}/s-2/images/1.png` }, alt: '[Image #1]' } })
})

test('a picture shown as code is left as code: in a fence and in a code span', async ($, on) => {
  world(on, { files: { '/project/app/docs/logo.png': PNG, '/project/app/shot.png': PNG } })
  await startSession($)
  const fence = '```md\n![logo](docs/logo.png)\n```'
  // Nothing but code: the engine draws the answer as it is.
  const plain = await answer($, `The README starts:\n\n${fence}`, 'a-1')
  expect(await plain.find({ key: 'engine' })).toBeDefined()
  expect(await plain.find({ type: 'Image' })).toBeUndefined()
  // An answer the mod draws (it names shot.png): its code is drawn whole, no picture taken out of it.
  const drawn = await answer($, `The README starts:\n\n${fence}\n\nand \`![logo](docs/logo.png)\` stays, see shot.png.`, 'a-2')
  expect(await drawn.find({ type: 'Image' })).toBeUndefined()
  expect((await drawn.findAll({ type: 'Markdown' })).map(block => block.props.text)).toEqual(['The README starts:', fence, 'and `![logo](docs/logo.png)` stays, see shot.png.'])
})

test('a Read row shows the bytes Claude read once its file has changed', async ($, on) => {
  const w = world(on, { files: { '/project/app/shot.png': padded(PNG, 200) } })
  await startSession($)
  await readRow($, 'tu-1', '/project/app/shot.png')
  // Claude read the 1-pixel PNG; the file is another now.
  const row = await resultRow($, 'tu-1', image(PNG))
  expect(await row.find({ type: 'Image' })).toMatchObject({ props: { source: { file: expect.stringMatching(/\.source\.png$/) } } })
  expect(w.runs.find(run => run.argv[2]?.includes('base64 --decode >'))?.stdin).toBe(PNG)
})

test('a picture Claude writes after answering gets its chip, once the index is old', async ($, on) => {
  const w = world(on, { tracked: ['src/index.ts'] })
  await startSession($)
  const text = 'Saved it as `demo.gif`.'
  expect(await (await answer($, text, 'a-1')).find({ key: 'ref:0' })).toBeUndefined()
  w.tracked.push('docs/media/demo.gif')
  w.files['/project/app/docs/media/demo.gif'] = gif([0, 1]).toBase64()
  await w.clock.advance(4000)
  expect(await (await answer($, text, 'a-2')).find({ key: 'ref:0' })).toMatchObject({ props: { props: { label: 'demo.gif' } } })
})

test('over ssh the terminal is sent the picture; under tmux it is drawn in cells', async ($, on) => {
  world(on, { env: { TERM: 'xterm-kitty', SSH_CONNECTION: '10.0.0.2 51234 10.0.0.1 22' } })
  await startSession($)
  const row = await resultRow($, 'tu-1', image(PNG))
  expect(await row.find({ type: 'Image' })).toMatchObject({ props: { source: { png: PNG } } })
})

test('under tmux a picture is drawn in cells, even from Ghostty', async ($, on) => {
  world(on, { env: { TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux-501/default,1,0' } })
  await startSession($)
  const row = await resultRow($, 'tu-1', image(PNG))
  expect(await row.find({ type: 'Raster' })).toBeDefined()
  expect(await row.find({ type: 'Image' })).toBeUndefined()
})

test('a small picture is not enlarged to convert it, and takes the cells of its own size', async ($, on) => {
  const w = world(on, { files: { '/project/app/icon.jpg': Uint8Array.of(0xff, 0xd8, 0xff, 0xe0).toBase64() }, sizes: { '/project/app/icon.jpg': { width: 64, height: 64 } } })
  await startSession($)
  await readRow($, 'tu-1', '/project/app/icon.jpg')
  const row = await resultRow($, 'tu-1', image(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0).toBase64(), 'image/jpeg'))
  const converted = w.runs.find(run => run.argv[0] === 'sips' && run.argv[1] === '-s')
  expect(converted?.argv).not.toContain('-Z')
  expect(await row.find({ type: 'Image' })).toMatchObject({ props: { columns: 8, rows: 4 } })
})

test('a card over an answer with rows under it stays on its rows, not above the screen', async ($, on) => {
  world(on, { files: { '/project/app/shot.png': PNG } })
  await startSession($)
  const row = await answer($, 'See shot.png.', 'a-1', { first: 0, last: 0, of: 1 })
  await row.post({ rows: 1 }, { in: 'probe:0' })
  // A later row under it: the answer is not at the foot of the screen.
  await $.ui.mount({ plugin: 'inline-images', surface: 'terminal', component: 'UserMessage', requestId: 'm-2', props: { text: 'and then?', origin: { kind: 'composer' }, isExpanded: false }, viewport: SCREEN })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  expect(await row.find({ key: 'card' })).toBeUndefined()
})

test('the newest answer, at the foot of the screen, opens its card over the rows above it', async ($, on) => {
  world(on, { files: { '/project/app/shot.png': PNG } })
  await startSession($)
  const row = await answer($, 'See shot.png.', 'a-1', { first: 0, last: 0, of: 1 })
  await row.post({ rows: 1 }, { in: 'probe:0' })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  expect(await row.find({ key: 'card' })).toMatchObject({ props: { top: -4 } })
})

test('a card waits for every block above its chip to be measured', async ($, on) => {
  world(on, { files: { '/project/app/shot.png': PNG } })
  await startSession($)
  const row = await answer($, 'First.\n\nSecond.\n\nI saved it as shot.png.', 'a-1', { first: 0, last: 9, of: 10 })
  await row.post({ rows: 1 }, { in: 'probe:2' })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  expect(await row.find({ key: 'card' })).toBeUndefined()
  for (const [i, rows] of [2, 2].entries()) await row.post({ rows }, { in: `probe:${i}` })
  expect(await row.find({ key: 'card' })).toMatchObject({ props: { top: 2 } })
})

// --- Lighter on the engine, the memory and the disk.

test('the memory budget drops the least recently used, never one in use nor the one just kept', () => {
  const dropped: string[] = []
  const budget = new Budget<string>(10, key => dropped.push(key), key => key === 'playing')
  budget.set('playing', 'p', 4)
  budget.set('a', 'a', 4)
  budget.get('playing')
  budget.set('b', 'b', 4)
  expect(dropped).toEqual(['a'])
  expect(budget.keys()).toEqual(['playing', 'b'])
  // Past the budget with all that is left in use or just kept: nothing more goes.
  budget.set('c', 'c', 8)
  expect(dropped).toEqual(['a', 'b'])
  expect([budget.keys(), budget.bytes]).toEqual([['playing', 'c'], 12])
})

test("the session's id is asked once, not on every row drawn", async ($, on) => {
  const w = world(on, { files: { '/project/app/shot.png': PNG } })
  await startSession($)
  for (const id of ['a-1', 'a-2', 'a-3']) await answer($, 'See shot.png.', id)
  await resultRow($, 'tu-1', image(PNG))
  expect(w.asked.sessionId).toBe(1)
})

test("a session that ends takes its cache with it; one starting removes those gone a week", async ($, on) => {
  const day = 24 * 60 * 60 * 1000
  const root = '/tmp/claude-501/inline-images'
  const w = world(on, { now: 30 * day, dirs: { [`${root}/old`]: 20 * day, [`${root}/recent`]: 29 * day } })
  await startSession($)
  await w.clock.advance(10)
  const removed = () => w.runs.filter(run => run.argv[0] === 'rm').map(run => run.argv.at(-1))
  expect(removed()).toEqual([`${root}/old`])
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's-1', resume: { id: 's-1' } })
  expect(removed()).toEqual([`${root}/old`, `${root}/s-1`])
})

test('one picture embedded twice is two Images, each with a key of its own', async ($, on) => {
  world(on, { files: { '/project/app/out/anim.gif': gif([0, 1]).toBase64() } })
  await startSession($)
  const text = 'Before: ![before](out/anim.gif)\n\nAfter: ![after](out/anim.gif)'
  await answer($, text, 'a-1')
  const row = await answer($, text, 'a-2')
  const keys = (await row.findAll({ type: 'Image' })).map(image => image.key)
  expect(keys).toHaveLength(2)
  expect(new Set(keys).size).toBe(2)
})

test('an answer with pictures but no chips mounts no probes', async ($, on) => {
  world(on, { files: { '/project/app/out/chart.png': PNG, '/project/app/shot.png': PNG } })
  await startSession($)
  const embedded = await answer($, 'Here:\n\n![chart](out/chart.png)', 'a-1')
  expect(await embedded.find({ key: 'probe:0' })).toBeUndefined()
  const named = await answer($, 'Saved as shot.png.', 'a-2')
  expect(await named.find({ key: 'probe:0' })).toBeDefined()
})

test("a chip's picture is read before the pointer comes onto it", async ($, on) => {
  const w = world(on, { files: { '/project/app/shot.png': PNG } })
  await startSession($)
  await answer($, 'Saved as shot.png.', 'a-1')
  await w.clock.advance(10)
  expect(w.runs.some(run => run.argv[2]?.startsWith('head -c') && run.argv[3] === '/project/app/shot.png')).toBe(true)
})

// --- Pictures in the unfolded view, and a click on one.

test('an unfolded group of reads (--verbose, ctrl+o) shows its pictures under its rows, named', async ($, on) => {
  world(on, { files: { '/project/app/a.png': PNG, '/project/app/b.png': PNG } })
  await startSession($)
  const call = (id: string, path: string) => ({ tool_use_id: id, tool: 'Read', input: { file_path: path }, isRunning: false, isErrored: false, isInterrupted: false, output: image(PNG) })
  const group = (isExpanded: boolean, requestId: string) => $.ui.mount({
    plugin: 'inline-images',
    surface: 'terminal',
    component: 'ToolGroup',
    requestId,
    props: { calls: [call('tu-1', '/project/app/a.png'), call('tu-2', '/project/app/b.png')], isActive: false, isExpanded },
    viewport: SCREEN
  })
  await group(true, 'g-0')
  const row = await group(true, 'g-1')
  expect(await row.find({ key: 'engine' })).toBeDefined()
  expect((await row.findAll({ type: 'Image' })).map(image => image.props.alt)).toEqual(['a.png', 'b.png'])
  expect(await row.find({ type: 'Text', text: 'a.png' })).toBeDefined()
})

test('a click on a picture drawn opens it in the system viewer: the file read, or the copy of the bytes Claude was sent', { options: { click: true } }, async ($, on) => {
  const w = world(on, { files: { '/project/app/shot.png': PNG } })
  await startSession($)
  const click = async (row: Awaited<ReturnType<typeof resultRow>>) => {
    const region = (await row.findAll({ type: 'Client' })).find(client => String(client.key).startsWith('open:'))!
    await row.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: String(region.key) })
    await row.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: String(region.key) })
  }
  await readRow($, 'tu-1', '/project/app/shot.png')
  await click(await resultRow($, 'tu-1', image(PNG)))
  expect(w.runs.filter(run => run.argv[0] === 'open').map(run => run.argv[1])).toEqual(['/project/app/shot.png'])
  await click(await resultRow($, 'tu-2', image(PNG)))
  expect(w.runs.filter(run => run.argv[0] === 'open').map(run => run.argv[1])[1]).toMatch(/\/inline-images\/s-1\/read-[0-9a-f]+\.source\.png$/)
})

test('by default a click opens nothing: a picture the terminal draws takes no region, and one in cells keeps its window', async ($, on) => {
  const w = world(on, { files: { '/project/app/shot.png': PNG } })
  await startSession($)
  await readRow($, 'tu-1', '/project/app/shot.png')
  expect(await (await resultRow($, 'tu-1', image(PNG))).findAll({ type: 'Client' })).toEqual([])
  expect(w.runs.some(run => run.argv[0] === 'open')).toBe(false)
})

test('by default a click on a picture in cells, or on a chip, opens nothing', async ($, on) => {
  const w = world(on, { env: CELLS, files: { '/project/app/shot.png': PNG } })
  await startSession($)
  await readRow($, 'tu-1', '/project/app/shot.png')
  const row = await resultRow($, 'tu-1', image(PNG))
  const region = (await row.findAll({ type: 'Client' })).find(client => String(client.key).startsWith('open:'))!
  await row.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: String(region.key) })
  await row.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: String(region.key) })
  const answered = await answer($, 'Saved as shot.png.', 'a-1')
  await answered.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'ref:0' })
  await answered.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'ref:0' })
  await w.clock.advance(50)
  expect(w.runs.some(run => run.argv[0] === 'open')).toBe(false)
  // The window stays: the pointer is still on the picture.
  expect(w.shows.at(-1)!.verb).toBe('show')
})

test('off fullscreen there is no pointer: a picture takes no click region', async ($, on) => {
  world(on, { files: { '/project/app/shot.png': PNG } })
  await startSession($)
  const row = await $.ui.mount({ plugin: 'inline-images', surface: 'terminal', component: 'ToolResult', requestId: 'tu-1', props: { tool_use_id: 'tu-1', tool: 'Read', output: image(PNG), isErrored: false }, viewport: { ...SCREEN, isFullscreen: false } })
  expect(await row.find({ type: 'Image' })).toBeDefined()
  expect(await row.findAll({ type: 'Client' })).toHaveLength(0)
})

// --- /images.

test('/images turns the pictures off and on again, and sets their size', async ($, on) => {
  world(on)
  await startSession($)
  const run = async (args: string) => (await images($, args)).text
  // A PNG whose header says 800 by 800: as many rows as the size allows.
  const header = decoded(PNG)
  new DataView(header.buffer).setUint32(16, 800)
  new DataView(header.buffer).setUint32(20, 800)
  const tall = image(header.toBase64())
  const rowsOf = async (id: string) => {
    const row = await resultRow($, id, tall)
    return (await row.find({ type: 'Image' }))?.props.rows
  }
  expect(await rowsOf('tu-1')).toBe(12)

  expect(await run('off')).toBe('Inline Images: off. /images to turn it on.')
  const off = await resultRow($, 'tu-2', tall)
  expect(await off.find({ type: 'Image' })).toBeUndefined()
  expect(await off.find({ key: 'engine' })).toBeDefined()

  expect(await run('')).toBe('Inline Images: on, pictures medium (up to 12 rows).')
  expect(await run('small')).toBe('Inline Images: on, pictures small (up to 6 rows).')
  expect(await rowsOf('tu-3')).toBe(6)
  expect(await run('large')).toBe('Inline Images: on, pictures large (up to 24 rows).')
  expect(await rowsOf('tu-4')).toBe(24)
  expect(await run('huge')).toBe('/images huge: not a choice. Use on, off, small, medium or large. Inline Images: on, pictures large (up to 24 rows).')
})

test('/images off stops the GIFs playing', async ($, on) => {
  const w = world(on)
  await startSession($)
  await resultRow($, 'tu-1', image(gif([0, 1]).toBase64(), 'image/gif'))
  await w.clock.advance(200)
  expect(w.blits).toHaveLength(1)
  await images($, 'off')
  await w.clock.advance(1000)
  expect(w.blits).toHaveLength(1)
})

// --- The strip above the prompt: the draft's pictures, before it is sent.

const BAND = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const strip = ($: Engine) => $.ui.mount({ plugin: 'inline-images', surface: 'terminal', component: 'AbovePrompt', props: BAND, viewport: SCREEN })
const FOLDER = '/tmp/claude-501/-project-app/s-1/images'

test('a picture pasted in the draft shows above the prompt, small, named; one typed by hand does not', async ($, on) => {
  const w = world(on, { files: { [FOLDER]: '', [`${FOLDER}/1.png`]: PNG } })
  w.box.text = 'what is wrong here? [Image #1] [Image #9]'
  await startSession($)
  await w.clock.advance(4000)
  const band = await strip($)
  expect(await band.find({ type: 'Image' })).toMatchObject({ props: { source: { file: `${FOLDER}/1.png` }, alt: '[Image #1]' } })
  expect(await band.find({ type: 'Text', text: '[Image #1]' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /Image #9/ })).toBeUndefined()
})

test('the draft is read once as the session starts, then followed by its edits and changes, never polled', async ($, on) => {
  const w = world(on, { files: { [FOLDER]: '', [`${FOLDER}/1.png`]: PNG } })
  w.box.text = '[Image #1]'
  await startSession($)
  await w.clock.advance(60_000)
  expect(w.asked.promptReads).toBe(1)
  expect(await (await strip($)).find({ type: 'Image' })).toMatchObject({ props: { alt: '[Image #1]' } })
})

test('with /images off the strip is not drawn', async ($, on) => {
  const w = world(on, { files: { [FOLDER]: '', [`${FOLDER}/1.png`]: PNG } })
  w.box.text = '[Image #1]'
  await startSession($)
  await images($, 'off')
  const band = await strip($)
  expect(await band.find({ type: 'Image' })).toBeUndefined()
})

// --- The cache folder: never written to once removed.

test('a session that ends for any reason forgets its cache: the next one is made anew', async ($, on) => {
  const w = world(on)
  await startSession($)
  await resultRow($, 'tu-1', image(PNG))
  const root = '/tmp/claude-501/inline-images'
  await $.session.end({ reason: 'resume', sessionId: 's-1', resume: { id: 's-1' } })
  w.session.id = 's-2'
  await resultRow($, 'tu-2', image(PNG))
  const made = w.runs.filter(run => run.argv[0] === 'mkdir').map(run => run.argv.at(-1))
  expect(made).toEqual([`${root}/s-1`, `${root}/s-2`])
  expect(w.runs.find(run => run.argv[2]?.includes('base64 --decode >') && run.argv[3]!.startsWith(`${root}/s-2/`))).toBeDefined()
})

test('a file where the cache folder goes (sips writing into a folder removed) is replaced by the folder', async ($, on) => {
  const root = '/tmp/claude-501/inline-images'
  const w = world(on, { files: { [`${root}/s-1`]: PNG } })
  await startSession($)
  const row = await resultRow($, 'tu-1', image(PNG))
  const order = w.runs.filter(run => ['rm', 'mkdir'].includes(run.argv[0]!) && run.argv.at(-1) === `${root}/s-1`).map(run => run.argv.slice(0, 2).join(' '))
  expect(order).toEqual(['rm -rf', 'mkdir -p'])
  expect(await row.find({ type: 'Image' })).toBeDefined()
})

// --- What the second review found, each kept fixed.

test('a pasted picture not found is looked for again once the last look is old', async ($, on) => {
  const w = world(on, { files: { [FOLDER]: '' } })
  w.box.text = 'see [Image #2]'
  await startSession($)
  await w.clock.advance(4000)
  expect(await (await strip($)).find({ type: 'Image' })).toBeUndefined()
  // The engine wrote it late, or a real paste took the id typed before it.
  w.files[`${FOLDER}/2.png`] = PNG
  await w.clock.advance(11_000)
  const band = await strip($)
  await w.clock.advance(10)
  expect(await band.find({ type: 'Image' })).toMatchObject({ props: { alt: '[Image #2]' } })
})

test("a session's own cache is never swept as gone, and is touched while the session runs", async ($, on) => {
  const day = 24 * 60 * 60 * 1000
  const root = '/tmp/claude-501/inline-images'
  const w = world(on, { now: 30 * day, dirs: { [`${root}/s-1`]: 1 * day, [`${root}/old`]: 1 * day } })
  await startSession($)
  await w.clock.advance(10)
  expect(w.runs.filter(run => run.argv[0] === 'rm').map(run => run.argv.at(-1))).toEqual([`${root}/old`])
  await resultRow($, 'tu-1', image(PNG))
  await w.clock.advance(6 * 60 * 60 * 1000)
  expect(w.runs.some(run => run.argv[0] === 'touch' && run.argv[1] === `${root}/s-1`)).toBe(true)
})

test('a stray backtick blanks no picture past its paragraph', async ($, on) => {
  world(on, { files: { '/project/app/out/chart.png': PNG } })
  await startSession($)
  const row = await $.ui.mount({ plugin: 'inline-images', surface: 'terminal', component: 'AssistantMessage', requestId: 'a-1', props: { text: 'Type a ` to quote.\n\n![chart](out/chart.png)\n\nThen run `make`.', isFirstOfReply: true }, viewport: { ...SCREEN, isFullscreen: false } })
  expect(await row.find({ type: 'Image' })).toMatchObject({ props: { alt: 'chart.png' } })
})

test('/images off closes a card left open: on again, it does not come back', async ($, on) => {
  world(on, { files: { '/project/app/shot.png': PNG } })
  await startSession($)
  const row = await answer($, 'Saved as shot.png.', 'a-1')
  await row.post({ rows: 1 }, { in: 'probe:0' })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  expect(await row.find({ key: 'card' })).toBeDefined()
  await images($, 'off')
  await images($, 'on')
  expect(await (await answer($, 'Saved as shot.png.', 'a-1b')).find({ key: 'card' })).toBeUndefined()
  expect(await row.find({ key: 'card' })).toBeUndefined()
})

test('a session after /clear starts with pictures on, whatever /images set', async ($, on) => {
  const w = world(on)
  await startSession($)
  await images($, 'off')
  await $.session.end({ reason: 'clear', sessionId: 's-1', resume: { id: 's-1' } })
  w.session.id = 's-2'
  const row = await resultRow($, 'tu-1', image(PNG))
  expect(await row.find({ type: 'Image' })).toBeDefined()
})

test('a narrow strip draws the pictures that fit, their names whole, and counts the rest', async ($, on) => {
  const files: Record<string, string> = { [FOLDER]: '' }
  for (const id of [1, 2, 3, 4, 5]) files[`${FOLDER}/${id}.png`] = PNG
  const w = world(on, { files })
  w.box.text = '[Image #1] [Image #2] [Image #3] [Image #4] [Image #5]'
  await startSession($)
  await w.clock.advance(10)
  const band = await $.ui.mount({ plugin: 'inline-images', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 40 }, viewport: SCREEN })
  // Each column is at least its name, 10 cells; two of them, the gap and "+3 more" fit in 40.
  expect((await band.findAll({ type: 'Image' })).map(image => image.props.alt)).toEqual(['[Image #1]', '[Image #2]'])
  expect(await band.find({ type: 'Text', text: '+3 more' })).toBeDefined()
})

test('a sent prompt shares the width among the pictures it draws, not one typed by hand', async ($, on) => {
  // A PNG whose header says 1600 by 200: as wide as its share lets it.
  const wide = decoded(PNG)
  new DataView(wide.buffer).setUint32(16, 1600)
  new DataView(wide.buffer).setUint32(20, 200)
  const w = world(on, { files: { [FOLDER]: '', [`${FOLDER}/1.png`]: wide.toBase64() } })
  await startSession($)
  const sent = () => $.ui.mount({ plugin: 'inline-images', surface: 'terminal', component: 'UserMessage', requestId: 'm-1', props: { text: '[Image #1] [Image #7]', origin: { kind: 'composer' }, isExpanded: false }, viewport: SCREEN })
  await sent()
  await w.clock.advance(4000)
  const row = await $.ui.mount({ plugin: 'inline-images', surface: 'terminal', component: 'UserMessage', requestId: 'm-2', props: { text: '[Image #1] [Image #7]', origin: { kind: 'composer' }, isExpanded: false }, viewport: SCREEN })
  expect(await row.find({ type: 'Image' })).toMatchObject({ props: { columns: 116 } })
})

// --- Lighter still: a streaming answer, a paste looked for long.

test('an answer streaming in keeps one lookup a block, its chips those of the text as it stands', async ($, on) => {
  world(on, { files: { '/project/app/a.png': PNG, '/project/app/b.png': PNG } })
  await startSession($)
  const props = (text: string) => ({ text, isFirstOfReply: true, onScreen: { first: 0, last: 9, of: 10 } })
  const row = await $.ui.mount({ plugin: 'inline-images', surface: 'terminal', component: 'AssistantMessage', requestId: 'a-1', props: props('Saved as a.png'), viewport: SCREEN })
  expect(await row.find({ key: 'ref:0' })).toMatchObject({ props: { props: { label: 'a.png' } } })
  // The same block, as more of it streams in: the chip follows the text, not an earlier lookup.
  await row.redraw(props('Saved as b.png, not a.'))
  expect(await row.find({ key: 'ref:0' })).toMatchObject({ props: { props: { label: 'b.png' } } })
})

test("a paste looked for again and again looks through every project's folder once in a while", async ($, on) => {
  const root = '/tmp/claude-501'
  const dirs: Record<string, number> = {}
  for (let i = 0; i < 50; i++) dirs[`${root}/-project-${i}`] = 0
  const w = world(on, { dirs })
  w.box.text = '[Image #3]'
  await startSession($)
  await w.clock.advance(4000)
  // Sixteen looks for the paste over three seconds; the temp folder listed once.
  expect(w.lists.filter(path => path === root)).toHaveLength(1)
})

// --- PNG without a converter, and the systems: Windows with PowerShell, WSL with Windows' viewer.

/** A PNG with stored (uncompressed) deflate blocks, written by hand: colour type, depth, and rows of raw samples. */
function pngOf (width: number, height: number, colour: number, depth: number, rows: number[][], extra: [string, number[]][] = []) {
  const chunk = (type: string, body: number[]) => {
    const length = [24, 16, 8, 0].map(shift => (body.length >>> shift) & 0xff)
    return [...length, ...Array.from(type, c => c.charCodeAt(0)), ...body, 0, 0, 0, 0]
  }
  const raw = rows.flatMap(row => [0, ...row])
  const stored = [0x78, 0x01, 1, raw.length & 0xff, raw.length >> 8, ~raw.length & 0xff, (~raw.length >> 8) & 0xff, ...raw, 0, 0, 0, 0]
  const header = [...[24, 16, 8, 0].map(s => (width >>> s) & 0xff), ...[24, 16, 8, 0].map(s => (height >>> s) & 0xff), depth, colour, 0, 0, 0]
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', header), ...extra.flatMap(([type, body]) => chunk(type, body)), ...chunk('IDAT', stored), ...chunk('IEND', [])])
}

test('a PNG decodes to RGBA: colour, grey, a palette with see-through entries, two bits a pixel', () => {
  expect([...decodePng(pngOf(2, 1, 2, 8, [[255, 0, 0, 0, 0, 255]])).data]).toEqual([255, 0, 0, 255, 0, 0, 255, 255])
  expect([...decodePng(pngOf(1, 1, 6, 8, [[1, 2, 3, 128]])).data]).toEqual([1, 2, 3, 128])
  expect([...decodePng(pngOf(2, 1, 0, 8, [[0, 200]])).data]).toEqual([0, 0, 0, 255, 200, 200, 200, 255])
  const palette: [string, number[]][] = [['PLTE', [255, 0, 0, 0, 255, 0]], ['tRNS', [0]]]
  expect([...decodePng(pngOf(2, 1, 3, 8, [[0, 1]], palette)).data]).toEqual([255, 0, 0, 0, 0, 255, 0, 255])
  // Two bits a pixel, grey: 0b11_01_00_00 is white, then a third of white.
  expect([...decodePng(pngOf(2, 1, 0, 2, [[0b11010000]])).data]).toEqual([255, 255, 255, 255, 85, 85, 85, 255])
})

test('a PNG is drawn in cells with no converter at all', async ($, on) => {
  const w = world(on, { env: { TERM_PROGRAM: 'Apple_Terminal' } })
  await startSession($)
  const row = await resultRow($, 'tu-1', image(pngOf(2, 1, 2, 8, [[255, 0, 0, 0, 0, 255]]).toBase64()))
  expect(await row.find({ type: 'Raster' })).toBeDefined()
  expect(w.runs.some(run => run.argv[0] === 'sips' || run.argv[0] === 'magick')).toBe(false)
})

test('a PNG too large to send is sent as pixels, shrunk, with no converter', async ($, on) => {
  const w = world(on, { env: { TERM: 'xterm-kitty', SSH_CONNECTION: '10.0.0.2 51234 10.0.0.1 22' } })
  await startSession($)
  const wide = pngOf(2000, 1, 2, 8, [Array.from({ length: 6000 }, (_, i) => i % 256)])
  const row = await resultRow($, 'tu-1', image(wide.toBase64()))
  expect(await row.find({ type: 'Image' })).toMatchObject({ props: { source: { width: 1024, height: 1 } } })
  expect(w.runs.some(run => run.argv[0] === 'sips' || run.argv[0] === 'magick')).toBe(false)
})

test('on Windows the mod runs with PowerShell, not sh, and opens a picture with explorer', { options: { click: true } }, async ($, on) => {
  const w = world(on, { env: { OS: 'Windows_NT', TEMP: 'C:/Users/me/AppData/Local/Temp' } })
  await startSession($)
  const row = await resultRow($, 'tu-1', image(PNG))
  expect(await row.find({ type: 'Raster' })).toBeDefined()
  expect(w.runs.some(run => ['sh', 'mkdir', 'rm', 'touch', 'id'].includes(run.argv[0]!))).toBe(false)
  expect(w.scripts.some(script => script.includes('New-Item'))).toBe(true)
  expect(w.scripts.some(script => script.includes('WriteAllBytes'))).toBe(true)
  const region = (await row.findAll({ type: 'Client' })).find(client => String(client.key).startsWith('open:'))!
  await row.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: String(region.key) })
  await row.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: String(region.key) })
  expect(w.runs.find(run => run.argv[0] === 'explorer')?.argv[1]).toMatch(/^C:\\Users\\me\\AppData\\Local\\Temp\\claude\\inline-images\\s-1\\read-[0-9a-f]+\.source\.png$/)
})

test("under WSL a picture opens in Windows' viewer, and converts with Windows' PowerShell where ImageMagick is missing", { options: { click: true } }, async ($, on) => {
  const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0).toBase64()
  const w = world(on, { uname: 'Linux', env: { WSL_DISTRO_NAME: 'Ubuntu', TERM_PROGRAM: 'vscode' }, files: { '/home/me/shot.jpg': jpeg }, sizes: { '/home/me/shot.jpg': { width: 64, height: 64 } }, missing: ['magick', 'convert', 'identify'] })
  await startSession($)
  await readRow($, 'tu-1', '/home/me/shot.jpg')
  const row = await resultRow($, 'tu-1', image(jpeg, 'image/jpeg'))
  expect(await row.find({ type: 'Raster' })).toBeDefined()
  const converted = w.runs.find(run => run.argv[0] === 'powershell.exe')
  expect(converted).toBeDefined()
  const region = (await row.findAll({ type: 'Client' })).find(client => String(client.key).startsWith('open:'))!
  await row.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: String(region.key) })
  await row.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: String(region.key) })
  await w.clock.advance(50)
  expect(w.runs.find(run => run.argv[0] === 'explorer.exe')?.argv[1]).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\shot.jpg')
})

// --- Terminals that draw cells: a window by the pointer; iTerm2's pixels.

const CELLS = { TERM_PROGRAM: 'Apple_Terminal' }

/** The pointer onto (or off) the click region over the first picture drawn. */
async function pointPicture (row: Awaited<ReturnType<typeof resultRow>>, type: 'enter' | 'leave' | 'move' = 'enter') {
  const region = (await row.findAll({ type: 'Client' })).find(client => String(client.key).startsWith('open:'))!
  await row.pointer({ type, x: 0, y: 0, in: String(region.key) })
}

/** What the window was told to show, in order: each picture's path, or none while it is made. */
const shown = (w: ReturnType<typeof world>) => w.shows.filter(show => show.verb === 'show').map(show => show.path)

test('in a terminal that draws cells, a picture under the pointer opens in the window, and the window closes as the pointer leaves', async ($, on) => {
  const w = world(on, { env: CELLS, files: { '/project/app/shot.png': PNG } })
  await startSession($)
  await w.clock.advance(10)
  // The window's program starts with the session, before any picture is pointed at: one for it.
  expect(w.windows).toHaveLength(1)
  expect(w.windows[0]).toMatchObject({ argv: ['osascript', '-l', 'JavaScript', '-e', expect.stringContaining('NSPanel')], env: { INLINE_IMAGES_COMMANDS: expect.stringMatching(/\/window-[0-9a-z]+\.txt$/), INLINE_IMAGES_SIZE: '800' } })
  await readRow($, 'tu-1', '/project/app/shot.png')
  const row = await resultRow($, 'tu-1', image(PNG))
  await pointPicture(row)
  await w.clock.advance(50)
  // Its size goes with it: the window opens that large at once, a spinner in it till the picture is read.
  expect(w.shows).toEqual([{ verb: 'show', path: '/project/app/shot.png', width: 1, height: 1 }])
  await pointPicture(row, 'leave')
  await w.clock.advance(50)
  expect(w.shows.at(-1)!.verb).toBe('hide')
  await pointPicture(row)
  await w.clock.advance(50)
  expect(shown(w)).toEqual(['/project/app/shot.png', '/project/app/shot.png'])
  expect(w.windows).toHaveLength(1)
})

test('going from one picture straight to the next shows the next: the leave of the first does not hide it', async ($, on) => {
  const w = world(on, { env: CELLS, files: { '/project/app/a.png': PNG, '/project/app/b.png': PNG } })
  await startSession($)
  const row = await answer($, '1. See a.png\n2. And b.png', 'a-1')
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:1' })
  await row.pointer({ type: 'leave', x: 0, y: 0, in: 'ref:0' })
  await w.clock.advance(50)
  expect(w.shows.at(-1)).toMatchObject({ verb: 'show', path: '/project/app/b.png' })
})

test('off the fullscreen interface the window\'s program waits for a pointer: none starts with the session', async ($, on) => {
  const w = world(on, { env: CELLS, tui: null })
  await startSession($)
  await w.clock.advance(100)
  expect(w.windows).toHaveLength(0)
})

test('the session ending ends the window\'s program', async ($, on) => {
  const w = world(on, { env: CELLS })
  await startSession($)
  await w.clock.advance(10)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's-1', resume: { id: 's-1' } })
  await w.clock.advance(100)
  expect(w.windows[0]!.isEnded).toBe(true)
})

test('in a terminal that draws cells, a chip opens its picture in the window, not a card of cells', async ($, on) => {
  const w = world(on, { env: CELLS, files: { '/project/app/shot.png': PNG } })
  await startSession($)
  const row = await answer($, 'Saved as shot.png.', 'a-1')
  await row.post({ rows: 1 }, { in: 'probe:0' })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  await w.clock.advance(50)
  expect(shown(w)).toEqual(['/project/app/shot.png'])
  expect(await row.find({ key: 'card' })).toBeUndefined()
})

test('a window that cannot show sends the pictures back to the terminal: a chip opens its card again', async ($, on) => {
  const w = world(on, { env: CELLS, files: { '/project/app/shot.png': PNG }, window: 'error' })
  await startSession($)
  await w.clock.advance(10)
  const row = await answer($, 'Saved as shot.png.', 'a-1')
  await row.post({ rows: 1 }, { in: 'probe:0' })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  expect(await row.find({ key: 'card' })).toBeDefined()
  expect(w.windows).toHaveLength(1)
})

test("on Windows the window is PowerShell's, and under WSL Windows' own, the picture's path in its Windows form", async ($, on) => {
  const w = world(on, { uname: 'Linux', env: { WSL_DISTRO_NAME: 'Ubuntu', TERM_PROGRAM: 'vscode', WSLENV: 'WT_SESSION' }, files: { '/home/me/shot.png': PNG } })
  await startSession($)
  await readRow($, 'tu-1', '/home/me/shot.png')
  const row = await resultRow($, 'tu-1', image(PNG))
  await pointPicture(row)
  await w.clock.advance(50)
  expect(w.windows[0]!.argv[0]).toBe('powershell.exe')
  expect(w.windows[0]!.env).toMatchObject({ WSLENV: 'WT_SESSION:INLINE_IMAGES_COMMANDS/p:INLINE_IMAGES_SIZE' })
  expect(shown(w)).toEqual(['\\\\wsl.localhost\\Ubuntu\\home\\me\\shot.png'])
})

test("on Linux a window needs a display and Python's Tk, and is shown a PNG of a picture Tk cannot read, a spinner in it meanwhile", async ($, on) => {
  const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0).toBase64()
  const w = world(on, { uname: 'Linux', env: { TERM_PROGRAM: 'vscode', DISPLAY: ':0' }, files: { '/home/me/shot.jpg': jpeg }, sizes: { '/home/me/shot.jpg': { width: 64, height: 64 } } })
  await startSession($)
  await readRow($, 'tu-1', '/home/me/shot.jpg')
  const row = await resultRow($, 'tu-1', image(jpeg, 'image/jpeg'))
  await pointPicture(row)
  await w.clock.advance(50)
  expect(w.windows[0]!.argv.slice(0, 2)).toEqual(['python3', '-c'])
  expect(shown(w).at(-1)).toMatch(/\.window\.png$/)
})

test('on Linux with no display, or over ssh, no window: the terminal shows the picture', async ($, on) => {
  const w = world(on, { uname: 'Linux', env: { TERM_PROGRAM: 'vscode' }, files: { '/home/me/shot.png': PNG } })
  await startSession($)
  await readRow($, 'tu-1', '/home/me/shot.png')
  const row = await resultRow($, 'tu-1', image(PNG))
  expect(await row.findAll({ type: 'Client' })).toEqual([])
  await w.clock.advance(10)
  expect(w.windows).toHaveLength(0)
})

test('iTerm2 3.5 and later is sent the picture in fullscreen, and draws it in cells elsewhere', async ($, on) => {
  world(on, { env: { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.4' } })
  await startSession($)
  const row = await resultRow($, 'tu-1', image(PNG))
  expect(await row.find({ type: 'Image' })).toMatchObject({ props: { source: { png: PNG } } })
})

test('iTerm2 off fullscreen draws in cells', async ($, on) => {
  world(on, { env: { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.4' } })
  await startSession($)
  const row = await $.ui.mount({ plugin: 'inline-images', surface: 'terminal', component: 'ToolResult', requestId: 'tu-1', props: { tool_use_id: 'tu-1', tool: 'Read', output: image(PNG), isErrored: false }, viewport: { ...SCREEN, isFullscreen: false } })
  expect(await row.find({ type: 'Raster' })).toBeDefined()
})

test('in cells a picture takes half the rows', async ($, on) => {
  const square = decoded(PNG)
  new DataView(square.buffer).setUint32(16, 800)
  new DataView(square.buffer).setUint32(20, 800)
  world(on, { env: CELLS, files: { '/project/app/sq.png': square.toBase64() } })
  await startSession($)
  await readRow($, 'tu-1', '/project/app/sq.png')
  const row = await resultRow($, 'tu-1', image(square.toBase64()))
  expect(await row.find({ type: 'Raster' })).toMatchObject({ props: { rows: 6 } })
})

// --- The VS Code extension, the desktop and mobile apps: an Svg holding the picture.

const remote = ($: Engine, surface: 'vscode' | 'desktop' | 'mobile', text: string, requestId = 'a-1') =>
  $.ui.mount({ plugin: 'inline-images', surface, component: 'AssistantMessage', requestId, props: { text, isFirstOfReply: true } })

test('in the VS Code extension a picture an answer names shows under it, in an Svg, its own bytes inside', async ($, on) => {
  const w = world(on, { files: { '/project/app/docs/shot.png': PNG } })
  await startSession($)
  await remote($, 'vscode', 'Saved as `docs/shot.png`.', 'a-0')
  await w.clock.advance(10)
  const row = await remote($, 'vscode', 'Saved as `docs/shot.png`.')
  // The answer is the engine's own drawing; the picture is under it.
  expect(await row.find({ key: 'engine' })).toBeDefined()
  expect(await row.find({ type: 'Svg' })).toMatchObject({ props: { alt: 'shot.png', width: 1, height: 1, source: expect.stringContaining(`href="data:image/png;base64,${PNG}"`) } })
  expect(await row.find({ type: 'Text', text: 'docs/shot.png' })).toBeDefined()
})

test('in the desktop app a picture too large for an Svg is shrunk to a JPEG that fits', async ($, on) => {
  // A PNG whose header says 3000 by 2000, 200 KB.
  const header = decoded(PNG)
  new DataView(header.buffer).setUint32(16, 3000)
  new DataView(header.buffer).setUint32(20, 2000)
  const big = padded(header.toBase64(), 200_000)
  const w = world(on, { files: { '/project/app/big.png': big } })
  await startSession($)
  await remote($, 'desktop', 'See ![chart](big.png).', 'a-0')
  await w.clock.advance(10)
  const row = await remote($, 'desktop', 'See ![chart](big.png).')
  expect(await row.find({ type: 'Svg' })).toMatchObject({ props: { alt: 'big.png', source: expect.stringContaining('href="data:image/jpeg;base64,') } })
  expect(w.runs.find(run => run.argv[0] === 'sips' && run.argv[1] === '-s')?.argv).toEqual(expect.arrayContaining(['jpeg', 'formatOptions', '70', '-Z', '1200']))
})

test('in a remote app a picture that is not there draws nothing, and an answer that names none is left alone', async ($, on) => {
  const w = world(on)
  await startSession($)
  await remote($, 'mobile', 'Saved as `gone.png`.', 'a-0')
  await w.clock.advance(10)
  const missing = await remote($, 'mobile', 'Saved as `gone.png`.')
  expect(await missing.find({ type: 'Svg' })).toBeUndefined()
  const plain = await remote($, 'vscode', 'No pictures here.', 'a-2')
  expect(await plain.find({ type: 'Svg' })).toBeUndefined()
})

// --- What the review of 0.4.0 found, each kept fixed.

test("a picture the window cannot read loses its window alone: the next one still opens in one", async ($, on) => {
  const w = world(on, { env: CELLS, files: { '/project/app/a.png': PNG, '/project/app/b.png': PNG }, window: 'unreadable' })
  await startSession($)
  const row = await answer($, '1. See a.png\n2. And b.png', 'a-1')
  for (const [i, rows] of [1, 1].entries()) await row.post({ rows }, { in: `probe:${i}` })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  await w.clock.advance(50)
  await row.pointer({ type: 'leave', x: 0, y: 0, in: 'ref:0' })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:1' })
  await w.clock.advance(50)
  expect(shown(w)).toEqual(['/project/app/a.png', '/project/app/b.png'])
  // And the first is not tried again.
  await row.pointer({ type: 'leave', x: 0, y: 0, in: 'ref:1' })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  await w.clock.advance(50)
  expect(shown(w)).toHaveLength(2)
})

test('a picture pointed at while the window\'s program starts shows once it is ready; one left meanwhile never does', async ($, on) => {
  const w = world(on, { env: CELLS, files: { '/project/app/shot.png': PNG }, startMs: 1500 })
  await startSession($)
  await readRow($, 'tu-1', '/project/app/shot.png')
  const row = await resultRow($, 'tu-1', image(PNG))
  await pointPicture(row)
  await w.clock.advance(10)
  await pointPicture(row, 'leave')
  await w.clock.advance(2000)
  expect(shown(w)).toEqual([])
  await pointPicture(row)
  await w.clock.advance(50)
  expect(shown(w)).toEqual(['/project/app/shot.png'])
})

test('a chip opens its window at once, before its picture is read', async ($, on) => {
  const w = world(on, { env: CELLS, files: { '/project/app/shot.png': PNG } })
  await startSession($)
  const row = await answer($, 'Saved as shot.png.', 'a-1')
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  await w.clock.advance(50)
  expect(shown(w)).toEqual(['/project/app/shot.png'])
})

test("iTerm2's way is settled by the terminal's own drawing, not an app's", async ($, on) => {
  world(on, { env: { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.4' }, files: { '/project/app/shot.png': PNG } })
  await startSession($)
  // The mobile app draws first, off fullscreen as phones are.
  await $.ui.mount({ plugin: 'inline-images', surface: 'mobile', component: 'AssistantMessage', requestId: 'a-0', props: { text: 'Saved as shot.png.', isFirstOfReply: true }, viewport: { ...SCREEN, isFullscreen: false } })
  const row = await resultRow($, 'tu-1', image(PNG))
  expect(await row.find({ type: 'Image' })).toMatchObject({ props: { source: { png: PNG } } })
})

test('in an app a picture written after the answer shows once its file is there', async ($, on) => {
  const w = world(on)
  await startSession($)
  await remote($, 'vscode', 'See ![chart](out/chart.png).', 'a-0')
  await w.clock.advance(10)
  w.files['/project/app/out/chart.png'] = PNG
  await w.clock.advance(4000)
  // The answer drawn again looks again, and finds it.
  await remote($, 'vscode', 'See ![chart](out/chart.png).', 'a-1')
  await w.clock.advance(10)
  const row = await remote($, 'vscode', 'See ![chart](out/chart.png).', 'a-2')
  await w.clock.advance(10)
  expect(await row.find({ type: 'Svg' })).toMatchObject({ props: { alt: 'chart.png' } })
})

test('a PNG with an alpha channel too large for an Svg is shrunk to a PNG, keeping what is see-through', async ($, on) => {
  const header = decoded(PNG)
  new DataView(header.buffer).setUint32(16, 3000)
  new DataView(header.buffer).setUint32(20, 2000)
  header[25] = 6
  const w = world(on, { files: { '/project/app/logo.png': padded(header.toBase64(), 200_000) } })
  await startSession($)
  await remote($, 'desktop', 'See ![logo](logo.png).', 'a-0')
  await w.clock.advance(10)
  const row = await remote($, 'desktop', 'See ![logo](logo.png).')
  expect(await row.find({ type: 'Svg' })).toMatchObject({ props: { source: expect.stringContaining('href="data:image/png;base64,') } })
  // Its size came from its header: never measured by sips.
  expect(w.runs.some(run => run.argv[0] === 'sips' && run.argv[1] === '-g')).toBe(false)
})

test('a Windows path in an answer is taken as the absolute path it is', async ($, on) => {
  const w = world(on, { env: { OS: 'Windows_NT', TEMP: 'C:/Temp' }, files: { 'C:\\Users\\me\\shot.png': PNG } })
  await startSession($)
  await remote($, 'vscode', 'Saved as `C:\\Users\\me\\shot.png`.', 'a-0')
  await w.clock.advance(10)
  const row = await remote($, 'vscode', 'Saved as `C:\\Users\\me\\shot.png`.')
  expect(await row.find({ type: 'Svg' })).toMatchObject({ props: { alt: 'shot.png' } })
})

test('a large PNG drawn in cells is shrunk by the converter, not decoded here', async ($, on) => {
  const header = decoded(PNG)
  new DataView(header.buffer).setUint32(16, 2000)
  new DataView(header.buffer).setUint32(20, 1000)
  const w = world(on, { env: CELLS, files: { '/project/app/wide.png': header.toBase64() } })
  await startSession($)
  await readRow($, 'tu-1', '/project/app/wide.png')
  const row = await resultRow($, 'tu-1', image(header.toBase64()))
  expect(await row.find({ type: 'Raster' })).toBeDefined()
  expect(w.runs.find(run => run.argv[0] === 'sips' && run.argv[3] === 'bmp')).toBeDefined()
})

test("a small file's header is taken from the one read of it: no process to read it", async ($, on) => {
  const w = world(on, { env: CELLS, files: { '/project/app/shot.png': PNG } })
  await startSession($)
  await readRow($, 'tu-1', '/project/app/shot.png')
  await resultRow($, 'tu-1', image(PNG))
  expect(w.runs.some(run => run.argv[2]?.startsWith('head -c'))).toBe(false)
})

// --- What the review of 0.4.3 found in the window by the pointer, each kept fixed.

const WSL = { WSL_DISTRO_NAME: 'Ubuntu', TERM_PROGRAM: 'vscode' }
const toWindows = (path: string) => `\\\\wsl.localhost\\Ubuntu${path.replaceAll('/', '\\')}`

test('a pointer that leaves while the show is on its way leaves no window open: the show is not sent after the hide', async ($, on) => {
  const w = world(on, { uname: 'Linux', env: WSL, files: { '/home/me/shot.png': PNG } })
  await startSession($)
  await w.clock.advance(10)
  await readRow($, 'tu-1', '/home/me/shot.png')
  const row = await resultRow($, 'tu-1', image(PNG))
  const region = (await row.findAll({ type: 'Client' })).find(client => String(client.key).startsWith('open:'))!
  await row.pointer({ type: 'enter', x: 0, y: 0, in: String(region.key) })
  await w.clock.advance(5)
  await row.pointer({ type: 'leave', x: 0, y: 0, in: String(region.key) })
  await w.clock.advance(100)
  expect(shown(w)).toEqual([])
})

test('going from one picture to the next before the first is shown shows the second, not the first', async ($, on) => {
  const w = world(on, { uname: 'Linux', env: WSL, files: { '/home/me/a.png': PNG, '/home/me/b.png': PNG } })
  await startSession($)
  await w.clock.advance(10)
  const row = await answer($, '1. See /home/me/a.png\n2. And /home/me/b.png', 'a-1')
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  await w.clock.advance(5)
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:1' })
  await w.clock.advance(5)
  await row.pointer({ type: 'leave', x: 0, y: 0, in: 'ref:0' })
  await w.clock.advance(100)
  expect(shown(w)).toEqual([toWindows('/home/me/b.png')])
})

test('a picture whose path has no Windows form is left to the terminal: no spinner left in the window, and its chip opens a card', async ($, on) => {
  const w = world(on, { uname: 'Linux', env: WSL, files: { '/nowin/shot.png': PNG } })
  await startSession($)
  const row = await answer($, 'Saved as /nowin/shot.png.', 'a-1')
  await row.post({ rows: 1 }, { in: 'probe:0' })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  await w.clock.advance(100)
  expect(shown(w).filter(path => path === '')).toEqual([])
  await row.pointer({ type: 'leave', x: 0, y: 0, in: 'ref:0' })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  expect(await row.find({ key: 'card' })).toBeDefined()
})

test('a chip whose picture the window cannot read opens its card the next time', async ($, on) => {
  const w = world(on, { env: CELLS, files: { '/project/app/shot.png': PNG }, window: 'unreadable' })
  await startSession($)
  const row = await answer($, 'Saved as shot.png.', 'a-1')
  await row.post({ rows: 1 }, { in: 'probe:0' })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  await w.clock.advance(100)
  await row.pointer({ type: 'leave', x: 0, y: 0, in: 'ref:0' })
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  expect(await row.find({ key: 'card' })).toBeDefined()
})

test('a hover as the session starts, before its program is up, starts one program, and the picture shows', async ($, on) => {
  const w = world(on, { env: CELLS, files: { '/project/app/shot.png': PNG } })
  await startSession($)
  const row = await answer($, 'Saved as shot.png.', 'a-1')
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  await w.clock.advance(100)
  expect(w.windows).toHaveLength(1)
  expect(shown(w)).toEqual(['/project/app/shot.png'])
})

test("a session that ends tells its program to quit, in a file no later program writes to", async ($, on) => {
  const w = world(on, { env: CELLS })
  await startSession($)
  await w.clock.advance(10)
  const first = w.windows[0]!.env.INLINE_IMAGES_COMMANDS!
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's-1', resume: { id: 's-1' } })
  await startSession($)
  await w.clock.advance(100)
  expect(w.written[first]).toMatch(/\nquit\n/)
  expect(w.windows.at(-1)!.env.INLINE_IMAGES_COMMANDS).not.toBe(first)
})

test('a program that keeps ending on its own sends the pictures back to the terminal: a chip opens its card', async ($, on) => {
  const w = world(on, { env: CELLS, files: { '/project/app/shot.png': PNG }, window: 'crash' })
  await startSession($)
  const row = await answer($, 'Saved as shot.png.', 'a-1')
  await row.post({ rows: 1 }, { in: 'probe:0' })
  for (let i = 0; i < 4; i++) {
    await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
    await w.clock.advance(100)
    await row.pointer({ type: 'leave', x: 0, y: 0, in: 'ref:0' })
  }
  expect(w.windows).toHaveLength(3)
  await row.pointer({ type: 'enter', x: 0, y: 0, in: 'ref:0' })
  expect(await row.find({ key: 'card' })).toBeDefined()
})

test('pressed on a picture, dragged off it and let go outside, the window closes', async ($, on) => {
  const w = world(on, { env: CELLS, files: { '/project/app/shot.png': PNG } })
  await startSession($)
  await readRow($, 'tu-1', '/project/app/shot.png')
  const row = await resultRow($, 'tu-1', image(PNG))
  const region = String((await row.findAll({ type: 'Client' })).find(client => String(client.key).startsWith('open:'))!.key)
  await row.pointer({ type: 'enter', x: 0, y: 0, in: region })
  await w.clock.advance(50)
  await row.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: region })
  // The press holds the pointer: its moves and its let-go outside the one-cell picture still come here.
  await row.pointer({ type: 'move', x: -3, y: -2, button: 'left', in: region })
  await w.clock.advance(50)
  await row.pointer({ type: 'up', x: -3, y: -2, button: 'left', in: region })
  await w.clock.advance(50)
  expect(w.shows.at(-1)!.verb).toBe('hide')
})

test('a large PNG with see-through pixels drawn in cells is decoded here, keeping them: the converter\'s BMP has no alpha', async ($, on) => {
  const logo = palettePng(1001, 1000, true)
  const w = world(on, { env: CELLS, files: { '/project/app/logo.png': logo } })
  await startSession($)
  await readRow($, 'tu-1', '/project/app/logo.png')
  const row = await resultRow($, 'tu-1', image(logo))
  expect(await row.find({ type: 'Raster' })).toBeDefined()
  expect(w.runs.some(run => run.argv[0] === 'sips' && run.argv.includes('bmp'))).toBe(false)
})

test('a palette PNG with a see-through colour too large for an Svg is shrunk to a PNG, not a JPEG', async ($, on) => {
  const logo = palettePng(400, 400, true)
  const w = world(on, { files: { '/project/app/logo.png': logo } })
  await startSession($)
  await remote($, 'desktop', 'See ![logo](logo.png).', 'a-0')
  await w.clock.advance(10)
  const row = await remote($, 'desktop', 'See ![logo](logo.png).')
  expect(await row.find({ type: 'Svg' })).toMatchObject({ props: { source: expect.stringContaining('href="data:image/png;base64,') } })
})

test('Ghostty and kitty are handed a still by its path: the file is never read whole', async ($, on) => {
  const w = world(on, { files: { '/project/app/shot.png': PNG } })
  await startSession($)
  await readRow($, 'tu-1', '/project/app/shot.png')
  const row = await resultRow($, 'tu-1', image(PNG))
  expect(await row.find({ type: 'Image' })).toMatchObject({ props: { source: { file: '/project/app/shot.png' } } })
  expect(w.reads).not.toContain('/project/app/shot.png')
})

// --- What is left of the first review, before the mod is public.

/**
 * A GIF of a canvas `width` by `height`, a palette of 4 colours (black, red, green, blue) and one
 * frame per entry of `frames`: its size, its LZW minimum code size, and its codes, each with its
 * width in bits.
 */
function gifOf (width: number, height: number, frames: { w: number; h: number; minSize: number; codes: [number, number][] }[]) {
  const u16 = (n: number) => [n & 0xff, n >> 8]
  const bytes = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...u16(width), ...u16(height), 0x81, 0, 0, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]
  for (const frame of frames) {
    const data: number[] = []
    let held = 0
    let bits = 0
    for (const [code, size] of frame.codes) {
      held |= code << bits
      bits += size
      while (bits >= 8) {
        data.push(held & 0xff)
        held >>>= 8
        bits -= 8
      }
    }
    if (bits > 0) data.push(held & 0xff)
    bytes.push(0x2c, 0, 0, 0, 0, ...u16(frame.w), ...u16(frame.h), 0, frame.minSize, data.length, ...data, 0)
  }
  bytes.push(0x3b)
  return Uint8Array.from(bytes)
}

test('a GIF\'s last codes, held in the last byte read, are decoded: its last pixel is not lost', () => {
  // Clear, red, green, blue, end: the end code 4 bits wide, as the table has grown to 8.
  const { frames } = decodeGif(gifOf(3, 1, [{ w: 3, h: 1, minSize: 2, codes: [[4, 3], [1, 3], [2, 3], [3, 3], [5, 4]] }]))
  expect([...frames[0]!.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255])
})

test('a GIF with a code size no GIF has, or a frame larger than any canvas, is refused at once', () => {
  const started = Date.now()
  expect(() => decodeGif(gifOf(2, 1, [{ w: 2, h: 1, minSize: 30, codes: [[0, 8]] }]))).toThrow('a broken GIF')
  expect(() => decodeGif(gifOf(2, 1, [{ w: 40000, h: 40000, minSize: 2, codes: [[4, 3], [1, 3], [5, 3]] }]))).toThrow('a broken GIF')
  expect(Date.now() - started).toBeLessThan(1000)
})

test('a long animation of a large canvas is cut, rather than decoded for minutes', () => {
  const frame = { w: 1, h: 1, minSize: 2, codes: [[4, 3], [1, 3], [5, 3]] as [number, number][] }
  const { frames } = decodeGif(gifOf(4000, 4000, Array.from({ length: 40 }, () => frame)), 500, () => 1)
  expect(frames.length).toBe(25)
})
