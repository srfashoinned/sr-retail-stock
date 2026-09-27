const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const sharp = require("sharp");
const sql = require("mssql");

const ROOT = __dirname;
const PORT = Number(process.env.STOCK_API_PORT || 3030);
const CACHE_FILE = path.join(ROOT, "items.json");
const IMAGE_ROOT = path.join(ROOT, "images", "products");
const PRIVATE_DIR = path.join(ROOT, "private");
const IMAGE_KEY_FILE = path.join(PRIVATE_DIR, "image-upload-key.txt");
const ACCESS_KEY_FILE = path.join(PRIVATE_DIR, "access-keys.json");
const UPLOAD_SESSION_FILE = path.join(PRIVATE_DIR, "upload-sessions.json");
const config = require("./config.json");
const execFileAsync = promisify(execFile);
const imageTypes = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

let memoryCache = {
  items: null,
  updatedAt: null,
  version: null,
  loading: null
};

function stockVersion(items) {
  return crypto.createHash("sha1").update(JSON.stringify(items || [])).digest("hex").slice(0, 16);
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-sr-image-key");
}

function sendJson(res, status, payload, cache = "no-store") {
  cors(res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cache
  });
  res.end(JSON.stringify(payload));
}

function sendImageFile(res, urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/images\/products\/?/, "");
  const target = path.resolve(IMAGE_ROOT, cleanPath);
  if (!target.startsWith(IMAGE_ROOT)) return sendJson(res, 403, { error: "Forbidden" });
  const ext = path.extname(target).toLowerCase();
  if (!imageTypes[ext]) return sendJson(res, 403, { error: "Forbidden" });
  fs.readFile(target, (error, data) => {
    if (error) return sendJson(res, 404, { error: "Image not found" });
    cors(res);
    res.writeHead(200, {
      "Content-Type": imageTypes[ext],
      "Cache-Control": "public, max-age=300"
    });
    res.end(data);
  });
}

function loadFileCache() {
  if (!fs.existsSync(CACHE_FILE)) return [];
  return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
}

function safeAlias(value = "") {
  return String(value).trim().replace(/[^a-zA-Z0-9_-]/g, "");
}

function readImageKeys() {
  const keys = new Set();
  if (process.env.SR_IMAGE_UPLOAD_KEY) {
    process.env.SR_IMAGE_UPLOAD_KEY
      .split(/[,\s]+/)
      .map(value => value.trim())
      .filter(Boolean)
      .forEach(value => keys.add(value));
  }
  try {
    fs.readFileSync(IMAGE_KEY_FILE, "utf8")
      .split(/[,\s]+/)
      .map(value => value.trim())
      .filter(Boolean)
      .forEach(value => keys.add(value));
  } catch {
  }
  return keys;
}

function imageKeyAllowed(value) {
  const token = String(value || "").trim();
  return readImageKeys().has(token) || authSessionAllowed(token);
}

function readJsonFile(file, fallback) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : fallback;
  } catch {
    return fallback;
  }
}

function authHash(pin, salt) {
  return crypto.createHash("sha256").update(`${salt}:${pin}`).digest("hex");
}

function safeHashEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authRole(pin) {
  const data = readJsonFile(ACCESS_KEY_FILE, {});
  const salt = String(data.salt || "");
  if (!salt) return "";
  const digest = authHash(String(pin || "").trim(), salt);
  if (data.adminHash && safeHashEqual(data.adminHash, digest)) return "admin";
  if (data.staffHash && safeHashEqual(data.staffHash, digest)) return "staff";
  return "";
}

function readAuthSessions() {
  return readJsonFile(UPLOAD_SESSION_FILE, {});
}

function saveAuthSessions(sessions) {
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.writeFileSync(UPLOAD_SESSION_FILE, JSON.stringify(sessions));
}

function makeAuthSession(role) {
  const now = Date.now();
  const sessions = readAuthSessions();
  for (const [token, row] of Object.entries(sessions)) {
    if (!row || Number(row.expiresAt || 0) <= now) delete sessions[token];
  }
  const token = `${role}.${crypto.randomBytes(24).toString("hex")}`;
  sessions[token] = { role, expiresAt: now + 12 * 60 * 60 * 1000 };
  saveAuthSessions(sessions);
  return token;
}

function authSessionAllowed(token) {
  if (!token) return false;
  const row = readAuthSessions()[token];
  return !!row && Number(row.expiresAt || 0) > Date.now();
}

