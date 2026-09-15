const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = __dirname;
const OUT = path.join(ROOT, "item-ledgers-cache.json");
const QUERY_HELPER = path.join(
  process.env.USERPROFILE || "C:\\Users\\SR",
  ".codex",
  ".chatgpt-projects",
  "g-p-6a8c4962894c819191deb060ee3df29f",
  "retail-daddy-customers",
  "sql",
  "readonly-query.ps1"
);
const DATABASE = process.env.RETAIL_DADDY_DATABASE || "Raintech_DB3";

const query = `
SELECT
  P.PID AS ProductID,
  LTRIM(RTRIM(ISNULL(P.ProductCode,''))) AS ProductCode,
  LTRIM(RTRIM(ISNULL(P.ProductName,''))) AS ProductName,
  LTRIM(RTRIM(ISNULL(P.Barcode,''))) AS ProductBarcode,
  LTRIM(RTRIM(ISNULL(S.Category,''))) AS ItemGroup,
  ISNULL(P.MRP,0) AS MRP,
  ISNULL(P.SellingPrice,0) AS SalePrice,
  ISNULL((SELECT TOP 1 O.WSalePrice FROM dbo.Product_OpeningStock O WHERE O.ProductID=P.PID ORDER BY O.ID DESC),0) AS WholesalePrice,
  ISNULL((SELECT TOP 1 O.PPrice FROM dbo.Product_OpeningStock O WHERE O.ProductID=P.PID ORDER BY O.ID DESC),ISNULL(P.CostPrice,0)) AS PurchasePrice,
  ISNULL(P.OpeningStock,0) AS OpeningStock,
  ISNULL((SELECT SUM(ISNULL(SP.Qty,0)) FROM dbo.Stock_Product SP WHERE SP.ProductID=P.PID),0) AS CurrentStock
FROM dbo.Product P
LEFT JOIN dbo.SubCategory S ON S.ID=P.SubCategoryID;

SELECT
  IP.ProductID,
  COUNT(DISTINCT I.Inv_ID) AS invoiceCount,
  SUM(ISNULL(IP.Qty,0)) AS soldQty,
  SUM(ISNULL(IP.TotalAmount,0)) AS saleAmount,
  SUM(ISNULL(IP.PurchaseRate,0) * ISNULL(IP.Qty,0)) AS costAmount,
  SUM(ISNULL(IP.TotalAmount,0)) - SUM(ISNULL(IP.PurchaseRate,0) * ISNULL(IP.Qty,0)) AS profitAmount,
  AVG(NULLIF(IP.SalesRate,0)) AS averageRate,
  MAX(I.InvoiceDate) AS lastSold
FROM dbo.Invoice_Product IP
JOIN dbo.InvoiceInfo I ON I.Inv_ID=IP.InvoiceID
GROUP BY IP.ProductID;

WITH Sales AS (
  SELECT
    IP.ProductID,
    I.Inv_ID AS VchCode,
    I.InvoiceDate AS Date,
    I.InvoiceNo AS VchNo,
    LTRIM(RTRIM(ISNULL(C.Name,'Cash'))) AS CustomerName,
    LTRIM(RTRIM(ISNULL(IP.Barcode,''))) AS Barcode,
    ISNULL(IP.Qty,0) AS Qty,
    ISNULL(IP.SalesRate,0) AS Rate,
    ISNULL(IP.MRP,0) AS MRP,
    ISNULL(IP.TotalAmount,0) AS Amount,
    ISNULL(IP.PurchaseRate,0) AS PurchaseRate,
    ISNULL(IP.PurchaseRate,0) * ISNULL(IP.Qty,0) AS CostAmount,
    ISNULL(IP.TotalAmount,0) - (ISNULL(IP.PurchaseRate,0) * ISNULL(IP.Qty,0)) AS ProfitAmount,
    ROW_NUMBER() OVER (PARTITION BY IP.ProductID ORDER BY I.InvoiceDate DESC, I.Inv_ID DESC) AS rn
  FROM dbo.Invoice_Product IP
  JOIN dbo.InvoiceInfo I ON I.Inv_ID=IP.InvoiceID
  LEFT JOIN dbo.Customer C ON C.ID=I.Customer_ID
)
SELECT * FROM Sales WHERE rn <= 80;

WITH Purchases AS (
  SELECT
    SP.ProductID,
    'Purchase invoice' AS MovementType,
    S.ST_ID AS RowCode,
    S.Date AS Date,
    LTRIM(RTRIM(ISNULL(S.InvoiceNo,''))) AS VchNo,
    LTRIM(RTRIM(ISNULL(S.SupplierInvoiceNo,''))) AS SupplierInvoiceNo,
    LTRIM(RTRIM(ISNULL(SU.Name,''))) AS PartyName,
    LTRIM(RTRIM(ISNULL(SP.Barcode,''))) AS Barcode,
    ISNULL(SP.Qty,0) AS Qty,
    ISNULL(SP.Price,0) AS PurchasePrice,
    ISNULL(SP.WPrice,0) AS WholesalePrice,
    ISNULL(SP.RPrice,0) AS SalePrice,
    ISNULL(SP.MRP,0) AS MRP,
    ISNULL(SP.TotalAmount,0) AS Amount,
    1 AS CanOpen,
    ROW_NUMBER() OVER (PARTITION BY SP.ProductID ORDER BY S.Date DESC, S.ST_ID DESC) AS rn
  FROM dbo.Stock_Product SP
  JOIN dbo.Stock S ON S.ST_ID=SP.StockID
  LEFT JOIN dbo.Supplier SU ON SU.ID=S.SupplierID
)
SELECT * FROM Purchases WHERE rn <= 80;
`;

