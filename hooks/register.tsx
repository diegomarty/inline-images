import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, EventOf, ImageSource, Register, RenderElement, Timer } from 'claude-code'

import { Budget } from './budget'
import { decodeGif, isGif, shrink } from './gif'
import { parseBmp, toCells } from './pixels'
import { decodePng, isPng } from './png'
import { canShowWindows, convert, detect, makeFolder, open as openFile, readBytes, remove, tempFolder, touch, windowCommand, windowPath, windowReads, writeBytes, writeFrames } from './system'
import type { Pixels } from './pixels'
import type { Hovered, Picture, View } from '../types'

type Engine = EngineInterface
type RenderOf<C extends string> = Extract<EventOf['ui.render'], { component: C, surface: 'terminal' }>
type Ui = Elements['terminal']

const pictures = atom({ plugin: 'inline-images', key: 'pictures' } as const, {} as Record<string, Picture>)
const hovered = atom({ plugin: 'inline-images', key: 'hovered' } as const, null as Hovered | null)
const draft = atom({ plugin: 'inline-images', key: 'draft' } as const, [] as number[])
const view = atom({ plugin: 'inline-images', key: 'view' } as const, { isOn: true, size: 'medium' } as View)


const TOKEN = /\[Image #(\d+)\]/g
// `![alt](path)`, an optional title after the path.
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i
const MAX_FILE_BYTES = 32 * 1024 * 1024
// $.fs.read and a process's output each stop at 4 MiB: a larger file is read in pieces this large.
const READ_LIMIT = 4 * 1024 * 1024
const PIECE_BYTES = 2 * 1024 * 1024
// How long a picture read from a file, the image index and a lookup that missed are trusted before
// they are looked at again.
const RECHECK_MS = 3000
// What the pictures read, and their cells, may hold in memory together; past it the least recently
// shown go (a GIF playing last), read again when next drawn.
const LOADED_BUDGET = 96 * 1024 * 1024
const CELLS_BUDGET = 16 * 1024 * 1024
// The cache of a session gone this long is removed when the next session starts.
const CACHE_DAYS = 7
// The pictures a chip names are read before the pointer comes onto one: this many of an answer's,
// each no larger than this.
const PREFETCH_CHIPS = 8
const PREFETCH_BYTES = 2 * 1024 * 1024
const MAX_COLUMNS = 120
// Under a tool row the transcript writes `  ⎿  `: the picture lines up with the text after it.
const RESULT_INDENT = 5
const MESSAGE_INDENT = 2
// About how many pixels a cell is across: a picture is never drawn larger than about its own size.
const CELL_PIXELS = 8
// The longest side a still picture is shrunk to for the terminal; the bytes one may be sent.
const STILL_PIXELS = 1600
const VIEW_PIXELS = 1024
const VIEW_BYTES = 2 * 1024 * 1024
// A picture an Svg draws (the VS Code extension, the desktop and mobile apps, which have no Image)
// holds it as a data URI in its markup, 131072 characters at most: what its bytes may take, how
// wide it is drawn at most, in CSS pixels, and the sides a larger one is shrunk to, as a JPEG, till
// it fits.
const SVG_DATA = 120000
const SVG_WIDTH = 480
const SVG_SIDE = 1200
// A picture's window: its longest side at most, in points. Its program, ended on its own (not by
// the session), is started again so many times at most.
const WINDOW_SIZE = 800
const WINDOW_STARTS = 3
// A PNG drawn in cells past this many pixels is shrunk by a converter where there is one, quicker
// than decoding it here.
const DECODE_PIXELS = 1_000_000
// The longest side the cells are sampled from, eight points a cell across.
const CELL_SOURCE_PIXELS = 800
// A GIF's frames are shrunk to this side, and all of them together to this many bytes.
const FRAME_PIXELS = 480
const FRAME_BUDGET = 24 * 1024 * 1024
const MAX_FRAMES = 300
// The engine writes a pasted image just after the paste puts its placeholder in the box.
const WAIT_MS = 200
const WAIT_TRIES = 15
// The strip of the draft's pictures above the prompt takes this many rows a picture at most; pasted
// pictures side by side stand this far apart, each at least this wide.
const DRAFT_ROWS = 5
const PASTE_GAP = 2
const PASTE_COLUMNS = 8
// A pasted picture not found (the engine slow to write it, or an [Image #N] typed before the paste
// that gets that id) is looked for again once this old.
const PASTE_RETRY_MS = 10000
// A picture drawn this recently is not dropped from memory to make room: two that do not fit together
// would otherwise push each other out and be read again, without end.
const DRAWN_MS = 2000
// While a session runs its cache folder is touched this often, so another session's sweep of caches
// gone a week never takes it.
const TOUCH_MS = 6 * 60 * 60 * 1000
// A picture an answer names without drawing it: in a link's target, in code, or bare.
const REFERENCE = /\]\(\s*<?([^)\s>]+\.(?:png|jpe?g|gif|webp))>?[^)]*\)|`([^`\n]+\.(?:png|jpe?g|gif|webp))`|((?:[A-Za-z]:)?(?:~|\.{1,2})?[\\/]?[\w@%+.-]+(?:[\\/][\w@%+.-]+)*\.(?:png|jpe?g|gif|webp))(?![\w\\/])/gi
const WEB_LINK = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi
const MAX_REFERENCES = 24
// The card a chip opens: the most rows its picture takes, and what the border and caption add.
const HOVER_ROWS = 24
const CARD_ROWS = 3
const MIN_CARD_ROWS = 6
// What the screen keeps under the transcript: the prompt and the lines around it.
const BOTTOM_ROWS = 8

/** What the terminal is shown of a picture, frame by frame: an Image's sources, or pixels to draw in cells. */
type Loaded = { sources?: ImageSource[]; pixels?: Pixels[]; href?: Href; delays: number[] }
/** A picture as an Svg holds it: a data URI, and the picture's own size. */
type Href = { href: string; width: number; height: number }

// How the terminal draws a picture: Ghostty and kitty read a file; one Claude Code was told draws
// pictures (CLAUDE_CODE_FORCE_TERMINAL_IMAGES) is sent its bytes; any other gets it in colored cells.
let graphics: 'none' | 'file' | 'bytes' = 'none'
// iTerm2 3.5 and later draws pictures in fullscreen alone: whether the session is, its first drawing
// says. Where the terminal draws cells, a picture under the pointer opens in a window of its own, on
// the desktop the session runs on: whether it can, the window open now, and the picture under the
// pointer.
let isItermPending = false
let canWindow = false
// The window's program, one a session (window.ts): what it says, the file it is told what to do in,
// the number of the last thing told, what is still to be written there, and the picture each show
// was for.
type Host = {
  stream: ReturnType<Engine['process']['spawn']>
  commands: string
  number: number
  isReady: boolean
  next?: string
  isWriting: boolean
  shows: Map<number, string>
}
let host: Host | undefined
let hostStarts = 0
// The picture the window is for (up, or on its way), and the one under the pointer.
let windowKey: string | undefined
let pointerOn: string | undefined
// The pictures a window could not show: the terminal's cells are theirs.
const noWindow = new Set<string>()
let temp: string | undefined
let sessionId: string | undefined
let folder: string | undefined
let cache: string | undefined
// When the temp folder was last looked through for this session's, and how often it may be.
let scannedAt = -Infinity
const SCAN_MS = 10000
const loaded = new Budget<Loaded>(LOADED_BUDGET, key => forget(key), key => isInUse(key))
// When each picture was last drawn: one drawn lately stays in memory, over the budget if it must.
const drawnAt = new Map<string, number>()
const isInUse = (key: string) => Date.now() - (drawnAt.get(key) ?? -Infinity) < DRAWN_MS || [...playing.values()].some(play => play.key === key)
const loading = new Set<string>()
// The pictures that could not be read, by key, and when: not tried again on every redraw.
const failed = new Map<string, number>()
// Which session the mod reads for: a load started in an earlier one keeps nothing it read.
let epoch = 0
// The timer that keeps this session's cache marked as in use.
let touchTimer: Timer | undefined
// Each picture read from a file (or looked for there): the file, its mtime then (-1: not there),
// and when that was last looked at.
const checked = new Map<string, { file: string; mtime: number; at: number }>()
const cells = new Budget<string>(CELLS_BUDGET)
// The files of the chips already read, or let be, before the pointer came onto one.
const prefetched = new Set<string>()
// The file each picture was read from (for one Claude was sent, the copy written of it), by key; and
// the picture under each picture's click region, by `<requestId>/<region key>`.
const sourceFiles = new Map<string, string>()
const openers = new Map<string, string>()
// The pictures each block of an answer names, by the answer and the block: its text then, whether
// every name was found, and when it was looked up. One entry a block, replaced as an answer streams
// in, so the partial texts do not pile up; at most MAX_KNOWN of them, the oldest going first.
const references = new Map<string, { text: string; at: number; found: Promise<{ files: string[]; isComplete: boolean }> }>()
const MAX_KNOWN = 1000
// The image files under the working folder, and when they were listed.
let index: { at: number; files: Promise<string[]> } | undefined
// The order transcript rows were first drawn in: the newest is the one at the foot of the screen.
const rowOrder = new Map<string, number>()
// The file each chip names, by `<requestId>/<chip key>`; and where the answer showing the card was when it opened.
const chipFiles = new Map<string, string>()
let hoveredAt: string | undefined
// How many rows each block of an answer was laid out in, by the answer's requestId, as its probes said.
const blockRows = new Map<string, number[]>()
// The file a Read call read, by its tool_use_id, as its row named it.
const readPaths = new Map<string, string>()

/** An animation playing: where it is drawn, which picture, and the frame on show. */
type Playing = { requestId: string; element: string; key: string; frame: number; columns: number; rows: number; timer?: Timer }
const playing = new Map<string, Playing>()

const idsIn = (text: string) => [...new Set([...text.matchAll(TOKEN)].map(match => Number(match[1])))]

/** A short, stable name for a key, to name its files by. */
function nameOf (key: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193)
  return `${key.slice(0, key.indexOf(':'))}-${(hash >>> 0).toString(16)}`
}

const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

/** Where pasted images are stored for this session: `<temp>/<project path, dashed>/<session id>/images`. */
async function sessionFolder ($: Engine) {
  if (folder) return folder
  const id = await follow($)
  const root = (temp ??= await tempFolder($))
  const names = new Set([await $.session.root(), await $.session.cwd()].map(path => path.replace(/[^a-zA-Z0-9]/g, '-')))
  for (const name of names) {
    if (await $.fs.exists(`${root}/${name}/${id}/images`)) return (folder = `${root}/${name}/${id}`)
  }
  // A project path too long for a folder name gets a hash after it: look for the session instead,
  // through every project's folder, once in a while: a pasted picture is looked for many times.
  const now = await $.clock.now()
  if (now - scannedAt < SCAN_MS) return undefined
  scannedAt = now
  for (const entry of await $.fs.list(root).catch(() => [])) {
    if (entry.kind === 'dir' && (await $.fs.exists(`${root}/${entry.name}/${id}/images`))) return (folder = `${root}/${entry.name}/${id}`)
  }
  return undefined
}

async function pastedFile ($: Engine, id: number) {
  const found = await sessionFolder($)
  if (!found) return undefined
  const name = (await $.fs.list(`${found}/images`).catch(() => [])).find(entry => entry.name.startsWith(`${id}.`))?.name
  return name && /^\d+\.[a-z]+$/.test(name) ? `${found}/images/${name}` : undefined
}

/** The key of pasted image `id`: it names the session, as after /clear the ids start again from 1. */
const pasteKey = (id: number) => `paste:${sessionId}:${id}`

/** Reads pasted image `id`, waiting a little for the engine, which writes it just after the paste. */
function loadPaste ($: Engine, id: number) {
  void load($, pasteKey(id), async () => {
    let file = await pastedFile($, id)
    for (let tries = 0; !file && tries < WAIT_TRIES; tries++) {
      await $.clock.sleep(WAIT_MS)
      file = await pastedFile($, id)
    }
    return file ? [{ file }] : []
  })
}

/**
 * Keeps the strip's list of the draft's pictures in step with the prompt box, and reads each as it
 * comes into the draft: a picture is ready by the time the strip draws it, and an [Image #N] typed
 * by hand, with none behind it, is known as such.
 */
async function track ($: Engine, text: string) {
  const ids = idsIn(text)
  const now = await read($, draft)
  if (ids.length === now.length && ids.every((id, i) => id === now[i])) return
  await update($, draft, () => ids)
  await follow($)
  for (const id of ids) loadPaste($, id)
}

/**
 * The mod's own folder for this session, made where it is missing. Looked at on every use: one
 * removed under the session must not be written to, as sips, told to write into a folder that is
 * not there, writes a file at the folder's path, says nothing, and every write after it fails.
 */
async function cacheFolder ($: Engine) {
  const id = await follow($)
  const path = cache ?? `${(temp ??= await tempFolder($))}/inline-images/${id}`
  const kind = await $.fs.stat(path).then(stat => stat.kind, () => undefined)
  if (kind === 'dir') return (cache = path)
  // A file where the folder goes: one such a write left. It goes, and the folder is made.
  if (kind !== undefined) await remove($, path)
  await makeFolder($, path)
  return (cache = path)
}

/**
 * The session's id, asked once: `session.start` and `session.end` (a /clear among its reasons) set
 * it and clear it, so a row drawing does not ask again.
 */
async function follow ($: Engine) {
  return (sessionId ??= await $.session.id())
}

/** Forgets everything read: a new session, or a /clear, whose pasted ids start again from 1. */
function reset () {
  epoch++
  sessionId = undefined
  folder = undefined
  scannedAt = -Infinity
  cache = undefined
  loaded.clear()
  failed.clear()
  checked.clear()
  cells.clear()
  for (const play of playing.values()) play.timer?.cancel()
  playing.clear()
  references.clear()
  blockRows.clear()
  rowOrder.clear()
  prefetched.clear()
  sourceFiles.clear()
  openers.clear()
  drawnAt.clear()
  noWindow.clear()
  index = undefined
}

/** A picture dropped from memory: its cells go too, and its animation stops. */
function forget (key: string) {
  for (const id of cells.keys()) if (id.startsWith(`${key}#`)) cells.delete(id)
  for (const [id, play] of playing) {
    if (play.key !== key) continue
    play.timer?.cancel()
    playing.delete(id)
  }
}

