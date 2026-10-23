// What the mod asks of the system it runs on, each a way a system: make and remove folders, write
// and read bytes, convert and measure a picture, open one in the viewer. macOS and Linux with their
// own tools; Windows with PowerShell, the paths handed over in the environment, never pasted into a
// command; WSL with Linux's tools, and Windows' PowerShell and viewer for what Linux there lacks.
import type { EngineInterface } from 'claude-code'

import { LINUX, MACOS, WINDOWS } from './window'

type Engine = EngineInterface

export type System = 'macos' | 'linux' | 'wsl' | 'windows'

let system: System = 'macos'

/** The system the session runs on, as `detect` found it. */
export const systemOf = () => system

/** Finds the system the session runs on: Windows by its environment, the rest by `uname`. */
export async function detect ($: Engine): Promise<System> {
  if ((await $.env.get('OS')) === 'Windows_NT') return (system = 'windows')
  const name = (await $.process.run(['uname', '-s']).catch(() => undefined))?.stdout.trim()
  if (name === 'Darwin') return (system = 'macos')
  return (system = (await $.env.get('WSL_DISTRO_NAME')) !== undefined ? 'wsl' : 'linux')
}

/** A PowerShell script as `-EncodedCommand` takes it: UTF-16LE, base64. */
function encoded (script: string) {
  const bytes = new Uint8Array(script.length * 2)
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i)
    bytes[i * 2] = code & 0xff
    bytes[i * 2 + 1] = code >> 8
  }
  return bytes.toBase64()
}

/** A program to run: its arguments and what it is told in the environment. */
export type Command = { argv: string[]; env: Record<string, string> }

/**
 * How PowerShell runs a script, told what it needs in the environment (INLINE_IMAGES_*). Under WSL it
 * is Windows' own, `powershell.exe`: the variables cross over through WSLENV, the paths among them
 * (`paths`) turned into their Windows form.
 */
