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

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function todayIso() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function addOneDayIso(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function runBusyProfitLines(query) {
  const { stdout } = await execFileAsync("sqlcmd", [
    "-S", process.env.BUSY_SQL_SERVER || "localhost",
    "-E",
    "-d", process.env.BUSY_SQL_DATABASE || "BusyComp0004_db12026",
    "-W",
    "-h", "-1",
    "-w", "65535",
    "-Q", query
  ], { windowsHide: true, maxBuffer: 20 * 1024 * 1024 });

  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("(") && !line.includes("rows affected"));
}

function busyProfitQuery(mode, fromDate, toDate) {
  const dateWhere = `
  AND H.Date >= CONVERT(date, '${fromDate}')
  AND H.Date < CONVERT(date, '${addOneDayIso(toDate)}')`;

  if (mode === "item") {
    return `
SET NOCOUNT ON;
SELECT
  LTRIM(RTRIM(CONVERT(varchar(20), Item.Code))) + CHAR(9)
  + REPLACE(Item.Name, CHAR(9), ' ') + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value1)) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(10), MAX(H.Date), 120) + CHAR(9)
  + CONVERT(varchar(5), MAX(ISNULL(H.CreationTime,H.Date)), 108) + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value3)) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value1) * Item.D4) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value3)) - SUM(ABS(D.Value1) * Item.D4) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(
      CASE
        WHEN SUM(ABS(D.Value3)) = 0 THEN 0
        ELSE (SUM(ABS(D.Value3)) - SUM(ABS(D.Value1) * Item.D4)) * 100.0 / SUM(ABS(D.Value3))
      END
    AS decimal(18,2))) AS ReportLine
FROM Tran1 H
JOIN Tran2 D ON D.VchCode = H.VchCode
JOIN Master1 Item ON Item.Code = D.MasterCode1
WHERE H.VchType = 9
  AND D.RecType = 2
  AND Item.MasterType = 6
${dateWhere}
  AND ISNULL(H.VchCancelled,0) = 0
  AND ISNULL(H.Cancelled,0) = 0
GROUP BY Item.Code,Item.Name
ORDER BY MAX(H.Date) DESC, MAX(H.VchCode) DESC`;
  }

  return `
SET NOCOUNT ON;
SELECT
  CONVERT(varchar(10), H.Date, 120) + CHAR(9)
  + LTRIM(RTRIM(H.VchNo)) + CHAR(9)
  + REPLACE(ISNULL(B.PartyName, Party.Name), CHAR(9), ' ') + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value1)) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(5), MAX(ISNULL(H.CreationTime,H.Date)), 108) + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value3)) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value1) * Item.D4) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value3)) - SUM(ABS(D.Value1) * Item.D4) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(
      CASE
        WHEN SUM(ABS(D.Value3)) = 0 THEN 0
        ELSE (SUM(ABS(D.Value3)) - SUM(ABS(D.Value1) * Item.D4)) * 100.0 / SUM(ABS(D.Value3))
      END
    AS decimal(18,2))) AS ReportLine
FROM Tran1 H
JOIN Tran2 D ON D.VchCode = H.VchCode
JOIN Master1 Item ON Item.Code = D.MasterCode1
LEFT JOIN BillingDet B ON B.VchCode = H.VchCode
LEFT JOIN Master1 Party ON Party.Code = H.MasterCode1
WHERE H.VchType = 9
  AND D.RecType = 2
  AND Item.MasterType = 6
${dateWhere}
  AND ISNULL(H.VchCancelled,0) = 0
  AND ISNULL(H.Cancelled,0) = 0
GROUP BY H.VchCode,H.Date,H.VchNo,ISNULL(B.PartyName, Party.Name)
ORDER BY H.Date DESC,H.VchCode DESC`;
}