/** Whether a picture under the pointer opens in a window: a terminal that draws cells, on a desktop. */
const isWindowing = () => canWindow && graphics === 'none'

/** Settles iTerm2's way at the first drawing: pixels in fullscreen, cells elsewhere. */
function settle (e: { surface: string; viewport?: { isFullscreen?: boolean } }) {
  if (!isItermPending || e.surface !== 'terminal' || e.viewport === undefined) return
  isItermPending = false
  graphics = e.viewport.isFullscreen === false ? 'none' : 'bytes'
}

/**
 * Starts the window's program: one for the session, started before the pointer comes, as it takes a
 * while to (PowerShell's above all). It shows one picture at a time, told in a file.
 */
async function startHost ($: Engine) {
  if (host) return host
  if (!canWindow || hostStarts >= WINDOW_STARTS) return undefined
  hostStarts++
  const commands = `${await cacheFolder($)}/window.txt`
  await $.fs.write(commands, '')
  if (host) return host
  const started: Host = { stream: $.process.spawn(await windowCommand($, commands, WINDOW_SIZE)), commands, number: 0, isReady: false, isWriting: false, shows: new Map() }
  host = started
  void readHost($, started)
  return started
}

/**
 * Reads what the window's program says while it runs. A picture it cannot read is not shown it
 * again; a program that cannot run at all (no display, no Tk) sends the pictures back to the
 * terminal.
 */
async function readHost ($: Engine, running: Host) {
  let said = ''
  let rest = ''
  try {
    for await (const { stream, text } of running.stream) {
      if (stream === 'stderr') {
        if (said.length < 2000) said += text
        continue
      }
      const lines = (rest + text).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines.map(line => line.trim())) {
        if (line === 'ready') running.isReady = true
        const failed = /^error (\d+): (.*)$/.exec(line)
        const key = failed ? running.shows.get(Number(failed[1])) : undefined
        if (key !== undefined) {
          noWindow.add(key)
          if (windowKey === key) windowKey = undefined
          $.ui.log(`inline-images: no window for ${baseName(sourceFiles.get(key) ?? key)} (${failed![2]})`, { to: 'debug' })
        } else if (line.startsWith('error') && said.length < 2000) said += `${line}\n`
      }
    }
  } catch (error) {
    said += messageOf(error)
  }
  if (host !== running) return
  host = undefined
  windowKey = undefined
  // Ended before it was ready, or saying it cannot run here: the cells are all.
  if (running.isReady && !/^error: /m.test(said)) return
  canWindow = false
  $.ui.log(`inline-images: no window (${said.trim().slice(0, 300) || 'the program could not start'}); the terminal shows the pictures`, { to: 'debug' })
}

/**
 * Tells the window's program to show a picture (its path in the program's form, none while it is
 * made, and its size where known), to hide the window, or to end; started first to show one. Told
 * in order: what is told while a write is on its way is written after it, the latest alone.
 */
async function tell ($: Engine, verb: 'show' | 'hide' | 'quit', key?: string, path = '', width = 0, height = 0) {
  const running = verb === 'show' ? await startHost($) : host
  if (!running) return
  const number = ++running.number
  if (key !== undefined) {
    running.shows.set(number, key)
    if (running.shows.size > MAX_KNOWN) running.shows.delete(running.shows.keys().next().value!)
  }
  running.next = `${number}\n${verb}\n${path}\n${width}\n${height}\nend\n`
  if (running.isWriting) return
  running.isWriting = true
  try {
    while (running.next !== undefined) {
      const text = running.next
      running.next = undefined
      await $.fs.write(running.commands, text)
    }
  } finally {
    running.isWriting = false
  }
}

/**
 * Shows picture `key` (from `file`, or the file it was read from) in the window by the pointer:
 * the window opens at once, a spinner in it where the picture takes a moment (one the window cannot
 * read is made a PNG first), and the picture fills it.
 */
