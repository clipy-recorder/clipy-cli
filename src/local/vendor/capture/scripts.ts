// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/capture/src/scripts.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * The pointer helpers, one per OS, each using only what ships with it.
 * See sidecar.ts for the line protocol they print.
 */

/** python3 -c <this> <interval seconds>. Needs only libX11 (always present with X). */
export const LINUX_POINTER_SCRIPT = String.raw`
import ctypes, ctypes.util, os, sys, time
lib = ctypes.util.find_library("X11") or "libX11.so.6"
try:
    x = ctypes.cdll.LoadLibrary(lib)
except OSError:
    print("E libX11 not found", flush=True); sys.exit(2)
x.XOpenDisplay.restype = ctypes.c_void_p
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XDefaultRootWindow.restype = ctypes.c_ulong
x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x.XDefaultScreen.argtypes = [ctypes.c_void_p]
x.XDisplayWidth.argtypes = [ctypes.c_void_p, ctypes.c_int]
x.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
P = ctypes.POINTER
x.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, P(ctypes.c_ulong), P(ctypes.c_ulong),
    P(ctypes.c_int), P(ctypes.c_int), P(ctypes.c_int), P(ctypes.c_int), P(ctypes.c_uint)]
d = x.XOpenDisplay(None)
if not d:
    print("E cannot open X display " + os.environ.get("DISPLAY", "(unset)"), flush=True); sys.exit(2)
root = x.XDefaultRootWindow(d)
scr = x.XDefaultScreen(d)
print('S [{"name":"screen","x":0,"y":0,"width":%d,"height":%d,"primary":true}]' % (x.XDisplayWidth(d, scr), x.XDisplayHeight(d, scr)), flush=True)
iv = float(sys.argv[1]) if len(sys.argv) > 1 else 0.05
parent = os.getppid()
rr = ctypes.c_ulong(); cr = ctypes.c_ulong()
rx = ctypes.c_int(); ry = ctypes.c_int(); wx = ctypes.c_int(); wy = ctypes.c_int(); m = ctypes.c_uint()
while os.getppid() == parent:
    x.XQueryPointer(d, root, ctypes.byref(rr), ctypes.byref(cr), ctypes.byref(rx), ctypes.byref(ry),
        ctypes.byref(wx), ctypes.byref(wy), ctypes.byref(m))
    b = (1 if m.value & 256 else 0) | (2 if m.value & 1024 else 0) | (4 if m.value & 512 else 0)
    sys.stdout.write("P %d %d %d %d\n" % (int(time.time() * 1000), rx.value, ry.value, b))
    sys.stdout.flush()
    time.sleep(iv)
`;

/** osascript -l JavaScript -e <this> <interval seconds>. */
export const MAC_POINTER_SCRIPT = String.raw`
ObjC.import("AppKit");
function out(s) {
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(
    $.NSString.alloc.initWithUTF8String(s + "\n").dataUsingEncoding($.NSUTF8StringEncoding));
}
function run(argv) {
  var iv = parseFloat(argv[0]) || 0.05;
  var screens = $.NSScreen.screens;
  var mainH = screens.objectAtIndex(0).frame.size.height;
  var list = [];
  for (var i = 0; i < screens.count; i++) {
    var f = screens.objectAtIndex(i).frame;
    list.push({ name: "Display " + (i + 1), x: f.origin.x, y: mainH - (f.origin.y + f.size.height),
      width: f.size.width, height: f.size.height, primary: i === 0 });
  }
  out("S " + JSON.stringify(list));
  while (true) {
    var p = $.NSEvent.mouseLocation;
    var b = $.NSEvent.pressedMouseButtons;
    out("P " + Date.now() + " " + Math.round(p.x) + " " + Math.round(mainH - p.y) + " " + (b & 7));
    delay(iv);
  }
}
`;

const WINDOWS_TYPES = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace ClipyCapture -Name User32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
public struct POINT { public int X; public int Y; }
'@
[void][ClipyCapture.User32]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms
$screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [pscustomobject]@{ name = $_.DeviceName; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height; primary = $_.Primary }
})
[Console]::Out.WriteLine('S ' + (ConvertTo-Json -Compress -InputObject $screens))
[Console]::Out.Flush()
`;

export function windowsScreensScript(): string {
  return WINDOWS_TYPES;
}

export function windowsPointerScript(intervalMs: number): string {
  return (
    WINDOWS_TYPES +
    String.raw`
$p = New-Object ClipyCapture.User32+POINT
while ($true) {
  [void][ClipyCapture.User32]::GetCursorPos([ref]$p)
  $b = 0
  if ([ClipyCapture.User32]::GetAsyncKeyState(1) -band 0x8000) { $b += 1 }
  if ([ClipyCapture.User32]::GetAsyncKeyState(2) -band 0x8000) { $b += 2 }
  if ([ClipyCapture.User32]::GetAsyncKeyState(4) -band 0x8000) { $b += 4 }
  [Console]::Out.WriteLine("P $([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) $($p.X) $($p.Y) $b")
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${Math.max(10, Math.round(intervalMs))}
}
`
  );
}

/** PowerShell -EncodedCommand takes base64 of UTF-16LE. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}