async function handleAuth(req, res, url) {
  if ((url.pathname === "/auth/login" || url.pathname === "/auth/login.php") && req.method === "POST") {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8") || "{}");
    const pin = String(body.pin || "").trim();
    if (pin.length < 3) return sendJson(res, 400, { ok: false, error: "PIN required" });
    const role = authRole(pin);
    if (!role) return sendJson(res, 403, { ok: false, error: "Wrong PIN" });
    return sendJson(res, 200, { ok: true, role, imageKey: makeAuthSession(role) });
  }
  return sendJson(res, 404, { ok: false, error: "Auth not found" });
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
    .filter(name => /\.(jpe?g|png|webp|gif)$/i.test(name) && !/-thumb\.webp$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(name => {
      const full = path.join(folder, name);
      const thumbName = name.replace(/\.[^.]+$/, "-thumb.webp");
      const thumb = path.join(folder, thumbName);
      return {
        name,
        url: `/images/products/${encodeURIComponent(alias)}/${encodeURIComponent(name)}?v=${fs.statSync(full).mtimeMs}`,
        thumbnailUrl: fs.existsSync(thumb) ? `/images/products/${encodeURIComponent(alias)}/${encodeURIComponent(thumbName)}?v=${fs.statSync(thumb).mtimeMs}` : null
      };
    });
}

async function handleImageApi(req, res, url) {
  if (url.pathname === "/image-api/list" && req.method === "GET") {
    const alias = safeAlias(url.searchParams.get("alias"));
    if (!alias) return sendJson(res, 400, { ok: false, error: "Missing product code" });
    return sendJson(res, 200, { ok: true, images: imageList(alias) });
  }

  if (url.pathname === "/image-api/upload" && req.method === "POST") {
    if (!imageKeyAllowed(req.headers["x-sr-image-key"])) {
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
    const contentType = /content-type:\s*([^\r\n]+)/i.exec(file.headers)?.[1] || "image/jpeg";
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(contentType)) {
      return sendJson(res, 400, { ok: false, error: "Only image files allowed" });
    }

    const folder = path.join(IMAGE_ROOT, alias);
    if (!folder.startsWith(IMAGE_ROOT)) return sendJson(res, 403, { ok: false, error: "Invalid product code" });
    fs.mkdirSync(folder, { recursive: true });
    const normalized = await sharp(file.data, { animated: false })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 84, mozjpeg: true })
      .toBuffer();
    const incomingHash = crypto.createHash("sha256").update(normalized).digest("hex");
    for (const existing of imageList(alias)) {
      const existingBuffer = fs.readFileSync(path.join(folder, existing.name));
      if (crypto.createHash("sha256").update(existingBuffer).digest("hex") === incomingHash) {
        return sendJson(res, 200, { ok: true, duplicate: true, image: existing });
      }
    }
    const used = new Set(imageList(alias).map(img => parseInt(img.name, 10)));
    let num = 1;
    while (used.has(num)) num++;
    if (num > 10) return sendJson(res, 400, { ok: false, error: "Max 10 images reached" });
    const filename = `${num}.jpg`;
    const thumbnailName = `${num}-thumb.webp`;
    fs.writeFileSync(path.join(folder, filename), normalized);
    await sharp(normalized).resize({ width: 360, height: 360, fit: "inside", withoutEnlargement: true }).webp({ quality: 76 }).toFile(path.join(folder, thumbnailName));
    return sendJson(res, 200, { ok: true, image: imageList(alias).find(img => img.name === filename) });
  }

  if (url.pathname === "/image-api/delete" && req.method === "POST") {
    if (!imageKeyAllowed(req.headers["x-sr-image-key"])) {
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
    const thumbnail = path.join(IMAGE_ROOT, alias, name.replace(/\.[^.]+$/, "-thumb.webp"));
    if (fs.existsSync(thumbnail)) fs.unlinkSync(thumbnail);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { ok: false, error: "Image API not found" });
}

function normalizeDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

