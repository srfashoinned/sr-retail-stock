const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const OUT = path.join(ROOT, "items.json");
const PREVIOUS = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : [];

const sqlServer = process.env.BUSY_SQL_SERVER || ".";
const sqlDatabase = process.env.BUSY_SQL_DATABASE || "BusyComp0004_db12026";

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function num(value) {
  const n = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function dateOnly(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function key(value) {
  return clean(value).toLowerCase();
}

const previousByBarcode = new Map();
const previousByName = new Map();
for (const item of PREVIOUS) {
  if (item.barcode) previousByBarcode.set(key(item.barcode), item);
  if (item.name) previousByName.set(key(item.name), item);
}

function previousMatch(row) {
  return previousByBarcode.get(key(row.Barcode)) || previousByName.get(key(row.ProductName)) || null;
}

function runBusyQuery() {
  const query = `
SET NOCOUNT ON;
SELECT
  CONVERT(varchar(20), I.Code) AS ProductID,
  REPLACE(REPLACE(REPLACE(LTRIM(RTRIM(ISNULL(I.Name,''))), '|', ' '), CHAR(13), ' '), CHAR(10), ' ') AS ProductName,
  REPLACE(REPLACE(REPLACE(LTRIM(RTRIM(ISNULL(I.Alias,''))), '|', ' '), CHAR(13), ' '), CHAR(10), ' ') AS Barcode,
  REPLACE(REPLACE(REPLACE(LTRIM(RTRIM(ISNULL(G.Name,''))), '|', ' '), CHAR(13), ' '), CHAR(10), ' ') AS ItemGroup,
  CAST(ISNULL(I.D2,0) AS decimal(18,2)) AS MRP,
  CAST(ISNULL(I.D3,0) AS decimal(18,2)) AS SalePrice,
  CAST(ISNULL(I.D3,0) AS decimal(18,2)) AS WholesalePrice,
  CAST(ISNULL(I.D4,0) AS decimal(18,2)) AS PurchasePrice,
  CAST(ISNULL(M.MovementQty,0) AS decimal(18,3)) AS StockQty,
  CONVERT(varchar(10), NULLIF(I.CreationTime, CONVERT(datetime,'19000101')), 120) AS EntryDate
FROM Master1 I
LEFT JOIN Master1 G ON G.Code = I.ParentGrp
OUTER APPLY (
  SELECT SUM(ISNULL(T.Value1,0)) AS MovementQty
  FROM Tran2 T
  WHERE T.RecType = 2
    AND T.MasterCode1 = I.Code
) M
WHERE I.MasterType = 6
ORDER BY I.Code DESC;
`;
  const stdout = execFileSync("sqlcmd", [
    "-S", sqlServer,
    "-E",
    "-d", sqlDatabase,
    "-W",
    "-s", "|",
    "-w", "65535",
    "-Q", query
  ], { encoding: "utf8", maxBuffer: 80 * 1024 * 1024 });

  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const headerIndex = lines.findIndex(line => line.startsWith("ProductID|"));
  if (headerIndex < 0) throw new Error("BUSYWin stock query returned no header.");
  const headers = lines[headerIndex].split("|").map(clean);
  const rows = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (line.startsWith("(") || line.includes("rows affected")) continue;
    const parts = line.split("|");
    if (parts.length < headers.length) continue;
    const row = {};
    headers.forEach((name, index) => { row[name] = clean(parts[index]); });
    rows.push(row);
  }
  return rows;
}

function mapItem(row) {
  const old = previousMatch(row);
  const group = clean(row.ItemGroup) || "GENERAL";
  return {
    ProductID: num(row.ProductID),
    name: clean(row.ProductName),
    alias: old?.alias || `B-${clean(row.ProductID)}`,
    barcode: clean(row.Barcode),
    group,
    Category: group,
    SubCategory: group,
    PartGroup: group,
    mrp: num(row.MRP),
    sale: num(row.SalePrice),
    wholesale: num(row.WholesalePrice),
    purchase: num(row.PurchasePrice),
    size: old?.size || "",
    colour: old?.colour || "",
    stock: num(row.StockQty),
    entryDate: dateOnly(row.EntryDate) || old?.entryDate || ""
  };
}

function main() {
  console.log("");
  console.log("==========================================");
  console.log("   SR FASHION - BUSYWIN STOCK EXPORT");
  console.log("==========================================");
  console.log(`Database: ${sqlDatabase}`);

  const rows = runBusyQuery();
  const items = rows.map(mapItem).filter(item => item.name);
  fs.writeFileSync(OUT, JSON.stringify(items, null, 2), "utf8");

  const inStock = items.filter(item => Number(item.stock || 0) > 0).length;
  console.log(`BUSYWin items exported: ${items.length}`);
  console.log(`Items in stock: ${inStock}`);
  console.log(`Written: ${OUT}`);
}

main();