async function openWindow ($: Engine, key: string, given?: string) {
  if (pointerOn !== key || noWindow.has(key) || windowKey === key) return
  windowKey = key
  const picture = (await read($, pictures))[key]
  const [width, height] = picture && 'width' in picture ? [picture.width, picture.height] : [0, 0]
  let file = given ?? sourceFiles.get(key)
  const isReadable = file !== undefined && windowReads(file)
  await tell($, 'show', key, isReadable ? await windowPath($, file!) : '', width, height)
  if (isReadable) return
  // A picture the system's window cannot read (Tk reads PNG and GIF; System.Drawing no WebP) is
  // shown a PNG of it.
  if (file) {
    const out = `${await cacheFolder($)}/${nameOf(key)}.window.png`
    file = await convert($, file, out, 'png', WINDOW_SIZE).then(() => out, () => undefined)
  }
  if (windowKey !== key) return
  const path = file && (await windowPath($, file))
  if (path) return tell($, 'show', key, path, width, height)
  noWindow.add(key)
  windowKey = undefined
  await tell($, 'hide')
}

/** Closes the window. */
function closeWindow ($: Engine) {
  if (windowKey === undefined) return
  windowKey = undefined
  void tell($, 'hide').catch(() => undefined)
}

/** Ends the window's program: the session ends. */
async function stopHost ($: Engine) {
  const running = host
  host = undefined
  windowKey = undefined
  pointerOn = undefined
  hostStarts = 0
  if (!running) return
  // Told to end (a program under WSL outlives its stream), and its stream ended.
  await $.fs.write(running.commands, `${running.number + 1}\nquit\n\n0\n0\nend\n`).catch(() => undefined)
  void running.stream.return(undefined as never)?.catch(() => undefined)
}

/** The pointer onto (or off) a picture or a chip (`file`, a chip's): its window opens, or closes. */
function pointAt ($: Engine, key: string, isOver: boolean, file?: string) {
  if (isOver) {
    pointerOn = key
    void openWindow($, key, file).catch(() => undefined)
    return
  }
  if (pointerOn === key) pointerOn = undefined
  if (windowKey === key) closeWindow($)
}

/** The bytes a picture holds in memory: its frames' pixels, or the base64 it is sent as. */
function weightOf ({ sources, pixels, href }: Loaded) {
  const sent = (sources ?? []).reduce((sum, source) => sum + ('rgba' in source ? source.rgba.length : 'png' in source ? source.png.length : 256), 0)
  return sent + (pixels ?? []).reduce((sum, frame) => sum + frame.data.length, 0) + (href?.href.length ?? 0)
}

/** Keeps a picture read, within the budget. */
const keep = (key: string, value: Loaded) => loaded.set(key, value, weightOf(value))

/** Removes the cache of a session that ended. */
async function sweepEnded ($: Engine, id: string) {
  if (!/^[\w-]+$/.test(id)) return
  await remove($, `${(temp ??= await tempFolder($))}/inline-images/${id}`)
}

/**
 * Removes, as a session starts, the caches of sessions gone a week: by their folder's mtime, which a
 * running session keeps fresh (touchCache), and never this session's own.
 */
async function sweepOld ($: Engine) {
  const root = `${(temp ??= await tempFolder($))}/inline-images`
  const now = await $.clock.now()
  const own = await follow($)
  for (const entry of await $.fs.list(root).catch(() => [])) {
    if (entry.kind === 'dir' && entry.name !== own && /^[\w-]+$/.test(entry.name) && now - entry.mtimeMs > CACHE_DAYS * 24 * 60 * 60 * 1000) {
      await remove($, `${root}/${entry.name}`)
    }
  }
}

/** Marks this session's cache as in use: a running session's is never taken for one gone. */
async function touchCache ($: Engine) {
  if (cache) await touch($, cache)
}

/** Notes a transcript row the first time it is drawn. */
function noteRow (requestId: string) {
  if (!rowOrder.has(requestId)) rowOrder.set(requestId, rowOrder.size)
}

/** Whether a row is the newest drawn: the transcript's last, at the foot of the screen. */
const isNewest = (requestId: string) => rowOrder.get(requestId) === rowOrder.size - 1