function parseProfitRows(mode, lines) {
  return lines.map(line => {
    const parts = line.split("\t");
    if (mode === "item") {
      const [itemCode, itemName, qtySold, lastSoldDate, lastSoldTime, saleAmount, cost, profit, profitPercent] = parts;
      return { itemCode, itemName: itemName || "", qtySold: Number(qtySold || 0), lastSoldDate: formatBusyDate(lastSoldDate), lastSoldTime: lastSoldTime || "", saleAmount: Number(saleAmount || 0), cost: Number(cost || 0), profit: Number(profit || 0), profitPercent: Number(profitPercent || 0) };
    }
    const [billDate, billNo, partyName, qtySold, billTime, saleAmount, cost, profit, profitPercent] = parts;
    return { billDate: formatBusyDate(billDate), billNo, partyName: partyName || "", qtySold: Number(qtySold || 0), billTime: billTime || "", saleAmount: Number(saleAmount || 0), cost: Number(cost || 0), profit: Number(profit || 0), profitPercent: Number(profitPercent || 0) };
  });
}

function profitTotals(rows) {
  const totals = rows.reduce((acc, row) => {
    acc.saleAmount += row.saleAmount;
    acc.cost += row.cost;
    acc.profit += row.profit;
    return acc;
  }, { saleAmount: 0, cost: 0, profit: 0 });
  totals.profitPercent = totals.saleAmount ? totals.profit * 100 / totals.saleAmount : 0;
  return totals;
}

function formatBusyDate(value) {
  const [year, month, day] = String(value || "").slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : String(value || "");
}

async function busyProfitReport(mode, fromDate, toDate) {
  const rows = parseProfitRows(mode, await runBusyProfitLines(busyProfitQuery(mode, fromDate, toDate)));
  return { rows, totals: profitTotals(rows), fromDate, toDate, source: "live-busywin" };
}