async function powershellCommand ($: Engine, script: string, env: Record<string, string>, paths: string[] = []): Promise<Command> {
  const isWsl = system === 'wsl'
  const crossing: Record<string, string> = isWsl
    ? { WSLENV: [await $.env.get('WSLENV'), ...Object.keys(env).map(name => (paths.includes(name) ? `${name}/p` : name))].filter(Boolean).join(':') }
    : {}
  const argv = [isWsl ? 'powershell.exe' : 'powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded(`$ErrorActionPreference = 'Stop'\n${script}`)]
  return { argv, env: { ...env, ...crossing } }
}

/** Runs a PowerShell script (powershellCommand), `stdin` piped to it. */
async function powershell ($: Engine, script: string, env: Record<string, string>, paths: string[] = [], stdin?: string) {
  const { argv, env: all } = await powershellCommand($, script, env, paths)
  return $.process.run(argv, { env: all, ...(stdin !== undefined && { stdin }) })
}

const ok = (result: { exitCode: number } | undefined, what: string) => {
  if (result?.exitCode !== 0) throw new Error(what)
}

/** Claude Code's temp folder: `<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>`; on Windows `<… or %TEMP%>\claude`. */
export async function tempFolder ($: Engine) {
  if (system !== 'windows') {
    const base = ((await $.env.get('CLAUDE_CODE_TMPDIR')) || '/tmp').replace(/\/+$/, '')
    return `${base}/claude-${(await $.process.run(['id', '-u'])).stdout.trim()}`
  }
  const own = (await $.env.get('TEMP')) || (await $.env.get('TMP')) || `${(await $.env.get('SystemRoot')) || 'C:\\Windows'}\\temp`
  return `${((await $.env.get('CLAUDE_CODE_TMPDIR')) || own).replace(/[\\/]+$/, '')}/claude`
}

/** Makes a folder, and those above it. */
export async function makeFolder ($: Engine, path: string) {
  if (system === 'windows') return ok(await powershell($, 'New-Item -ItemType Directory -Force -Path $env:INLINE_IMAGES_PATH | Out-Null', { INLINE_IMAGES_PATH: path }), `could not make ${path}`)
  ok(await $.process.run(['mkdir', '-p', path]), `could not make ${path}`)
}

/** Removes a file, or a folder and all in it; one that is not there is no error. */
export async function remove ($: Engine, path: string) {
  if (system === 'windows') {
    await powershell($, 'Remove-Item -LiteralPath $env:INLINE_IMAGES_PATH -Recurse -Force -ErrorAction SilentlyContinue', { INLINE_IMAGES_PATH: path }).catch(() => undefined)
    return
  }
  await $.process.run(['rm', '-rf', path]).catch(() => undefined)
}

/** Marks a folder as in use now. */
export async function touch ($: Engine, path: string) {
  if (system === 'windows') {
    await powershell($, '(Get-Item -LiteralPath $env:INLINE_IMAGES_PATH).LastWriteTime = Get-Date', { INLINE_IMAGES_PATH: path }).catch(() => undefined)
    return
  }
  await $.process.run(['touch', path]).catch(() => undefined)
}

/** Writes base64 bytes to a file: `$.fs` writes text alone. */
export async function writeBytes ($: Engine, path: string, base64: string) {
  const result = system === 'windows'
    ? await powershell($, '[IO.File]::WriteAllBytes($env:INLINE_IMAGES_PATH, [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))', { INLINE_IMAGES_PATH: path }, [], base64)
    : await $.process.run(['sh', '-c', 'base64 --decode > "$0"', path], { stdin: base64 })
  ok(result, `could not write ${path}`)
}

/** Writes each base64 line of `lines` to `<dir>/<i>.rgba`, in one process. */
export async function writeFrames ($: Engine, dir: string, lines: string[]) {
  const stdin = `${lines.join('\n')}\n`
  const result = system === 'windows'
    ? await powershell($, '$i = 0; while ($null -ne ($line = [Console]::In.ReadLine())) { if ($line) { [IO.File]::WriteAllBytes((Join-Path $env:INLINE_IMAGES_PATH "$i.rgba"), [Convert]::FromBase64String($line)); $i++ } }', { INLINE_IMAGES_PATH: dir }, [], stdin)
    : await $.process.run(['sh', '-c', 'i=0; while IFS= read -r line; do printf %s "$line" | base64 --decode > "$0/$i.rgba" || exit 1; i=$((i+1)); done', dir], { stdin })
  ok(result, 'could not write the frames')
}

/**
 * `count` bytes of a file from byte `at` (fewer at its end), through base64: what reads a file
 * past the 4 MiB one `$.fs.read` takes, or its first bytes without reading the rest.
 */
export async function readBytes ($: Engine, path: string, at: number, count: number) {
  const result = system === 'windows'
    ? await powershell($, String.raw`
$file = [IO.File]::OpenRead($env:INLINE_IMAGES_PATH)
try {
  [void]$file.Seek([long]$env:INLINE_IMAGES_AT, 'Begin')
  $buffer = New-Object byte[] ([int]$env:INLINE_IMAGES_COUNT)
  $read = 0
  while ($read -lt $buffer.Length) { $n = $file.Read($buffer, $read, $buffer.Length - $read); if ($n -le 0) { break }; $read += $n }
  [Console]::Out.Write([Convert]::ToBase64String($buffer, 0, $read))
} finally { $file.Close() }`, { INLINE_IMAGES_PATH: path, INLINE_IMAGES_AT: String(at), INLINE_IMAGES_COUNT: String(count) })
    : at === 0
      ? await $.process.run(['sh', '-c', 'head -c "$1" "$0" | base64', path, String(count)])
      : await $.process.run(['sh', '-c', 'dd if="$0" bs="$1" skip="$2" count=1 2>/dev/null | base64', path, String(count), String(at / count)])
  if (result.exitCode !== 0 || result.isStdoutTruncated) throw new Error(`could not read ${path}`)
  return Uint8Array.fromBase64(result.stdout.replace(/\s+/g, ''))
}

/** A converter: macOS's sips, ImageMagick (`magick`, or `convert` before version 7), Windows' PowerShell. */
type Tool = 'sips' | 'magick' | 'convert' | 'powershell'

// The converters each system is tried with, in order. On Windows `convert` is the system's disk
// tool, never ImageMagick's.
const TOOLS: Record<System, Tool[]> = { macos: ['sips', 'magick', 'convert'], linux: ['magick', 'convert'], wsl: ['magick', 'convert', 'powershell'], windows: ['magick', 'powershell'] }

// The converter that worked here.
let tool: Tool | undefined

const POWERSHELL_SIZE = String.raw`
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile($env:INLINE_IMAGES_PATH)
[Console]::Out.Write("$($image.Width) $($image.Height)")
$image.Dispose()`

// Writes INLINE_IMAGES_PATH shrunk to INLINE_IMAGES_SIZE at most, never enlarged, as
// INLINE_IMAGES_FORMAT (bmp or png) to INLINE_IMAGES_OUT. After Image Preview's converter.
const POWERSHELL_CONVERT = String.raw`
Add-Type -AssemblyName System.Drawing
$source = [System.Drawing.Image]::FromFile($env:INLINE_IMAGES_PATH)
$fit = [Math]::Min(1.0, [int]$env:INLINE_IMAGES_SIZE / [Math]::Max($source.Width, $source.Height))
$width = [Math]::Max(1, [int]($source.Width * $fit))
$height = [Math]::Max(1, [int]($source.Height * $fit))
$picture = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$canvas = [System.Drawing.Graphics]::FromImage($picture)
$canvas.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$canvas.DrawImage($source, 0, 0, $width, $height)
$canvas.Dispose()
$source.Dispose()
$format = if ($env:INLINE_IMAGES_FORMAT -eq 'png') { [System.Drawing.Imaging.ImageFormat]::Png } else { [System.Drawing.Imaging.ImageFormat]::Bmp }
$picture.Save($env:INLINE_IMAGES_OUT, $format)
$picture.Dispose()`

/** A picture's own width and height, as `name` reads them; undefined where it cannot. */
async function sizeWith ($: Engine, name: Tool, file: string) {
  const result = name === 'powershell'
    ? await powershell($, POWERSHELL_SIZE, { INLINE_IMAGES_PATH: file }, ['INLINE_IMAGES_PATH']).catch(() => undefined)
    : await $.process.run(name === 'sips'
      ? ['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file]
      : [name === 'magick' ? 'magick' : 'identify', ...(name === 'magick' ? ['identify'] : []), '-format', '%w %h', `${file}[0]`]).catch(() => undefined)
  if (result?.exitCode !== 0) return undefined
  const [width, height] = name === 'sips'
    ? [/pixelWidth: (\d+)/.exec(result.stdout)?.[1], /pixelHeight: (\d+)/.exec(result.stdout)?.[1]].map(Number)
    : result.stdout.trim().split(/\s+/).map(Number)
  return width && height ? { width, height } : undefined
}

/**
 * Writes `file` as `format` to `out`, its longest side shrunk to `side` pixels at most, never
 * enlarged (sips's -Z would enlarge a smaller one). Answers the picture's own size.
 */
export async function convert ($: Engine, file: string, out: string, format: 'png' | 'bmp', side: number) {
  for (const name of tool ? [tool] : TOOLS[system]) {
    const size = await sizeWith($, name, file)
    if (!size) continue
    const shrinks = Math.max(size.width, size.height) > side
    const result = name === 'powershell'
      ? await powershell($, POWERSHELL_CONVERT, { INLINE_IMAGES_PATH: file, INLINE_IMAGES_OUT: out, INLINE_IMAGES_SIZE: String(side), INLINE_IMAGES_FORMAT: format }, ['INLINE_IMAGES_PATH', 'INLINE_IMAGES_OUT']).catch(() => undefined)
      : await $.process.run(name === 'sips'
        ? ['sips', '-s', 'format', format, ...(shrinks ? ['-Z', String(side)] : []), file, '--out', out]
        : [name, `${file}[0]`, '-resize', `${side}x${side}>`, `${format === 'bmp' ? 'BMP3' : 'PNG'}:${out}`]).catch(() => undefined)
    if (result?.exitCode === 0) {
      tool = name
      return size
    }
  }
  throw new Error(system === 'macos' ? 'needs sips or ImageMagick to read it' : system === 'linux' ? 'needs ImageMagick to read it' : 'needs ImageMagick or PowerShell to read it')
}

/** Opens a picture in the system's viewer: Preview on macOS, the desktop's own elsewhere. */
export async function open ($: Engine, path: string) {
  if (system === 'wsl') {
    const windows = (await $.process.run(['wslpath', '-w', path]).catch(() => undefined))?.stdout.trim()
    if (windows) await $.process.run(['explorer.exe', windows]).catch(() => undefined)
    return
  }
  const argv = system === 'macos' ? ['open', path] : system === 'windows' ? ['explorer', path.replaceAll('/', '\\')] : ['xdg-open', path]
  await $.process.run(argv).catch(() => undefined)
}

/**
 * Whether this system can show a picture in a window of its own, by the pointer: macOS, Windows and
 * WSL (Windows' own window) always; Linux on a display, with Python's Tk.
 */
export async function canShowWindows ($: Engine) {
  if (system !== 'linux') return true
  if (!(await $.env.get('DISPLAY'))) return false
  return (await $.process.run(['python3', '-c', 'import tkinter']).catch(() => undefined))?.exitCode === 0
}

/** Whether a window of this system shows `file` as it is: Linux's Tk reads PNG and GIF alone. */
export const windowReads = (file: string) => system !== 'linux' || /\.(png|gif)$/i.test(file)

/** The program that shows `file` in a window by the pointer, `size` its longest side at most, `life` seconds at most. */
export async function windowCommand ($: Engine, file: string, size: number, life: number): Promise<Command> {
  const env = { INLINE_IMAGES_FILE: file, INLINE_IMAGES_SIZE: String(size), INLINE_IMAGES_LIFE: String(life) }
  if (system === 'macos') return { argv: ['osascript', '-l', 'JavaScript', '-e', MACOS], env }
  if (system === 'linux') return { argv: ['python3', '-c', LINUX], env }
  return powershellCommand($, WINDOWS, env, ['INLINE_IMAGES_FILE'])
}
