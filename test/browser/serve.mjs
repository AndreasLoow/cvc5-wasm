// Static server for the browser test, with plain headers: no
// Cross-Origin-Opener-Policy, no Cross-Origin-Embedder-Policy, so the page is
// not cross-origin isolated.  .wasm is served as application/wasm so it can be
// streamed and compiled while it downloads.
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const port = Number(process.env.PORT || 8080);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".smt2": "text/plain; charset=utf-8",
  ".tsv": "text/plain; charset=utf-8",
};

export function serve() {
  const server = createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (rel === "/") rel = "/test/browser/index.html";
    const file = join(root, normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    let size;
    try {
      size = statSync(file).size;
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found: " + rel);
      return;
    }
    res.writeHead(200, {
      "content-type": types[extname(file)] || "application/octet-stream",
      "content-length": size,
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, port })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port: p } = await serve();
  console.log(`serving ${root} on http://localhost:${p}/ (no COOP/COEP)`);
}