async function fetchLiveStock() {
  const pool = await sql.connect(config);
  const result = await pool.request().query(`
SELECT
    P.PID AS ProductID,
    LTRIM(RTRIM(ISNULL(P.ProductCode, ''))) AS ProductCode,
    LTRIM(RTRIM(ISNULL(P.ProductName, ''))) AS ProductName,
    LTRIM(RTRIM(ISNULL(SC.Category, ''))) AS Category,
    LTRIM(RTRIM(ISNULL(SC.SubCategoryName, ''))) AS SubCategory,
    LTRIM(RTRIM(
        CASE
            WHEN ISNULL(P.PartNo, '') <> '' THEN P.PartNo
            WHEN ISNULL(SC.SubCategoryName, '') <> '' THEN SC.SubCategoryName
            ELSE ISNULL(SC.Category, '')
        END
    )) AS PartGroup,
    LTRIM(RTRIM(COALESCE(
        (
            SELECT TOP 1 CONVERT(NVARCHAR(100), SP.Barcode)
            FROM dbo.Stock_Product SP
            WHERE SP.ProductID = P.PID
              AND NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(100), SP.Barcode))), '') IS NOT NULL
              AND LTRIM(RTRIM(CONVERT(NVARCHAR(100), SP.Barcode))) <> '0'
            ORDER BY SP.SP_ID DESC
        ),
        (
            SELECT TOP 1 CONVERT(NVARCHAR(100), O.Barcode)
            FROM dbo.Product_OpeningStock O
            WHERE O.ProductID = P.PID
              AND NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(100), O.Barcode))), '') IS NOT NULL
              AND LTRIM(RTRIM(CONVERT(NVARCHAR(100), O.Barcode))) <> '0'
            ORDER BY O.ID DESC
        ),
        NULLIF(LTRIM(RTRIM(CONVERT(NVARCHAR(100), P.Barcode))), '0'),
        ''
    ))) AS Barcode,
    COALESCE(
        P.AddDate,
        (
            SELECT TOP 1 O.PAddDate
            FROM dbo.Product_OpeningStock O
            WHERE O.ProductID = P.PID AND O.PAddDate IS NOT NULL
            ORDER BY O.ID DESC
        )
    ) AS EntryDate,
    ISNULL(P.MRP, 0) AS MRP,
    ISNULL(P.SellingPrice, 0) AS SalePrice,
    LTRIM(RTRIM(ISNULL(
        (
            SELECT TOP 1 NULLIF(CONVERT(NVARCHAR(100), SP.Size), '')
            FROM dbo.Stock_Product SP
            WHERE SP.ProductID = P.PID
            ORDER BY SP.SP_ID DESC
        ),
        (
            SELECT TOP 1 NULLIF(CONVERT(NVARCHAR(100), O.Size), '')
            FROM dbo.Product_OpeningStock O
            WHERE O.ProductID = P.PID
            ORDER BY O.ID DESC
        )
    ))) AS Size,
    LTRIM(RTRIM(ISNULL(
        (
            SELECT TOP 1 NULLIF(CONVERT(NVARCHAR(100), SP.Color), '')
            FROM dbo.Stock_Product SP
            WHERE SP.ProductID = P.PID
            ORDER BY SP.SP_ID DESC
        ),
        (
            SELECT TOP 1 NULLIF(CONVERT(NVARCHAR(100), O.Colour), '')
            FROM dbo.Product_OpeningStock O
            WHERE O.ProductID = P.PID
            ORDER BY O.ID DESC
        )
    ))) AS Colour,
    ISNULL((SELECT TOP 1 O.WSalePrice FROM dbo.Product_OpeningStock O WHERE O.ProductID = P.PID ORDER BY O.ID DESC), 0) AS WholesalePrice,
    ISNULL((SELECT TOP 1 O.PPrice FROM dbo.Product_OpeningStock O WHERE O.ProductID = P.PID ORDER BY O.ID DESC), ISNULL(P.CostPrice, 0)) AS PurchasePrice,
    CAST(ISNULL(P.OpeningStock, 0) AS DECIMAL(18,3)) AS ProductOpeningStock,
    CAST(ISNULL((SELECT SUM(ISNULL(O.Qty, 0)) FROM dbo.Product_OpeningStock O WHERE O.ProductID = P.PID), 0) AS DECIMAL(18,3)) AS ProductOpeningQty,
    CAST(ISNULL((SELECT SUM(ISNULL(SP.Qty, 0)) FROM dbo.Stock_Product SP WHERE SP.ProductID = P.PID), 0) AS DECIMAL(18,3)) AS StockProductQty,
    CAST(ISNULL((SELECT SUM(ISNULL(IP.Qty, 0)) FROM dbo.Invoice_Product IP WHERE IP.ProductID = P.PID), 0) AS DECIMAL(18,3)) AS SoldQty,
    CAST(ISNULL((SELECT SUM(ISNULL(SR.Qty, 0)) FROM dbo.SalesReturn_Join SR WHERE SR.ProductID = P.PID), 0) AS DECIMAL(18,3)) AS SalesReturnQty
FROM dbo.Product P
LEFT JOIN dbo.SubCategory SC ON P.SubCategoryID = SC.ID
ORDER BY P.PID DESC;
  `);

  const products = result.recordset.map(item => {
    const productOpeningStock = Number(item.ProductOpeningStock || 0);
    const productOpeningQty = Number(item.ProductOpeningQty || 0);
    const stockProductQty = Number(item.StockProductQty || 0);
    const soldQty = Number(item.SoldQty || 0);
    const salesReturnQty = Number(item.SalesReturnQty || 0);
    const baseStock = stockProductQty !== 0
      ? stockProductQty
      : productOpeningQty !== 0
        ? productOpeningQty
        : productOpeningStock;
    const availableQty = Math.round((baseStock - soldQty + salesReturnQty + Number.EPSILON) * 1000) / 1000;

    return {
      ProductID: Number(item.ProductID || 0),
      name: item.ProductName || "",
      alias: item.ProductCode || "",
      barcode: String(item.Barcode || "").trim(),
      group: item.PartGroup || item.SubCategory || item.Category || "GENERAL",
      Category: item.Category || "",
      SubCategory: item.SubCategory || "",
      PartGroup: item.PartGroup || "",
      mrp: Number(item.MRP || 0),
      sale: Number(item.SalePrice || 0),
      wholesale: Number(item.WholesalePrice || 0),
      purchase: Number(item.PurchasePrice || 0),
      size: item.Size || "",
      colour: item.Colour || "",
      stock: availableQty,
      entryDate: normalizeDate(item.EntryDate)
    };
  }).filter(product => product.ProductID || product.name || product.alias || product.barcode);

  const version = stockVersion(products);
  const changed = version !== memoryCache.version;
  if (changed) fs.writeFileSync(CACHE_FILE, JSON.stringify(products, null, 2), "utf8");
  memoryCache = { items: products, updatedAt: changed || !memoryCache.updatedAt ? new Date().toISOString() : memoryCache.updatedAt, version, loading: null };
  return products;
}