function sqlText(value) {
  return String(value || "").replace(/'/g, "''");
}

function parseTabbedObjects(lines, columns) {
  return lines.map(line => {
    const parts = line.split("\t");
    return columns.reduce((row, column, index) => {
      row[column] = parts[index] ?? "";
      return row;
    }, {});
  });
}

function busyItemHistoryQuery({ productId, barcode, name }) {
  const clauses = [];
  if (productId) clauses.push(`Item.Code = ${Number(productId) || 0}`);
  if (barcode) clauses.push(`LTRIM(RTRIM(ISNULL(Item.Alias,''))) = '${sqlText(barcode)}'`);
  if (name) clauses.push(`Item.Name LIKE '%${sqlText(name)}%'`);
  const where = clauses.length ? clauses.join(" OR ") : "1 = 0";
  return `
SET NOCOUNT ON;
DECLARE @ItemCode int;
SELECT TOP 1 @ItemCode = Item.Code
FROM Master1 Item
WHERE Item.MasterType = 6 AND (${where})
ORDER BY CASE WHEN Item.Code = ${Number(productId) || 0} THEN 0 ELSE 1 END, Item.Code DESC;

SELECT
  'ITEM' + CHAR(9)
  + CONVERT(varchar(20), Item.Code) + CHAR(9)
  + REPLACE(Item.Name, CHAR(9), ' ') + CHAR(9)
  + REPLACE(ISNULL(Item.Alias,''), CHAR(9), ' ') + CHAR(9)
  + REPLACE(ISNULL(G.Name,''), CHAR(9), ' ') + CHAR(9)
  + CONVERT(varchar(40), CAST(ISNULL(Item.D2,0) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ISNULL(Item.D3,0) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(CASE WHEN ISNULL(Item.D10,0) <> 0 THEN Item.D10 ELSE Item.D3 END AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ISNULL(Item.D4,0) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ISNULL(O.OpeningQty,0) + ISNULL(M.MovementQty,0) AS decimal(18,2))) AS ReportLine
FROM Master1 Item
LEFT JOIN Master1 G ON G.Code = Item.ParentGrp
OUTER APPLY (SELECT SUM(ISNULL(T.D1,0)) AS OpeningQty FROM Tran4 T WHERE T.MasterCode1 = Item.Code) O
OUTER APPLY (SELECT SUM(ISNULL(T.Value1,0)) AS MovementQty FROM Tran2 T WHERE T.RecType = 2 AND T.MasterCode1 = Item.Code) M
WHERE Item.Code = @ItemCode;

SELECT
  'SUMMARY' + CHAR(9)
  + CONVERT(varchar(20), Item.Code) + CHAR(9)
  + CONVERT(varchar(20), COUNT(DISTINCT H.VchCode)) + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value1)) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value3)) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value1) * Item.D4) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value3)) - SUM(ABS(D.Value1) * Item.D4) AS decimal(18,2))) AS ReportLine
FROM Tran1 H
JOIN Tran2 D ON D.VchCode = H.VchCode
JOIN Master1 Item ON Item.Code = D.MasterCode1
WHERE H.VchType = 9 AND D.RecType = 2 AND Item.Code = @ItemCode
  AND ISNULL(H.VchCancelled,0) = 0 AND ISNULL(H.Cancelled,0) = 0
GROUP BY Item.Code;

SELECT TOP 80
  'SALE' + CHAR(9)
  + CONVERT(varchar(20), H.VchCode) + CHAR(9)
  + CONVERT(varchar(10), H.Date, 120) + CHAR(9)
  + LTRIM(RTRIM(H.VchNo)) + CHAR(9)
  + REPLACE(ISNULL(B.PartyName, Party.Name), CHAR(9), ' ') + CHAR(9)
  + REPLACE(ISNULL(Item.Alias,''), CHAR(9), ' ') + CHAR(9)
  + CONVERT(varchar(40), CAST(ABS(D.Value1) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(CASE WHEN ABS(D.Value1) = 0 THEN 0 ELSE ABS(D.Value3) / ABS(D.Value1) END AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ISNULL(Item.D2,0) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ABS(D.Value3) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ISNULL(Item.D4,0) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ABS(D.Value1) * ISNULL(Item.D4,0) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ABS(D.Value3) - (ABS(D.Value1) * ISNULL(Item.D4,0)) AS decimal(18,2))) AS ReportLine
FROM Tran1 H
JOIN Tran2 D ON D.VchCode = H.VchCode
JOIN Master1 Item ON Item.Code = D.MasterCode1
LEFT JOIN BillingDet B ON B.VchCode = H.VchCode
LEFT JOIN Master1 Party ON Party.Code = H.MasterCode1
WHERE H.VchType = 9 AND D.RecType = 2 AND Item.Code = @ItemCode
  AND ISNULL(H.VchCancelled,0) = 0 AND ISNULL(H.Cancelled,0) = 0
ORDER BY H.Date DESC, H.VchCode DESC, D.SrNo;

SELECT TOP 80
  'PURCHASE' + CHAR(9)
  + CONVERT(varchar(20), D.VchCode) + CHAR(9)
  + 'Stock movement' + CHAR(9)
  + CONVERT(varchar(20), D.VchCode) + CHAR(9)
  + CONVERT(varchar(10), D.Date, 120) + CHAR(9)
  + LTRIM(RTRIM(D.VchNo)) + CHAR(9)
  + '' + CHAR(9)
  + REPLACE(ISNULL(Store.Name,''), CHAR(9), ' ') + CHAR(9)
  + REPLACE(ISNULL(Item.Alias,''), CHAR(9), ' ') + CHAR(9)
  + CONVERT(varchar(40), CAST(ABS(D.Value1) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ISNULL(Item.D4,0) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(CASE WHEN ISNULL(Item.D10,0) <> 0 THEN Item.D10 ELSE Item.D3 END AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ISNULL(Item.D3,0) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ISNULL(Item.D2,0) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ABS(D.Value3) AS decimal(18,2))) + CHAR(9)
  + '0' AS ReportLine
FROM Tran2 D
JOIN Master1 Item ON Item.Code = D.MasterCode1
LEFT JOIN Master1 Store ON Store.Code = D.MasterCode2
WHERE D.RecType = 2 AND D.MasterCode1 = @ItemCode AND D.Value1 > 0
ORDER BY D.Date DESC, D.VchCode DESC;`;
}

async function busyItemHistory(params) {
  const lines = await runBusyProfitLines(busyItemHistoryQuery(params));
  const byType = { ITEM: [], SUMMARY: [], SALE: [], PURCHASE: [] };
  for (const line of lines) {
    const [type, ...rest] = line.split("\t");
    if (byType[type]) byType[type].push(rest.join("\t"));
  }
  const items = parseTabbedObjects(byType.ITEM, ["ProductID", "ProductName", "ProductBarcode", "ItemGroup", "MRP", "SalePrice", "WholesalePrice", "PurchasePrice", "CurrentStock"]);
  const summary = parseTabbedObjects(byType.SUMMARY, ["ProductID", "invoiceCount", "soldQty", "saleAmount", "costAmount", "profitAmount"]);
  const sales = parseTabbedObjects(byType.SALE, ["VchCode", "Date", "VchNo", "CustomerName", "Barcode", "Qty", "Rate", "MRP", "Amount", "PurchaseRate", "CostAmount", "ProfitAmount"]);
  const purchases = parseTabbedObjects(byType.PURCHASE, ["ProductID", "MovementType", "RowCode", "Date", "VchNo", "SupplierInvoiceNo", "PartyName", "Barcode", "Qty", "PurchasePrice", "WholesalePrice", "SalePrice", "MRP", "Amount", "CanOpen"]);
  return [items, summary, sales, purchases];
}

function busyBillQuery(vchCode) {
  const code = sqlText(vchCode);
  return `
SET NOCOUNT ON;
DECLARE @VchCode int;
SELECT TOP 1 @VchCode = H.VchCode
FROM Tran1 H
WHERE H.VchType = 9
  AND (CONVERT(varchar(20), H.VchCode) = '${code}' OR LTRIM(RTRIM(H.VchNo)) = '${code}')
ORDER BY H.Date DESC, H.VchCode DESC;

SELECT
  'HEADER' + CHAR(9)
  + CONVERT(varchar(20), H.VchCode) + CHAR(9)
  + LTRIM(RTRIM(H.VchNo)) + CHAR(9)
  + CONVERT(varchar(10), H.Date, 120) + CHAR(9)
  + REPLACE(ISNULL(B.PartyName, Party.Name), CHAR(9), ' ') + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value3)) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(0 AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value3)) AS decimal(18,2))) AS ReportLine
FROM Tran1 H
JOIN Tran2 D ON D.VchCode = H.VchCode
JOIN Master1 Item ON Item.Code = D.MasterCode1
LEFT JOIN BillingDet B ON B.VchCode = H.VchCode
LEFT JOIN Master1 Party ON Party.Code = H.MasterCode1
WHERE H.VchCode = @VchCode AND D.RecType = 2 AND Item.MasterType = 6
GROUP BY H.VchCode,H.VchNo,H.Date,ISNULL(B.PartyName, Party.Name);

SELECT
  'LINE' + CHAR(9)
  + CONVERT(varchar(20), Item.Code) + CHAR(9)
  + REPLACE(Item.Name, CHAR(9), ' ') + CHAR(9)
  + REPLACE(ISNULL(Item.Alias,''), CHAR(9), ' ') + CHAR(9)
  + REPLACE(ISNULL(G.Name,''), CHAR(9), ' ') + CHAR(9)
  + CONVERT(varchar(40), CAST(ABS(D.Value1) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(CASE WHEN ABS(D.Value1) = 0 THEN 0 ELSE ABS(D.Value3) / ABS(D.Value1) END AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ISNULL(Item.D2,0) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ABS(D.Value3) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ABS(D.Value1) * ISNULL(Item.D4,0) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ABS(D.Value3) - (ABS(D.Value1) * ISNULL(Item.D4,0)) AS decimal(18,2))) AS ReportLine
FROM Tran2 D
JOIN Master1 Item ON Item.Code = D.MasterCode1
LEFT JOIN Master1 G ON G.Code = Item.ParentGrp
WHERE D.VchCode = @VchCode AND D.RecType = 2 AND Item.MasterType = 6
ORDER BY D.SrNo;`;
}

async function busyBill(vchCode) {
  const lines = await runBusyProfitLines(busyBillQuery(vchCode));
  const byType = { HEADER: [], LINE: [] };
  for (const line of lines) {
    const [type, ...rest] = line.split("\t");
    if (byType[type]) byType[type].push(rest.join("\t"));
  }
  const headers = parseTabbedObjects(byType.HEADER, ["VchCode", "VchNo", "Date", "partyName", "VchAmtBaseCur", "FormRecAmt", "FormIssAmt"]);
  const items = parseTabbedObjects(byType.LINE, ["itemCode", "itemName", "barcode", "itemGroup", "qty", "rate", "mrp", "amount", "costAmount", "profitAmount"]);
  return [headers, items];
}

function busyPurchaseReportQuery(fromDate, toDate) {
  const dateWhere = `H.Date >= CONVERT(date, '${fromDate}') AND H.Date < CONVERT(date, '${addOneDayIso(toDate)}')`;
  return `
SET NOCOUNT ON;
SELECT
  'SUMMARY' + CHAR(9)
  + CONVERT(varchar(20), COUNT(DISTINCT H.VchCode)) + CHAR(9)
  + CONVERT(varchar(40), CAST(ISNULL(SUM(ABS(D.Value1)),0) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ISNULL(SUM(ABS(D.Value3)),0) AS decimal(18,2))) AS ReportLine
FROM Tran1 H
JOIN Tran2 D ON D.VchCode = H.VchCode
JOIN Master1 Item ON Item.Code = D.MasterCode1
WHERE H.VchType = 2
  AND D.RecType = 2
  AND Item.MasterType = 6
  AND ISNULL(H.VchCancelled,0) = 0
  AND ISNULL(H.Cancelled,0) = 0
  AND ${dateWhere};

SELECT
  'BILL' + CHAR(9)
  + CONVERT(varchar(20), H.VchCode) + CHAR(9)
  + LTRIM(RTRIM(H.VchNo)) + CHAR(9)
  + CONVERT(varchar(10), H.Date, 120) + CHAR(9)
  + REPLACE(ISNULL(B.PartyName, Party.Name), CHAR(9), ' ') + CHAR(9)
  + CONVERT(varchar(5), MAX(ISNULL(H.CreationTime,H.Date)), 108) + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value1)) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value3)) AS decimal(18,2))) AS ReportLine
FROM Tran1 H
JOIN Tran2 D ON D.VchCode = H.VchCode
JOIN Master1 Item ON Item.Code = D.MasterCode1
LEFT JOIN BillingDet B ON B.VchCode = H.VchCode
LEFT JOIN Master1 Party ON Party.Code = H.MasterCode1
WHERE H.VchType = 2
  AND D.RecType = 2
  AND Item.MasterType = 6
  AND ISNULL(H.VchCancelled,0) = 0
  AND ISNULL(H.Cancelled,0) = 0
  AND ${dateWhere}
GROUP BY H.VchCode,H.VchNo,H.Date,ISNULL(B.PartyName, Party.Name)
ORDER BY H.Date DESC,H.VchCode DESC;`;
}

async function busyPurchaseReport(fromDate, toDate) {
  const lines = await runBusyProfitLines(busyPurchaseReportQuery(fromDate, toDate));
  const byType = { SUMMARY: [], BILL: [] };
  for (const line of lines) {
    const [type, ...rest] = line.split("\t");
    if (byType[type]) byType[type].push(rest.join("\t"));
  }
  const summary = parseTabbedObjects(byType.SUMMARY, ["purchaseBillCount", "purchaseQty", "purchaseAmount"]).map(row => ({
    purchaseBillCount: Number(row.purchaseBillCount || 0),
    purchaseQty: Number(row.purchaseQty || 0),
    purchaseAmount: Number(row.purchaseAmount || 0)
  }));
  const rows = parseTabbedObjects(byType.BILL, ["VchCode", "VchNo", "Date", "partyName", "billTime", "qty", "amount"]).map(row => ({
    ...row,
    qty: Number(row.qty || 0),
    amount: Number(row.amount || 0)
  }));
  return [summary, rows];
}

function busyPurchaseBillQuery(vchCode) {
  const code = sqlText(vchCode);
  return `
SET NOCOUNT ON;
DECLARE @VchCode int;
SELECT TOP 1 @VchCode = H.VchCode
FROM Tran1 H
WHERE H.VchType = 2
  AND (CONVERT(varchar(20), H.VchCode) = '${code}' OR LTRIM(RTRIM(H.VchNo)) = '${code}')
ORDER BY H.Date DESC, H.VchCode DESC;

SELECT
  'HEADER' + CHAR(9)
  + CONVERT(varchar(20), H.VchCode) + CHAR(9)
  + LTRIM(RTRIM(H.VchNo)) + CHAR(9)
  + CONVERT(varchar(10), H.Date, 120) + CHAR(9)
  + REPLACE(ISNULL(B.PartyName, Party.Name), CHAR(9), ' ') + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value3)) AS decimal(18,2))) AS ReportLine
FROM Tran1 H
JOIN Tran2 D ON D.VchCode = H.VchCode
JOIN Master1 Item ON Item.Code = D.MasterCode1
LEFT JOIN BillingDet B ON B.VchCode = H.VchCode
LEFT JOIN Master1 Party ON Party.Code = H.MasterCode1
WHERE H.VchCode = @VchCode AND D.RecType = 2 AND Item.MasterType = 6
GROUP BY H.VchCode,H.VchNo,H.Date,ISNULL(B.PartyName, Party.Name);

SELECT
  'LINE' + CHAR(9)
  + CONVERT(varchar(20), Item.Code) + CHAR(9)
  + REPLACE(Item.Name, CHAR(9), ' ') + CHAR(9)
  + REPLACE(ISNULL(Item.Alias,''), CHAR(9), ' ') + CHAR(9)
  + REPLACE(ISNULL(G.Name,''), CHAR(9), ' ') + CHAR(9)
  + CONVERT(varchar(40), CAST(ABS(D.Value1) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(CASE WHEN ABS(D.Value1) = 0 THEN 0 ELSE ABS(D.Value3) / ABS(D.Value1) END AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ISNULL(Item.D2,0) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ABS(D.Value3) AS decimal(18,2))) AS ReportLine
FROM Tran2 D
JOIN Master1 Item ON Item.Code = D.MasterCode1
LEFT JOIN Master1 G ON G.Code = Item.ParentGrp
WHERE D.VchCode = @VchCode AND D.RecType = 2 AND Item.MasterType = 6
ORDER BY D.SrNo;`;
}

async function busyPurchaseBill(vchCode) {
  const lines = await runBusyProfitLines(busyPurchaseBillQuery(vchCode));
  const byType = { HEADER: [], LINE: [] };
  for (const line of lines) {
    const [type, ...rest] = line.split("\t");
    if (byType[type]) byType[type].push(rest.join("\t"));
  }
  const headers = parseTabbedObjects(byType.HEADER, ["VchCode", "VchNo", "Date", "partyName", "VchAmtBaseCur"]);
  const items = parseTabbedObjects(byType.LINE, ["itemCode", "itemName", "barcode", "itemGroup", "qty", "rate", "mrp", "amount"]);
  return [headers, items];
}

function busyPayablesQuery() {
  return `
SET NOCOUNT ON;
WITH Suppliers AS (
  SELECT DISTINCT H.MasterCode1 AS Code
  FROM Tran1 H
  WHERE H.VchType = 2 AND ISNULL(H.VchCancelled,0) = 0 AND ISNULL(H.Cancelled,0) = 0
),
Balances AS (
  SELECT T.MasterCode1 AS Code, SUM(ISNULL(T.Value1,0)) AS RawBalance
  FROM Tran2 T
  WHERE T.RecType = 1
  GROUP BY T.MasterCode1
)
SELECT TOP 80
  CONVERT(varchar(20), S.Code) + CHAR(9)
  + REPLACE(ISNULL(M.Name,''), CHAR(9), ' ') + CHAR(9)
  + REPLACE(ISNULL(M.Alias,''), CHAR(9), ' ') + CHAR(9)
  + CONVERT(varchar(40), CAST(ISNULL(B.RawBalance,0) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(ABS(ISNULL(B.RawBalance,0)) AS decimal(18,2))) AS ReportLine
FROM Suppliers S
JOIN Master1 M ON M.Code = S.Code
LEFT JOIN Balances B ON B.Code = S.Code
WHERE ABS(ISNULL(B.RawBalance,0)) > 0.01
ORDER BY ABS(ISNULL(B.RawBalance,0)) DESC, M.Name;`;
}

async function busyPayables() {
  const lines = await runBusyProfitLines(busyPayablesQuery());
  const rows = parseTabbedObjects(lines, ["supplierCode", "supplierName", "alias", "rawBalance", "payableAmount"]).map(row => ({
    ...row,
    rawBalance: Number(row.rawBalance || 0),
    payableAmount: Number(row.payableAmount || 0)
  }));
  const summary = {
    supplierCount: rows.length,
    payableAmount: rows.reduce((sum, row) => sum + Number(row.payableAmount || 0), 0)
  };
  return [[summary], rows];
}

function busySalesExtrasQuery(fromDate, toDate) {
  const dateWhere = `H.Date >= CONVERT(date, '${fromDate}') AND H.Date < CONVERT(date, '${addOneDayIso(toDate)}')`;
  return `
SET NOCOUNT ON;
SELECT TOP 12
  'TOPITEM' + CHAR(9)
  + CONVERT(varchar(20), Item.Code) + CHAR(9)
  + REPLACE(Item.Name, CHAR(9), ' ') + CHAR(9)
  + REPLACE(ISNULL(Item.Alias,''), CHAR(9), ' ') + CHAR(9)
  + REPLACE(ISNULL(G.Name,''), CHAR(9), ' ') + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value1)) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value3)) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value1) * ISNULL(Item.D4,0)) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value3)) - SUM(ABS(D.Value1) * ISNULL(Item.D4,0)) AS decimal(18,2))) AS ReportLine
FROM Tran1 H
JOIN Tran2 D ON D.VchCode = H.VchCode
JOIN Master1 Item ON Item.Code = D.MasterCode1
LEFT JOIN Master1 G ON G.Code = Item.ParentGrp
WHERE H.VchType = 9
  AND D.RecType = 2
  AND Item.MasterType = 6
  AND ISNULL(H.Cancelled, 0) = 0
  AND ${dateWhere}
GROUP BY Item.Code, Item.Name, Item.Alias, G.Name
ORDER BY SUM(ABS(D.Value1)) DESC, SUM(ABS(D.Value3)) DESC;

SELECT TOP 20
  'ZEROCOST' + CHAR(9)
  + CONVERT(varchar(20), H.VchCode) + CHAR(9)
  + LTRIM(RTRIM(H.VchNo)) + CHAR(9)
  + CONVERT(varchar(10), H.Date, 120) + CHAR(9)
  + REPLACE(ISNULL(B.PartyName, Party.Name), CHAR(9), ' ') + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value3)) AS decimal(18,2))) + CHAR(9)
  + CONVERT(varchar(40), CAST(SUM(ABS(D.Value1)) AS decimal(18,2))) AS ReportLine
FROM Tran1 H
JOIN Tran2 D ON D.VchCode = H.VchCode
JOIN Master1 Item ON Item.Code = D.MasterCode1
LEFT JOIN BillingDet B ON B.VchCode = H.VchCode
LEFT JOIN Master1 Party ON Party.Code = H.MasterCode1
WHERE H.VchType = 9
  AND D.RecType = 2
  AND Item.MasterType = 6
  AND ISNULL(H.Cancelled, 0) = 0
  AND ISNULL(Item.D4, 0) = 0
  AND ${dateWhere}
GROUP BY H.VchCode, H.VchNo, H.Date, ISNULL(B.PartyName, Party.Name)
ORDER BY H.Date DESC, H.VchCode DESC;`;
}

async function busySalesExtras(fromDate, toDate) {
  const lines = await runBusyProfitLines(busySalesExtrasQuery(fromDate, toDate));
  const byType = { TOPITEM: [], ZEROCOST: [] };
  for (const line of lines) {
    const [type, ...rest] = line.split("\t");
    if (byType[type]) byType[type].push(rest.join("\t"));
  }
  const topItems = parseTabbedObjects(byType.TOPITEM, ["itemCode", "itemName", "barcode", "itemGroup", "qtySold", "saleAmount", "costAmount", "profitAmount"]);
  const zeroCostBills = parseTabbedObjects(byType.ZEROCOST, ["VchCode", "VchNo", "Date", "partyName", "billAmount", "qtySold"]);
  return { topItems, zeroCostBills };
}

async function busySalesReport(fromDate, toDate) {
  const report = await busyProfitReport("bill", fromDate, toDate);
  const extras = await busySalesExtras(fromDate, toDate);
  const rows = report.rows.map(row => ({
    VchCode: row.billNo,
    VchNo: row.billNo,
    Date: normalizeDateForApi(row.billDate),
    partyName: row.partyName || "Cash",
    billAmount: row.saleAmount,
    paidAmount: 0,
    balanceAmount: row.saleAmount,
    costPrice: row.cost,
    profitAmount: row.profit,
    actualProfit: row.profit,
    billDiscount: 0,
    status: row.profit < 0 ? "Loss" : row.cost === 0 ? "Zero cost" : "Profit",
    qtySold: row.qtySold,
    billTime: row.billTime
  }));
  const cashRows = rows.filter(row => String(row.partyName || "").trim().toLowerCase() === "cash");
  const creditRows = rows.filter(row => String(row.partyName || "").trim().toLowerCase() !== "cash");
  const summary = {
    billCount: rows.length,
    billAmount: report.totals.saleAmount,
    paidAmount: 0,
    balanceAmount: report.totals.saleAmount,
    costPrice: report.totals.cost,
    profitAmount: report.totals.profit,
    actualProfit: report.totals.profit,
    qtySold: rows.reduce((sum, row) => sum + Number(row.qtySold || 0), 0),
    cashBillCount: cashRows.length,
    cashAmount: cashRows.reduce((sum, row) => sum + Number(row.billAmount || 0), 0),
    creditBillCount: creditRows.length,
    creditAmount: creditRows.reduce((sum, row) => sum + Number(row.billAmount || 0), 0),
    zeroCostBillCount: extras.zeroCostBills.length,
    zeroCostAmount: extras.zeroCostBills.reduce((sum, row) => sum + Number(row.billAmount || 0), 0)
  };
  return [[summary], rows, extras.topItems, extras.zeroCostBills];
}

function normalizeDateForApi(value) {
  const text = String(value || "");
  const m = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : text;
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

    if (url.pathname === "/api/profit/bill-wise" || url.pathname === "/api/profit/item-wise") {
      const today = todayIso();
      const fromDate = isIsoDate(url.searchParams.get("fromDate")) ? url.searchParams.get("fromDate") : today;
      const toDate = isIsoDate(url.searchParams.get("toDate")) ? url.searchParams.get("toDate") : fromDate;
      if (fromDate > toDate) return sendJson(res, 400, { error: "Invalid profit report dates" });
      const mode = url.pathname.endsWith("/item-wise") ? "item" : "bill";
      return sendJson(res, 200, await busyProfitReport(mode, fromDate, toDate));
    }

    if (url.pathname === "/api/item-history") {
      const productId = url.searchParams.get("productId") || "";
      const barcode = url.searchParams.get("barcode") || "";
      const name = url.searchParams.get("name") || "";
      if (!productId && !barcode && !name) return sendJson(res, 400, { error: "Missing item search" });
      return sendJson(res, 200, await busyItemHistory({ productId, barcode, name }));
    }

    if (url.pathname === "/api/bill") {
      const vchCode = url.searchParams.get("vchCode") || url.searchParams.get("billNo") || "";
      if (!vchCode) return sendJson(res, 400, { error: "Missing bill code" });
      return sendJson(res, 200, await busyBill(vchCode));
    }

    if (url.pathname === "/api/purchase-bill") {
      const vchCode = url.searchParams.get("vchCode") || url.searchParams.get("billNo") || url.searchParams.get("stockId") || "";
      if (!vchCode) return sendJson(res, 400, { error: "Missing purchase bill code" });
      return sendJson(res, 200, await busyPurchaseBill(vchCode));
    }

    if (url.pathname === "/api/sales-report") {
      const today = todayIso();
      const from = isIsoDate(url.searchParams.get("from")) ? url.searchParams.get("from") : today;
      const to = isIsoDate(url.searchParams.get("to")) ? url.searchParams.get("to") : from;
      if (from > to) return sendJson(res, 400, { error: "Invalid sales report dates" });
      return sendJson(res, 200, await busySalesReport(from, to));
    }

    if (url.pathname === "/api/purchase-report") {
      const today = todayIso();
      const from = isIsoDate(url.searchParams.get("from")) ? url.searchParams.get("from") : today;
      const to = isIsoDate(url.searchParams.get("to")) ? url.searchParams.get("to") : from;
      if (from > to) return sendJson(res, 400, { error: "Invalid purchase report dates" });
      return sendJson(res, 200, await busyPurchaseReport(from, to));
    }

    if (url.pathname === "/api/payables") {
      return sendJson(res, 200, await busyPayables());
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
