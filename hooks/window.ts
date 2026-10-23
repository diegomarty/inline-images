// The programs that show pictures in a window of their own, by the pointer, outside the terminal:
// one a system, for a terminal that cannot draw the picture itself. One runs for the whole session,
// started before it is needed, so the window opens the moment the pointer comes.
//
// Each is run with INLINE_IMAGES_COMMANDS, the file it is told what to do in, and
// INLINE_IMAGES_SIZE, a picture's longest side at most. It reads the file every 40 milliseconds;
// the file holds six lines, the last `end` (a file half written is not read): a number, larger
// for each command, then
//
//   show, a picture's path (or none, while it is made), its width and its height in pixels (0, 0
//     where they are not known): the window opens by the pointer at once, a spinner in it, and the
//     picture takes its place once read; shown with no path, the next show with one fills it;
//   hide: the window closes;
//   quit: the program ends.
//
// It says `.` as it starts, `ready` once it reads the file, `shown <number>` once a picture is in
// the window, `error <number>: …` for a picture it cannot read and `error: …` where it cannot run at
// all; and a `.` every tenth of a second, so it ends when nobody reads. The window never takes the
// focus or the pointer: the terminal keeps both.
//
// After Image Preview's windows (https://github.com/midudev/better-claude/tree/main/plugins/image-preview),
// MIT © Miguel Ángel Durán (midudev).

/** macOS: JavaScript for Automation, run by `osascript`, drawing an AppKit panel. */
export const MACOS = String.raw`
ObjC.import('Cocoa')

function run () {
  const env = $.NSProcessInfo.processInfo.environment
  const read = key => { const value = env.objectForKey(key); return value.isNil() ? '' : ObjC.unwrap(value) }
  // Writing to a pipe nobody reads throws: the program ends.
  const say = text => $.NSFileHandle.fileHandleWithStandardOutput.writeData($(text + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
  say('.')
  const commands = read('INLINE_IMAGES_COMMANDS')
  const largest = Number(read('INLINE_IMAGES_SIZE')) || 800
  const pad = 6
  const gap = 18
  // An accessory app: no Dock icon, never the active one.
  $.NSApplication.sharedApplication.setActivationPolicy(1)

  // Where a window of a picture width by height pixels goes (a box for the spinner where they
  // are not known): above the pointer and to its right; under it, or to its left, where there is no
  // room; never over the pointer, which stays on the terminal.
  const placeFor = (width, height) => {
    const mouse = $.NSEvent.mouseLocation
    const screens = $.NSScreen.screens
    let screen = $.NSScreen.mainScreen
    for (let i = 0; i < screens.count; i++) {
      const frame = screens.objectAtIndex(i).frame
      if (mouse.x >= frame.origin.x && mouse.x < frame.origin.x + frame.size.width && mouse.y >= frame.origin.y && mouse.y < frame.origin.y + frame.size.height) screen = screens.objectAtIndex(i)
    }
    const area = screen.visibleFrame
    let inner = width > 0 && height > 0 ? { width: width / screen.backingScaleFactor, height: height / screen.backingScaleFactor } : { width: 240, height: 160 }
    const fit = Math.min(1, largest / Math.max(inner.width, inner.height), (area.size.width * 0.7) / inner.width, (area.size.height * 0.7) / inner.height)
    inner = { width: Math.round(inner.width * fit), height: Math.round(inner.height * fit) }
    const outer = { width: inner.width + pad * 2, height: inner.height + pad * 2 }
    const top = area.origin.y + area.size.height
    const right = area.origin.x + area.size.width
    let x = mouse.x + gap
    let y = mouse.y + gap
    if (y + outer.height > top) y = mouse.y - gap - outer.height
    if (x + outer.width > right) x = mouse.x - gap - outer.width
    x = Math.max(area.origin.x, Math.min(x, right - outer.width))
    y = Math.max(area.origin.y, Math.min(y, top - outer.height))
    return { frame: $.NSMakeRect(x, y, outer.width, outer.height), outer, inner }
  }

  let shown = null
  const hide = () => {
    if (!shown) return
    shown.panel.orderOut(null)
    shown = null
  }
  // The window at once, a spinner in it.
  const open = (width, height) => {
    hide()
    const place = placeFor(width, height)
    // Borderless and non-activating; over every app window, on every space, full-screen ones too.
    const panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(place.frame, 128, 2, false)
    panel.level = 25
    panel.ignoresMouseEvents = true
    panel.hasShadow = true
    panel.opaque = false
    panel.backgroundColor = $.NSColor.clearColor
    panel.collectionBehavior = 1 | 16 | 256
    panel.releasedWhenClosed = false
    const backdrop = $.NSVisualEffectView.alloc.initWithFrame($.NSMakeRect(0, 0, place.outer.width, place.outer.height))
    backdrop.material = 13
    backdrop.state = 1
    backdrop.wantsLayer = true
    backdrop.layer.cornerRadius = 10
    backdrop.layer.masksToBounds = true
    backdrop.autoresizingMask = 2 | 16
    const spinner = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect((place.outer.width - 32) / 2, (place.outer.height - 32) / 2, 32, 32))
    spinner.style = 1
    spinner.indeterminate = true
    spinner.autoresizingMask = 1 | 4 | 8 | 32
    spinner.startAnimation(null)
    backdrop.addSubview(spinner)
    panel.contentView = backdrop
    panel.orderFrontRegardless
    shown = { panel, backdrop, spinner, isWaiting: true }
    // Drawn before the picture is read.
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.01))
  }
  // The picture in the window, in the spinner's place.
  const fill = (number, file) => {
    const image = $.NSImage.alloc.initWithContentsOfFile(file)
    if (image.isNil() || image.representations.count === 0) {
      say('error ' + number + ': cannot read the image')
      return hide()
    }
    const pixels = image.representations.firstObject
    const place = placeFor(pixels.pixelsWide, pixels.pixelsHigh)
    shown.spinner.stopAnimation(null)
    shown.spinner.removeFromSuperview
    shown.panel.setFrameDisplay(place.frame, true)
    const view = $.NSImageView.alloc.initWithFrame($.NSMakeRect(pad, pad, place.inner.width, place.inner.height))
    view.image = image
    view.imageScaling = 3
    shown.backdrop.addSubview(view)
    shown.isWaiting = false
    say('shown ' + number)
  }

  let last = 0
  let beat = 0
  say('ready')
  for (;;) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.04))
    if (++beat % 3 === 0) say('.')
    const text = $.NSString.stringWithContentsOfFileEncodingError(commands, $.NSUTF8StringEncoding, null)
    if (text.isNil()) continue
    const lines = ObjC.unwrap(text).split('\n')
    const number = Number(lines[0])
    if (lines.length < 6 || lines[5] !== 'end' || !(number > last)) continue
    last = number
    const [, verb, file, width, height] = lines
    if (verb === 'quit') return
    if (verb === 'hide') hide()
    if (verb !== 'show') continue
    if (!(shown && shown.isWaiting && file)) open(Number(width), Number(height))
    if (file) fill(number, file)
  }
}
`

