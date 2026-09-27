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
  const ps = (purchases[0] || [])[0] || {};
  const purchaseRows = (purchases[1] || []).slice(0, 12);
  const payableSummary = (payables[0] || [])[0] || {};
  const payableRows = (payables[1] || []).slice(0, 20);
  const debtRows = receivableRows_(receivables).slice(0, 20);
  const totalReceivable = receivableRows_(receivables).reduce((sum, row) => sum + num_(row.balance), 0);
  const profit = num_(s.actualProfit || s.profitAmount);
  const salesAmount = num_(s.billAmount);
  const margin = salesAmount ? (profit / salesAmount) * 100 : 0;

  const lines = [
    "SR Fashion Owner Report",
    "Period: " + period,
    "Customer ID: " + CUSTOMER_ID,
    "",
    "Priority 1: Sale / Profit",
    "Bills: " + n_(s.billCount) + " | Qty: " + n_(s.qtySold),
    "Sales: " + money_(s.billAmount) + " | Cost: " + money_(s.costPrice) + " | Profit: " + money_(profit) + " | Margin: " + margin.toFixed(1) + "%",
    "Cash: " + money_(s.cashAmount) + " | Credit: " + money_(s.creditAmount),
    "",
    "Priority 2: Receivables Till Date",
    "Total receivable: " + money_(totalReceivable) + " | Parties: " + n_(debtRows.length),
    debtRows.length ? debtRows.map(row => "- " + row.name + ": " + money_(row.balance) + (row.mobile ? " | " + row.mobile : "")).join("\n") : "- No receivables",
    "",
    "Priority 3: Payables Till Date",
    "Total payable: " + money_(payableSummary.payableAmount) + " | Suppliers: " + n_(payableSummary.supplierCount),
    payableRows.length ? payableRows.map(row => "- " + (row.supplierName || "Supplier") + ": " + money_(row.payableAmount)).join("\n") : "- No payables",
    "",
    "Priority 4: Purchase Bills In Selected Period",
    "Purchase bills: " + n_(ps.purchaseBillCount) + " | Qty: " + n_(ps.purchaseQty) + " | Amount: " + money_(ps.purchaseAmount),
    purchaseRows.length ? purchaseRows.map(row => "- " + (row.VchNo || row.VchCode) + ": " + (row.partyName || "Supplier") + " | " + money_(row.amount) + " | Qty " + n_(row.qty)).join("\n") : "- No purchase bills"
  ].join("\n");

  const profitColor = profit >= 0 ? "#16a34a" : "#dc2626";
  const html =
    '<div style="margin:0;padding:18px;background:#f3f4f6;font-family:Arial,sans-serif;color:#111827">' +
      '<div style="max-width:720px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e5e7eb">' +
        '<div style="background:#111827;color:#ffffff;padding:18px 20px">' +
          '<div style="font-size:12px;color:#facc15;font-weight:700;letter-spacing:.08em;text-transform:uppercase">SR Fashion Pusad</div>' +
          '<div style="font-size:24px;font-weight:900;margin-top:4px">Owner Daily Report</div>' +
          '<div style="font-size:13px;color:#d1d5db;margin-top:6px">Period: ' + escapeHtml_(period) + ' | Customer ID: ' + escapeHtml_(CUSTOMER_ID) + '</div>' +
        '</div>' +
        '<div style="padding:16px">' +
          '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:8px;margin:-8px -8px 10px -8px;width:calc(100% + 16px)"><tr>' +
            metricCard_("Sales", money_(salesAmount), "#fef3c7", "#92400e") +
            metricCard_("Profit", money_(profit), "#dcfce7", profitColor) +
          '</tr><tr>' +
            metricCard_("Cash", money_(s.cashAmount), "#e0f2fe", "#075985") +
            metricCard_("Credit", money_(s.creditAmount), "#fee2e2", "#991b1b") +
          '</tr></table>' +
          '<div style="font-size:13px;color:#4b5563;margin:4px 0 14px 0">Bills: <b>' + n_(s.billCount) + '</b> | Qty sold: <b>' + n_(s.qtySold) + '</b> | Cost: <b>' + money_(s.costPrice) + '</b> | Margin: <b style="color:' + profitColor + '">' + margin.toFixed(1) + '%</b></div>' +
          sectionHtml_("1. Money To Collect", "Receivables till date", money_(totalReceivable) + " from " + n_(debtRows.length) + " parties", "#fff7ed", "#c2410c", receivableRowsHtml_(debtRows)) +
          sectionHtml_("2. Money To Pay", "Supplier payables till date", money_(payableSummary.payableAmount) + " to " + n_(payableSummary.supplierCount) + " suppliers", "#fef2f2", "#b91c1c", payableRowsHtml_(payableRows)) +
          sectionHtml_("3. Purchase Bills", "Selected period purchase entry", n_(ps.purchaseBillCount) + " bills | " + money_(ps.purchaseAmount), "#eff6ff", "#1d4ed8", purchaseRowsHtml_(purchaseRows)) +
          '<div style="margin-top:14px;padding:12px;border-radius:12px;background:#f9fafb;color:#6b7280;font-size:12px;line-height:1.5">This mail is generated automatically from SR Fashion live reports. Top-sold/most-sold items are intentionally hidden to keep the owner report focused on money movement.</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  return {
    subject: "SR Fashion Owner Report - " + period,
    text: lines,
    html: html
  };
}

