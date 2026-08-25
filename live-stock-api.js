const http = require("http");
const fs = require("fs");
const path = require("path");
const sql = require("mssql");

const ROOT = __dirname;
const PORT = Number(process.env.STOCK_API_PORT || 3030);
const CACHE_FILE = path.join(ROOT, "items.json");
const config = require("./config.json");

let memoryCache = {
  items: null,
  updatedAt: null,
  loading: null
};

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, payload, cache = "no-store") {
  cors(res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cache
  });
  res.end(JSON.stringify(payload));
}

function loadFileCache() {
  if (!fs.existsSync(CACHE_FILE)) return [];
  return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
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
      stock: availableQty,
      entryDate: normalizeDate(item.EntryDate)
    };
  }).filter(product => product.ProductID || product.name || product.alias || product.barcode);

  fs.writeFileSync(CACHE_FILE, JSON.stringify(products, null, 2), "utf8");
  memoryCache = { items: products, updatedAt: new Date().toISOString(), loading: null };
  return products;
}

async function getStock() {
  if (memoryCache.loading) return memoryCache.loading;
  memoryCache.loading = fetchLiveStock().finally(() => {
    memoryCache.loading = null;
  });
  return memoryCache.loading;
}

const server = http.createServer(async (req, res) => {
  try {
    cors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        updatedAt: memoryCache.updatedAt,
        cachedItems: memoryCache.items?.length || loadFileCache().length
      });
    }

    if (url.pathname === "/api/items") {
      try {
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

server.listen(PORT, () => {
  console.log(`SR Fashion live stock API running on http://localhost:${PORT}`);
});