/** A PNG's width and height, from its header. */
function pngSize (bytes: Uint8Array) {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** A file's first bytes: enough to tell a GIF, and a PNG's size. */
async function headOf ($: Engine, file: string) {
  return readBytes($, file, 0, 32)
}

/** A whole file's bytes: in one read under 4 MiB, past that in pieces, each through base64. */
async function bytesOf ($: Engine, file: string, size?: number) {
  size ??= (await $.fs.stat(file)).size
  if (size < READ_LIMIT) return Uint8Array.fromBase64((await $.fs.read(file, { as: 'bytes' })).base64)
  const bytes = new Uint8Array(size)
  for (let at = 0; at < size; at += PIECE_BYTES) bytes.set((await readBytes($, file, at, PIECE_BYTES)).subarray(0, size - at), at)
  return bytes
}

/** A GIF's width and height, from its header. */
function gifSize (bytes: Uint8Array) {
  if (!isGif(bytes) || bytes.length < 10) return undefined
  return { width: bytes[6]! | (bytes[7]! << 8), height: bytes[8]! | (bytes[9]! << 8) }
}

/**
 * A picture as an Svg holds it: a PNG or GIF small enough as its own bytes (a GIF keeps playing);
 * any other shrunk till it fits the Svg's markup, a JPEG, or a PNG where it has an alpha channel (a
 * JPEG would turn what is see-through black). Measured once; each try after the first takes the side
 * its bytes say should fit.
 */
async function loadHref ($: Engine, key: string, file: string, head: Uint8Array, all: Uint8Array | undefined, size: number): Promise<[Picture, Loaded]> {
  const own = pngSize(head) ?? gifSize(head)
  const type = isPng(head) ? 'png' : isGif(head) ? 'gif' : undefined
  if (type && own && Math.ceil(size / 3) * 4 <= SVG_DATA) {
    const bytes = all ?? await bytesOf($, file, size)
    return [{ ...own, frames: 1 }, { href: { href: `data:image/${type};base64,${bytes.toBase64()}`, ...own }, delays: [0] }]
  }
  const format = isPng(head) && (head[25] === 4 || head[25] === 6) ? 'png' : 'jpeg'
  const out = `${await cacheFolder($)}/${nameOf(key)}.svg.${format === 'png' ? 'png' : 'jpg'}`
  let measured = own
  let side = SVG_SIDE
  for (let tries = 0; tries < 3; tries++) {
    measured = await convert($, file, out, format, side, measured)
    const bytes = await bytesOf($, out)
    const length = Math.ceil(bytes.length / 3) * 4
    if (length <= SVG_DATA) {
      const href = { href: `data:image/${format};base64,${bytes.toBase64()}`, width: measured.width, height: measured.height }
      return [{ width: measured.width, height: measured.height, frames: 1 }, { href, delays: [0] }]
    }
    // A picture's bytes go with its area: the side that should fit, a little under.
    side = Math.max(64, Math.floor(Math.min(side, Math.max(measured.width, measured.height)) * Math.sqrt(SVG_DATA / length) * 0.9))
  }
  throw new Error('too large to show')
}

/** The markup of an Svg drawing a picture at its own shape, SVG_WIDTH CSS pixels wide at most. */
function svgOf ({ href, width, height }: { href: string; width: number; height: number }) {
  const w = Math.min(SVG_WIDTH, width)
  const h = Math.max(1, Math.round((height * w) / width))
  return { source: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" href="${href}"/></svg>`, width: w, height: h }
}

/** A whole number that changes when the file does: what tells the terminal to read it again. */
const generationOf = (mtime: number) => Math.floor(mtime / 1000) % 2147483647

/** A GIF's frames, shrunk to fit the budget as they are decoded, as the terminal is shown them. */
async function loadGif ($: Engine, key: string, bytes: Uint8Array, version: string): Promise<[Picture, Loaded]> {
  // Every frame together within the budget: a long animation is shrunk further.
  const gif = decodeGif(bytes, MAX_FRAMES, (w, h, count) =>
    Math.max(1, Math.min(FRAME_PIXELS, Math.floor(Math.sqrt(FRAME_BUDGET / 4 / Math.max(1, count)) * Math.max(w, h) / Math.sqrt(w * h)))))
  const frames = gif.frames
  const count = frames.length
  const { width, height } = frames[0]!
  const delays = gif.frames.map(frame => frame.delay)
  const picture = { width: gif.width, height: gif.height, frames: count }
  if (graphics === 'none') return [picture, { pixels: frames, delays }]
  if (graphics === 'bytes') return [picture, { sources: frames.map(frame => ({ rgba: frame.data.toBase64(), width, height })), delays }]
  const dir = `${await cacheFolder($)}/${nameOf(key + version)}`
  await makeFolder($, dir)
  await writeFrames($, dir, frames.map(frame => frame.data.toBase64()))
  return [picture, { sources: frames.map((_, i) => ({ file: `${dir}/${i}.rgba`, format: 'rgba' as const, width, height })), delays }]
}

/**
 * A still picture, as a PNG the terminal reads or is sent, or as pixels to draw in cells. Its size
 * is its own (a PNG's header, else the converter's), not the size it was shrunk to: it decides how
 * many cells it takes.
 */
async function loadStill ($: Engine, key: string, file: string, head: Uint8Array, bytes: number, mtime: number, version: string, all?: Uint8Array): Promise<[Picture, Loaded]> {
  const out = `${await cacheFolder($)}/${nameOf(key + version)}`
  // A PNG drawn in cells or sent as pixels is decoded here, with no converter: on any system, sips
  // and ImageMagick or not. One that cannot be (too large) goes on to the converter.
  const own = pngSize(head)
  if (own && isPng(head) && graphics !== 'file') {
    const picture = { width: own.width, height: own.height, frames: 1 }
    // Sent as it is where it is small enough: nothing to decode.
    if (graphics === 'bytes' && Math.max(own.width, own.height) <= VIEW_PIXELS && bytes <= VIEW_BYTES) {
      return [picture, { sources: [{ png: (all ?? await bytesOf($, file, bytes)).toBase64() }], delays: [0] }]
    }
    // A large one drawn in cells is shrunk by a converter where there is one: quicker than here.
    if (graphics === 'none' && own.width * own.height > DECODE_PIXELS) {
      const isConverted = await convert($, file, `${out}.bmp`, 'bmp', CELL_SOURCE_PIXELS, own).then(() => true, () => false)
      if (isConverted) return [picture, { pixels: [parseBmp(await bytesOf($, `${out}.bmp`))], delays: [0] }]
    }
    const pixels = await Promise.resolve(all ?? bytesOf($, file, bytes)).then(decodePng).catch(() => undefined)
    if (pixels) {
      if (graphics === 'none') return [picture, { pixels: [shrink(pixels, CELL_SOURCE_PIXELS, CELL_SOURCE_PIXELS)], delays: [0] }]
      // Too large to send as it is: as pixels, shrunk to what one may send.
      const side = Math.max(1, Math.floor(Math.min(VIEW_PIXELS, Math.sqrt(VIEW_BYTES / 4 / (own.width * own.height)) * Math.max(own.width, own.height))))
      const small = shrink(pixels, side, side)
      return [picture, { sources: [{ rgba: small.data.toBase64(), width: small.width, height: small.height }], delays: [0] }]
    }
  }
  if (graphics === 'none') {
    const converted = await convert($, file, `${out}.bmp`, 'bmp', CELL_SOURCE_PIXELS)
    const pixels = parseBmp(await bytesOf($, `${out}.bmp`))
    const size = own ?? converted
    return [{ width: size.width, height: size.height, frames: 1 }, { pixels: [pixels], delays: [0] }]
  }
  let png = file
  let size = own
  const side = graphics === 'bytes' ? VIEW_PIXELS : STILL_PIXELS
  if (!own || Math.max(own.width, own.height) > side || (graphics === 'bytes' && bytes > VIEW_BYTES)) {
    // A PNG too large for the terminal, with no converter here, is drawn as it is: the terminal
    // shrinks it.
    const converted = await convert($, file, `${out}.png`, 'png', side).catch(error => {
      if (own && graphics === 'file') return undefined
      throw error
    })
    if (converted) {
      png = `${out}.png`
      size = converted
    }
  }
  const shown = png === file ? own : pngSize(await headOf($, png))
  if (!shown) throw new Error('could not read it')
  size ??= shown
  const picture = { width: size.width, height: size.height, frames: 1 }
  if (graphics === 'file') return [picture, { sources: [{ file: png, format: 'png', generation: generationOf(mtime) }], delays: [0] }]
  const pngBytes = png === file && all ? all : await bytesOf($, png)
  if (pngBytes.length > VIEW_BYTES) throw new Error('too large to send')
  return [picture, { sources: [{ png: pngBytes.toBase64() }], delays: [0] }]
}

/** Where a picture is read from: a file, or bytes the transcript holds (`ext` naming their kind). */
type Origin = { file: string } | { base64: string; ext: string }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** What a load read: the picture, what it is drawn from, its file, and that file's mtime (a file's). */
type Read = { picture: Picture; value: Loaded; file: string; mtime?: number }

/** Reads a picture from one origin: for the terminal, or (a key `svg:…`) for an Svg. */
async function loadFrom ($: Engine, key: string, origin: Origin): Promise<Read> {
  let file: string
  let size: number
  let mtime = 0
  if ('file' in origin) {
    file = origin.file
    const stat = await $.fs.stat(file).catch(() => {
      throw new Error('not found')
    })
    if (stat.size > MAX_FILE_BYTES) throw new Error('larger than 32 MB')
    size = stat.size
    mtime = stat.mtimeMs
  } else {
    file = `${await cacheFolder($)}/${nameOf(key)}.source.${origin.ext}`
    await writeBytes($, file, origin.base64)
    size = Math.floor((origin.base64.length * 3) / 4)
  }
  const version = `@${mtime}`
  // A file small enough is read once, in the engine, its header taken from it: no process for it.
  const all = size < READ_LIMIT ? await bytesOf($, file, size) : undefined
  const head = all ? all.subarray(0, 32) : await headOf($, file)
  const [picture, value] = key.startsWith('svg:')
    ? await loadHref($, key, file, head, all, size)
    : isGif(head)
      ? await loadGif($, key, all ?? await bytesOf($, file, size), version)
      : await loadStill($, key, file, head, size, mtime, version, all)
  return { picture, value, file, ...('file' in origin && { mtime }) }
}

/**
 * Reads a picture once, from the first of its origins that reads; the drawings that wait on it
 * draw again. One that cannot be read is not tried again (until its file changes, for a picture
 * read from a file): a redraw would try it again and draw again, without end.
 */
async function load ($: Engine, key: string, from: () => Promise<Origin[]>) {
  const isPaste = key.startsWith('paste:')
  if (loaded.has(key) || loading.has(key) || (failed.has(key) && !isPaste)) return
  loading.add(key)
  const mine = epoch
  let read: Read | undefined
  let missing: string | undefined
  let reason = 'not found'
  let now = 0
  try {
    now = await $.clock.now()
    // A pasted picture not found is looked for again once the last look is old.
    if (isPaste && failed.has(key) && now - failed.get(key)! < PASTE_RETRY_MS) return
    for (const origin of await from()) {
      try {
        read = await loadFrom($, key, origin)
        break
      } catch (error) {
        reason = messageOf(error)
        if ('file' in origin) missing ??= origin.file
      }
    }
  } catch (error) {
    reason = messageOf(error)
  } finally {
    loading.delete(key)
  }
  // The session ended meanwhile (a /clear, a resume): what this load read is not the new one's.
  if (mine !== epoch) return
  let picture: Picture
  if (read) {
    failed.delete(key)
    keep(key, read.value)
    sourceFiles.set(key, read.file)
    if (read.mtime !== undefined) checked.set(key, { file: read.file, mtime: read.mtime, at: now })
    picture = read.picture
  } else {
    failed.set(key, now)
    if (missing && !checked.has(key)) checked.set(key, { file: missing, mtime: -1, at: now })
    picture = { error: reason }
  }
  // Read in the background: a module unloaded meanwhile has no state to write to.
  await update($, pictures, all => ({ ...all, [key]: picture })).catch(() => undefined)
}

/**
 * Looks again, now and then, at the file a picture was read from (or looked for at): changed, or
 * there at last, the picture is read again; the rows that show it draw again.
 */
async function recheck ($: Engine, key: string) {
  const seen = checked.get(key)
  if (!seen || loading.has(key)) return
  const now = await $.clock.now()
  if (now - seen.at < RECHECK_MS) return
  seen.at = now
  const mtime = await $.fs.stat(seen.file).then(stat => stat.mtimeMs, () => -1)
  if (mtime === seen.mtime) return
  checked.delete(key)
  loaded.delete(key)
  failed.delete(key)
  forget(key)
  await update($, pictures, all => {
    const { [key]: _, ...rest } = all
    return rest
  }).catch(() => undefined)
}

/**
 * The box of cells a picture takes: as large as the bounds allow, keeping its shape (a cell is about
 * twice as tall as it is wide), never much larger than the picture itself.
 */
function fitCells (width: number, height: number, maxColumns: number, maxRows: number) {
  let columns = Math.max(1, Math.min(maxColumns, Math.ceil(width / CELL_PIXELS)))
  let rows = Math.max(1, Math.round((columns * height) / width / 2))
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.min(columns, Math.round((rows * 2 * width) / height)))
  }
  return { columns, rows }
}

function cellsOf (key: string, frame: number, columns: number, rows: number) {
  const id = `${key}#${frame}:${columns}x${rows}`
  let painted = cells.get(id)
  if (painted === undefined) {
    painted = toCells(loaded.get(key)!.pixels![frame]!, columns, rows)
    cells.set(id, painted, painted.length)
  }
  return painted
}

const playId = (requestId: string, element: string) => `${requestId}/${element}`

