const SECRET_KEY = "doxtDw4GauCg87bMvnlVhpXI3W1yPqH0";
const DEFAULT_TO = "srfashionned@gmail.com";
const CUSTOMER_ID = "srfashionpsd@gmail.com";
const LIVE_API = "https://live-stock.srfashionned.in";
const RECEIVABLES_URL = "https://receivables.srfashionned.in/cache-data.json";

function doGet(e) {
  return handleOwnerEmail_(e);
}

function doPost(e) {
  return handleOwnerEmail_(e);
}

function handleOwnerEmail_(e) {
  const p = (e && e.parameter) || {};
  if (String(p.key || "") !== SECRET_KEY) {
    return json_({ ok: false, error: "Bad key" });
  }
  let from = validDate_(p.from) ? String(p.from) : validDate_(p.date) ? String(p.date) : today_();
  let toDate = validDate_(p.toDate) ? String(p.toDate) : validDate_(p.until) ? String(p.until) : from;
  if (from > toDate) {
    const swap = from;
    from = toDate;
    toDate = swap;
  }
  const to = validEmail_(p.to) ? String(p.to).trim() : DEFAULT_TO;
  const report = buildOwnerReport_(from, toDate);
  GmailApp.sendEmail(to, report.subject, report.text, {
    name: "SR Fashion Owner Report",
    htmlBody: report.html
  });
  return json_({ ok: true, to, from, toDate, subject: report.subject });
}

function buildOwnerReport_(from, toDate) {
  const period = from === toDate ? from : from + " to " + toDate;
  const sales = fetchJson_(LIVE_API + "/api/sales-report?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(toDate));
  const purchases = fetchJson_(LIVE_API + "/api/purchase-report?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(toDate));
  const payables = fetchJson_(LIVE_API + "/api/payables");
  const receivables = fetchJson_(RECEIVABLES_URL + "?t=" + Date.now());

  const s = (sales[0] || [])[0] || {};
  const topItems = (sales[2] || []).slice(0, 8);
  const ps = (purchases[0] || [])[0] || {};
  const purchaseRows = (purchases[1] || []).slice(0, 12);
  const payableSummary = (payables[0] || [])[0] || {};
  const payableRows = (payables[1] || []).slice(0, 20);
  const debtRows = receivableRows_(receivables).slice(0, 20);
  const totalReceivable = receivableRows_(receivables).reduce((sum, row) => sum + num_(row.balance), 0);

  const lines = [
    "SR Fashion Owner Report",
    "Period: " + period,
    "Customer ID: " + CUSTOMER_ID,
    "",
    "Sale / Profit",
    "Bills: " + n_(s.billCount) + " | Qty: " + n_(s.qtySold),
    "Sales: " + money_(s.billAmount) + " | Cost: " + money_(s.costPrice) + " | Profit: " + money_(s.actualProfit || s.profitAmount),
    "Cash: " + money_(s.cashAmount) + " | Credit: " + money_(s.creditAmount),
    "",
    "Top Sold Items",
    topItems.length ? topItems.map(item => "- " + (item.itemName || "Item") + ": " + n_(item.qtySold) + " qty | Sale " + money_(item.saleAmount) + " | Profit " + money_(item.profitAmount)).join("\n") : "- None",
    "",
    "Selected Period Purchases",
    "Purchase bills: " + n_(ps.purchaseBillCount) + " | Qty: " + n_(ps.purchaseQty) + " | Amount: " + money_(ps.purchaseAmount),
    purchaseRows.length ? purchaseRows.map(row => "- " + (row.VchNo || row.VchCode) + ": " + (row.partyName || "Supplier") + " | " + money_(row.amount) + " | Qty " + n_(row.qty)).join("\n") : "- No purchase bills",
    "",
    "Receivables Till Date",
    "Total receivable: " + money_(totalReceivable) + " | Parties: " + n_(debtRows.length),
    debtRows.length ? debtRows.map(row => "- " + row.name + ": " + money_(row.balance) + (row.mobile ? " | " + row.mobile : "")).join("\n") : "- No receivables",
    "",
    "Payables Till Date",
    "Total payable: " + money_(payableSummary.payableAmount) + " | Suppliers: " + n_(payableSummary.supplierCount),
    payableRows.length ? payableRows.map(row => "- " + (row.supplierName || "Supplier") + ": " + money_(row.payableAmount)).join("\n") : "- No payables"
  ].join("\n");

  return {
    subject: "SR Fashion Owner Report - " + period,
    text: lines,
    html: "<pre style=\"font-family:Arial,sans-serif;white-space:pre-wrap;line-height:1.45\">" + escapeHtml_(lines) + "</pre>"
  };
}

function fetchJson_(url) {
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) {
    throw new Error("Fetch failed: " + url + " HTTP " + res.getResponseCode());
  }
  return JSON.parse(res.getContentText());
}

function receivableRows_(cache) {
  const rows = cache.customerRows || cache.customers || [];
  return rows.map(c => ({
    name: c.customerName || c.name || "Customer",
    mobile: c.mobile || c.whatsapp || "",
    balance: num_(c.balance || c.Balance)
  })).filter(c => c.balance > 0).sort((a, b) => b.balance - a.balance);
}

function today_() {
  return Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyy-MM-dd");
}

function validEmail_(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function validDate_(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function num_(value) {
  return Number(value || 0);
}

function n_(value) {
  return Math.round(num_(value)).toLocaleString("en-IN");
}

function money_(value) {
  return "Rs " + Math.round(num_(value)).toLocaleString("en-IN");
}

function escapeHtml_(value) {
  return String(value || "").replace(/[&<>"']/g, function(ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch];
  });
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