fetchLiveStock = async function fetchBusyWinStock() {
  await execFileAsync(process.execPath, [path.join(ROOT, "export-stock-busywin.js")], {
    cwd: ROOT,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024
  });
  const products = loadFileCache();
  const version = stockVersion(products);
  memoryCache = {
    items: products,
    updatedAt: new Date().toISOString(),
    version,
    loading: null
  };
  return products;
};

async function getStock() {
  if (memoryCache.loading) return memoryCache.loading;
  memoryCache.loading = fetchLiveStock().finally(() => {
    memoryCache.loading = null;
  });
  return memoryCache.loading;
}

function refreshStockInBackground() {
  if (memoryCache.loading) return;
  memoryCache.loading = fetchLiveStock().catch(() => null).finally(() => {
    memoryCache.loading = null;
  });
}

const server = http.createServer(async (req, res) => {
  try {
    cors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/auth/")) {
      return handleAuth(req, res, url);
    }
    if (url.pathname.startsWith("/image-api/")) {
      return handleImageApi(req, res, url);
    }
    if (url.pathname.startsWith("/images/products/")) {
      return sendImageFile(res, url.pathname);
    }

    if (url.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        updatedAt: memoryCache.updatedAt,
        version: memoryCache.version,
        cachedItems: memoryCache.items?.length || loadFileCache().length
      });
    }

    if (url.pathname === "/api/items") {
      try {
        const cached = memoryCache.items || loadFileCache();
        if (cached.length) {
          refreshStockInBackground();
          const version = memoryCache.version || stockVersion(cached);
          if (url.searchParams.get("version") === version) {
            return sendJson(res, 200, { source: "live", unchanged: true, version, updatedAt: memoryCache.updatedAt, count: cached.length });
          }
          return sendJson(res, 200, {
            source: memoryCache.updatedAt ? "memory-cache" : "file-cache",
            updatedAt: memoryCache.updatedAt || (fs.existsSync(CACHE_FILE) ? fs.statSync(CACHE_FILE).mtime.toISOString() : null),
            count: cached.length,
            version,
            items: cached
          }, "public, max-age=30, stale-while-revalidate=300");
        }
        const items = await getStock();
        return sendJson(res, 200, {
          source: "live",
          updatedAt: memoryCache.updatedAt,
          count: items.length,
          items
        });
      } catch (error) {
        const cached = loadFileCache();
        return sendJson(res, 200, {
          source: "cache",
          error: error.message,
          updatedAt: fs.existsSync(CACHE_FILE) ? fs.statSync(CACHE_FILE).mtime.toISOString() : null,
          count: cached.length,
          items: cached
        }, "public, max-age=60, stale-if-error=86400");
      }
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
});

// Keep one current snapshot ready for every website visitor. This avoids making
// each browser wait for a database query and lets the page see changes quickly.
setInterval(refreshStockInBackground, 5000).unref();
refreshStockInBackground();

server.listen(PORT, () => {
  console.log(`SR Fashion live stock API running on http://localhost:${PORT}`);
});