/** Shows the next frame, then waits its delay; ends where the picture is no longer drawn. */
async function step ($: Engine, id: string) {
  const play = playing.get(id)
  const frames = play && loaded.get(play.key)
  if (!play || !frames) return void playing.delete(id)
  play.frame = (play.frame + 1) % frames.delays.length
  const { requestId, element: key, columns, rows } = play
  const shown = frames.sources
    ? await $.ui.blit({ requestId, key, source: frames.sources[play.frame]!, columns, rows }).catch(() => ({ deny: 'gone' }))
    : await $.ui.blit({ requestId, key, cells: cellsOf(play.key, play.frame, columns, rows), columns, rows }).catch(() => ({ deny: 'gone' }))
  if (playing.get(id) !== play) return
  if (shown.deny) return void playing.delete(id)
  play.timer = $.clock.after(frames.delays[play.frame]!, () => void step($, id))
}

/** Plays an animation drawn at a site while it shows; one off screen stops, on the frame it was on. */
function play ($: Engine, requestId: string, element: string, key: string, columns: number, rows: number, isShown: boolean) {
  const id = playId(requestId, element)
  const now = playing.get(id)
  if (now && (!isShown || now.columns !== columns || now.rows !== rows)) {
    now.timer?.cancel()
    playing.delete(id)
  }
  if (!isShown || playing.has(id)) return now?.frame ?? 0
  const frames = loaded.get(key)!
  const started: Playing = { requestId, element, key, frame: now?.frame ?? 0, columns, rows }
  playing.set(id, started)
  started.timer = $.clock.after(frames.delays[started.frame]!, () => void step($, id))
  return started.frame
}

type Site = { ui: Ui; requestId: string; maxColumns: number; maxRows: number; isShown: boolean; animate: boolean; canPoint: boolean }

// The options: the most rows a picture takes, and whether GIFs play. And what `/images` set: whether
// pictures are drawn at all, and the most rows small and large ones take (medium: the option's).
let optionRows = 12
let maxRows = 12
let animate = true
// Whether a click on a picture or a chip opens it in the system's viewer (the Open on click option).
let clickOpens = false
let isOn = true
const SIZE_ROWS = { small: 6, large: 24 }
const START_VIEW: View = { isOn: true, size: 'medium' }

/** Draws the pictures as `/images` set: off, none (each row the engine's own), and nothing plays. */
function apply ($: Engine, { isOn: on, size }: View) {
  isOn = on
  maxRows = size === 'medium' ? optionRows : SIZE_ROWS[size]
  if (on) return
  closeWindow($)
  for (const play of playing.values()) play.timer?.cancel()
  playing.clear()
}

/** What `/images` answers: how pictures are drawn now. */
const describe = ({ isOn: on, size }: View) =>
  on ? `Inline Images: on, pictures ${size} (up to ${size === 'medium' ? optionRows : SIZE_ROWS[size]} rows).` : 'Inline Images: off. /images to turn it on.'

/** Where a row's pictures are drawn, and how large they may be. */
function siteOf ($: Engine, e: RenderOf<'ToolResult' | 'ToolGroup' | 'UserMessage' | 'AssistantMessage' | 'AbovePrompt'>, indent: number): Site {
  return {
    ui: $.ui.resolve(e),
    requestId: e.requestId,
    maxColumns: Math.max(8, Math.min(MAX_COLUMNS, (e.viewport?.columns ?? 80) - indent - 2)),
    // In cells a picture shows its layout, not its detail: half the rows do as well.
    maxRows: graphics === 'none' ? Math.max(3, Math.round(maxRows / 2)) : maxRows,
    // Off screen (`null`) an animation stops; a surface that does not say counts as on screen.
    isShown: !('onScreen' in e.props) || e.props.onScreen !== null,
    animate,
    // The pointer reaches a picture in fullscreen alone; it is wanted there to open a window, or for
    // a click where clicks open pictures.
    canPoint: e.viewport?.isFullscreen !== false && (isWindowing() || clickOpens)
  }
}

/** One picture, as large as the site allows: the picture itself, or a dim line while it loads or where it cannot be read. */
function pictureOf ($: Engine, site: Site, all: Record<string, Picture>, key: string, label: string, slot = 'image'): RenderElement {
  const { ui: { Box, Client, Image, Raster, Text }, requestId } = site
  const picture = all[key]
  const frames = loaded.get(key)
  if (key.startsWith('file:')) void recheck($, key).catch(() => undefined)
  if (picture && 'error' in picture) return <Text key={key} dimColor>{`${label}: no preview, ${picture.error}`}</Text>
  if (!picture || !frames) return <Text key={key} dimColor>{`${label} loading…`}</Text>

  drawnAt.set(key, Date.now())
  const { columns, rows } = fitCells(picture.width, picture.height, site.maxColumns, site.maxRows)
  const element = `${slot}:${nameOf(key)}`
  const isAnimated = frames.delays.length > 1 && site.animate
  const frame = isAnimated ? play($, requestId, element, key, columns, rows, site.isShown) : 0
  const drawn = frames.sources
    ? <Image key={element} source={frames.sources[frame]!} columns={columns} rows={rows} alt={label} />
    : <Raster key={element} columns={columns} rows={rows} cells={cellsOf(key, frame, columns, rows)} />
  if (!site.canPoint) return drawn
  // Over the picture, an unpainted region of its size: a click on it opens the picture in the
  // system's viewer.
  const opener = `open:${element}`
  openers.set(`${requestId}/${opener}`, key)
  return (
    <Box key={`picture:${element}`} width={columns} height={rows} flexShrink={0}>
      {drawn}
      <Box position="absolute" top={0} left={0}>
        <Client key={opener} module="./chip.tsx" width={columns} height={rows} />
      </Box>
    </Box>
  )
}

/** A text exactly `width` cells wide: cut with an ellipsis, or padded with spaces. */
const fill = (text: string, width: number) => (text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width))

// The narrowest a card is, so its caption reads.
const MIN_CARD_COLUMNS = 24

/**
 * A picture in a bordered card, its path under it. It floats over the answer, which shows through any
 * cell it leaves unwritten: every line is written to the card's width, spaces and all, and the card
 * is no wider than the picture (or its caption, up to a point).
 */
function cardOf ($: Engine, site: Site, all: Record<string, Picture>, key: string, caption: string): [RenderElement, number] {
  const { Box, Text } = site.ui
  const picture = all[key]
  const label = baseName(caption)
  const isShown = picture && !('error' in picture) && loaded.has(key)
  const columns = isShown ? fitCells(picture.width, picture.height, site.maxColumns, site.maxRows).columns : 0
  const rows = isShown ? fitCells(picture.width, picture.height, site.maxColumns, site.maxRows).rows : 0
  const width = Math.min(site.maxColumns, Math.max(columns, Math.min(caption.length, MIN_CARD_COLUMNS)))
  // A caption wider than the card names the file alone.
  const name = caption.length > width ? label : caption
  const side = (n: number) => n > 0 && <Text>{Array.from({ length: rows }, () => ' '.repeat(n)).join('\n')}</Text>
  const left = Math.floor((width - columns) / 2)
  // The border's two rows, the caption's, and the picture's (or the line saying why there is none).
  const height = 3 + (isShown ? rows : 1)
  return [(
    <Box key="frame" flexDirection="column" borderStyle="round" borderDimColor flexShrink={0} width={width + 2}>
      {!isShown
        ? <Text dimColor>{fill(picture && 'error' in picture ? `${label}: no preview, ${picture.error}` : `${label} loading…`, width)}</Text>
        : (
          <Box flexDirection="row">
            {side(left)}
            {pictureOf($, site, all, key, label, 'card')}
            {side(width - columns - left)}
          </Box>
          )}
      <Text dimColor>{fill(name, width)}</Text>
    </Box>
  ), height]
}

/**
 * Pasted pictures side by side, each in its share of the width, and in the strip its `[Image #N]`
 * under it: as many as fit, the rest counted. One with no picture behind it (an [Image #N] typed by
 * hand) draws nothing; one that cannot be read says why.
 */
function pastedRow ($: Engine, site: Site, all: Record<string, Picture>, ids: number[], isNamed: boolean): RenderElement | undefined {
  const { Box, Text } = site.ui
  const shown = ids.filter(id => (all[pasteKey(id)] as { error?: string } | undefined)?.error !== 'not found')
  if (shown.length === 0) return undefined
  const label = (id: number) => `[Image #${id}]`
  const more = (n: number) => `+${n} more`
  const least = isNamed ? Math.max(...shown.map(id => label(id).length)) : PASTE_COLUMNS
  const width = (n: number) => n * least + PASTE_GAP * (n - 1) + (n < shown.length ? PASTE_GAP + more(shown.length - n).length : 0)
  let count = shown.length
  while (count > 1 && width(count) > site.maxColumns) count--
  const rest = shown.length - count
  const room = site.maxColumns - PASTE_GAP * (count - 1) - (rest > 0 ? PASTE_GAP + more(rest).length : 0)
  const share = { ...site, maxColumns: Math.max(1, Math.floor(room / count)) }
  return (
    <Box key="pasted" flexDirection="row" columnGap={PASTE_GAP}>
      {shown.slice(0, count).map(id => (
        <Box key={`pasted-${id}`} flexDirection="column" flexShrink={0}>
          {pictureOf($, share, all, pasteKey(id), label(id), 'pasted')}
          {isNamed && <Text dimColor wrap="truncate-end">{label(id)}</Text>}
        </Box>
      ))}
      {rest > 0 && <Text dimColor>{more(rest)}</Text>}
    </Box>
  )
}