function metricCard_(label, value, bg, color) {
  return '<td width="50%" style="background:' + bg + ';border-radius:14px;padding:14px;vertical-align:top">' +
    '<div style="font-size:11px;color:#6b7280;font-weight:700;text-transform:uppercase">' + escapeHtml_(label) + '</div>' +
    '<div style="font-size:24px;font-weight:900;color:' + color + ';margin-top:4px">' + escapeHtml_(value) + '</div>' +
  '</td>';
}

function sectionHtml_(title, sub, total, bg, color, rowsHtml) {
  return '<div style="margin-top:12px;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">' +
    '<div style="background:' + bg + ';padding:12px 14px">' +
      '<div style="font-size:15px;font-weight:900;color:' + color + '">' + escapeHtml_(title) + '</div>' +
      '<div style="font-size:12px;color:#4b5563;margin-top:2px">' + escapeHtml_(sub) + '</div>' +
      '<div style="font-size:18px;font-weight:900;color:#111827;margin-top:6px">' + escapeHtml_(total) + '</div>' +
    '</div>' +
    '<div style="padding:8px 12px">' + rowsHtml + '</div>' +
  '</div>';
}

function receivableRowsHtml_(rows) {
  if (!rows.length) return '<div style="font-size:13px;color:#6b7280;padding:8px 0">No receivables.</div>';
  return rows.slice(0, 12).map(function(row) {
    return rowHtml_(row.name, money_(row.balance), row.mobile || "Customer balance");
  }).join("");
}

function payableRowsHtml_(rows) {
  if (!rows.length) return '<div style="font-size:13px;color:#6b7280;padding:8px 0">No payables.</div>';
  return rows.slice(0, 12).map(function(row) {
    return rowHtml_(row.supplierName || "Supplier", money_(row.payableAmount), "BUSY balance " + money_(row.rawBalance));
  }).join("");
}

function purchaseRowsHtml_(rows) {
  if (!rows.length) return '<div style="font-size:13px;color:#6b7280;padding:8px 0">No purchase bills in selected period.</div>';
  return rows.slice(0, 12).map(function(row) {
    return rowHtml_("Bill " + (row.VchNo || row.VchCode), money_(row.amount), (row.partyName || "Supplier") + " | Qty " + n_(row.qty));
  }).join("");
}

function rowHtml_(left, right, sub) {
  return '<div style="border-bottom:1px solid #f3f4f6;padding:9px 0">' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>' +
      '<td style="font-size:13px;font-weight:800;color:#111827">' + escapeHtml_(left) + '<div style="font-size:11px;font-weight:400;color:#6b7280;margin-top:2px">' + escapeHtml_(sub) + '</div></td>' +
      '<td style="font-size:13px;font-weight:900;color:#111827;text-align:right;white-space:nowrap">' + escapeHtml_(right) + '</td>' +
    '</tr></table>' +
  '</div>';
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
