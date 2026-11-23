// Preloaded with NODE_OPTIONS=--import into every process a local-mode test
// starts (the CLI, its session daemon, the speech worker). A request to the
// Clipy API under test (CLIPY_API_URL) or to any host off this machine is
// written to CLIPY_TEST_FETCH_LOG and refused, so a test can assert that
// --local made no such request. Every way out is covered: fetch(),
// http/https request and get, and raw net/tls connections. Loopback traffic to
// anything else passes through: `clipy mark` talks to its own session daemon
// on 127.0.0.1, Playwright to its browser, the tests to their own page server.
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

const log = process.env.CLIPY_TEST_FETCH_LOG;
const api = process.env.CLIPY_API_URL?.replace(/\/+$/, "");
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

let apiHost = "";
let apiPort = "";
try {
  if (api) {
    const u = new URL(api);
    apiHost = u.hostname;
    apiPort = u.port || (u.protocol === "https:" ? "443" : "80");
  }
} catch {
  // no usable API URL: only off-machine traffic is refused
}

/** Whether a connection to host:port must be refused (and logged). */
function blocked(host, port) {
  const h = String(host ?? "localhost").replace(/^\[|\]$/g, "");
  const p = port === undefined || port === null ? "" : String(port);
  if (apiHost && (h === apiHost || (LOOPBACK.has(h) && LOOPBACK.has(apiHost))) && p === apiPort) return true;
  return !LOOPBACK.has(h);
}

function refuse(kind, where) {
  appendFileSync(log, `${process.pid} ${kind} ${where}\n`);
  return new Error(`network disabled in this test: ${kind} ${where}`);
}

if (log) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      // not a URL: treat as off-machine
    }
    const toApi = Boolean(api) && String(url).startsWith(api);
    if (toApi || !LOOPBACK.has(host)) throw refuse("fetch", url);
    return realFetch(input, init);
  };

  /** Host and port of an http(s).request call, whatever its argument shape. */
  function requestTarget(args, defaultPort) {
    let url = null;
    let options = {};
    for (const arg of args) {
      if (typeof arg === "string") url = new URL(arg);
      else if (arg instanceof URL) url = arg;
      else if (arg && typeof arg === "object") options = arg;
    }
    const host = options.hostname ?? options.host?.replace(/:\d+$/, "") ?? url?.hostname ?? "localhost";
    const port = options.port ?? (url?.port || undefined) ?? defaultPort;
    return { host, port: String(port ?? defaultPort) };
  }

  for (const [mod, kind, defaultPort] of [[http, "http", 80], [https, "https", 443]]) {
    const realRequest = mod.request;
    const realGet = mod.get;
    mod.request = function patchedRequest(...args) {
      const { host, port } = requestTarget(args, defaultPort);
      if (blocked(host, port)) throw refuse(`${kind}.request`, `${host}:${port}`);
      return realRequest.apply(this, args);
    };
    mod.get = function patchedGet(...args) {
      const { host, port } = requestTarget(args, defaultPort);
      if (blocked(host, port)) throw refuse(`${kind}.get`, `${host}:${port}`);
      return realGet.apply(this, args);
    };
  }

  /** Host and port of a net/tls connect call; a Unix socket path is local. */
  function connectTarget(args) {
    const [first, second] = args;
    if (first && typeof first === "object") {
      if (first.path) return null;
      return { host: first.host ?? "localhost", port: first.port };
    }
    if (typeof first === "string" && !/^\d+$/.test(first)) return null; // a socket path
    return { host: typeof second === "string" ? second : "localhost", port: first };
  }

  for (const [mod, kind, names] of [[net, "net", ["connect", "createConnection"]], [tls, "tls", ["connect"]]]) {
    for (const name of names) {
      const real = mod[name];
      mod[name] = function patchedConnect(...args) {
        const target = connectTarget(args);
        if (target && blocked(target.host, target.port)) throw refuse(`${kind}.${name}`, `${target.host}:${target.port}`);
        return real.apply(this, args);
      };
    }
  }

  // ESM `import { request } from "node:http"` bindings see the patched functions too.
  syncBuiltinESMExports();
}
