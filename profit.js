const qs = (s) => document.querySelector(s);
const els = {
  billWiseBtn: qs("#billWiseBtn"),
  itemWiseBtn: qs("#itemWiseBtn"),
  fromDate: qs("#fromDate"),
  toDate: qs("#toDate"),
  runBtn: qs("#runBtn"),
  csvBtn: qs("#csvBtn"),
  reportTitle: qs("#reportTitle"),
  col1: qs("#col1"),
  col2: qs("#col2"),
  col3: qs("#col3"),
  rows: qs("#rows"),
  status: qs("#status"),
  totalSales: qs("#totalSales"),
  totalCost: qs("#totalCost"),
  totalProfit: qs("#totalProfit"),
  totalMargin: qs("#totalMargin"),
  todayBtn: qs("#todayBtn"),
  detailModal: qs("#detailModal"),
  detailTitle: qs("#detailTitle"),
  detailSub: qs("#detailSub"),
  detailBody: qs("#detailBody"),
  detailClose: qs("#detailClose"),
  profitBack: qs("#profitBack"),
  profitLogout: qs("#profitLogout")
};
let mode = "bill";
let cache = null;
let currentRows = [];
init();
async function init() {
  cache = await loadCache();
  const params = new URLSearchParams(location.search);
  const requestedMode = params.get("mode");
  if (requestedMode === "item") mode = "item";
  const fallbackDate = todayIso();
  els.fromDate.value = params.get("fromDate") || fallbackDate;
  els.toDate.value = params.get("toDate") || els.fromDate.value;
  setMode(mode, false);
  els.billWiseBtn.addEventListener("click", () => setMode("bill"));
  els.itemWiseBtn.addEventListener("click", () => setMode("item"));
  els.runBtn.addEventListener("click", runReport);
  els.todayBtn.addEventListener("click", () => {
    const today = todayIso();
    els.fromDate.value = today;
    els.toDate.value = today;
    runReport();
  });
  els.csvBtn.addEventListener("click", exportCsv);
  els.rows.addEventListener("click", event => {
    const row = event.target.closest("[data-row-index]");
    if (row) openRowDetails(Number(row.dataset.rowIndex));
  });
  els.detailClose.addEventListener("click", closeDetails);
  els.profitBack.addEventListener("click", () => {
    if (!els.detailModal.hidden) return closeDetails();
    if (document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1) return history.back();
    location.href = "https://srfashionned.in/";
  });
  els.profitLogout.addEventListener("click", () => {
    sessionStorage.removeItem("sr_admin_unlocked_session");
    sessionStorage.removeItem("sr_image_upload_key");
    location.replace("https://srfashionned.in/?logout=1");
  });
  els.detailModal.addEventListener("click", event => {
    if (event.target === els.detailModal) closeDetails();
  });
  window.addEventListener("popstate", () => {
    if (!els.detailModal.hidden) closeDetails(true);
  });
  runReport();
}
async function loadCache() {
  try {
    const res = await fetch("profit-cache.json", { cache: "no-store" });
    if (res.ok) return await res.json();
  } catch (_) {}
  return { defaultFrom: todayIso(), defaultTo: todayIso(), billWise: { rows: [], totals: {} }, itemWise: { rows: [], totals: {} } };
}
async function runReport() {
  const liveUrl = `https://live-stock.srfashionned.in/api/profit/${mode === "bill" ? "bill-wise" : "item-wise"}?${new URLSearchParams({ fromDate: els.fromDate.value, toDate: els.toDate.value })}`;
  const liveController = new AbortController();
  const liveTimeout = setTimeout(() => liveController.abort(), 15000);
  try {
    els.status.textContent = "Reading live BUSYWin data...";
    const res = await fetch(liveUrl, { cache: "no-store", signal: liveController.signal });
    if (!res.ok) throw new Error("live BUSYWin server unavailable");
    const data = await res.json();
    render(data, "Live BUSY data");
  } catch (_) {
    const data = mode === "bill" ? cache.billWise : cache.itemWise;
    render(data, `Saved backup only because live BUSYWin did not answer. Backup from ${cache.savedAt ? new Date(cache.savedAt).toLocaleString("en-IN") : "upload"}`);
  } finally {
    clearTimeout(liveTimeout);
  }
}
function render(data, sourceLabel) {
  currentRows = sortRowsNewest(data.rows || []);
  renderTotals(data.totals || {});
  renderRows(currentRows);
  els.status.textContent = `${sourceLabel}. ${currentRows.length} ${mode === "bill" ? "bills" : "items"} loaded.`;
}
function renderRows(rows) {
  if (!rows.length) {
    els.rows.innerHTML = `<tr><td colspan="7" class="empty">No ${mode === "bill" ? "bills" : "items"} found.</td></tr>`;
    return;
  }
  els.rows.innerHTML = rows.map((row, index) => {
    const profitClass = row.profit < 0 ? "loss" : "profit";
    const main = mode === "bill"
      ? `Bill ${clean(row.billNo || "-")} <span>${clean(row.partyName || "Cash")}</span>`
      : `${clean(row.itemName || "-")} <span>${clean(row.itemCode || "")}</span>`;
    const when = mode === "bill"
      ? `${clean(row.billDate || "")} <span class="profit-time">${clean(row.billTime || "")}</span>`
      : `${clean(row.lastSoldDate || "")} <span class="profit-time">${clean(row.lastSoldTime || "")}</span>`;
    const qty = `Qty ${num(row.qtySold)}`;
    return `<tr class="profit-row" data-row-index="${index}"><td colspan="7">
      <div class="profit-card">
        <div class="profit-top">
          <div class="profit-title">${main}</div>
          <div class="profit-amount ${profitClass}">${money(row.profit)}</div>
        </div>
        <div class="profit-meta">
          <span>${when}</span>
          <span>${qty}</span>
          <span>Sale ${money(row.saleAmount)}</span>
          <span>Cost ${money(row.cost)}</span>
          <span class="${profitClass}">${pct(row.profitPercent)}</span>
        </div>
      </div>
    </td></tr>`;
  }).join("");
}
function renderTotals(t) {
  els.totalSales.textContent = money(t.saleAmount);
  els.totalCost.textContent = money(t.cost);
  els.totalProfit.textContent = money(t.profit);
  els.totalMargin.textContent = pct(t.profitPercent);
  els.totalProfit.className = t.profit < 0 ? "loss" : "profit";
  els.totalMargin.className = t.profit < 0 ? "loss" : "profit";
}
async function openRowDetails(index) {
  const row = currentRows[index];
  if (!row) return;
  els.detailModal.hidden = false;
  if (!history.state?.profitDetail) history.pushState({ profitDetail: true }, "", location.href);
  els.detailTitle.textContent = mode === "bill" ? `Bill ${row.billNo || "-"}` : row.itemName || "Item Ledger";
  els.detailSub.textContent = mode === "bill"
    ? `${row.billDate || ""} ${row.billTime || ""} · Qty ${num(row.qtySold)}`
    : `${row.itemCode || ""} · Qty ${num(row.qtySold)}`;
  els.detailBody.innerHTML = `<div class="detail-note">Loading live BUSY details...</div>`;
  try {
    if (mode === "bill") {
      const billLookup = row.vchCode
        ? `vchCode=${encodeURIComponent(row.vchCode)}`
        : `billNo=${encodeURIComponent(row.billNo || "")}`;
      const [headers = [], items = []] = await liveJson(`/api/bill?${billLookup}`);
      renderBillDetails(headers[0] || row, items);
    } else {
      const [items = [], summary = [], sales = []] = await liveJson(`/api/item-history?productId=${encodeURIComponent(row.itemCode || "")}`);
      renderItemLedger(items[0] || row, summary[0] || {}, sales);
    }
  } catch (error) {
    els.detailBody.innerHTML = `<div class="detail-note">Could not open live details right now. ${clean(error.message || "")}</div>`;
  }
}
async function liveJson(path) {
  const res = await fetch(`https://live-stock.srfashionned.in${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error("Live BUSY bridge did not answer");
  return res.json();
}
function renderBillDetails(header, items) {
  const totalSale = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const totalCost = items.reduce((sum, item) => sum + Number(item.costAmount || 0), 0);
  const totalProfit = items.reduce((sum, item) => sum + Number(item.profitAmount || 0), 0);
  const totalQty = items.reduce((sum, item) => sum + Number(item.qty || 0), 0);
  els.detailSub.textContent = `${clean(formatDate(header.Date) || "")} · ${clean(header.partyName || "Cash")} · ${money(header.VchAmtBaseCur)}`;
  els.detailBody.innerHTML = items.length ? `
    <div class="detail-grid summary-grid">
      <span>Items <b>${items.length}</b></span>
      <span>Qty <b>${num(totalQty)}</b></span>
      <span>Sale <b>${money(totalSale || header.VchAmtBaseCur)}</b></span>
      <span>Cost <b>${money(totalCost)}</b></span>
      <span>Profit <b>${money(totalProfit)}</b></span>
    </div>
    <div class="detail-list">
      ${items.map((item, i) => `
        <div class="detail-row">
          <div class="detail-top"><b>${i + 1}. ${clean(item.itemName)}</b><strong>${money(item.amount)}</strong></div>
          <small>${clean(item.barcode || item.itemGroup || "")}</small>
          <div class="detail-grid">
            <span>Qty <b>${num(item.qty)}</b></span>
            <span>Sold/pc <b>${money(item.rate)}</b></span>
            <span>Cost/pc <b>${unitCost(item.costAmount, item.qty)}</b></span>
            <span>Total cost <b>${money(item.costAmount)}</b></span>
            <span>Profit <b>${money(item.profitAmount)}</b></span>
          </div>
        </div>
      `).join("")}
    </div>` : `<div class="detail-note">No products found in this bill.</div>`;
}
function renderItemLedger(item, summary, sales) {
  els.detailSub.textContent = `${clean(item.ProductBarcode || "")} · Stock ${num(item.CurrentStock)} · Profit ${money(summary.profitAmount)}`;
  els.detailBody.innerHTML = `
    <div class="detail-grid summary-grid">
      <span>Sale <b>${money(item.SalePrice)}</b></span>
      <span>Purchase <b>${money(item.PurchasePrice)}</b></span>
      <span>Sold <b>${num(summary.soldQty)}</b></span>
      <span>Invoices <b>${num(summary.invoiceCount)}</b></span>
    </div>
    <div class="detail-list">
      ${sales.length ? sales.map(sale => `
        <button class="detail-row detail-button" type="button" onclick="openProfitBillFromDetail('${clean(sale.VchCode || sale.VchNo || "")}')">
          <div class="detail-top"><b>Bill ${clean(sale.VchNo || sale.VchCode)}</b><strong>${money(sale.Amount)}</strong></div>
          <small>${clean(formatDate(sale.Date))} · ${clean(sale.CustomerName || "Cash")}</small>
          <div class="detail-grid">
            <span>Qty <b>${num(sale.Qty)}</b></span>
            <span>Sold/pc <b>${money(sale.Rate)}</b></span>
            <span>Cost/pc <b>${unitCost(sale.CostAmount, sale.Qty)}</b></span>
            <span>Total cost <b>${money(sale.CostAmount)}</b></span>
            <span>Profit <b>${money(sale.ProfitAmount)}</b></span>
          </div>
        </button>
      `).join("") : `<div class="detail-note">No sale invoice found for this item.</div>`}
    </div>`;
}
function closeDetails(fromHistory = false) {
  els.detailModal.hidden = true;
  if (!fromHistory && history.state?.profitDetail) history.back();
}
async function openProfitBillFromDetail(vchCode) {
  els.detailTitle.textContent = `Bill ${vchCode || "-"}`;
  els.detailSub.textContent = "Loading live BUSY bill...";
  els.detailBody.innerHTML = `<div class="detail-note">Opening bill products...</div>`;
  try {
    const [headers = [], items = []] = await liveJson(`/api/bill?vchCode=${encodeURIComponent(vchCode || "")}`);
    renderBillDetails(headers[0] || { VchNo: vchCode }, items);
  } catch (error) {
    els.detailBody.innerHTML = `<div class="detail-note">Could not open this bill right now. ${clean(error.message || "")}</div>`;
  }
}
window.openProfitBillFromDetail = openProfitBillFromDetail;
function setMode(next, shouldRun = true) {
  mode = next;
  els.billWiseBtn.classList.toggle("active", mode === "bill");
  els.itemWiseBtn.classList.toggle("active", mode === "item");
  els.reportTitle.textContent = mode === "bill" ? "Date-wise Bills" : "Item-wise Profit / Loss";
  els.col1.textContent = mode === "bill" ? "Bill Date" : "Item Code";
  els.col2.textContent = mode === "bill" ? "Bill No" : "Item Name";
  els.col3.textContent = mode === "bill" ? "Party Name" : "Qty Sold";
  if (shouldRun) runReport();
}
function exportCsv() {
  const head = mode === "bill" ? ["Bill Date", "Time", "Bill No", "Party Name", "Qty Sold", "Sale Amount", "Cost", "Profit", "Profit %"] : ["Last Sold Date", "Time", "Item Code", "Item Name", "Qty Sold", "Sale Amount", "Cost", "Profit", "Profit %"];
  const lines = [head, ...currentRows.map(r => [...(mode === "bill" ? [r.billDate, r.billTime, r.billNo, r.partyName, r.qtySold] : [r.lastSoldDate, r.lastSoldTime, r.itemCode, r.itemName, r.qtySold]), r.saleAmount, r.cost, r.profit, r.profitPercent])];
  const blob = new Blob([lines.map(line => line.map(v => `"${String(v ?? "").replaceAll('"', '""')}"`).join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sr-fashion-${mode}-profit.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
function money(v) { return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(Number(v || 0)); }
function pct(v) { return `${Number(v || 0).toFixed(2)}%`; }
function num(v) { return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Number(v || 0)); }
function unitCost(cost, qty) {
  const q = Number(qty || 0);
  return money(q ? Number(cost || 0) / q : 0);
}
function clean(v) { return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function formatDate(value) {
  const text = String(value || "");
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : text;
}
function sortRowsNewest(rows) {
  return [...rows].sort((a, b) => rowStamp(b) - rowStamp(a));
}
function rowStamp(row) {
  const date = mode === "bill" ? row.billDate : row.lastSoldDate;
  const time = mode === "bill" ? row.billTime : row.lastSoldTime;
  const normalized = normalizeDate(date);
  const parsed = Date.parse(`${normalized}T${time || "00:00"}`);
  return Number.isFinite(parsed) ? parsed : 0;
}
function normalizeDate(value) {
  const text = String(value || "");
  const m = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : text.slice(0, 10);
}
function todayIso() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
