import fs from "node:fs";
import path from "node:path";

const API = process.env.RECEIVABLES_API || "http://127.0.0.1:3020";
const OUT = path.resolve("E:/New Website/receivables/cache-data.json");

async function getJson(route) {
  const res = await fetch(`${API}${route}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${route} failed: ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${route} returned non-data response: ${text.slice(0, 60)}`);
  }
}

function inputDate(value) {
  if (!value) return "";
  const text = String(value);
  const msMatch = text.match(/\/Date\((-?\d+)\)\//);
  const d = msMatch ? new Date(Number(msMatch[1])) : new Date(text);
  if (Number.isNaN(d.getTime())) return "";
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function salesKey(from, to) {
  return `${from || ""}_${to || ""}`;
}

async function main() {
  const [[kpiRows, trendRows], [customerRows]] = await Promise.all([
    getJson("/api/kpis"),
    getJson("/api/customers")
  ]);

  const profileByCode = {};
  for (const customer of customerRows) {
    const code = customer.customerCode;
    if (!code) continue;
    try {
      profileByCode[String(code)] = await getJson(`/api/customer?code=${encodeURIComponent(code)}`);
    } catch (error) {
      profileByCode[String(code)] = null;
      console.warn(`Skipped customer ${code}: ${error.message}`);
    }
  }

  const now = new Date();
  const today = inputDate(now);
  const monthStart = inputDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const monthEnd = inputDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  const yearStart = inputDate(new Date(now.getFullYear(), 0, 1));
  const salesRanges = [
    ["today", today, today],
    ["month", monthStart, monthEnd],
    ["year", yearStart, today]
  ];

  const salesReports = {};
  for (const [label, from, to] of salesRanges) {
    const [summary, rows] = await getJson(`/api/sales-report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const report = { label, from, to, summary: summary?.[0] || {}, rows: rows || [] };
    salesReports[label] = report;
    salesReports[salesKey(from, to)] = report;
  }

  const payload = {
    savedAt: new Date().toISOString(),
    source: "retail-daddy-hostinger-full-snapshot",
    kpiRows,
    trendRows,
    customerRows,
    profileByCode,
    salesReports,
    billByCode: {}
  };
  fs.writeFileSync(OUT, JSON.stringify(payload));
  console.log(JSON.stringify({
    out: OUT,
    customers: customerRows.length,
    profiles: Object.keys(profileByCode).length,
    salesReports: Object.keys(salesReports).length,
    bills: 0,
    bytes: fs.statSync(OUT).size
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