const queryFile = path.join(os.tmpdir(), `sr-item-ledgers-${Date.now()}.sql`);
fs.writeFileSync(queryFile, query, "utf8");
const result = spawnSync("powershell.exe", [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  QUERY_HELPER,
  "-Database",
  DATABASE,
  "-QueryFile",
  queryFile
], { encoding: "utf8", maxBuffer: 1024 * 1024 * 120, windowsHide: true });
fs.rmSync(queryFile, { force: true });
if (result.status !== 0) {
  throw new Error(result.stderr || result.stdout || `SQL export failed with ${result.status}`);
}

function table(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.value)) return value.value;
  if (value && typeof value === "object" && "ProductID" in value) return [value];
  return [];
}
const parsed = JSON.parse(result.stdout || "[]");
const tables = Array.isArray(parsed) ? parsed : [parsed];
const [productsRaw = [], summariesRaw = [], salesRaw = [], purchasesRaw = []] = tables;
const products = table(productsRaw);
const summaries = table(summariesRaw);
const sales = table(salesRaw);
const purchases = table(purchasesRaw);
const byProduct = {};
for (const product of products) {
  const id = String(product.ProductID || "");
  if (!id) continue;
  byProduct[id] = [[product], [], [], []];
}
for (const row of summaries) {
  const id = String(row.ProductID || "");
  if (byProduct[id]) byProduct[id][1].push(row);
}
for (const row of sales) {
  const id = String(row.ProductID || "");
  if (byProduct[id]) byProduct[id][2].push(row);
}
for (const row of purchases) {
  const id = String(row.ProductID || "");
  if (byProduct[id]) byProduct[id][3].push(row);
}

const payload = {
  savedAt: new Date().toISOString(),
  source: "retail-daddy-item-ledger-cache",
  products: Object.keys(byProduct).length,
  ledgers: byProduct
};
fs.writeFileSync(OUT, JSON.stringify(payload), "utf8");
console.log(JSON.stringify({
  savedAt: payload.savedAt,
  products: payload.products,
  size: fs.statSync(OUT).size
}, null, 2));
