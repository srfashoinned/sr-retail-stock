const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3031);
const ROOT = __dirname;
const IMAGE_ROOT = path.join(ROOT, "images", "products");
const PRIVATE_DIR = path.join(ROOT, "private");
const IMAGE_KEY_FILE = path.join(PRIVATE_DIR, "image-upload-key.txt");

function readImageKey() {
  if (process.env.SR_IMAGE_UPLOAD_KEY) return process.env.SR_IMAGE_UPLOAD_KEY;
  try {
    return fs.readFileSync(IMAGE_KEY_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
}

function safeFile(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
  const target = path.resolve(ROOT, cleanPath || "index.html");
  if (!target.startsWith(ROOT)) return null;
  const rel = path.relative(ROOT, target).replace(/\\/g, "/").toLowerCase();
  if (
    rel.startsWith("private/") ||
    rel === "config.json" ||
    rel.endsWith(".ps1") ||
    rel.endsWith(".vbs") ||
    rel.endsWith(".bat") ||
    rel === "serve-stock-site.js" ||
    rel === "live-stock-api.js"
  ) return null;
  return target;
}

function safeAlias(value = "") {
  return String(value).trim().replace(/[^a-zA-Z0-9_-]/g, "");
}

function readBody(req, limit = 9 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Image too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!boundaryMatch) throw new Error("Missing upload boundary");
  const boundary = Buffer.from("--" + (boundaryMatch[1] || boundaryMatch[2]));
  const parts = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    if (buffer[start] === 45 && buffer[start + 1] === 45) break;
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), start);
    if (headerEnd === -1) break;
    const next = buffer.indexOf(boundary, headerEnd + 4);
    if (next === -1) break;
    const headers = buffer.slice(start, headerEnd).toString("utf8");
    let data = buffer.slice(headerEnd + 4, next);
    if (data.length >= 2 && data[data.length - 2] === 13 && data[data.length - 1] === 10) {
      data = data.slice(0, -2);
    }
    parts.push({ headers, data });
    start = next;
  }
  return parts;
}

function imageList(alias) {
  const folder = path.join(IMAGE_ROOT, alias);
  if (!folder.startsWith(IMAGE_ROOT) || !fs.existsSync(folder)) return [];
  return fs.readdirSync(folder)
    .filter(name => /\.(jpe?g|png|webp|gif)$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(name => ({
      name,
      url: `/images/products/${encodeURIComponent(alias)}/${encodeURIComponent(name)}?v=${fs.statSync(path.join(folder, name)).mtimeMs}`
    }));
}

async function handleImageApi(req, res, url) {
  if (url.pathname === "/image-api/list" && req.method === "GET") {
    const alias = safeAlias(url.searchParams.get("alias"));
    if (!alias) return sendJson(res, 400, { ok: false, error: "Missing product code" });
    return sendJson(res, 200, { ok: true, images: imageList(alias) });
  }

  if (url.pathname === "/image-api/upload" && req.method === "POST") {
    if (!readImageKey() || (req.headers["x-sr-image-key"] || "") !== readImageKey()) {
      return sendJson(res, 403, { ok: false, error: "Image upload password required" });
    }
    const body = await readBody(req);
    const parts = parseMultipart(body, req.headers["content-type"]);
    const fields = {};
    let file = null;
    for (const part of parts) {
      const nameMatch = /name="([^"]+)"/i.exec(part.headers);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      if (name === "file") file = part;
      else fields[name] = part.data.toString("utf8");
    }
    const alias = safeAlias(fields.alias);
    if (!alias || !file?.data?.length) return sendJson(res, 400, { ok: false, error: "Missing image" });
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(/content-type:\s*([^\r\n]+)/i.exec(file.headers)?.[1] || "image/jpeg")) {
      return sendJson(res, 400, { ok: false, error: "Only image files allowed" });
    }

    const folder = path.join(IMAGE_ROOT, alias);
    if (!folder.startsWith(IMAGE_ROOT)) return sendJson(res, 403, { ok: false, error: "Invalid product code" });
    fs.mkdirSync(folder, { recursive: true });
    const used = new Set(imageList(alias).map(img => parseInt(img.name, 10)));
    let num = 1;
    while (used.has(num)) num++;
    if (num > 10) return sendJson(res, 400, { ok: false, error: "Max 10 images reached" });
    const filename = `${num}.jpg`;
    fs.writeFileSync(path.join(folder, filename), file.data);
    return sendJson(res, 200, { ok: true, image: imageList(alias).find(img => img.name === filename) });
  }

  if (url.pathname === "/image-api/delete" && req.method === "POST") {
    if (!readImageKey() || (req.headers["x-sr-image-key"] || "") !== readImageKey()) {
      return sendJson(res, 403, { ok: false, error: "Image upload password required" });
    }
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8") || "{}");
    const alias = safeAlias(body.alias);
    const name = String(body.name || "").replace(/[^a-zA-Z0-9_.-]/g, "");
    if (!alias || !/^\d+\.(jpe?g|png|webp|gif)$/i.test(name)) {
      return sendJson(res, 400, { ok: false, error: "Invalid image" });
    }
    const file = path.join(IMAGE_ROOT, alias, name);
    if (!file.startsWith(path.join(IMAGE_ROOT, alias))) return sendJson(res, 403, { ok: false, error: "Invalid path" });
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return sendJson(res, 200, { ok: true });
  }

  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/image-api/")) {
    handleImageApi(req, res, url).catch(error => sendJson(res, 500, { ok: false, error: error.message }));
    return;
  }

  if (req.url === "/health") {
    return send(res, 200, JSON.stringify({ ok: true, site: "sr-stock", updatedAt: new Date().toISOString() }), {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
  }

  const target = safeFile(req.url);
  if (!target) return send(res, 403, "Forbidden", { "Content-Type": "text/plain" });

  fs.stat(target, (err, stat) => {
    const file = !err && stat.isDirectory() ? path.join(target, "index.html") : target;
    fs.readFile(file, (readErr, data) => {
      if (readErr) {
        return fs.readFile(path.join(ROOT, "index.html"), (fallbackErr, fallback) => {
          if (fallbackErr) return send(res, 404, "Not found", { "Content-Type": "text/plain" });
          send(res, 200, fallback, {
            "Content-Type": types[".html"],
            "Cache-Control": "no-cache"
          });
        });
      }

      const ext = path.extname(file).toLowerCase();
      send(res, 200, data, {
        "Content-Type": types[ext] || "application/octet-stream",
        "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300"
      });
    });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`SR Fashion stock website server running at http://127.0.0.1:${PORT}`);
});