/** A row drawn as the engine draws it, the pictures under it. */
function withPictures (ui: Ui, drawn: RenderElement, indent: number, pictures: RenderElement[]) {
  const { Box } = ui
  return (
    <Box flexDirection="column">
      {drawn}
      <Box flexDirection="column" paddingLeft={indent} rowGap={0}>
        {pictures}
      </Box>
    </Box>
  )
}

type ReadImage = { type: 'image'; file: { base64: string; type: string; originalSize?: number } }

const isReadImage = (output: unknown): output is ReadImage =>
  typeof output === 'object' && output !== null && (output as { type?: unknown }).type === 'image' &&
  typeof (output as ReadImage).file?.base64 === 'string'

const filePathOf = (input: unknown) => {
  const path = (input as { file_path?: unknown } | null)?.file_path
  return typeof path === 'string' ? path : undefined
}

/**
 * Reads the picture a Read call returned: from the file it read, at full size, while the file is
 * still the one Claude read (as large as it was); else, or where the file cannot be read, from the
 * bytes Claude was sent.
 */
function loadRead ($: Engine, toolUseId: string, output: ReadImage) {
  const key = `read:${toolUseId}`
  void load($, key, async () => {
    const sent: Origin = { base64: output.file.base64, ext: output.file.type.replace('image/', '').replace('jpeg', 'jpg') }
    const path = readPaths.get(toolUseId)
    const size = path ? await $.fs.stat(path).then(stat => stat.size, () => undefined) : undefined
    return path && size !== undefined && size === output.file.originalSize ? [{ file: path }, sent] : [sent]
  })
  return key
}

/** The image files under the working folder, as git knows them (tracked or not, less the ignored), listed again once old. */
function imageIndex ($: Engine, cwd: string, now: number) {
  if (!index || now - index.at >= RECHECK_MS) {
    const files = $.process.run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.PNG', '*.JPG', '*.JPEG', '*.GIF', '*.WEBP'], { cwd })
      .then(result => (result.exitCode === 0 ? result.stdout.split('\0').filter(Boolean).map(path => `${cwd}/${path}`) : []))
      .catch(() => [])
    index = { at: now, files }
  }
  return index.files
}

/**
 * The text with its code blanked out, every other character where it was: a fenced block (to its
 * closing fence, or the end) and an inline code span hold code, not markdown.
 */
function withoutCode (text: string) {
  const blank = (code: string) => code.replace(/[^\n]/g, ' ')
  // A code span ends within its paragraph: a stray backtick blanks nothing past a blank line.
  return text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, blank)
    .split(/(\n[ \t]*\n)/)
    .map(paragraph => paragraph.replace(/(`+)[^`\n][\s\S]*?\1/g, blank))
    .join('')
}

