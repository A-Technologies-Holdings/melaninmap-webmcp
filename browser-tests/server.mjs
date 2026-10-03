/**
 * A tiny static file server for the real-browser suite.
 *
 * The playground imports ../dist/index.js and
 * ../.test-build/examples/domConsentSurface.js as ES modules, which browsers
 * refuse to load from file://. This serves the repository root over loopback
 * so the page runs exactly as a consumer would load it, with no dependency
 * beyond node:http.
 *
 * It binds 127.0.0.1 on an ephemeral port, answers GET/HEAD only, and refuses
 * any path that resolves outside the root.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** @returns {Promise<{ url: string, close: () => Promise<void> }>} */
export async function startStaticServer(root) {
  const base = path.resolve(root);
  const server = createServer(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    let file;
    try {
      const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");
      file = path.resolve(base, `.${decodeURIComponent(pathname)}`);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error("not a file");
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
        "content-length": info.size,
        "cache-control": "no-store",
      });
      if (req.method === "HEAD") res.end();
      else createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