/** Linux and other X11 desktops: Python's Tk, an undecorated tooltip window. The picture is a PNG or a GIF. */
export const LINUX = String.raw`
import math, os, sys
print('.', flush=True)
try:
    import tkinter as tk
except ImportError:
    print('error: no tkinter', flush=True)
    sys.exit(1)

commands = os.environ.get('INLINE_IMAGES_COMMANDS', '')
largest = int(os.environ.get('INLINE_IMAGES_SIZE') or 800)
try:
    root = tk.Tk()
except tk.TclError as error:
    print('error: no display: %s' % error, flush=True)
    sys.exit(1)
root.withdraw()
root.overrideredirect(True)
for name, value in (('-topmost', True), ('-type', 'tooltip')):
    try:
        root.attributes(name, value)
    except tk.TclError:
        pass
BACK = '#202020'
SPINNER = '◐◓◑◒'
pad, gap = 6, 18
root.configure(background=BACK)
holder = tk.Label(root, borderwidth=0, highlightthickness=0, background=BACK, foreground='#c8c8c8', font=('TkDefaultFont', 20))
holder.pack(padx=pad, pady=pad, expand=True, fill='both')
state = {'last': 0, 'waiting': False, 'image': None, 'beat': 0}


def fit(width, height):
    # The picture's size in the window, and the step it is shrunk by: a box for the spinner where
    # its size is not known.
    if width <= 0 or height <= 0:
        return 240, 160, 1
    step = max(1, math.ceil(max(width / min(largest, root.winfo_screenwidth() * 0.7), height / min(largest, root.winfo_screenheight() * 0.7))))
    return math.ceil(width / step), math.ceil(height / step), step


def place(width, height):
    # Above the pointer and to its right; under it, or to its left, where there is no room: never
    # over the pointer, which stays on the terminal.
    outer_width, outer_height = width + pad * 2, height + pad * 2
    screen_width, screen_height = root.winfo_screenwidth(), root.winfo_screenheight()
    mouse_x, mouse_y = root.winfo_pointerxy()
    x, y = mouse_x + gap, mouse_y - gap - outer_height
    if y < 0:
        y = mouse_y + gap
    if x + outer_width > screen_width:
        x = mouse_x - gap - outer_width
    x = max(0, min(x, screen_width - outer_width))
    y = max(0, min(y, screen_height - outer_height))
    root.geometry('%dx%d+%d+%d' % (outer_width, outer_height, x, y))


def hide():
    root.withdraw()
    holder.configure(image='', text='')
    state['image'] = None
    state['waiting'] = False


def open_window(width, height):
    hide()
    inner_width, inner_height, _ = fit(width, height)
    holder.configure(text=SPINNER[0])
    place(inner_width, inner_height)
    root.deiconify()
    root.lift()
    root.update()
    state['waiting'] = True


def fill(number, path):
    try:
        image = tk.PhotoImage(file=path)
    except tk.TclError:
        print('error %d: cannot read the image' % number, flush=True)
        hide()
        return
    _, _, step = fit(image.width(), image.height())
    if step > 1:
        image = image.subsample(step)
    state['image'] = image
    state['waiting'] = False
    holder.configure(image=image, text='')
    place(image.width(), image.height())
    print('shown %d' % number, flush=True)


def poll():
    state['beat'] += 1
    if state['beat'] % 3 == 0:
        try:
            print('.', flush=True)
        except (BrokenPipeError, OSError):
            # Nobody reads: end, the pipe's last flush going nowhere.
            os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
            root.destroy()
            return
        if state['waiting']:
            holder.configure(text=SPINNER[(state['beat'] // 3) % len(SPINNER)])
    try:
        with open(commands, encoding='utf-8') as file:
            lines = file.read().split('\n')
    except OSError:
        lines = []
    if len(lines) >= 6 and lines[5] == 'end' and lines[0].isdigit() and int(lines[0]) > state['last']:
        number = state['last'] = int(lines[0])
        verb, path, width, height = lines[1:5]
        if verb == 'quit':
            root.destroy()
            return
        if verb == 'hide':
            hide()
        if verb == 'show':
            if not (state['waiting'] and path):
                open_window(int(width or 0), int(height or 0))
            if path:
                fill(number, path)
    root.after(40, poll)


print('ready', flush=True)
poll()
root.mainloop()
`