/** The pictures an answer embeds (`![alt](path)`, outside code), each with where it is in the text. */
const embeddedAt = (text: string) => [...withoutCode(text).matchAll(MARKDOWN_IMAGE)]
  .map(match => ({ target: match[2]!, at: match.index }))
  .filter(({ target }) => !/^[a-z]+:\/\//i.test(target.replace(/^file:\/\//, '')) && IMAGE_FILE.test(target))

/** The text an answer draws its pictures from: what it embeds (`![alt](path)`), apart from what it only names. */
const embeddedIn = (text: string) => embeddedAt(text).map(({ target }) => target)

/** A path as an answer wrote it, made absolute: from home, or from the working folder. */
function absolute (target: string, cwd: string, home: string | undefined) {
  let path = target.replace(/^file:\/\//, '')
  try {
    path = decodeURI(path)
  } catch {}
  // An absolute path: POSIX, a Windows drive's (C:\ or C:/), or a share's (\\server).
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) return path
  if (path.startsWith('~/')) return home ? `${home}${path.slice(1)}` : undefined
  return `${cwd}/${path.replace(/^\.\//, '')}`
}

/**
 * The image files an answer names without embedding them, each once, in order: a path that is there,
 * else the file under the working folder whose path ends with the name (`leads-filtros.gif`).
 */
async function referencesIn ($: Engine, text: string, cwd: string, now: number) {
  const bare = text.replace(MARKDOWN_IMAGE, ' ').replace(WEB_LINK, match => (match.startsWith('file://') ? match : ' '))
  const named = [...new Set([...bare.matchAll(REFERENCE)].map(match => (match[1] ?? match[2] ?? match[3])!.trim()))].slice(0, MAX_REFERENCES)
  if (named.length === 0) return { files: [], isComplete: true }
  const home = named.some(name => name.startsWith('~/')) ? await $.env.get('HOME') : undefined
  const found: string[] = []
  for (const name of named) {
    const path = absolute(name, cwd, home)
    if (path && (await $.fs.exists(path))) {
      found.push(path)
      continue
    }
    const tail = `/${name.replace(/^(\.\/|~\/|\/)+/, '')}`
    const match = (await imageIndex($, cwd, now)).filter(file => file.endsWith(tail)).sort((a, b) => a.length - b.length)[0]
    if (match) found.push(match)
  }
  return { files: [...new Set(found)], isComplete: found.length === named.length }
}

/**
 * The pictures a block of an answer names: looked up once, and again (once old) while a name is
 * still not found, as one Claude writes after it answers.
 */
async function namedIn ($: Engine, where: string, text: string, cwd: string) {
  const now = await $.clock.now()
  const known = references.get(where)
  if (known?.text === text && (now - known.at < RECHECK_MS || (await known.found).isComplete)) return (await known.found).files
  const found = referencesIn($, text, cwd, now)
  references.delete(where)
  references.set(where, { text, at: now, found })
  if (references.size > MAX_KNOWN) references.delete(references.keys().next().value!)
  return (await found).files
}

/** Reads a chip's picture before the pointer comes onto it, a small one only, once. */
async function prefetch ($: Engine, file: string) {
  if (prefetched.has(file)) return
  prefetched.add(file)
  const size = await $.fs.stat(file).then(stat => stat.size, () => Infinity)
  if (size <= PREFETCH_BYTES) await load($, `file:${file}`, async () => [{ file }])
}

/** A block of an answer: a paragraph, a list item with what is indented under it, a fence, a table; and whether a blank line comes before it. */
type Block = { text: string; gap: boolean }

/** An answer cut into the blocks its markdown draws one under another, so each can carry its chips beside it. */
function blocksOf (text: string) {
  const blocks: Block[] = []
  let lines: string[] = []
  let gap = false
  let fence: string | undefined
  const flush = () => {
    if (lines.length > 0) blocks.push({ text: lines.join('\n'), gap })
    lines = []
    gap = false
  }
  for (const line of text.split('\n')) {
    if (fence) {
      lines.push(line)
      if (line.trimStart().startsWith(fence)) fence = undefined
      continue
    }
    const opens = /^\s*(```|~~~)/.exec(line)
    if (opens) fence = opens[1]
    else if (line.trim() === '') {
      flush()
      gap = blocks.length > 0
      continue
    } else if (/^ {0,3}([-*+]|\d+[.)])\s/.test(line) && lines.length > 0 && !/^\s*\|/.test(lines[0]!)) flush()
    lines.push(line)
  }
  flush()
  return blocks
}

export const register: Register = (on, options) => {
  optionRows = Math.max(3, Math.min(60, Math.round(Number(options.rows ?? 12))))
  maxRows = optionRows
  animate = options.animate !== false
  clickOpens = options.click === true
  const markdown = options.markdown !== false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await detect($)
    const program = await $.env.get('TERM_PROGRAM')
    const term = await $.env.get('TERM')
    const isNative = program === 'ghostty' || term === 'xterm-ghostty' || term === 'xterm-kitty' || (await $.env.get('KITTY_WINDOW_ID')) !== undefined
    const isForced = /^(1|true|yes|on)$/i.test((await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')) ?? '')
    // Over ssh the terminal is on another machine: it cannot read this one's files, it is sent the
    // bytes. tmux passes no picture through: cells.
    const isRemote = (await $.env.get('SSH_CONNECTION')) !== undefined || (await $.env.get('SSH_TTY')) !== undefined
    const isTmux = (await $.env.get('TMUX')) !== undefined
    graphics = isForced ? 'bytes' : isTmux ? 'none' : isNative ? (isRemote ? 'bytes' : 'file') : 'none'
    // iTerm2 3.5 and later is sent the bytes, in fullscreen: the first drawing settles it.
    const [major = 0, minor = 0] = ((await $.env.get('TERM_PROGRAM_VERSION')) ?? '').split('.').map(Number)
    isItermPending = graphics === 'none' && !isTmux && program === 'iTerm.app' && (major > 3 || (major === 3 && minor >= 5))
    // A window by the pointer, on the desktop the session runs on: not over ssh, another machine's.
    canWindow = options.window !== false && e.isInteractive && !isRemote && (await canShowWindows($))
    // A reload starts with nothing read: what the state says was read is read again.
    await stopHost($)
    reset()
    await follow($)
    await update($, pictures, () => ({}))
    await update($, hovered, () => null)
    void sweepOld($)
    touchTimer?.cancel()
    touchTimer = $.clock.every(TOUCH_MS, () => void touchCache($))
    // A reload keeps what /images set.
    apply($, await read($, view))
    // The draft as it stands; edits and every other change of the box follow from here.
    await track($, (await $.prompt.read()).text)
    await $.command.register({ name: 'images', description: 'Inline Images: turn the pictures on or off, or set their size', argumentHint: 'on | off | small | medium | large', immediate: true })
    // The window's program, started now so the first picture under the pointer opens at once
    // (iTerm2's, once its first drawing says it draws cells).
    if (isWindowing() && !isItermPending) void startHost($).catch(() => undefined)
    return result
  })

  // /images turns the pictures off and on again, or sets their size (and turns them on); every row
  // draws again.
  on('command.run', { command: 'images' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    const now = await read($, view)
    const sizes = ['small', 'medium', 'large'] as const
    const size = sizes.find(name => name === word)
    if (word !== '' && word !== 'on' && word !== 'off' && !size) {
      return { text: `/images ${word}: not a choice. Use on, off, small, medium or large. ${describe(now)}` }
    }
    const next: View = size ? { isOn: true, size } : { ...now, isOn: word === '' ? !now.isOn : word === 'on' }
    await update($, view, () => next)
    apply($, next)
    // Off, the chips go with no 'leave' from under a resting pointer: their card goes too.
    if (!next.isOn) await update($, hovered, () => null)
    $.ui.invalidate('ui.render')
    return { text: describe(next) }
  })

  // A session that ends takes its cache with it, and everything read is forgotten: after a /clear,
  // a resume or any other end the process may go on under another session, with no session.start,
  // and must not keep using the cache just removed.
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    // Forgotten before the cache goes, so nothing drawn meanwhile writes into the one going.
    await stopHost($)
    reset()
    await sweepEnded($, e.sessionId)
    await update($, pictures, () => ({}))
    await update($, hovered, () => null)
    // The next session starts as any does: pictures on, at medium.
    await update($, view, () => START_VIEW)
    apply($, START_VIEW)
    return result
  })

  // The strip follows the draft: an edit (a key, a paste), and every other change of the box (a
  // recalled entry, a submit or a clear, a plugin's fill). Neither waits for it.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    if (isOn) void track($, box.text).catch(() => undefined)
    return box
  })

  on('prompt.change', async ($, e, next) => {
    const result = await next(e)
    if (isOn) void track($, e.text).catch(() => undefined)
    return result
  })

  // Above the prompt, while you write: the pictures pasted in the draft, side by side, each named,
  // small; a click opens one. Sent, they show under the prompt, the same pictures read once.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    settle(e)
    if (!isOn || e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const ids = await read($, draft)
    if (ids.length === 0) return next(e)
    await follow($)
    for (const id of ids) loadPaste($, id)
    const all = await read($, pictures)
    const site = { ...siteOf($, e, 0), maxColumns: e.props.bodyColumns, maxRows: Math.max(1, Math.min(DRAFT_ROWS, e.props.maxRows - 2)) }
    const row = pastedRow($, site, all, ids, true)
    if (!row) return next(e)
    const { Box } = site.ui
    return (
      <Box flexDirection="column">
        {await next(e)}
        {row}
      </Box>
    )
  })

  // The row of a Read call names the file it read: its picture is read from there, at full size.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    noteRow(e.requestId)
    if (e.props.tool === 'Read') {
      const path = filePathOf(e.props.input)
      if (path) readPaths.set(e.props.tool_use_id, path)
    }
    return next(e)
  })

  // A Read of a picture: the picture under its `⎿ Read image` line.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    noteRow(e.requestId)
    settle(e)
    if (!isOn) return next(e)
    if (e.surface !== 'terminal' || e.props.tool !== 'Read' || e.props.isErrored || !isReadImage(e.props.output)) return next(e)
    await follow($)
    const key = loadRead($, e.props.tool_use_id, e.props.output)
    const site = siteOf($, e, RESULT_INDENT)
    const path = readPaths.get(e.props.tool_use_id)
    return withPictures(site.ui, await next(e), RESULT_INDENT, [pictureOf($, site, await read($, pictures), key, path ? baseName(path) : 'image')])
  })

  // A run of reads folded into one line: each picture read, named, under the line.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    noteRow(e.requestId)
    settle(e)
    if (!isOn) return next(e)
    // Folded, the group is one count line; unfolded (--verbose, the ctrl+o transcript outside
    // fullscreen), a row a call, which draws its result inline with no ToolResult of its own: either
    // way its pictures are drawn under it, named.
    if (e.surface !== 'terminal') return next(e)
    const reads = e.props.calls.flatMap(call =>
      call.tool === 'Read' && call.tool_use_id && !call.isErrored && isReadImage(call.output) ? [{ id: call.tool_use_id, output: call.output, path: filePathOf(call.input) }] : [])
    if (reads.length === 0) return next(e)
    await follow($)
    const site = siteOf($, e, RESULT_INDENT)
    const all = await read($, pictures)
    const { Text } = site.ui
    const drawn: RenderElement[] = []
    for (const { id, output, path } of reads) {
      if (path) readPaths.set(id, path)
      const key = loadRead($, id, output)
      const label = path ? baseName(path) : 'image'
      if (reads.length > 1 || e.props.isExpanded) drawn.push(<Text key={`label:${id}`} dimColor>{label}</Text>)
      drawn.push(pictureOf($, site, all, key, label))
    }
    return withPictures(site.ui, await next(e), RESULT_INDENT, drawn)
  })

  // A prompt you sent with pictures pasted in: the pictures under it, side by side.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    noteRow(e.requestId)
    settle(e)
    if (!isOn) return next(e)
    if (e.surface !== 'terminal' || e.props.origin.kind !== 'composer') return next(e)
    const ids = idsIn(e.props.text)
    if (ids.length === 0) return next(e)
    await follow($)
    for (const id of ids) loadPaste($, id)
    const site = siteOf($, e, MESSAGE_INDENT)
    const row = pastedRow($, site, await read($, pictures), ids, false)
    return row ? withPictures(site.ui, await next(e), MESSAGE_INDENT, [row]) : next(e)
  })

  // An answer with pictures. In fullscreen the mod draws it block by block: a picture it embeds
  // (`![alt](path)`) under the block that embeds it, and a chip beside the block for each picture it
  // only names; the pointer on a chip opens that picture in a card over the rows above, a click opens
  // it in the system's viewer. Elsewhere (no pointer) the engine draws it, the embedded pictures under it.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    noteRow(e.requestId)
    settle(e)
    if (!isOn) return next(e)
    if (!markdown) return next(e)
    const text = e.props.text
    // The VS Code extension, the desktop and mobile apps draw what Claude reads and what you paste
    // themselves, and no picture from this machine's files: the ones an answer embeds or names are
    // drawn under it, each an Svg holding the picture, named.
    if (e.surface !== 'terminal') {
      if (!/\.(png|jpe?g|gif|webp|bmp|tiff?|heic)\b/i.test(text)) return next(e)
      await follow($)
      const cwd = await $.session.cwd()
      const home = await $.env.get('HOME')
      const embedded = embeddedIn(text).flatMap(target => absolute(target, cwd, home) ?? [])
      const files = [...new Set([...embedded, ...(await namedIn($, `${e.requestId}#all`, text, cwd))])]
      if (files.length === 0) return next(e)
      for (const file of files) {
        void load($, `svg:${file}`, async () => [{ file }])
        void recheck($, `svg:${file}`).catch(() => undefined)
      }
      const all = await read($, pictures)
      const { Box, Svg, Text } = $.ui.resolve(e)
      const drawn: RenderElement[] = []
      for (const file of files) {
        const made = loaded.get(`svg:${file}`)?.href
        const picture = all[`svg:${file}`]
        if (picture && 'error' in picture && picture.error === 'not found') continue
        const name = file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file
        const shown = made ? svgOf(made) : undefined
        drawn.push(
          <Box key={`svg:${file}`} flexDirection="column">
            {shown
              ? <Svg source={shown.source} alt={baseName(file)} width={shown.width} height={shown.height} />
              : <Text dimColor>{picture && 'error' in picture ? `${baseName(file)}: no preview, ${picture.error}` : `${baseName(file)} loading…`}</Text>}
            <Text dimColor size="caption">{name}</Text>
          </Box>
        )
      }
      if (drawn.length === 0) return next(e)
      return (
        <Box flexDirection="column">
          {await next(e)}
          <Box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1}>{drawn}</Box>
        </Box>
      )
    }
    // A cheap look first: most answers name no picture at all.
    if (!/\.(png|jpe?g|gif|webp|bmp|tiff?|heic)\b/i.test(text)) return next(e)
    await follow($)
    const cwd = await $.session.cwd()
    const home = await $.env.get('HOME')
    const site = siteOf($, e, MESSAGE_INDENT)
    const all = await read($, pictures)
    const { Box, Client, Markdown, Text } = site.ui

    /** The embedded pictures of a text, drawn: none for a link to a file that is not there. */
    /** The pictures a text embeds, drawn (none for a link to a file that is not there), and the targets drawn. */
    const embeddedOf = (part: string, place: Site, slot = 'image') => {
      const drawn: RenderElement[] = []
      const targets = new Set<string>()
      const seen = new Set<string>()
      for (const target of embeddedIn(part)) {
        const file = absolute(target, cwd, home)
        if (!file) continue
        const key = `file:${file}`
        void load($, key, async () => [{ file }])
        // Not there yet, it is not drawn, but its file is still looked at again now and then.
        void recheck($, key).catch(() => undefined)
        const picture = all[key]
        if (picture && 'error' in picture && picture.error === 'not found') continue
        targets.add(target)
        if (seen.has(file)) continue
        seen.add(file)
        drawn.push(pictureOf($, place, all, key, baseName(file), slot))
      }
      return { drawn, targets }
    }

    // Chips need the pointer, which the terminal reports in fullscreen alone.
    if (e.viewport?.isFullscreen === false) {
      const { drawn } = embeddedOf(text, site)
      return drawn.length === 0 ? next(e) : withPictures(site.ui, await next(e), MESSAGE_INDENT, drawn)
    }

    const blocks = blocksOf(text)
    const named: string[][] = []
    for (const [i, block] of blocks.entries()) {
      const embedded = embeddedIn(block.text).flatMap(target => absolute(target, cwd, home) ?? [])
      named.push((await namedIn($, `${e.requestId}#${i}`, block.text, cwd)).filter(file => !embedded.includes(file)))
    }
    const hasEmbedded = embeddedIn(text).length > 0
    const hasChips = named.some(files => files.length > 0)
    if (!hasEmbedded && !hasChips) return next(e)
    for (const file of named.flat().slice(0, PREFETCH_CHIPS)) void prefetch($, file)

    const now = await read($, hovered)
    const onScreen = e.props.onScreen
    if (now?.requestId === e.requestId) {
      const where = JSON.stringify(onScreen ?? null)
      // The answer moved under a resting pointer: the chip is no longer under it.
      if (hoveredAt !== undefined && hoveredAt !== where) void update($, hovered, () => null).catch(() => undefined)
      else hoveredAt = where
    }
    const isHosting = now?.requestId === e.requestId && hoveredAt === JSON.stringify(onScreen ?? null)
    const chipWidth = Math.max(0, ...named.flat().map(file => baseName(file).length))
    const bodyColumns = Math.max(16, site.maxColumns - (chipWidth > 0 ? chipWidth + 2 : 0))
    const place = { ...site, maxColumns: bodyColumns }
    let index = 0
    let open: { file: string; block: number } | undefined
    const rows = blocks.map((block, i) => {
      const chips = named[i]!.map(file => {
        const chip = `ref:${index++}`
        chipFiles.set(`${e.requestId}/${chip}`, file)
        if (isHosting && chip === now!.element) open = { file, block: i }
        return { chip, file }
      })
      // Each block's pictures have keys of their own: one picture embedded twice is two Images.
      const { drawn: pictures, targets } = embeddedOf(block.text, place, `image-${i}`)
      // A picture drawn under the block is not written in it too, as its alt and path.
      const isDrawn = new Set(embeddedAt(block.text).filter(({ target }) => targets.has(target)).map(({ at }) => at))
      const shown = block.text.replace(MARKDOWN_IMAGE, (match: string, alt: string, target: string, at: number) => (isDrawn.has(at) ? '' : match)).trim()
      return (
        <Box key={`block-${i}`} flexDirection="column" marginTop={block.gap ? 1 : 0}>
          {shown.length > 0 && (
            <Box flexDirection="row" columnGap={2}>
              <Box flexDirection="column" width={chips.length > 0 ? bodyColumns : undefined} flexShrink={1}>
                <Markdown text={shown} />
              </Box>
              {chips.length > 0 && (
                <Box flexDirection="column" flexShrink={0}>
                  {chips.map(({ chip, file }) => <Client key={chip} module="./chip.tsx" props={{ label: baseName(file) }} />)}
                </Box>
              )}
            </Box>
          )}
          {pictures}
          {hasChips && (
            <Box position="absolute" top={0} left={0} width={1} height="100%">
              <Client key={`probe:${i}`} module="./probe.tsx" width={1} height="100%" />
            </Box>
          )}
        </Box>
      )
    })
    // The card of the chip the pointer is on, drawn last so no block paints over it: over the rows
    // above its block where they hold it, else over those below, else over the most there are.
    let card: RenderElement | undefined
    const heights = blockRows.get(e.requestId) ?? []
    // Each block up to the chip's must have said its height (a probe that has not is a hole).
    const measured = open && Array.from({ length: open.block + 1 }, (_, i) => heights[i]).every(rows => typeof rows === 'number' && rows > 0)
    if (open && measured) {
      let top = 0
      for (let i = 0; i <= open.block; i++) {
        top += blocks[i]!.gap ? 1 : 0
        if (i < open.block) top += heights[i]!
      }
      const bottom = top + heights[open.block]!
      const first = onScreen?.first ?? 0
      const last = onScreen?.last ?? onScreen?.of ?? bottom
      const viewportRows = e.viewport?.rows ?? 40
      // Above the answer on screen: the rows the screen holds over it, known only for the newest row,
      // the one at the foot of the screen, whose top shows; any other may have rows under it.
      const outside = first === 0 && isNewest(e.requestId) ? Math.max(0, viewportRows - BOTTOM_ROWS - (last - first + 1)) : 0
      const aboveIn = top - first
      const below = last - bottom + 1
      const caption = open.file.startsWith(`${cwd}/`) ? open.file.slice(cwd.length + 1) : open.file
      const cardSite = (rows: number) => ({ ...site, maxColumns: Math.max(8, site.maxColumns - 2), maxRows: Math.max(1, rows - CARD_ROWS) })
      const key = `file:${open.file}`
      const wanted = cardOf($, cardSite(HOVER_ROWS + CARD_ROWS), all, key, caption)[1]
      const [space, isAbove] = aboveIn >= wanted ? [aboveIn, true]
        : below >= wanted ? [below, false]
        : aboveIn + outside >= wanted ? [aboveIn + outside, true]
        : aboveIn + outside >= below ? [aboveIn + outside, true] : [below, false]
      if (space >= MIN_CARD_ROWS) {
        const [drawn, height] = cardOf($, cardSite(Math.min(space, HOVER_ROWS + CARD_ROWS)), all, key, caption)
        card = <Box key="card" position="absolute" top={isAbove ? top - height : bottom} left={0}>{drawn}</Box>
      }
    }
    // The reply's first block opens with the engine's bullet; the text stands two columns in.
    return (
      <Box flexDirection="row">
        <Text>{e.props.isFirstOfReply ? '● ' : '  '}</Text>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {rows}
          {card}
        </Box>
      </Box>
    )
  })

  // A probe says how many rows its block was laid out in: where a card floats over an answer. A chip
  // says when the pointer comes onto it and when it leaves: its card opens and closes, the picture
  // read as it first opens. Clicked, the picture opens in the system's viewer.
  on('ui.message', async ($, e, next) => {
    const result = await next(e)
    const rows = (e.data as { rows?: unknown } | null)?.rows
    if (/^probe:\d+$/.test(e.element) && typeof rows === 'number') {
      const heights = blockRows.get(e.requestId) ?? []
      heights[Number(e.element.slice('probe:'.length))] = rows
      blockRows.set(e.requestId, heights)
      // A card open over this answer moves with the blocks; with none open, nothing draws again.
      if ((await read($, hovered))?.requestId === e.requestId) await update($, hovered, now => (now ? { ...now } : now))
      return result
    }
    // A click on a picture drawn: it opens in the system's viewer.
    const opened = /^open:/.test(e.element) ? openers.get(`${e.requestId}/${e.element}`) : undefined
    if (opened !== undefined) {
      const data = e.data as { isOver?: unknown; isClicked?: unknown } | null
      const file = sourceFiles.get(opened)
      if (data?.isClicked === true && clickOpens) {
        pointAt($, opened, false)
        if (file) void openFile($, file)
      } else if (isWindowing()) pointAt($, opened, data?.isOver === true)
      return result
    }
    const path = /^ref:\d+$/.test(e.element) ? chipFiles.get(`${e.requestId}/${e.element}`) : undefined
    if (!path) return result
    const data = e.data as { isOver?: unknown; isClicked?: unknown } | null
    const isThis = (now: Hovered | null) => now?.requestId === e.requestId && now.element === e.element
    if (data?.isClicked === true && clickOpens) {
      pointAt($, `file:${path}`, false)
      void openFile($, path)
      await update($, hovered, () => null)
      return result
    }
    // Where the terminal draws cells, the chip's picture opens in a window, not a card of cells.
    if (isWindowing()) {
      pointAt($, `file:${path}`, data?.isOver === true, path)
      return result
    }
    if (data?.isOver === true) {
      void load($, `file:${path}`, async () => [{ file: path }])
      if (!isThis(await read($, hovered))) {
        hoveredAt = undefined
        await update($, hovered, () => ({ requestId: e.requestId, element: e.element, path }))
      }
    } else await update($, hovered, now => (isThis(now) ? null : now))
    return result
  })
}
