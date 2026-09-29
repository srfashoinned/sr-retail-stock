const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.RECEIVABLES_PORT || 3021);
const ROOT = path.join(__dirname, "receivables");
const LEGACY_HOST = "127.0.0.1";
const LEGACY_PORT = 3020;

const types = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function proxyApi(req, res) {
  const proxy = http.request({
    hostname: LEGACY_HOST,
    port: LEGACY_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${LEGACY_HOST}:${LEGACY_PORT}` }
  }, upstream => {
    res.writeHead(upstream.statusCode || 502, { ...upstream.headers, "cache-control": "no-store" });
    upstream.pipe(res);
  });
  proxy.on("error", error => {
    res.writeHead(502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: `Receivables service unavailable: ${error.message}` }));
  });
  req.pipe(proxy);
}

function staticFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
  const target = path.resolve(ROOT, clean || "index.html");
  return target.startsWith(ROOT + path.sep) || target === path.join(ROOT, "index.html") ? target : null;
}

http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) return proxyApi(req, res);
  let file = staticFile(req.url);
  if (!file) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, "index.html");
  fs.readFile(file, (error, body) => {
    if (error) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "content-type": types[ext] || "application/octet-stream",
      "cache-control": ext === ".html" || ext === ".js" || ext === ".json" ? "no-store" : "public, max-age=86400"
    });
    res.end(body);
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`SR Fashion receivables gateway running on http://127.0.0.1:${PORT}`);
});