/** Windows: PowerShell and Windows Forms, a tool window that is never activated. */
export const WINDOWS = String.raw`
$ErrorActionPreference = 'Stop'
function Say ($text) { [Console]::Out.WriteLine($text); [Console]::Out.Flush() }
Say '.'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$commands = $env:INLINE_IMAGES_COMMANDS
$largest = if ($env:INLINE_IMAGES_SIZE) { [int]$env:INLINE_IMAGES_SIZE } else { 800 }
# A form that shows without taking the focus, as a tool window, topmost, the pointer passing through.
# Compiled once into the temp folder, then loaded from there: compiling takes a second.
$assembly = Join-Path $env:TEMP 'inline-images-popup-2.dll'
if (-not (Test-Path $assembly)) {
  try {
  Add-Type -OutputAssembly $assembly -OutputType Library -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
public class InlineImagesPopup : System.Windows.Forms.Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override System.Windows.Forms.CreateParams CreateParams {
    get {
      System.Windows.Forms.CreateParams p = base.CreateParams;
      p.ExStyle |= 0x08000000 | 0x00000080 | 0x00000008 | 0x00000020;
      return p;
    }
  }
  [System.Runtime.InteropServices.DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware ();
}
'@
  } catch {
    # Another session compiling it at the same time: its file is used.
  }
}
Add-Type -Path $assembly
# The pointer and the screens in real pixels: a program Windows scales reads them scaled, and on
# screens of different scales puts the window on the wrong one.
[InlineImagesPopup]::SetProcessDPIAware() | Out-Null
$pad = 6
$gap = 18
$back = [System.Drawing.Color]::FromArgb(32, 32, 32)
$form = New-Object InlineImagesPopup
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.StartPosition = 'Manual'
$form.BackColor = $back
$form.Padding = New-Object System.Windows.Forms.Padding($pad)
$form.Opacity = 0.99
$box = New-Object System.Windows.Forms.PictureBox
$box.Dock = 'Fill'
$box.SizeMode = 'Zoom'
$spinner = New-Object System.Windows.Forms.Label
$spinner.Dock = 'Fill'
$spinner.TextAlign = 'MiddleCenter'
$spinner.ForeColor = [System.Drawing.Color]::FromArgb(200, 200, 200)
$spinner.BackColor = $back
$spinner.Font = New-Object System.Drawing.Font('Segoe UI Symbol', 20)
$form.Controls.Add($box)
$form.Controls.Add($spinner)
$turns = @([char]0x25D0, [char]0x25D3, [char]0x25D1, [char]0x25D2)
$graphics = $form.CreateGraphics()
$scale = $graphics.DpiX / 96
$graphics.Dispose()
$state = @{ last = 0; waiting = $false; beat = 0; image = $null }

# Where a window of a picture $width by $height pixels goes (a box for the spinner where they are
# not known): above the pointer and to its right; under it, or to its left, where there is no room;
# never over the pointer, which stays on the terminal.
function Place ([int]$width, [int]$height) {
  $cursor = [System.Windows.Forms.Cursor]::Position
  $area = [System.Windows.Forms.Screen]::FromPoint($cursor).WorkingArea
  if ($width -le 0 -or $height -le 0) { $width = 240; $height = 160 }
  $fit = [Math]::Min($scale, [Math]::Min($largest * $scale / [Math]::Max($width, $height), [Math]::Min($area.Width * 0.7 / $width, $area.Height * 0.7 / $height)))
  $outerWidth = [int]($width * $fit) + $pad * 2
  $outerHeight = [int]($height * $fit) + $pad * 2
  $x = $cursor.X + $gap
  $y = $cursor.Y - $gap - $outerHeight
  if ($y -lt $area.Top) { $y = $cursor.Y + $gap }
  if ($x + $outerWidth -gt $area.Right) { $x = $cursor.X - $gap - $outerWidth }
  $x = [Math]::Max($area.Left, [Math]::Min($x, $area.Right - $outerWidth))
  $y = [Math]::Max($area.Top, [Math]::Min($y, $area.Bottom - $outerHeight))
  $form.Bounds = New-Object System.Drawing.Rectangle($x, $y, $outerWidth, $outerHeight)
}

function Hide-Window {
  $form.Hide()
  $box.Image = $null
  if ($state.image) { $state.image.Dispose(); $state.image = $null }
  $state.waiting = $false
}

# The window at once, a spinner in it.
function Open-Window ([int]$width, [int]$height) {
  Hide-Window
  $box.Visible = $false
  $spinner.Text = [string]$turns[0]
  $spinner.Visible = $true
  Place $width $height
  $form.Show()
  $form.Refresh()
  $state.waiting = $true
}

# The picture in the window, in the spinner's place. Read from its bytes: the file stays free.
function Fill ([int]$number, [string]$file) {
  try {
    $image = [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream(, [System.IO.File]::ReadAllBytes($file))))
  } catch {
    Say "error $($number): cannot read the image"
    Hide-Window
    return
  }
  Place $image.Width $image.Height
  $box.Image = $image
  $state.image = $image
  $spinner.Visible = $false
  $box.Visible = $true
  $state.waiting = $false
  Say "shown $number"
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 40
$timer.add_Tick({
  $state.beat++
  if ($state.beat % 3 -eq 0) {
    try { Say '.' } catch { [System.Windows.Forms.Application]::ExitThread(); return }
    if ($state.waiting) { $spinner.Text = [string]$turns[[Math]::Floor($state.beat / 3) % $turns.Count] }
  }
  try { $lines = [System.IO.File]::ReadAllText($commands) -split [char]10 } catch { return }
  $number = 0
  if ($lines.Count -lt 6 -or $lines[5] -ne 'end' -or -not [int]::TryParse($lines[0], [ref]$number) -or $number -le $state.last) { return }
  $state.last = $number
  switch ($lines[1]) {
    'quit' { $timer.Stop(); [System.Windows.Forms.Application]::ExitThread() }
    'hide' { Hide-Window }
    'show' {
      if (-not ($state.waiting -and $lines[2])) { Open-Window ([int]$lines[3]) ([int]$lines[4]) }
      if ($lines[2]) { Fill $number $lines[2] }
    }
  }
})
$timer.Start()
Say 'ready'
[System.Windows.Forms.Application]::Run()
`
