// SPDX-License-Identifier: Apache-2.0
// GENERATED from oss/packages/capture/src/xauth.ts by cli/scripts/sync-local.mjs. Do not edit here.
/**
 * X authority for the private displays this package starts.
 *
 * A virtual display is started with access control on: only clients holding
 * its cookie (an Xauthority file readable by this user alone) can connect,
 * and, when it can be arranged, any process of this same user. Other users on
 * the machine cannot read or draw on it.
 *
 * Every X client this package runs against a display it started (ffmpeg, the
 * pointer helper, xrandr and friends) gets that display's XAUTHORITY through
 * `xEnv`.
 */

/** display name (":91") -> its Xauthority file */
const authorities = new Map<string, string>();

export function registerXAuthority(display: string, file: string): void {
  authorities.set(display, file);
}

export function forgetXAuthority(display: string): void {
  authorities.delete(display);
}

/** The Xauthority file of a display this process started, if any. */
export function xAuthorityFor(display: string | undefined): string | undefined {
  return display ? authorities.get(display) : undefined;
}

/** `env` with DISPLAY set to `xDisplay`, plus XAUTHORITY when it is a display this process started. */
export function xEnv(env: NodeJS.ProcessEnv, xDisplay: string | undefined): NodeJS.ProcessEnv {
  if (!xDisplay) return env;
  const auth = authorities.get(xDisplay);
  return { ...env, DISPLAY: xDisplay, ...(auth ? { XAUTHORITY: auth } : {}) };
}

/**
 * python3 -c <this> <user>: allow every process of <user> on the display
 * (server-interpreted "localuser", what `xhost +si:localuser:<user>` does).
 * Needs only libX11, like the pointer helper.
 */
export const ALLOW_LOCAL_USER_SCRIPT = String.raw`
import ctypes, ctypes.util, sys
x = ctypes.cdll.LoadLibrary(ctypes.util.find_library("X11") or "libX11.so.6")
class SI(ctypes.Structure):
    _fields_ = [("typelength", ctypes.c_int), ("valuelength", ctypes.c_int), ("type", ctypes.c_char_p), ("value", ctypes.c_char_p)]
class Host(ctypes.Structure):
    _fields_ = [("family", ctypes.c_int), ("length", ctypes.c_int), ("address", ctypes.c_void_p)]
x.XOpenDisplay.restype = ctypes.c_void_p
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XAddHost.argtypes = [ctypes.c_void_p, ctypes.POINTER(Host)]
x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
x.XCloseDisplay.argtypes = [ctypes.c_void_p]
d = x.XOpenDisplay(None)
if not d:
    sys.exit(2)
user = sys.argv[1].encode()
si = SI(9, len(user), b"localuser", user)
host = Host(5, ctypes.sizeof(SI), ctypes.cast(ctypes.pointer(si), ctypes.c_void_p))
x.XAddHost(d, ctypes.byref(host))
x.XSync(d, 0)
x.XCloseDisplay(d)
`;

/** python3 -c <this>: exit 0 when the X display in $DISPLAY accepts a connection. */
export const OPEN_DISPLAY_SCRIPT = String.raw`
import ctypes, ctypes.util, sys
x = ctypes.cdll.LoadLibrary(ctypes.util.find_library("X11") or "libX11.so.6")
x.XOpenDisplay.restype = ctypes.c_void_p
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
sys.exit(0 if x.XOpenDisplay(None) else 1)
`;
