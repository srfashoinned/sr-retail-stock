const state = {
  customers: [],
  profile: null,
  activeTab: "ledger",
  ledgerQuery: "",
  ledgerFrom: "",
  ledgerTo: "",
  itemQuery: "",
  customerSort: { key: "balance", dir: "desc" },
  tabSort: {},
  lastView: "dashboard",
  viewStack: [],
  soundOn: true,
  alertedToday: false,
  whatsappCustomer: null,
  whatsappApp: "business",
  reminderTone: "soft",
  currentBill: null,
  touchStartY: 0,
  pulling: false,
  cashPeriod: "",
  salesReport: null,
  kpiRows: [],
  trendRows: [],
  customerVisibleLimit: 35
};

const isFileMode = window.location.protocol === "file:";
const DASHBOARD_CACHE_KEY = "retailDaddyLastDashboardCache";
const FOLLOWUP_KEY = "retailDaddyFollowupsV1";
const NAV_KEY = "retailDaddyResumeNavV2";
let restoringNavigation = false;
const qs = selector => document.querySelector(selector);
const qsa = selector => [...document.querySelectorAll(selector)];

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value);
  const msMatch = text.match(/\/Date\((-?\d+)\)\//);
  const d = msMatch ? new Date(Number(msMatch[1])) : new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function date(value) {
  const d = parseDate(value);
  return d ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "-";
}

function inputDate(value) {
  const d = parseDate(value);
  if (!d) return "";
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function inRange(value, from, to) {
  const day = inputDate(value);
  if (!day) return !from && !to;
  return (!from || day >= from) && (!to || day <= to);
}

function clean(value = "") {
  return String(value || "").trim();
}

function amount(value) {
  return Number(value || 0);
}

function money(value) {
  const n = amount(value);
  const label = Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  if (n > 0) return `<span class="money dr">Rs ${label} Dr</span>`;
  if (n < 0) return `<span class="money cr">Rs ${label} Cr</span>`;
  return `<span class="money">Rs 0</span>`;
}

function plainMoney(value) {
  const n = amount(value);
  const suffix = n > 0 ? " Dr" : n < 0 ? " Cr" : "";
  return `Rs ${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}${suffix}`;
}

function rupees(value) {
  return `Rs ${amount(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function plainRupees(value) {
  return `Rs ${Math.abs(amount(value)).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function phoneForWhatsApp(value) {
  const phone = String(value || "").replace(/\D/g, "");
  if (!phone) return "";
  return phone.startsWith("91") ? phone : `91${phone}`;
}

function smsUrl(phone, text) {
  const message = encodeURIComponent(text);
  const separator = /iPhone|iPad|iPod/i.test(navigator.userAgent || "") ? "&" : "?";
  return `sms:+${phone}${separator}body=${message}`;
}

function whatsappUrl(phone, text, app = state.whatsappApp) {
  const message = encodeURIComponent(text);
  const android = /Android/i.test(navigator.userAgent || "");
  if (android) {
    const packageName = app === "business" ? "com.whatsapp.w4b" : "com.whatsapp";
    return `intent://send?phone=${phone}&text=${message}#Intent;scheme=whatsapp;package=${packageName};end`;
  }
  return `https://wa.me/${phone}?text=${message}`;
}

function setWhatsappApp(app) {
  state.whatsappApp = app === "standard" ? "standard" : "business";
  qs("#waAppBusiness")?.classList.toggle("active", state.whatsappApp === "business");
  qs("#waAppStandard")?.classList.toggle("active", state.whatsappApp === "standard");
}

function setReminderTone(tone) {
  state.reminderTone = ["soft", "medium", "strong"].includes(tone) ? tone : "soft";
  qs("#waToneSoft")?.classList.toggle("active", state.reminderTone === "soft");
  qs("#waToneMedium")?.classList.toggle("active", state.reminderTone === "medium");
  qs("#waToneStrong")?.classList.toggle("active", state.reminderTone === "strong");
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || isFileMode) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error((await res.json()).error || "Request failed");
  return res.json();
}

function readLocalDashboardCache() {
  try {
    return JSON.parse(localStorage.getItem(DASHBOARD_CACHE_KEY) || "null");
  } catch (_) {
    return null;
  }
}

function saveLocalDashboardCache(partial) {
  const current = readLocalDashboardCache() || {};
  const next = { ...current, ...partial, savedAt: new Date().toISOString(), source: "browser-cache" };
  localStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify(next));
}

function followups() {
  try { return JSON.parse(localStorage.getItem(FOLLOWUP_KEY) || "{}"); } catch (_) { return {}; }
}

function saveFollowups(data) {
  localStorage.setItem(FOLLOWUP_KEY, JSON.stringify(data));
}

function customerFollowup(code) {
  return followups()[String(code)] || {};
}

function setCustomerFollowup(code, patch) {
  const all = followups();
  const key = String(code);
  all[key] = { ...(all[key] || {}), ...patch, updatedAt: new Date().toISOString() };
  saveFollowups(all);
}

function markWhatsAppSent(customer) {
  if (!customer?.customerCode) return;
  const cur = customerFollowup(customer.customerCode);
  setCustomerFollowup(customer.customerCode, {
    lastWhatsAppAt: new Date().toISOString(),
    whatsappCount: amount(cur.whatsappCount) + 1,
    lastTone: state.reminderTone
  });
}

function markSmsSent(customer) {
  if (!customer?.customerCode) return;
  const cur = customerFollowup(customer.customerCode);
  setCustomerFollowup(customer.customerCode, {
    lastSmsAt: new Date().toISOString(),
    smsCount: amount(cur.smsCount) + 1,
    lastSmsFrom: "7588756668",
    lastTone: state.reminderTone
  });
}

async function readDashboardCache() {
  try {
    const res = await fetch(`/cache-data.json?t=${Date.now()}`, { cache: "no-store" });
    if (res.ok) return await res.json();
  } catch (_) {}
  return readLocalDashboardCache();
}

function updateBackButton() {
  const back = qs("#appBack");
  if (!back) return;
  const hasOverlay = !qs("#billModal")?.hidden || !qs("#whatsappModal")?.hidden || document.body.classList.contains("sidebar-open");
  back.hidden = !hasOverlay && state.lastView === "dashboard";
}

function saveNavigation(extra = {}) {
  try {
    const profileCode = state.profile?.summary?.customerCode || "";
    localStorage.setItem(NAV_KEY, JSON.stringify({
      view: state.lastView,
      profileCode,
      activeTab: state.activeTab,
      ledgerQuery: state.ledgerQuery,
      itemQuery: state.itemQuery,
      ledgerFrom: state.ledgerFrom,
      ledgerTo: state.ledgerTo,
      customerFilters: {
        search: qs("#searchBox")?.value || "",
        status: qs("#statusFilter")?.value || "all",
        from: qs("#customerFrom")?.value || "",
        to: qs("#customerTo")?.value || "",
        min: qs("#minBalance")?.value || ""
      },
      salesReport: state.salesReport ? {
        period: state.salesReport.period,
        from: state.salesReport.from,
        to: state.salesReport.to
      } : null,
      ...extra,
      savedAt: new Date().toISOString()
    }));
  } catch (_) {}
}

function pushBrowserNavigation(extra = {}) {
  if (restoringNavigation) return;
  try {
    const payload = {
      srReceivables: true,
      view: state.lastView,
      profileCode: state.profile?.summary?.customerCode || "",
      activeTab: state.activeTab,
      modal: extra.modal || "",
      salesReport: state.salesReport ? {
        period: state.salesReport.period,
        from: state.salesReport.from,
        to: state.salesReport.to
      } : null
    };
    if (!history.state?.srReceivables) history.replaceState({ srReceivables: true, view: "dashboard" }, "", location.href);
    history.pushState(payload, "", location.href);
  } catch (_) {}
}

function showView(id, push = true) {
  if (push && state.lastView && state.lastView !== id) {
    state.viewStack.push(state.lastView);
    state.viewStack = state.viewStack.slice(-12);
  }
  state.lastView = id;
  qsa(".view").forEach(el => el.classList.toggle("active", el.id === id));
  qsa(".nav-btn").forEach(el => el.classList.toggle("active", el.dataset.view === id));
  document.body.classList.remove("sidebar-open");
  qs("#sidebarShade").hidden = true;
  updateBackButton();
  saveNavigation();
  if (push) pushBrowserNavigation();
  tapSound();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function goAppBack(useBrowser = true) {
  if (!qs("#billModal")?.hidden) {
    qs("#billModal").hidden = true;
    updateBackButton();
    return;
  }
  if (!qs("#whatsappModal")?.hidden) {
    qs("#whatsappModal").hidden = true;
    updateBackButton();
    return;
  }
  if (document.body.classList.contains("sidebar-open")) {
    closeMenu();
    return;
  }
  if (useBrowser && history.state?.srReceivables && state.viewStack.length > 0) {
    history.back();
    return;
  }
  const previous = state.viewStack.pop() || "dashboard";
  showView(previous, false);
}

function openMenu() {
  document.body.classList.add("sidebar-open");
  qs("#sidebarShade").hidden = false;
  updateBackButton();
  tapSound();
}

function closeMenu() {
  document.body.classList.remove("sidebar-open");
  qs("#sidebarShade").hidden = true;
  updateBackButton();
  tapSound();
}

function applyCustomerFilters(filters = {}) {
  if (qs("#searchBox")) qs("#searchBox").value = filters.search || "";
  if (qs("#statusFilter")) qs("#statusFilter").value = filters.status || "all";
  if (qs("#customerFrom")) qs("#customerFrom").value = filters.from || "";
  if (qs("#customerTo")) qs("#customerTo").value = filters.to || "";
  if (qs("#minBalance")) qs("#minBalance").value = filters.min || "";
  renderCustomers();
}

async function restoreSavedNavigation() {
  if (restoringNavigation) return;
  const forceHome = new URLSearchParams(location.search).get("home") === "1";
  if (forceHome) {
    try { localStorage.removeItem(NAV_KEY); } catch (_) {}
    state.viewStack = [];
    showView("dashboard", false);
    try {
      const clean = new URL(location.href);
      clean.searchParams.delete("home");
      history.replaceState({ srReceivables: true, view: "dashboard" }, "", clean.pathname + clean.search + clean.hash);
    } catch (_) {}
    updateBackButton();
    return;
  }
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(NAV_KEY) || "null"); } catch (_) {}
  if (!saved) {
    try { history.replaceState({ srReceivables: true, view: "dashboard" }, "", location.href); } catch (_) {}
    return;
  }
  restoringNavigation = true;
  try {
    if (saved.customerFilters) applyCustomerFilters(saved.customerFilters);
    if (saved.salesReport?.period) {
      if (saved.salesReport.period === "day" && saved.salesReport.from) qs("#cashDayDate").value = saved.salesReport.from;
      if (saved.salesReport.period === "month" && saved.salesReport.from) {
        qs("#cashMonthFrom").value = String(saved.salesReport.from).slice(0, 7);
        qs("#cashMonthTo").value = String(saved.salesReport.to || saved.salesReport.from).slice(0, 7);
      }
      await openCashParty(saved.salesReport.period);
    } else if (saved.view === "profile" && saved.profileCode) {
      await openCustomer(saved.profileCode);
      state.activeTab = saved.activeTab || "ledger";
      state.ledgerQuery = saved.ledgerQuery || "";
      state.itemQuery = saved.itemQuery || "";
      state.ledgerFrom = saved.ledgerFrom || state.ledgerFrom;
      state.ledgerTo = saved.ledgerTo || state.ledgerTo;
      if (qs("#ledgerSearch")) qs("#ledgerSearch").value = state.ledgerQuery;
      if (qs("#ledgerFrom")) qs("#ledgerFrom").value = state.ledgerFrom;
      if (qs("#ledgerTo")) qs("#ledgerTo").value = state.ledgerTo;
      renderProfile();
    } else if (saved.view === "customers") {
      showView("customers", false);
    } else {
      showView("dashboard", false);
    }
    try { history.replaceState({ srReceivables: true, view: state.lastView, profileCode: state.profile?.summary?.customerCode || "", activeTab: state.activeTab }, "", location.href); } catch (_) {}
  } catch (_) {
    showView("dashboard", false);
  } finally {
    restoringNavigation = false;
    updateBackButton();
  }
}

window.addEventListener("popstate", event => {
  restoringNavigation = true;
  try {
    if (!qs("#billModal")?.hidden) qs("#billModal").hidden = true;
    if (!qs("#whatsappModal")?.hidden) qs("#whatsappModal").hidden = true;
    if (document.body.classList.contains("sidebar-open")) closeMenu();
    const view = event.state?.view || state.viewStack.pop() || "dashboard";
    if (view === "profile" && event.state?.profileCode) {
      openCustomer(event.state.profileCode).finally(() => {
        restoringNavigation = false;
        updateBackButton();
      });
      return;
    }
    showView(view, false);
  } finally {
    if (restoringNavigation) restoringNavigation = false;
    updateBackButton();
  }
});

function applyTheme() {
  if (localStorage.getItem("retailDaddyUiVersion") !== "10") {
    localStorage.setItem("retailDaddyTheme", "dark");
    localStorage.setItem("retailDaddyUiVersion", "10");
  }
  const theme = localStorage.getItem("retailDaddyTheme") || "dark";
  document.body.dataset.theme = theme;
  qs("#themeToggle").setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
  qs("#quickTheme").setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
}

function toggleTheme() {
  const next = document.body.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("retailDaddyTheme", next);
  applyTheme();
  tapSound();
}

function makeTone(notes, volume = 0.055, wave = "triangle", step = .12, hold = .11) {
  if (!state.soundOn) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const ctx = new AudioContext();
  notes.forEach((freq, index) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = wave;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + index * step);
    gain.gain.exponentialRampToValueAtTime(volume, ctx.currentTime + index * step + .02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + index * step + hold);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime + index * step);
    osc.stop(ctx.currentTime + index * step + hold + .03);
  });
}

function tapSound() {
  makeTone([560], 0.018, "sine", .08, .055);
}

function successSound() {
  makeTone([520, 660, 880, 1040], 0.06, "triangle", .09, .08);
}

function playAlertSound() {
  makeTone([260, 520, 260, 760], 0.09, "square", .13, .1);
}

function openSound() {
  makeTone([440, 620], 0.045, "sine", .1, .09);
}

function exportSound() {
  makeTone([720, 540, 880], 0.055, "triangle", .08, .075);
}

function welcomeSound() {
  makeTone([392, 523, 659, 784, 1046], 0.05, "sine", .1, .11);
}

function card(label, value, tone = "", filter = "") {
  return `<div class="kpi ${tone} ${filter ? "action" : ""}" ${filter ? `data-kpi-filter="${filter}"` : ""}><span>${label}</span><strong>${value}</strong></div>`;
}

function debtCard(count, value) {
  return `<div class="kpi debt-card action danger" data-kpi-filter="debt"><span>Debt (${amount(count).toLocaleString("en-IN")} parties)</span><strong>${plainMoney(value)}</strong></div>`;
}

function compareRows(a, b, key, dir) {
  const av = key.toLowerCase().includes("date") ? parseDate(a[key])?.getTime() || 0 : a[key];
  const bv = key.toLowerCase().includes("date") ? parseDate(b[key])?.getTime() || 0 : b[key];
  const result = typeof av === "number" || typeof bv === "number"
    ? amount(av) - amount(bv)
    : String(av || "").localeCompare(String(bv || ""));
  return dir === "asc" ? result : -result;
}

function sortRows(rows, sort) {
  if (!sort?.key) return rows;
  return [...rows].sort((a, b) => compareRows(a, b, sort.key, sort.dir));
}

function sortableTable(headers, rows, rowMap, sortName, empty = "No records found") {
  if (!rows.length) return `<div class="empty small">${empty}</div>`;
  const sort = state.tabSort[sortName] || {};
  const head = headers.map(h => {
    const active = sort.key === h.key ? ` ${sort.dir === "asc" ? "up" : "down"}` : "";
    return `<th ${h.key ? `data-sort="${h.key}" data-sort-name="${sortName}" class="sortable${active}"` : ""}>${h.label}</th>`;
  }).join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${sortRows(rows, sort).map(rowMap).join("")}</tbody></table></div>`;
}

function updateCustomerSortHeaders() {
  qsa("[data-customer-sort]").forEach(th => {
    const active = state.customerSort.key === th.dataset.customerSort;
    th.classList.toggle("up", active && state.customerSort.dir === "asc");
    th.classList.toggle("down", active && state.customerSort.dir === "desc");
  });
}

function labelMobileTables(root = document) {
  root.querySelectorAll("table").forEach(table => {
    const labels = [...table.querySelectorAll("thead th")].map(th => clean(th.textContent).replace(/\s+(sort|asc|desc)$/i, ""));
    table.querySelectorAll("tbody tr").forEach(row => {
      [...row.children].forEach((cell, index) => {
        if (labels[index]) cell.dataset.label = labels[index];
      });
    });
  });
}

const tableLabelObserver = new MutationObserver(() => requestAnimationFrame(() => labelMobileTables()));
tableLabelObserver.observe(document.body, { childList: true, subtree: true });

function installDatePickers() {
  qsa('input[type="date"], input[type="month"]').forEach(input => {
    input.addEventListener("pointerdown", () => {
      if (typeof input.showPicker === "function") {
        try { input.showPicker(); } catch (_) {}
      }
    });
  });
}

function applyKpis(kpiRows = [], trendRows = []) {
  state.kpiRows = kpiRows || [];
  state.trendRows = trendRows || [];
  const k = kpiRows[0] || {};
  const debts = debtCustomers();
  const overdue = overdueCustomers();
  const held = debts.filter(c => customerFollowup(c.customerCode).hold);
  qs("#kpis").innerHTML = [
    debtCard(k.customersOwing, k.totalReceivable),
    card("Call Today", overdue.length || debts.length, overdue.length ? "danger" : "", "debt"),
    card("Customers", amount(k.totalCustomers || state.customers.length).toLocaleString("en-IN"), "", "all"),
    card("On Hold", held.length, held.length ? "danger" : "")
  ].join("");

  const max = Math.max(...trendRows.map(r => amount(r.sales)), 1);
  qs("#salesTrend").innerHTML = trendRows.slice().reverse().map(row => `
    <div class="bar"><span>${escapeHtml(row.month)}</span><div class="fill" style="width:${Math.max(2, amount(row.sales) / max * 100)}%"></div><strong>Rs ${amount(row.sales).toLocaleString("en-IN")}</strong></div>
  `).join("");
}

function applyCustomers(customers = []) {
  state.customers = customers || [];
  applyKpis(state.kpiRows, state.trendRows);
  renderCustomers();
  renderDashboardReceivables();
  renderWarningBox();
}

async function loadKpis() {
  const [kpiRows, trendRows] = await api("/api/kpis");
  applyKpis(kpiRows, trendRows);
  saveLocalDashboardCache({ kpiRows, trendRows });
}

async function loadCustomers() {
  const [customers] = await api("/api/customers");
  applyCustomers(customers);
  saveLocalDashboardCache({ customerRows: customers });
}

async function loadCachedDashboard(error) {
  const cache = await readDashboardCache();
  if (!cache) throw error;
  const kpiRows = cache.kpiRows || (cache.kpis ? [cache.kpis] : []);
  const trendRows = cache.trendRows || cache.trend || [];
  const customerRows = cache.customerRows || cache.customers || [];
  applyKpis(kpiRows, trendRows);
  applyCustomers(customerRows);
  const saved = cache.savedAt ? date(cache.savedAt) : "last saved time";
  qs("#dbStatus").textContent = `Showing saved Retail Daddy copy from ${saved}. Live data will resume when shop PC is on.`;
}

function filteredCustomers() {
  const q = qs("#searchBox").value.trim().toLowerCase();
  const status = qs("#statusFilter").value;
  const from = qs("#customerFrom").value;
  const to = qs("#customerTo").value;
  const min = amount(qs("#minBalance").value);
  return state.customers.filter(c => {
    const balance = amount(c.balance);
    const haystack = [c.customerName, c.mobile, c.whatsapp, c.address].join(" ").toLowerCase();
    if (q && !haystack.includes(q)) return false;
    if (status === "debt" && balance <= 0) return false;
    if (status === "advance" && balance >= 0) return false;
    if (status === "clear" && balance !== 0) return false;
    if (Math.abs(balance) < min) return false;
    if ((from || to) && !inRange(c.lastPurchaseDate, from, to) && !inRange(c.lastPaymentDate, from, to)) return false;
    return true;
  });
}

function renderCustomers() {
  const rows = sortRows(filteredCustomers(), state.customerSort);
  const visibleRows = rows.slice(0, state.customerVisibleLimit);
  const receivable = rows.reduce((sum, c) => sum + Math.max(0, amount(c.balance)), 0);
  qs("#customerSummary").innerHTML = `<strong>${visibleRows.length} / ${rows.length}</strong> shown <span>Dena: <b>${plainMoney(receivable)}</b></span>`;
  qs("#customerRows").innerHTML = visibleRows.map(c => {
    const fu = customerFollowup(c.customerCode);
    const note = [fu.promiseDate ? `Promise ${date(fu.promiseDate)}` : "", fu.lastWhatsAppAt ? `WA ${date(fu.lastWhatsAppAt)}` : "", fu.lastSmsAt ? `SMS ${date(fu.lastSmsAt)}` : "", fu.hold ? "Hold" : ""].filter(Boolean).join(" | ");
    return `
    <tr data-code="${c.customerCode}" class="customer-row">
      <td><strong>${escapeHtml(c.customerName)}</strong><small>${escapeHtml(c.address || "")}</small>${note ? `<small>${escapeHtml(note)}</small>` : ""}</td>
      <td>${escapeHtml(c.mobile || c.whatsapp || "-")}</td>
      <td>${money(c.balance)}</td>
      <td>${amount(c.billCount)}</td>
      <td>${date(c.lastPurchaseDate)}</td>
      <td>${date(c.lastPaymentDate)}</td>
    </tr>`;
  }).join("");
  const more = qs("#customerMore");
  if (more) {
    more.innerHTML = rows.length > visibleRows.length
      ? `<button id="showMoreCustomers" type="button">Show ${Math.min(35, rows.length - visibleRows.length)} more</button>`
      : "";
  }
  updateCustomerSortHeaders();
  labelMobileTables(qs("#customers"));
}

function openCustomerFilter(status) {
  state.customerVisibleLimit = 35;
  qs("#statusFilter").value = status;
  qs("#searchBox").value = "";
  qs("#customerFrom").value = "";
  qs("#customerTo").value = "";
  qs("#minBalance").value = "";
  renderCustomers();
  showView("customers");
}

function debtCustomers() {
  return state.customers.filter(c => amount(c.balance) > 0).sort((a, b) => amount(b.balance) - amount(a.balance));
}

function overdueCustomers() {
  const today = inputDate(new Date());
  return debtCustomers().filter(c => inputDate(c.oldestDueDate || c.lastPurchaseDate) && inputDate(c.oldestDueDate || c.lastPurchaseDate) < today);
}

function renderDashboardReceivables() {
  const rows = debtCustomers().filter(c => !customerFollowup(c.customerCode).hold).slice(0, 10);
  qs("#dashboardReceivables").innerHTML = `<div class="mobile-debt-list">${rows.map((c, index) => {
    const phone = phoneForWhatsApp(c.mobile || c.whatsapp);
    const fu = customerFollowup(c.customerCode);
    return `
      <article class="mobile-debt-card" data-code="${c.customerCode}">
        <button class="debt-open" type="button" data-code="${c.customerCode}">
          <em>${index + 1}</em>
          <span><b>${escapeHtml(c.customerName)}</b><small>${escapeHtml(customerArea(c))}</small></span>
          <strong>${plainMoney(c.balance)}</strong>
        </button>
        <div class="debt-meta">
          <span>Due ${date(c.oldestDueDate || c.lastPurchaseDate)}</span>
          <span>Pay ${date(c.lastPaymentDate)}</span>
          ${fu.promiseDate ? `<span>Promise ${date(fu.promiseDate)}</span>` : ""}
        </div>
        <div class="row-actions">
          <button class="mini-btn" data-wa-code="${c.customerCode}">WhatsApp</button>
          <button class="mini-btn" data-sms-code="${c.customerCode}">SMS</button>
          ${phone ? `<a class="mini-btn call-btn" href="tel:+${phone}">Call</a>` : ""}
        </div>
      </article>`;
  }).join("") || `<div class="empty small">No pending receivables</div>`}</div>`;
}

function renderWarningBox() {
  const silentUntil = localStorage.getItem("retailDaddyWarningsSilentUntil") || "";
  const silenced = silentUntil && silentUntil >= inputDate(new Date());
  const rows = overdueCustomers();
  if (!rows.length || silenced) {
    qs("#warningBox").hidden = true;
    return;
  }
  const total = rows.reduce((sum, c) => sum + amount(c.balance), 0);
  qs("#warningBox").hidden = false;
  qs("#warningBox").innerHTML = `
    <div><strong>Warning: ${rows.length} overdue customers</strong><span>${plainMoney(total)} pending after due date</span></div>
    <button id="silentWarnings">Silent Today</button>
  `;
  playAlertSound();
}

function customerRisk(c) {
  const bal = amount(c.balance);
  const lastPay = parseDate(c.lastPaymentDate);
  const lastBuy = parseDate(c.lastPurchaseDate || c.oldestDueDate);
  const basis = lastPay || lastBuy;
  const days = basis ? Math.floor((Date.now() - basis.getTime()) / 86400000) : 999;
  let score = 0;
  if (bal > 0) score += Math.min(60, Math.floor(bal / 1000) * 6);
  if (days > 30) score += 20;
  if (days > 60) score += 20;
  if (days > 120) score += 20;
  const label = score >= 80 ? "High" : score >= 45 ? "Watch" : bal > 0 ? "Normal" : "Clear";
  return { score, label, days };
}

function openCustomerRiskReport() {
  const rows = state.customers
    .map(c => ({ ...c, risk: customerRisk(c) }))
    .filter(c => amount(c.balance) > 0)
    .sort((a, b) => b.risk.score - a.risk.score || amount(b.balance) - amount(a.balance));
  state.profile = null;
  state.salesReport = null;
  qs("#profileEmpty").hidden = true;
  qs("#profileContent").hidden = false;
  qs("#profileName").textContent = "Customer Risk";
  qs("#profileMeta").textContent = "Balance, last payment and ageing based follow-up priority";
  qs("#profileStats").innerHTML = [
    card("High Risk", rows.filter(r => r.risk.label === "High").length),
    card("Watch", rows.filter(r => r.risk.label === "Watch").length),
    card("Total Dena", plainMoney(rows.reduce((s, r) => s + amount(r.balance), 0)), "danger")
  ].join("");
  qs("#profileTabs").hidden = true;
  qs("#ledgerTools").hidden = true;
  qs("#tabContent").innerHTML = `
    <section class="ledger-report sales-report">
      <div class="report-head">
        <div><h3>Follow-up Priority</h3><p>Tap a customer to open full ledger and bills.</p></div>
      </div>
      <div class="sales-bill-list">
        ${rows.map(c => `
          <button class="sales-bill ${c.risk.label === "High" ? "loss" : ""}" type="button" data-code="${c.customerCode}">
            <span class="sales-bill-top"><b>${escapeHtml(c.customerName)}</b><strong>${plainMoney(c.balance)}</strong></span>
            <span class="sales-bill-main"><span>${escapeHtml(c.mobile || c.whatsapp || "No mobile")}</span><small>${c.risk.label} | ${c.risk.days} days</small></span>
            <span class="sales-bill-money"><em>Bills ${amount(c.billCount)}</em><em>Last pay ${date(c.lastPaymentDate)}</em><em>Oldest ${date(c.oldestDueDate || c.lastPurchaseDate)}</em></span>
          </button>
        `).join("") || `<div class="empty small">No risky customers found.</div>`}
      </div>
    </section>`;
  showView("profile");
}

function customerArea(c) {
  const text = clean(c.address || c.Address1 || "");
  return text.split(/[,|-]/)[0]?.trim() || "No area";
}

function openAreaRecoveryReport() {
  const rows = debtCustomers().filter(c => !customerFollowup(c.customerCode).hold);
  const groups = rows.reduce((acc, c) => {
    const area = customerArea(c);
    (acc[area] ||= []).push(c);
    return acc;
  }, {});
  state.profile = null;
  state.salesReport = null;
  qs("#profileEmpty").hidden = true;
  qs("#profileContent").hidden = false;
  qs("#profileName").textContent = "Area Recovery";
  qs("#profileMeta").textContent = "Pending customers grouped by area/address";
  qs("#profileStats").innerHTML = [
    card("Areas", Object.keys(groups).length),
    card("Customers", rows.length),
    card("Total Dena", plainMoney(rows.reduce((s, r) => s + amount(r.balance), 0)), "danger")
  ].join("");
  qs("#profileTabs").hidden = true;
  qs("#ledgerTools").hidden = true;
  qs("#tabContent").innerHTML = Object.entries(groups).sort((a,b)=>b[1].reduce((s,c)=>s+amount(c.balance),0)-a[1].reduce((s,c)=>s+amount(c.balance),0)).map(([area, list]) => `
    <section class="panel area-block">
      <div class="section-head"><div><h3>${escapeHtml(area)}</h3><p>${list.length} customers | ${plainMoney(list.reduce((s,c)=>s+amount(c.balance),0))}</p></div></div>
      <div class="sales-bill-list">${list.map(c => `<button class="sales-bill" data-code="${c.customerCode}"><span class="sales-bill-top"><b>${escapeHtml(c.customerName)}</b><strong>${plainMoney(c.balance)}</strong></span><span class="sales-bill-main"><span>${escapeHtml(c.mobile||c.whatsapp||"")}</span><small>${date(c.oldestDueDate||c.lastPurchaseDate)}</small></span></button>`).join("")}</div>
    </section>
  `).join("") || `<div class="empty small">No pending customer found.</div>`;
  showView("profile");
}

function openFollowupLog() {
  const all = followups();
  const rows = Object.entries(all).map(([code, fu]) => {
    const c = state.customers.find(x => String(x.customerCode) === String(code)) || { customerCode: code, customerName: code };
    return { ...c, fu };
  }).sort((a,b)=>String(b.fu.updatedAt||"").localeCompare(String(a.fu.updatedAt||"")));
  state.profile = null;
  state.salesReport = null;
  qs("#profileEmpty").hidden = true;
  qs("#profileContent").hidden = false;
  qs("#profileName").textContent = "Follow-up Log";
  qs("#profileMeta").textContent = "Promise dates, sent reminders, holds and local notes saved on this device";
  qs("#profileStats").innerHTML = [
    card("Customers", rows.length),
    card("On Hold", rows.filter(r => r.fu.hold).length),
    card("Promises", rows.filter(r => r.fu.promiseDate).length)
  ].join("");
  qs("#profileTabs").hidden = true;
  qs("#ledgerTools").hidden = true;
  qs("#tabContent").innerHTML = `<div class="sales-bill-list">${rows.map(r => `<button class="sales-bill" data-code="${r.customerCode}"><span class="sales-bill-top"><b>${escapeHtml(r.customerName)}</b><strong>${plainMoney(r.balance)}</strong></span><span class="sales-bill-main"><span>${r.fu.promiseDate ? "Promise "+date(r.fu.promiseDate) : "No promise"}</span><small>${[r.fu.lastWhatsAppAt ? "WA "+date(r.fu.lastWhatsAppAt) : "", r.fu.lastSmsAt ? "SMS "+date(r.fu.lastSmsAt) : ""].filter(Boolean).join(" | ") || "No message log"}</small></span><span class="sales-bill-extra">${escapeHtml([r.fu.paymentNote, r.fu.disputeNote, r.fu.hold ? "Reminder hold" : ""].filter(Boolean).join(" | "))}</span></button>`).join("") || `<div class="empty small">No local follow-up records yet.</div>`}</div>`;
  showView("profile");
}

function openControlCenter() {
  const debts = debtCustomers();
  const active = debts.filter(c => !customerFollowup(c.customerCode).hold);
  const overdue = overdueCustomers();
  const promisedToday = debts.filter(c => customerFollowup(c.customerCode).promiseDate === inputDate(new Date()));
  const waToday = debts.filter(c => inputDate(customerFollowup(c.customerCode).lastWhatsAppAt) === inputDate(new Date()));
  const smsToday = debts.filter(c => inputDate(customerFollowup(c.customerCode).lastSmsAt) === inputDate(new Date()));
  const total = debts.reduce((sum, c) => sum + amount(c.balance), 0);
  const cache = readLocalDashboardCache();
  state.profile = null;
  state.salesReport = null;
  qs("#profileEmpty").hidden = true;
  qs("#profileContent").hidden = false;
  qs("#profileName").textContent = "Control";
  qs("#profileMeta").textContent = "Recovery, reports and saved copy health";
  qs("#profileStats").innerHTML = [
    card("Total Dena", plainMoney(total), "danger"),
    card("Active Follow-up", active.length),
    card("Overdue", overdue.length, overdue.length ? "danger" : "good"),
    card("Saved Copy", cache?.savedAt ? date(cache.savedAt) : "-", cache?.savedAt ? "good" : "")
  ].join("");
  qs("#profileTabs").hidden = true;
  qs("#ledgerTools").hidden = true;
  qs("#tabContent").innerHTML = `
    <section class="panel">
      <div class="section-head"><div><h3>Today Recovery</h3><p>Call, WhatsApp, SMS and promise tracking</p></div></div>
      <div class="mini-kpis"><span>WhatsApp <b>${waToday.length}</b></span><span>SMS <b>${smsToday.length}</b></span><span>Promise <b>${promisedToday.length}</b></span><span>Overdue <b>${overdue.length}</b></span></div>
      <div class="quick-actions"><button id="menuDebtCustomers">Dena Customers</button><button id="menuCustomerRisk">Priority</button><button id="menuAreaRecovery">Area Wise</button></div>
    </section>
    <section class="panel">
      <div class="section-head"><div><h3>Reports</h3><p>Compact owner reports</p></div><button id="menuDailyClosing">Daily Closing</button></div>
      <div class="quick-actions"><button id="cashPartyDay">Today Profit</button><button id="cashPartyMonth">Monthly Profit</button><button id="menuFollowupLog">Follow-up Log</button></div>
    </section>
    <section class="panel">
      <div class="section-head"><div><h3>System</h3><p>${cache?.savedAt ? "Saved dashboard fallback is available" : "No saved dashboard fallback yet"}</p></div><button id="quickAll">All Customers</button></div>
      <div class="mini-kpis"><span>Customers <b>${state.customers.length}</b></span><span>Debt Parties <b>${debts.length}</b></span><span>SMS From <b>7588756668</b></span></div>
    </section>`;
  showView("profile");
}

function openOfflineCenter() {
  const cache = readLocalDashboardCache();
  const saved = cache?.savedAt ? date(cache.savedAt) : "Not saved yet";
  const customerCount = state.customers.length || (cache?.customerRows || cache?.customers || []).length || 0;
  state.profile = null;
  state.salesReport = null;
  qs("#profileEmpty").hidden = true;
  qs("#profileContent").hidden = false;
  qs("#profileName").textContent = "Offline / Install Center";
  qs("#profileMeta").textContent = "Use saved copy when laptop or tunnel is off";
  qs("#profileStats").innerHTML = [
    card("Network", navigator.onLine ? "Online" : "Offline", navigator.onLine ? "good" : "danger"),
    card("Saved Copy", saved, cache?.savedAt ? "good" : ""),
    card("Customers", customerCount.toLocaleString("en-IN")),
    card("Install", "Home Screen")
  ].join("");
  qs("#profileTabs").hidden = true;
  qs("#ledgerTools").hidden = true;
  qs("#tabContent").innerHTML = `
    <section class="ledger-report">
      <div class="report-head">
        <div><h3>Offline-First Status</h3><p>The dashboard can show saved receivables on this phone after it has opened once online.</p></div>
      </div>
      <div class="quick-actions">
        <button id="quickDebt">Dena Customers</button>
        <button id="menuDailyClosing">Daily Closing Pack</button>
        <button id="menuOwnerBrief">Owner Brief</button>
      </div>
      <p class="empty small">For live new sales, payments, bill details, and fresh receivable changes, the shop PC and Cloudflare tunnel still need to be online. Saved dashboard data remains available from this device.</p>
    </section>`;
  showView("profile");
}

function openVoiceMode() {
  state.profile = null;
  state.salesReport = null;
  qs("#profileEmpty").hidden = true;
  qs("#profileContent").hidden = false;
  qs("#profileName").textContent = "Voice Mode";
  qs("#profileMeta").textContent = "Say: debt customers, today profit, daily closing, search customer name";
  qs("#profileStats").innerHTML = [
    card("Listen", "Start"),
    card("Today", "Profit"),
    card("Customers", "Search"),
    card("Offline", "Status")
  ].join("");
  qs("#profileTabs").hidden = true;
  qs("#ledgerTools").hidden = true;
  qs("#tabContent").innerHTML = `
    <section class="ledger-report">
      <div class="quick-actions">
        <button id="voiceListenBtn">Start Listening</button>
        <button type="button" onclick="runReceivableVoiceCommand('debt customers')">Debt Customers</button>
        <button type="button" onclick="runReceivableVoiceCommand('today profit')">Today Profit</button>
      </div>
      <p id="voiceCommandStatus" class="empty small">Tap Start Listening and speak near the phone mic.</p>
    </section>`;
  showView("profile");
}

function speakReceivable(text) {
  try {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "en-IN";
    speechSynthesis.cancel();
    speechSynthesis.speak(utter);
  } catch (_) {}
}

function startReceivableVoiceCommand() {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const status = qs("#voiceCommandStatus");
  if (!Rec) {
    if (status) status.textContent = "Voice recognition is not available in this browser. Use Chrome on Android.";
    return;
  }
  const rec = new Rec();
  rec.lang = "en-IN";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  if (status) status.textContent = "Listening...";
  rec.onresult = event => {
    const text = event.results?.[0]?.[0]?.transcript || "";
    if (status) status.textContent = `Heard: ${text}`;
    runReceivableVoiceCommand(text);
  };
  rec.onerror = () => {
    if (status) status.textContent = "Could not hear clearly. Try again.";
  };
  rec.start();
}

function runReceivableVoiceCommand(text) {
  const t = String(text || "").toLowerCase();
  if (t.includes("today") || t.includes("profit") || t.includes("closing")) {
    speakReceivable("Opening today closing pack");
    openCashParty("day");
    return;
  }
  if (t.includes("debt") || t.includes("dena")) {
    speakReceivable("Opening debt customers");
    openCustomerFilter("debt");
    return;
  }
  if (t.includes("offline")) {
    speakReceivable("Opening offline center");
    openOfflineCenter();
    return;
  }
  const term = t.replace(/^(search|find|show|open)\s+/,"").trim();
  if (term) {
    qs("#searchBox").value = term;
    renderCustomers();
    speakReceivable("Searching customers");
    showView("customers");
  }
}

function openOwnerBrief() {
  const debts = debtCustomers();
  const active = debts.filter(c => !customerFollowup(c.customerCode).hold);
  const promisedToday = debts.filter(c => customerFollowup(c.customerCode).promiseDate === inputDate(new Date()));
  const waToday = debts.filter(c => inputDate(customerFollowup(c.customerCode).lastWhatsAppAt) === inputDate(new Date()));
  const smsToday = debts.filter(c => inputDate(customerFollowup(c.customerCode).lastSmsAt) === inputDate(new Date()));
  const total = debts.reduce((sum, c) => sum + amount(c.balance), 0);
  const recommended = active
    .map(c => ({ ...c, risk: customerRisk(c) }))
    .sort((a, b) => amount(b.balance) - amount(a.balance) || b.risk.days - a.risk.days)
    .slice(0, 15);
  const areas = active.reduce((acc, c) => {
    const area = customerArea(c);
    acc[area] = (acc[area] || 0) + amount(c.balance);
    return acc;
  }, {});
  const areaRows = Object.entries(areas).sort((a, b) => b[1] - a[1]).slice(0, 5);
  state.profile = null;
  state.salesReport = null;
  qs("#profileEmpty").hidden = true;
  qs("#profileContent").hidden = false;
  qs("#profileName").textContent = "Today Brief";
  qs("#profileMeta").textContent = "Today recovery order, promises, and collection pressure";
  qs("#profileStats").innerHTML = [
    card("Total Dena", plainMoney(total), "danger"),
    card("Call First", recommended.length),
    card("Promise Today", promisedToday.length, "good"),
    card("WhatsApp Sent", waToday.length),
    card("SMS Sent", smsToday.length)
  ].join("");
  qs("#profileTabs").hidden = true;
  qs("#ledgerTools").hidden = true;
  qs("#tabContent").innerHTML = `
    <section class="panel">
      <div class="section-head"><div><h3>Recommended Recovery Order</h3><p>Highest amount and oldest pending first</p></div></div>
      <div class="sales-bill-list">${recommended.map(c => `<button class="sales-bill ${c.risk.label === "High" ? "loss" : ""}" data-code="${c.customerCode}"><span class="sales-bill-top"><b>${escapeHtml(c.customerName)}</b><strong>${plainMoney(c.balance)}</strong></span><span class="sales-bill-main"><span>${escapeHtml(c.mobile || c.whatsapp || "No mobile")}</span><small>${c.risk.days} days | ${customerArea(c)}</small></span><span class="sales-bill-money"><em>Bills ${amount(c.billCount)}</em><em>${customerFollowup(c.customerCode).lastWhatsAppAt ? "WA "+date(customerFollowup(c.customerCode).lastWhatsAppAt) : "No WA"}</em><em>${customerFollowup(c.customerCode).lastSmsAt ? "SMS "+date(customerFollowup(c.customerCode).lastSmsAt) : "No SMS"}</em></span></button>`).join("") || `<div class="empty small">No pending recovery work.</div>`}</div>
    </section>
    <section class="panel">
      <div class="section-head"><div><h3>Area Pressure</h3><p>Where most money is pending</p></div><button id="menuAreaRecovery">Open Areas</button></div>
      <div class="mini-kpis">${areaRows.map(([area, value]) => `<span>${escapeHtml(area)} <b>${plainMoney(value)}</b></span>`).join("") || `<span>No area data</span>`}</div>
    </section>`;
  showView("profile");
}

function setPromisePay() {
  const p = state.profile?.summary;
  if (!p) return;
  const value = prompt("Promise-to-pay date (YYYY-MM-DD)", inputDate(new Date()));
  if (!value) return;
  setCustomerFollowup(p.customerCode, { promiseDate: value });
  renderProfile();
}

function setLocalPaymentNote() {
  const p = state.profile?.summary;
  if (!p) return;
  const value = prompt("Local payment note, example: Paid 500 cash today");
  if (!value) return;
  setCustomerFollowup(p.customerCode, { paymentNote: value });
  renderProfile();
}

function toggleHoldReminder() {
  const p = state.profile?.summary;
  if (!p) return;
  const cur = customerFollowup(p.customerCode);
  const note = cur.hold ? "" : prompt("Hold/dispute reason", cur.disputeNote || "Issue pending") || "Issue pending";
  setCustomerFollowup(p.customerCode, { hold: !cur.hold, disputeNote: note });
  renderProfile();
  renderDashboardReceivables();
}

async function openCustomer(code) {
  const [summary, ledger, bills, payments, outstanding, items] = await api(`/api/customer?code=${code}`);
  const listRow = state.customers.find(c => String(c.customerCode) === String(code)) || {};
  state.profile = { summary: { ...summary[0], oldestDueDate: listRow.oldestDueDate, lastPaymentDate: listRow.lastPaymentDate }, ledger, bills, payments, outstanding, items };
  state.salesReport = null;
  state.activeTab = "ledger";
  state.cashPeriod = "";
  const dates = ledger.map(r => inputDate(r.Date)).filter(Boolean);
  state.ledgerFrom = dates[0] || "2026-04-01";
  state.ledgerTo = dates[dates.length - 1] || inputDate(new Date());
  state.ledgerQuery = "";
  state.itemQuery = "";
  qs("#ledgerFrom").value = state.ledgerFrom;
  qs("#ledgerTo").value = state.ledgerTo;
  if (qs("#ledgerSearch")) qs("#ledgerSearch").value = "";
  renderProfile();
  showView("profile");
  saveNavigation({ profileCode: code });
  if (!restoringNavigation) {
    try {
      history.replaceState({ srReceivables: true, view: "profile", profileCode: code, activeTab: state.activeTab }, "", location.href);
    } catch (_) {}
  }
}

function renderProfile() {
  if (state.salesReport) {
    renderSalesReport();
    return;
  }
  const p = state.profile.summary;
  const purchased = state.profile.ledger.reduce((sum, r) => sum + Math.max(0, amount(r.amount)), 0);
  const jama = state.profile.ledger.reduce((sum, r) => sum + Math.max(0, -amount(r.amount)), 0);
  qs("#profileEmpty").hidden = true;
  qs("#profileContent").hidden = false;
  qs("#profileName").textContent = p.customerName || "";
  const fu = customerFollowup(p.customerCode);
  qs("#profileMeta").textContent = [p.Mobile, p.Address1, p.Address2, p.Address3].filter(Boolean).map(clean).join(" | ");
  const stats = [
    card("Current Balance", money(p.currentBalance), "danger"),
    card("Total Kharidi", `Rs ${purchased.toLocaleString("en-IN")}`),
    card("Total Jama", `Rs ${jama.toLocaleString("en-IN")}`, "good"),
    card("Oldest Due", date(p.oldestDueDate || p.lastPurchaseDate), "danger")
  ];
  qs("#profileStats").innerHTML = stats.join("");
  qsa(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === state.activeTab));
  qs("#profileTabs").hidden = false;
  qs("#ledgerTools").hidden = state.activeTab !== "ledger";
  renderTab();
}

function billCodeForLedger(row) {
  const no = clean(row.VchNo);
  const bill = state.profile.bills.find(b => clean(b.VchNo) === no);
  return bill ? bill.VchCode : "";
}

function filteredLedger() {
  const q = state.ledgerQuery.toLowerCase();
  return state.profile.ledger.filter(r => {
    if (!inRange(r.Date, state.ledgerFrom, state.ledgerTo)) return false;
    if (!q) return true;
    return [r.VchType, r.VchNo, r.narration].join(" ").toLowerCase().includes(q);
  });
}

function renderTab() {
  const p = state.profile;
  const target = qs("#tabContent");
  if (state.activeTab === "ledger") {
    target.innerHTML = renderLedgerReport(filteredLedger());
  } else if (state.activeTab === "bills") {
    target.innerHTML = sortableTable([
      { label: "Date", key: "Date" }, { label: "Bill No", key: "VchNo" }, { label: "Amount", key: "billAmount" }, { label: "Goods", key: "goodsAmount" }, { label: "Status", key: "storeName" }
    ], p.bills, r => `<tr data-bill="${r.VchCode}"><td>${date(r.Date)}</td><td>${escapeHtml(clean(r.VchNo))}</td><td>Rs ${amount(r.billAmount).toLocaleString("en-IN")}</td><td>Rs ${amount(r.goodsAmount).toLocaleString("en-IN")}</td><td>${escapeHtml(clean(r.storeName))}</td></tr>`, "bills");
  } else if (state.activeTab === "payments") {
    target.innerHTML = sortableTable([
      { label: "Date", key: "Date" }, { label: "Receipt No", key: "VchNo" }, { label: "Mode", key: "VchType" }, { label: "Jama Amount", key: "amount" }, { label: "Narration", key: "narration" }
    ], p.payments, r => `<tr><td>${date(r.Date)}</td><td>${escapeHtml(clean(r.VchNo))}</td><td>${escapeHtml(clean(r.VchType))}</td><td>${money(-amount(r.amount))}</td><td>${escapeHtml(r.narration || "")}</td></tr>`, "payments");
  } else if (state.activeTab === "outstanding") {
    target.innerHTML = sortableTable([
      { label: "Date", key: "Date" }, { label: "Due", key: "DueDate" }, { label: "Bill No", key: "refNo" }, { label: "Amount", key: "amount" }, { label: "Balance", key: "balance" }, { label: "Narration", key: "Narration" }
    ], p.outstanding, r => `<tr data-bill="${r.VchCode}"><td>${date(r.Date)}</td><td>${date(r.DueDate)}</td><td>${escapeHtml(clean(r.refNo))}</td><td>${money(r.amount)}</td><td>${money(r.balance)}</td><td>${escapeHtml(r.Narration || "")}</td></tr>`, "outstanding");
  } else if (state.activeTab === "items") {
    const itemRows = filteredPartyItems();
    target.innerHTML = `
      <section class="party-items">
        <div class="party-item-search">
          <input id="partyItemSearch" type="search" placeholder="Find item sold to this party">
        </div>
        <div class="party-item-list">
          ${itemRows.map(item => `
            <article class="party-item">
              <div><b>${escapeHtml(clean(item.itemName || "Item"))}</b><small>${escapeHtml(clean(item.barcode || item.itemGroup || ""))}</small></div>
              <span>Qty <b>${amount(item.totalQty)}</b></span>
              <span>Times <b>${amount(item.timesBought)}</b></span>
              <span>Avg <b>${rupees(item.averageRate)}</b></span>
              <span>Value <b>${rupees(item.totalValue)}</b></span>
            </article>
          `).join("") || `<div class="empty small">No item history found for this party.</div>`}
        </div>
      </section>`;
    const input = qs("#partyItemSearch");
    if (input) {
      input.value = state.itemQuery;
      input.addEventListener("input", () => {
        state.itemQuery = input.value.trim();
        renderTab();
      });
    }
  } else {
    const bills = p.bills.length;
    const purchased = p.ledger.reduce((s, r) => s + Math.max(0, amount(r.amount)), 0);
    const jama = p.ledger.reduce((s, r) => s + Math.max(0, -amount(r.amount)), 0);
    const avg = bills ? purchased / bills : 0;
    target.innerHTML = `<div class="kpi-grid">${card("Average Bill", `Rs ${avg.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`)}${card("Total Kharidi", `Rs ${purchased.toLocaleString("en-IN")}`)}${card("Total Jama", `Rs ${jama.toLocaleString("en-IN")}`, "good")}${card("Abhi Dena Hai", money(p.summary.currentBalance), "danger")}</div>`;
  }
  labelMobileTables(target);
}

function renderSalesReport() {
  const report = state.salesReport;
  const summary = report?.summary || {};
  const rows = report?.rows || [];
  qs("#profileEmpty").hidden = true;
  qs("#profileContent").hidden = false;
  qs("#profileName").textContent = `Profitability ${report?.periodLabel || "Report"}`;
  qs("#profileMeta").textContent = `${date(report?.from)} to ${date(report?.to)} | Billwise Profit Report`;
  qs("#profileStats").innerHTML = "";
  qs("#profileTabs").hidden = true;
  qs("#ledgerTools").hidden = true;
  const summaryItems = [
    ["Bills", amount(summary.billCount).toLocaleString("en-IN")],
    ["Sales", rupees(summary.billAmount), "good"],
    ["Paid", rupees(summary.paidAmount), "good"],
    ["Balance", rupees(summary.balanceAmount), amount(summary.balanceAmount) ? "danger" : ""],
    ["Cost", rupees(summary.costPrice)],
    ["Profit", rupees(summary.profitAmount), amount(summary.profitAmount) >= 0 ? "good" : "danger"],
    ["Actual", rupees(summary.actualProfit), amount(summary.actualProfit) >= 0 ? "good" : "danger"]
  ];
  const target = qs("#tabContent");
  target.innerHTML = `
    <section class="ledger-report sales-report" id="salesReport">
      <div class="report-head">
        <div>
          <h3>Billwise Profitability</h3>
          <p>Tap any invoice for items, qty, rate, MRP, cost and export.</p>
        </div>
        <div class="report-period"><span>${date(report?.from)} to ${date(report?.to)}</span><b>${rupees(summary.billAmount)}</b><button class="mini-btn" id="dailyClosingPdf">Daily PDF</button></div>
      </div>
      <div class="profit-summary">
        ${summaryItems.map(([label, value, tone]) => `<span class="${tone || ""}"><small>${label}</small><b>${value}</b></span>`).join("")}
      </div>
      <div class="sales-bill-list">
        ${rows.length ? rows.map(r => `
          <button class="sales-bill ${amount(r.actualProfit) < 0 ? "loss" : ""}" type="button" data-bill="${r.VchCode}">
            <span class="sales-bill-top">
              <b>${escapeHtml(clean(r.VchNo))}</b>
              <strong>${rupees(r.billAmount)}</strong>
            </span>
            <span class="sales-bill-main">
              <span>${escapeHtml(clean(r.partyName || "Cash"))}</span>
              <small>${date(r.Date)}</small>
            </span>
            <span class="sales-bill-money">
              <em>Bal ${rupees(r.balanceAmount)}</em>
              <em>Profit ${rupees(r.actualProfit)}</em>
            </span>
            <span class="sales-bill-extra">
              Paid ${rupees(r.paidAmount)} | Cost ${rupees(r.costPrice)} | Gross ${rupees(r.profitAmount)} | Disc ${rupees(r.billDiscount)} | ${escapeHtml(clean(r.status || "Profit"))}
            </span>
          </button>
        `).join("") : `<div class="empty small">No bills found for this period</div>`}
      </div>
    </section>`;
  labelMobileTables(target);
}

function renderLedgerReport(rows) {
  return `
    <section class="ledger-report" id="ledgerReport">
      <div class="ledger-range">${date(state.ledgerFrom)} to ${date(state.ledgerTo)}</div>
      ${sortableTable([
        { label: "Date", key: "Date" }, { label: "Particulars", key: "VchType" }, { label: "Voucher No", key: "VchNo" }, { label: "Kharidi", key: "amount" }, { label: "Jama", key: "creditAmount" }, { label: "Balance", key: "runningBalance" }, { label: "Narration", key: "narration" }
      ], rows.map(r => ({ ...r, creditAmount: Math.max(0, -amount(r.amount)) })), r => {
        const value = amount(r.amount);
        const billCode = billCodeForLedger(r);
        return `<tr ${billCode ? `data-bill="${billCode}"` : ""}><td>${date(r.Date)}</td><td>${escapeHtml(clean(r.VchType))}</td><td>${escapeHtml(clean(r.VchNo))}</td><td>${value > 0 ? money(value) : ""}</td><td>${value < 0 ? money(value) : ""}</td><td>${money(r.runningBalance)}</td><td>${escapeHtml(r.narration || "")}</td></tr>`;
      }, "ledger", "No ledger rows in this period")}
    </section>`;
}

function filteredPartyItems() {
  const q = state.itemQuery.toLowerCase();
  const rows = state.profile?.items || [];
  if (!q) return rows;
  return rows.filter(item => [item.itemName, item.barcode, item.itemGroup].join(" ").toLowerCase().includes(q));
}

async function openBill(vchCode) {
  const [headers, items] = await api(`/api/bill?vchCode=${vchCode}`);
  const h = headers[0] || {};
  state.currentBill = { header: h, items };
  qs("#billTitle").textContent = `Bill ${clean(h.VchNo || vchCode)}`;
  qs("#billMeta").textContent = `${date(h.Date)} | ${clean(h.partyName || h.billingParty)} | Rs ${amount(h.VchAmtBaseCur).toLocaleString("en-IN")}`;
  const totalCost = items.reduce((sum, row) => sum + amount(row.costAmount), 0);
  const totalProfit = items.reduce((sum, row) => sum + amount(row.profitAmount), 0);
  qs("#billBody").innerHTML = `
    <div class="bill-summary compact">
      <span>Total <b>Rs ${amount(h.VchAmtBaseCur).toLocaleString("en-IN")}</b></span>
      <span>Paid <b>Rs ${amount(h.FormRecAmt).toLocaleString("en-IN")}</b></span>
      <span>Balance <b>${plainMoney(h.FormIssAmt)}</b></span>
      <span>Cost <b>${rupees(totalCost)}</b></span>
      <span>Profit <b>${rupees(totalProfit)}</b></span>
      <span>Items <b>${items.length}</b></span>
    </div>
    <div class="bill-items">
      ${items.map((r, index) => `
        <div class="bill-item">
          <div class="bill-item-head"><b><em>${index + 1}</em>${escapeHtml(r.itemName)}</b><strong>${rupees(r.amount)}</strong></div>
          <div class="bill-item-code">${escapeHtml(r.barcode || r.itemGroup || "")}${r.itemGroup && r.barcode ? ` | ${escapeHtml(r.itemGroup)}` : ""}</div>
          <div class="bill-item-grid">
            <span>Qty <b>${amount(r.qty)}</b></span>
            <span>Rate <b>${rupees(r.rate)}</b></span>
            <span>MRP <b>${r.mrp ? rupees(r.mrp) : "-"}</b></span>
            <span>Cost <b>${rupees(r.costAmount)}</b></span>
            <span>Profit <b>${rupees(r.profitAmount)}</b></span>
          </div>
        </div>
      `).join("")}
    </div>
  `;
  labelMobileTables(qs("#billBody"));
  qs("#billModal").hidden = false;
  updateBackButton();
  if (!restoringNavigation) {
    saveNavigation({ modal: "bill", billCode: vchCode });
    try { history.pushState({ srReceivables: true, view: state.lastView, modal: "bill", billCode: vchCode }, "", location.href); } catch (_) {}
  }
  openSound();
}

function billFileName(ext) {
  const h = state.currentBill?.header || {};
  const no = clean(h.VchNo || "invoice").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return `${no || "invoice"}-${inputDate(h.Date) || "date"}.${ext}`;
}

function billReceiptHtml() {
  const bill = state.currentBill;
  if (!bill) return "";
  const h = bill.header || {};
  const items = bill.items || [];
  const itemRows = items.map((r, index) => `
    <tr>
      <td>${index + 1}</td>
      <td><b>${escapeHtml(clean(r.itemName))}</b><br>${escapeHtml(clean(r.barcode || r.itemGroup || ""))}</td>
      <td>${amount(r.qty)}</td>
      <td>${Math.round(amount(r.rate))}</td>
      <td>${r.mrp ? Math.round(amount(r.mrp)) : ""}</td>
      <td>${Math.round(amount(r.amount))}</td>
    </tr>`).join("");
  return `
    <section class="invoice-76">
      <h1>SR FASHION</h1>
      <p>PUSAD</p>
      <div class="line"></div>
      <div><b>Invoice:</b> ${escapeHtml(clean(h.VchNo || ""))}</div>
      <div><b>Date:</b> ${date(h.Date)}</div>
      <div><b>Customer:</b> ${escapeHtml(clean(h.partyName || h.billingParty || "Cash"))}</div>
      ${h.MobileNo ? `<div><b>Mobile:</b> ${escapeHtml(clean(h.MobileNo))}</div>` : ""}
      <div class="line"></div>
      <table>
        <thead><tr><th>#</th><th>Item</th><th>Qty</th><th>Rate</th><th>MRP</th><th>Amt</th></tr></thead>
        <tbody>${itemRows}</tbody>
      </table>
      <div class="line"></div>
      <div class="sum"><span>Bill</span><b>${rupees(h.VchAmtBaseCur)}</b></div>
      <div class="sum"><span>Paid</span><b>${rupees(h.FormRecAmt)}</b></div>
      <div class="sum"><span>Balance</span><b>${plainMoney(h.FormIssAmt)}</b></div>
      <div class="thanks">Thank you</div>
    </section>`;
}

function invoiceExportCss() {
  return `@page{size:76mm auto;margin:4mm}body{margin:0;background:#fff;color:#000;font-family:Arial,sans-serif}.invoice-76{width:72mm;margin:0 auto;font-size:10px;line-height:1.25}.invoice-76 h1{margin:0;text-align:center;font-size:17px;letter-spacing:0}.invoice-76 p{margin:2px 0 5px;text-align:center;font-weight:700}.invoice-76 .line{border-top:1px dashed #000;margin:5px 0}.invoice-76 table{width:100%;border-collapse:collapse;table-layout:fixed}.invoice-76 th,.invoice-76 td{padding:3px 2px;border-bottom:1px dotted #bbb;text-align:left;vertical-align:top;word-break:break-word}.invoice-76 th:nth-child(1),.invoice-76 td:nth-child(1){width:5mm}.invoice-76 th:nth-child(2),.invoice-76 td:nth-child(2){width:28mm}.invoice-76 th:nth-child(n+3),.invoice-76 td:nth-child(n+3){text-align:right}.invoice-76 .sum{display:flex;justify-content:space-between;font-size:12px;margin:3px 0}.invoice-76 .thanks{text-align:center;font-weight:800;margin-top:8px}`;
}

function exportBillPdf() {
  if (!state.currentBill) return;
  const doc = window.open("", "_blank", "width=360,height=720");
  doc.document.write(`<!doctype html><html><head><title>${billFileName("pdf")}</title><style>${invoiceExportCss()}</style></head><body>${billReceiptHtml()}<script>window.onload=()=>setTimeout(()=>window.print(),250)</script></body></html>`);
  doc.document.close();
  exportSound();
}

function createBillPngBlob() {
  const bill = state.currentBill;
  if (!bill) return Promise.resolve(null);
  const h = bill.header || {};
  const items = bill.items || [];
  const width = 576;
  const line = 28;
  const height = Math.max(820, 300 + items.length * 72);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";
  ctx.font = "900 34px Arial";
  ctx.fillText("SR FASHION", width / 2, 48);
  ctx.font = "700 18px Arial";
  ctx.fillText("PUSAD", width / 2, 76);
  ctx.textAlign = "left";
  ctx.font = "18px Arial";
  let y = 116;
  const row = text => { ctx.fillText(text, 22, y); y += line; };
  row(`Invoice: ${clean(h.VchNo || "")}`);
  row(`Date: ${date(h.Date)}`);
  row(`Customer: ${clean(h.partyName || h.billingParty || "Cash").slice(0, 36)}`);
  if (h.MobileNo) row(`Mobile: ${clean(h.MobileNo)}`);
  y += 8;
  ctx.setLineDash([8, 6]);
  ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(width - 20, y); ctx.stroke(); y += 26;
  ctx.setLineDash([]);
  items.forEach((item, index) => {
    ctx.font = "700 18px Arial";
    row(`${index + 1}. ${clean(item.itemName).slice(0, 42)}`);
    ctx.font = "16px Arial";
    row(`Qty ${amount(item.qty)}  Rate ${Math.round(amount(item.rate))}  MRP ${item.mrp ? Math.round(amount(item.mrp)) : "-"}  Amt ${Math.round(amount(item.amount))}`);
    if (item.barcode) row(`Code ${clean(item.barcode).slice(0, 28)}`);
    y += 8;
  });
  ctx.setLineDash([8, 6]);
  ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(width - 20, y); ctx.stroke(); y += 30;
  ctx.setLineDash([]);
  ctx.font = "900 22px Arial";
  row(`Bill: ${rupees(h.VchAmtBaseCur)}`);
  row(`Paid: ${rupees(h.FormRecAmt)}`);
  row(`Balance: ${plainMoney(h.FormIssAmt)}`);
  ctx.textAlign = "center";
  ctx.font = "900 22px Arial";
  ctx.fillText("Thank you", width / 2, y + 18);
  return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
}

async function exportBillPng() {
  const blob = await createBillPngBlob();
  downloadBlob(blob, billFileName("png"));
  exportSound();
}

function setLedgerFilters() {
  state.ledgerFrom = qs("#ledgerFrom").value;
  state.ledgerTo = qs("#ledgerTo").value;
  state.ledgerQuery = qs("#ledgerSearch")?.value.trim() || "";
  renderTab();
}

function ledgerFileName(ext) {
  const name = (state.profile?.summary?.customerName || "customer-ledger").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return `${name || "customer-ledger"}-${state.ledgerFrom || "start"}-${state.ledgerTo || "today"}.${ext}`;
}

function statementTotals(rows) {
  const purchased = rows.reduce((s, r) => s + Math.max(0, amount(r.amount)), 0);
  const jama = rows.reduce((s, r) => s + Math.max(0, -amount(r.amount)), 0);
  const closing = rows.length ? amount(rows[rows.length - 1].runningBalance) : amount(state.profile.summary.currentBalance);
  return { purchased, jama, closing };
}

function normalStatementHtml(rows) {
  const p = state.profile.summary;
  const t = statementTotals(rows);
  return `
    <section class="statement normal-statement">
      <h1>SR Fashion</h1>
      <h2>${escapeHtml(p.customerName)}</h2>
      <p>${escapeHtml([p.Mobile, p.Address1, p.Address2, p.Address3].filter(Boolean).map(clean).join(" | "))}</p>
      <div class="customer-note">Aapka account ${date(state.ledgerFrom)} se ${date(state.ledgerTo)} tak:</div>
      <div class="statement-box">
        <div><span>Aapne kharidi ki</span><b>Rs ${t.purchased.toLocaleString("en-IN")}</b></div>
        <div><span>Aapne jama kiya</span><b>Rs ${t.jama.toLocaleString("en-IN")}</b></div>
        <div class="due"><span>Abhi dena hai</span><b>${plainMoney(t.closing)}</b></div>
      </div>
      <p class="thanks">Kripya pending amount clear kar dijiye. Thank you.</p>
    </section>`;
}

function professionalStatementHtml(rows) {
  return `<section class="statement professional-statement">${renderLedgerReport(rows)}</section>`;
}

function statementHtml() {
  const rows = filteredLedger();
  return qs("#statementStyle").value === "normal" ? normalStatementHtml(rows) : professionalStatementHtml(rows);
}

function openLedgerPrint() {
  const doc = window.open("", "_blank", "width=900,height=700");
  doc.document.write(`<!doctype html><html><head><title>${ledgerFileName("pdf")}</title><style>${exportCss()}</style></head><body>${statementHtml()}<script>window.onload=()=>setTimeout(()=>window.print(),200)</script></body></html>`);
  doc.document.close();
}

function exportLedgerPdf() {
  openLedgerPrint();
  qs("#exportOptions").hidden = true;
  successSound();
}

function createLedgerPngBlob() {
  const rows = filteredLedger();
  const p = state.profile.summary;
  const t = statementTotals(rows);
  const normal = qs("#statementStyle").value === "normal";
  const width = 1200;
  const lineHeight = normal ? 50 : 34;
  const height = normal ? 760 : Math.max(760, 260 + rows.length * lineHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#0f172a";
  ctx.font = "700 42px Segoe UI, Arial";
  ctx.fillText("SR Fashion", 70, 80);
  ctx.font = "700 30px Segoe UI, Arial";
  ctx.fillText(clean(p.customerName), 70, 130);
  ctx.font = "18px Segoe UI, Arial";
  ctx.fillStyle = "#475569";
  ctx.fillText([p.Mobile, p.Address1, p.Address2, p.Address3].filter(Boolean).map(clean).join(" | ").slice(0, 105), 70, 165);
  ctx.fillText(`${date(state.ledgerFrom)} to ${date(state.ledgerTo)}`, 70, 198);

  if (normal) {
    drawStatementBox(ctx, "Aapne kharidi ki", `Rs ${t.purchased.toLocaleString("en-IN")}`, 90, 270);
    drawStatementBox(ctx, "Aapne jama kiya", `Rs ${t.jama.toLocaleString("en-IN")}`, 410, 270);
    drawStatementBox(ctx, "Abhi dena hai", plainMoney(t.closing), 730, 270, true);
    ctx.fillStyle = "#111827";
    ctx.font = "24px Segoe UI, Arial";
    wrapText(ctx, "Kripya pending amount clear kar dijiye. Thank you.", 90, 520, 980, 36);
  } else {
    drawLedgerPng(ctx, rows, 70, 250, width - 140);
  }
  return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
}

async function exportLedgerPng() {
  const blob = await createLedgerPngBlob();
  downloadBlob(blob, ledgerFileName("png"));
  qs("#exportOptions").hidden = true;
  successSound();
}

function roundedRect(ctx, x, y, width, height, radius) {
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    return;
  }
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

function drawStatementBox(ctx, label, value, x, y, due = false) {
  ctx.fillStyle = due ? "#fef2f2" : "#f8fafc";
  ctx.strokeStyle = due ? "#ef4444" : "#cbd5e1";
  ctx.lineWidth = 2;
  roundedRect(ctx, x, y, 290, 170, 14);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#64748b";
  ctx.font = "22px Segoe UI, Arial";
  ctx.fillText(label, x + 26, y + 58);
  ctx.fillStyle = due ? "#b91c1c" : "#111827";
  ctx.font = "700 34px Segoe UI, Arial";
  ctx.fillText(value, x + 26, y + 115);
}

function drawLedgerPng(ctx, rows, x, y, width) {
  const cols = [110, 230, 230, 140, 140, 160];
  const headers = ["Date", "Particulars", "Voucher", "Kharidi", "Jama", "Balance"];
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(x, y, width, 42);
  ctx.strokeStyle = "#cbd5e1";
  ctx.strokeRect(x, y, width, 42);
  ctx.fillStyle = "#475569";
  ctx.font = "700 16px Segoe UI, Arial";
  let cx = x + 12;
  headers.forEach((h, i) => { ctx.fillText(h, cx, y + 27); cx += cols[i]; });
  ctx.font = "15px Segoe UI, Arial";
  rows.forEach((r, rowIndex) => {
    const yy = y + 42 + rowIndex * 34;
    ctx.strokeStyle = "#e2e8f0";
    ctx.strokeRect(x, yy, width, 34);
    const value = amount(r.amount);
    const cells = [date(r.Date), clean(r.VchType), clean(r.VchNo), value > 0 ? plainMoney(value) : "", value < 0 ? plainMoney(value) : "", plainMoney(r.runningBalance)];
    ctx.fillStyle = "#111827";
    let cellX = x + 12;
    cells.forEach((cell, i) => { ctx.fillText(String(cell).slice(0, i === 2 ? 22 : 16), cellX, yy + 23); cellX += cols[i]; });
  });
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(" ");
  let line = "";
  for (const word of words) {
    const test = `${line}${word} `;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      line = `${word} `;
      y += lineHeight;
    } else {
      line = test;
    }
  }
  ctx.fillText(line, x, y);
}

function exportCss() {
  return `body{margin:0;background:#fff;font-family:Segoe UI,Arial,sans-serif;color:#111827}.statement{padding:34px}.statement h1{margin:0;color:#0f172a}.statement h2{margin:12px 0 4px}.statement p{color:#475569}.customer-note{margin:30px 0 14px;font-size:20px}.statement-box{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.statement-box div{border:1px solid #cbd5e1;border-radius:12px;padding:24px;background:#f8fafc}.statement-box .due{border-color:#ef4444;background:#fef2f2}.statement-box span{display:block;color:#64748b}.statement-box b{display:block;margin-top:12px;font-size:30px}.thanks{font-size:20px;margin-top:30px}.ledger-report{font-family:Segoe UI,Arial,sans-serif;color:#111827}.table-wrap{border:1px solid #dbe1ea;border-radius:8px;overflow:hidden}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #dbe1ea;text-align:left;font-size:13px}th{background:#f8fafc}.report-head{display:flex;justify-content:space-between;gap:20px;margin-bottom:14px}.mini-kpis{display:flex;gap:12px;margin:12px 0}.mini-kpis span{border:1px solid #dbe1ea;border-radius:6px;padding:10px 14px}.dr{color:#b91c1c}.cr{color:#047857}.money{font-weight:700}`;
}

function downloadBlob(blob, filename) {
  if (!blob) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
}

function contactFileName(ext) {
  return `sr-fashion-customers-${inputDate(new Date())}.${ext}`;
}

function exportContactsVcf() {
  const rows = filteredCustomers()
    .filter(c => phoneForWhatsApp(c.mobile || c.whatsapp))
    .map(c => {
      const name = clean(c.customerName || "SR Fashion Customer");
      const phone = phoneForWhatsApp(c.mobile || c.whatsapp);
      const note = `Balance ${plainMoney(c.balance)} | Bills ${amount(c.billCount)}`;
      return [
        "BEGIN:VCARD",
        "VERSION:3.0",
        `FN:${name.replace(/[\r\n:;]/g, " ")}`,
        `TEL;TYPE=CELL:+${phone}`,
        `NOTE:${note.replace(/[\r\n:;]/g, " ")}`,
        "END:VCARD"
      ].join("\r\n");
    });
  downloadBlob(new Blob([rows.join("\r\n")], { type: "text/vcard;charset=utf-8" }), contactFileName("vcf"));
  exportSound();
}

function exportContactsCsv() {
  const rows = filteredCustomers();
  const csv = [["Name", "Mobile", "Balance", "Bills", "Address"], ...rows.map(c => [
    c.customerName || "",
    c.mobile || c.whatsapp || "",
    amount(c.balance),
    amount(c.billCount),
    c.address || ""
  ])].map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\n");
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), contactFileName("csv"));
  exportSound();
}

function hinglishMessage(customer) {
  const name = customer.customerName || "ji";
  const due = Math.abs(amount(customer.balance)).toLocaleString("en-IN");
  if (state.reminderTone === "strong") {
    return `Assalamualaikum ${name}, S R Fashion se reminder hai. Aapka Rs ${due} dena pending hai. Kripya aaj payment clear/jama kar dijiye. Thank you.`;
  }
  if (state.reminderTone === "medium") {
    return `Assalamualaikum ${name}, S R Fashion se message hai. Aapka Rs ${due} dena hai. Kripya jaldi payment jama kar dijiye. Thank you.`;
  }
  return `Assalamualaikum ${name}, S R Fashion se halka reminder hai. Aapka Rs ${due} balance pending hai. Aapki suvidha se payment jama kar dijiye. Thank you.`;
}

function paymentReceivedMessage(customer, receivedAmount, remainingBalance) {
  const name = clean(customer.customerName || customer.Name || "Customer");
  return `S R Fashion: Received ${plainRupees(receivedAmount)} from ${name}. Remaining balance ${plainRupees(remainingBalance)}. Thank you.`;
}

function promptPaymentMessage(customer) {
  if (!customer) return null;
  const currentBalance = amount(customer.balance);
  const typed = prompt("Received amount", "");
  if (typed === null) return null;
  const received = amount(String(typed).replace(/,/g, ""));
  if (!received || received <= 0) {
    alert("Please enter received amount.");
    return null;
  }
  const remaining = Math.max(0, currentBalance - received);
  return {
    text: paymentReceivedMessage(customer, received, remaining),
    received,
    remaining
  };
}

function sendTextWhatsApp(customer) {
  const phone = phoneForWhatsApp(customer.mobile || customer.Mobile);
  if (!phone) return;
  window.open(whatsappUrl(phone, hinglishMessage(customer)), "_blank");
  markWhatsAppSent(customer);
  renderDashboardReceivables();
  successSound();
}

function sendCustomWhatsAppText(customer, text) {
  const phone = phoneForWhatsApp(customer.mobile || customer.Mobile);
  if (!phone) return;
  window.open(whatsappUrl(phone, text), "_blank");
  markWhatsAppSent(customer);
  renderDashboardReceivables();
  successSound();
}

function sendPaymentWhatsApp(customer) {
  const msg = promptPaymentMessage(customer);
  if (!msg) return;
  sendCustomWhatsAppText(customer, msg.text);
}

async function sendTextSms(customer, text = "") {
  const phone = phoneForWhatsApp(customer.mobile || customer.Mobile);
  if (!phone) {
    alert("No mobile number found for this customer.");
    return;
  }
  const message = text || hinglishMessage(customer);
  try {
    const res = await fetch("/api/send-sms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "7588756668", to: `+${phone}`, text: message, customerCode: customer.customerCode || "" })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.sent) throw new Error(payload.error || "SMS sender not connected");
    markSmsSent(customer);
    renderDashboardReceivables();
    successSound();
    alert("SMS sent.");
  } catch (error) {
    window.location.href = smsUrl(phone, message);
    markSmsSent(customer);
    renderDashboardReceivables();
    tapSound();
    alert("Auto SMS sender is not connected yet. Your phone SMS app opened with the message ready; tap Send there.");
  }
}

function sendPaymentSms(customer) {
  const msg = promptPaymentMessage(customer);
  if (!msg) return;
  sendTextSms(customer, msg.text);
}

function openWhatsAppOptions(customer) {
  state.whatsappCustomer = customer;
  qs("#whatsappTarget").textContent = `${customer.customerName || customer.Name || "Customer"} | ${plainMoney(customer.balance)}`;
  setWhatsappApp(state.whatsappApp);
  setReminderTone(state.reminderTone);
  qs("#whatsappModal").hidden = false;
  updateBackButton();
  if (!restoringNavigation) {
    saveNavigation({ modal: "whatsapp", customerCode: customer.customerCode || "" });
    try { history.pushState({ srReceivables: true, view: state.lastView, modal: "whatsapp", customerCode: customer.customerCode || "" }, "", location.href); } catch (_) {}
  }
  tapSound();
}

async function ensureWhatsappProfile() {
  const customer = state.whatsappCustomer;
  if (!customer) return null;
  if (!state.profile || String(state.profile.summary.customerCode) !== String(customer.customerCode)) {
    await openCustomer(customer.customerCode);
  }
  return state.profile.summary;
}

async function sendWhatsAppWithPng() {
  const p = await ensureWhatsappProfile();
  if (!p) return;
  const blob = await createLedgerPngBlob();
  downloadBlob(blob, ledgerFileName("png"));
  qs("#whatsappModal").hidden = true;
  sendTextWhatsApp({ customerName: p.customerName, mobile: p.Mobile, balance: statementTotals(filteredLedger()).closing });
}

async function sendWhatsAppWithPdf() {
  const p = await ensureWhatsappProfile();
  if (!p) return;
  openLedgerPrint();
  qs("#whatsappModal").hidden = true;
  sendTextWhatsApp({ customerName: p.customerName, mobile: p.Mobile, balance: statementTotals(filteredLedger()).closing });
}

async function sendWhatsAppWithCsv() {
  const p = await ensureWhatsappProfile();
  if (!p) return;
  const blob = createLedgerCsvBlob();
  downloadBlob(blob, ledgerFileName("csv"));
  qs("#whatsappModal").hidden = true;
  sendTextWhatsApp({ customerName: p.customerName, mobile: p.Mobile, balance: statementTotals(filteredLedger()).closing });
}

function sendLedgerWhatsApp() {
  const p = state.profile.summary;
  qs("#exportOptions").hidden = true;
  openWhatsAppOptions({ customerCode: p.customerCode, customerName: p.customerName, mobile: p.Mobile, balance: statementTotals(filteredLedger()).closing });
}

function sendLedgerSms() {
  const p = state.profile.summary;
  qs("#exportOptions").hidden = true;
  sendTextSms({ customerCode: p.customerCode, customerName: p.customerName, mobile: p.Mobile, balance: statementTotals(filteredLedger()).closing });
}

function voiceReminderScript(customer) {
  const name = customer.customerName || customer.Name || "ji";
  const due = spokenRupees(customer.balance);
  return `Assalamualaikum ${name}, S R Fashion Pusad se reminder hai. Aapka ${due} dena pending hai. Agar payment already ho gaya hai to please ignore kar dijiye. Thank you.`;
}

function spokenNumberIndian(value) {
  const ones = ["zero","ek","do","teen","chaar","paanch","chhe","saat","aath","nau","das","gyarah","baarah","terah","chaudah","pandrah","solah","satrah","atharah","unnees"];
  const tens = ["","","bees","tees","chaalis","pachaas","saath","sattar","assi","nabbe"];
  const n = Math.abs(Math.round(amount(value)));
  if (n < 20) return ones[n];
  if (n < 100) {
    const t = Math.floor(n / 10);
    const r = n % 10;
    if (n === 21) return "ikkees";
    if (n === 22) return "baees";
    if (n === 23) return "teis";
    if (n === 24) return "chaubees";
    if (n === 25) return "pachchees";
    if (n === 26) return "chhabbees";
    if (n === 27) return "sattaees";
    if (n === 28) return "atthaees";
    if (n === 29) return "untees";
    if (n === 31) return "ikattis";
    if (n === 32) return "battis";
    if (n === 33) return "taintees";
    if (n === 34) return "chauntees";
    if (n === 35) return "paintees";
    if (n === 36) return "chhattis";
    if (n === 37) return "saintis";
    if (n === 38) return "adtees";
    if (n === 39) return "untaalis";
    if (n === 41) return "iktaalis";
    if (n === 42) return "bayalis";
    if (n === 43) return "taintalis";
    if (n === 44) return "chauwalis";
    if (n === 45) return "paintalis";
    if (n === 46) return "chhiyalis";
    if (n === 47) return "saintalis";
    if (n === 48) return "adtalis";
    if (n === 49) return "unchaas";
    if (n === 51) return "ikyavan";
    if (n === 52) return "bavan";
    if (n === 53) return "tirpan";
    if (n === 54) return "chauvan";
    if (n === 55) return "pachpan";
    if (n === 56) return "chhappan";
    if (n === 57) return "sattavan";
    if (n === 58) return "atthavan";
    if (n === 59) return "unsaath";
    if (n === 61) return "iksath";
    if (n === 62) return "basath";
    if (n === 63) return "tirsath";
    if (n === 64) return "chausath";
    if (n === 65) return "painsath";
    if (n === 66) return "chhiyasath";
    if (n === 67) return "sadsath";
    if (n === 68) return "adsath";
    if (n === 69) return "unhattar";
    if (n === 71) return "ikhattar";
    if (n === 72) return "bahattar";
    if (n === 73) return "tihattar";
    if (n === 74) return "chauhattar";
    if (n === 75) return "pachhattar";
    if (n === 76) return "chhihattar";
    if (n === 77) return "satahattar";
    if (n === 78) return "athhattar";
    if (n === 79) return "unasi";
    if (n === 81) return "ikyasi";
    if (n === 82) return "bayasi";
    if (n === 83) return "tirasi";
    if (n === 84) return "chaurasi";
    if (n === 85) return "pachasi";
    if (n === 86) return "chhiyasi";
    if (n === 87) return "sattasi";
    if (n === 88) return "athasi";
    if (n === 89) return "navasi";
    if (n === 91) return "ikyanve";
    if (n === 92) return "baanve";
    if (n === 93) return "tiranve";
    if (n === 94) return "chauranve";
    if (n === 95) return "panchanve";
    if (n === 96) return "chhiyanve";
    if (n === 97) return "sattanve";
    if (n === 98) return "atthanve";
    if (n === 99) return "ninayanve";
    return tens[t] + (r ? " " + ones[r] : "");
  }
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return `${ones[h]} sau${r ? " " + spokenNumberIndian(r) : ""}`;
  }
  if (n < 100000) {
    const th = Math.floor(n / 1000);
    const r = n % 1000;
    return `${spokenNumberIndian(th)} hazaar${r ? " " + spokenNumberIndian(r) : ""}`;
  }
  if (n < 10000000) {
    const lakh = Math.floor(n / 100000);
    const r = n % 100000;
    return `${spokenNumberIndian(lakh)} lakh${r ? " " + spokenNumberIndian(r) : ""}`;
  }
  const crore = Math.floor(n / 10000000);
  const r = n % 10000000;
  return `${spokenNumberIndian(crore)} crore${r ? " " + spokenNumberIndian(r) : ""}`;
}

function spokenRupees(value) {
  return `${spokenNumberIndian(value)} rupaye`;
}

function voiceFileName(customer, type = "voice") {
  const name = clean(customer.customerName || customer.Name || "customer")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `sr-fashion-${name || "customer"}-${type}-${inputDate(new Date())}.txt`;
}

function downloadVoiceScript(customer, text, type) {
  const body = [
    "S R Fashion Pusad",
    "Voice / WhatsApp message",
    "",
    text
  ].join("\n");
  downloadBlob(new Blob([body], { type: "text/plain;charset=utf-8" }), voiceFileName(customer, type));
}

function urduVoiceReminderScript(customer) {
  const name = customer.customerName || customer.Name || "ji";
  const due = spokenRupees(customer.balance);
  return `Assalamualaikum ${name}, S R Fashion Pusad se yaad-dihani hai. Aapke zimma ${due} baqi hain. Meherbani karke payment jaldi jama kar dijiye. Agar payment ho chuki hai to is message ko ignore kar dijiye. Shukriya.`;
}

function speakAndCopy(text, lang, message) {
  try {
    speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = lang;
    utter.rate = 0.9;
    speechSynthesis.speak(utter);
  } catch (_) {}
  navigator.clipboard?.writeText(text);
  alert(message);
}

function sendVoiceScript() {
  const customer = state.whatsappCustomer;
  if (!customer) return;
  const text = voiceReminderScript(customer);
  downloadVoiceScript(customer, text, "voice-script");
  speakAndCopy(text, "hi-IN", "Voice-note script copied. It is also playing now if your browser allows speech. Record/send it in WhatsApp or WhatsApp Business.");
  sendCustomWhatsAppText(customer, text);
  qs("#whatsappModal").hidden = true;
}

function sendUrduVoiceScript() {
  const customer = state.whatsappCustomer;
  if (!customer) return;
  const text = urduVoiceReminderScript(customer);
  downloadVoiceScript(customer, text, "urdu-voice");
  speakAndCopy(text, "hi-IN", "Urdu/Hindi voice message copied. It is also playing now with full rupee amount.");
  sendCustomWhatsAppText(customer, text);
  qs("#whatsappModal").hidden = true;
}

function exportDailyClosingPdf() {
  if (!state.salesReport) return openCashParty("day");
  const summary = state.salesReport.summary || {};
  const rows = state.salesReport.rows || [];
  const html = `
    <section class="daily-close-print">
      <h1>SR Fashion Daily Closing</h1>
      <p>${date(state.salesReport.from)} to ${date(state.salesReport.to)}</p>
      <div class="close-grid">
        <span>Bills <b>${amount(summary.billCount)}</b></span>
        <span>Sales <b>${rupees(summary.billAmount)}</b></span>
        <span>Paid <b>${rupees(summary.paidAmount)}</b></span>
        <span>Balance <b>${rupees(summary.balanceAmount)}</b></span>
        <span>Cost <b>${rupees(summary.costPrice)}</b></span>
        <span>Actual Profit <b>${rupees(summary.actualProfit)}</b></span>
      </div>
      <table><thead><tr><th>Invoice</th><th>Customer</th><th>Sale</th><th>Paid</th><th>Profit</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${escapeHtml(clean(r.VchNo))}</td><td>${escapeHtml(clean(r.partyName || "Cash"))}</td><td>${rupees(r.billAmount)}</td><td>${rupees(r.paidAmount)}</td><td>${rupees(r.actualProfit)}</td></tr>`).join("")}
      </tbody></table>
    </section>`;
  const doc = window.open("", "_blank");
  doc.document.write(`<!doctype html><html><head><title>daily-closing.pdf</title><style>@page{size:A4;margin:10mm}body{font-family:Arial,sans-serif;color:#111}.daily-close-print h1{margin:0}.daily-close-print p{margin:4px 0 12px}.close-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}.close-grid span{border:1px solid #ddd;border-radius:8px;padding:10px}.close-grid b{display:block;font-size:18px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border-bottom:1px solid #ddd;padding:6px;text-align:left}th{background:#f3f4f6}</style></head><body>${html}<script>window.onload=()=>setTimeout(()=>window.print(),250)</script></body></html>`);
  doc.document.close();
  exportSound();
}

function createLedgerCsvBlob() {
  const rows = filteredLedger();
  const csv = [["Date", "Particulars", "Voucher No", "Kharidi", "Jama", "Running Balance", "Narration"], ...rows.map(r => {
    const value = amount(r.amount);
    return [date(r.Date), r.VchType || "", r.VchNo || "", value > 0 ? value : "", value < 0 ? Math.abs(value) : "", amount(r.runningBalance), r.narration || ""];
  })].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  return new Blob([csv], { type: "text/csv;charset=utf-8" });
}

function exportLedgerCsv() {
  downloadBlob(createLedgerCsvBlob(), ledgerFileName("csv"));
  qs("#exportOptions").hidden = true;
  successSound();
}

document.addEventListener("click", event => {
  tapSound();
  const nav = event.target.closest(".nav-btn");
  if (nav?.dataset.view) showView(nav.dataset.view);
  if (event.target.closest("#menuToggle")) openMenu();
  if (event.target.closest("#appBack")) goAppBack(true);
  if (event.target.closest("#sidebarShade")) closeMenu();
  if (event.target.closest(".homeBtn")) showView("dashboard");
  if (event.target.closest("#homeBrand") || event.target.closest(".brand")) showView("dashboard");
  if (event.target.closest("#menuControlCenter")) {
    openControlCenter();
  }
  if (event.target.closest("#menuAllCustomers")) {
    openCustomerFilter("all");
  }
  if (event.target.closest("#menuDebtCustomers")) {
    openCustomerFilter("debt");
  }
  if (event.target.closest("#menuAdvanceCustomers")) {
    openCustomerFilter("advance");
  }
  if (event.target.closest("#menuMonthlySales")) {
    showView("dashboard");
    qs("#monthlySalesPanel").hidden = false;
    qs("#monthlySalesPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (event.target.closest("#menuDailyClosing")) {
    openCashParty("day");
  }
  if (event.target.closest("#menuVoiceMode")) {
    openVoiceMode();
  }
  if (event.target.closest("#menuOfflineCenter")) {
    openOfflineCenter();
  }
  if (event.target.closest("#voiceListenBtn")) {
    startReceivableVoiceCommand();
  }
  if (event.target.closest("#menuCustomerRisk")) {
    openCustomerRiskReport();
  }
  if (event.target.closest("#menuAreaRecovery")) {
    openAreaRecoveryReport();
  }
  if (event.target.closest("#menuFollowupLog")) {
    openFollowupLog();
  }
  if (event.target.closest("#menuOwnerBrief")) {
    openOwnerBrief();
  }
  if (event.target.closest("#dailyClosingPdf")) {
    exportDailyClosingPdf();
  }
  if (event.target.closest("#promisePayBtn")) {
    setPromisePay();
  }
  if (event.target.closest("#localPayBtn")) {
    setLocalPaymentNote();
  }
  if (event.target.closest("#holdReminderBtn")) {
    toggleHoldReminder();
  }
  if (event.target.closest("#quickDebt")) {
    openCustomerFilter("debt");
  }
  if (event.target.closest("#quickAll")) {
    openCustomerFilter("all");
  }
  if (event.target.closest("#quickProfitToday")) {
    openCashParty("day");
  }
  if (event.target.closest("#showMoreCustomers")) {
    state.customerVisibleLimit += 35;
    renderCustomers();
  }
  if (event.target.closest("#cashMenuToggle")) {
    qs("#cashSubmenu").hidden = !qs("#cashSubmenu").hidden;
  }
  if (event.target.closest("#cashPartyDay")) {
    openCashParty("day");
  }
  if (event.target.closest("#cashPartyMonth") || event.target.closest("#cashPartyBtn")) {
    openCashParty("month");
  }
  if (event.target.closest("#cashPartyYear")) {
    openCashParty("year");
  }
  if (event.target.closest("#exportToggle")) {
    qs("#exportOptions").hidden = !qs("#exportOptions").hidden;
  }
  const kpi = event.target.closest("[data-kpi-filter]");
  if (kpi) openCustomerFilter(kpi.dataset.kpiFilter);
  if (event.target.closest("#silentWarnings")) {
    localStorage.setItem("retailDaddyWarningsSilentUntil", inputDate(new Date()));
    renderWarningBox();
  }
  const waCode = event.target.closest("[data-wa-code]");
  if (waCode) {
    event.stopPropagation();
    const c = state.customers.find(row => String(row.customerCode) === String(waCode.dataset.waCode));
    if (c) openWhatsAppOptions(c);
  }
  const smsCode = event.target.closest("[data-sms-code]");
  if (smsCode) {
    event.stopPropagation();
    const c = state.customers.find(row => String(row.customerCode) === String(smsCode.dataset.smsCode));
    if (c) sendTextSms(c);
  }
  const billTarget = event.target.closest("[data-bill]");
  if (billTarget) {
    event.preventDefault();
    event.stopPropagation();
    openBill(billTarget.dataset.bill);
    return;
  }
  const customerRow = event.target.closest("tr[data-code]");
  if (customerRow && !event.target.closest("button")) openCustomer(customerRow.dataset.code);
  const customerCard = event.target.closest("button[data-code]");
  if (customerCard && !event.target.closest("[data-wa-code]")) openCustomer(customerCard.dataset.code);
  const tab = event.target.closest(".tab");
  if (tab) {
    state.activeTab = tab.dataset.tab;
    renderProfile();
  }
  const sortHead = event.target.closest("[data-sort]");
  if (sortHead) {
    const name = sortHead.dataset.sortName;
    const current = state.tabSort[name] || {};
    state.tabSort[name] = { key: sortHead.dataset.sort, dir: current.key === sortHead.dataset.sort && current.dir === "asc" ? "desc" : "asc" };
    if (name === "dashboardReceivables") renderDashboardReceivables();
    else if (state.salesReport) renderSalesReport();
    else renderTab();
  }
  const customerSort = event.target.closest("[data-customer-sort]");
  if (customerSort) {
    const key = customerSort.dataset.customerSort;
    state.customerSort = { key, dir: state.customerSort.key === key && state.customerSort.dir === "asc" ? "desc" : "asc" };
    renderCustomers();
  }
});

document.addEventListener("keydown", event => {
  const tag = document.activeElement?.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  if (event.altKey && event.key.toLowerCase() === "l") {
    event.preventDefault();
    showView("customers");
    qs("#searchBox").focus();
  }
  if (event.key === "Escape") {
    if (document.body.classList.contains("sidebar-open") || !qs("#whatsappModal").hidden || !qs("#billModal").hidden || state.lastView !== "dashboard") goAppBack(false);
  }
  if (event.key === "Backspace" && !typing) {
    event.preventDefault();
    goAppBack(false);
  }
});

["searchBox", "statusFilter", "customerFrom", "customerTo", "minBalance"].forEach(id => qs(`#${id}`).addEventListener("input", () => {
  state.customerVisibleLimit = 35;
  renderCustomers();
}));
qs("#clearFilters").addEventListener("click", () => {
  ["searchBox", "customerFrom", "customerTo", "minBalance"].forEach(id => { qs(`#${id}`).value = ""; });
  qs("#statusFilter").value = "all";
  state.customerVisibleLimit = 35;
  renderCustomers();
});
qs("#themeToggle").addEventListener("click", toggleTheme);
qs("#quickTheme").addEventListener("click", toggleTheme);
async function openCashParty(period = "month") {
  const now = new Date();
  let from = inputDate(new Date(now.getFullYear(), now.getMonth(), 1));
  let to = inputDate(now);
  if (period === "day") {
    from = qs("#cashDayDate").value || inputDate(now);
    to = from;
  }
  if (period === "year") {
    from = inputDate(new Date(now.getFullYear(), 0, 1));
  }
  if (period === "month") {
    const monthFrom = qs("#cashMonthFrom").value || inputDate(now).slice(0, 7);
    const monthTo = qs("#cashMonthTo").value || monthFrom;
    const [fromYear, fromMonth] = monthFrom.split("-").map(Number);
    const [toYear, toMonth] = monthTo.split("-").map(Number);
    from = inputDate(new Date(fromYear, fromMonth - 1, 1));
    to = inputDate(new Date(toYear, toMonth, 0));
    if (from > to) {
      from = inputDate(new Date(toYear, toMonth - 1, 1));
      to = inputDate(new Date(fromYear, fromMonth, 0));
      qs("#cashMonthFrom").value = monthTo;
      qs("#cashMonthTo").value = monthFrom;
    }
  }
  if (period === "year") {
    to = inputDate(now);
  }
  state.cashPeriod = period === "day" ? "Day" : period === "year" ? "Yearly" : "Monthly";
  state.ledgerFrom = from;
  state.ledgerTo = to;
  qs("#ledgerFrom").value = state.ledgerFrom;
  qs("#ledgerTo").value = state.ledgerTo;
  try {
    const [summary, rows] = await api(`/api/sales-report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    state.profile = null;
    state.activeTab = "sales";
    state.salesReport = {
      period,
      periodLabel: period === "day" ? "Day" : period === "year" ? "Yearly" : "Monthly",
      from,
      to,
      summary: summary[0] || {},
      rows: rows || []
    };
    renderProfile();
    showView("profile");
    saveNavigation();
    if (!restoringNavigation) {
      try { history.replaceState({ srReceivables: true, view: "profile", salesReport: { period, from, to } }, "", location.href); } catch (_) {}
    }
  } catch (error) {
    alert(`Could not load Retail Daddy sales report: ${error.message}`);
  }
}

function refreshFromPull() {
  const hint = qs("#pullRefreshHint");
  hint.textContent = "Refreshing...";
  hint.classList.add("active");
  init().finally(() => {
    setTimeout(() => {
      hint.textContent = "Pull down to refresh";
      hint.classList.remove("active");
    }, 700);
  });
}

window.addEventListener("touchstart", event => {
  if (window.scrollY === 0) {
    state.touchStartY = event.touches[0].clientY;
    state.pulling = true;
  }
}, { passive: true });

window.addEventListener("touchmove", event => {
  if (!state.pulling) return;
  const distance = event.touches[0].clientY - state.touchStartY;
  qs("#pullRefreshHint").classList.toggle("ready", distance > 80);
}, { passive: true });

window.addEventListener("touchend", event => {
  if (!state.pulling) return;
  state.pulling = false;
  const distance = event.changedTouches[0].clientY - state.touchStartY;
  qs("#pullRefreshHint").classList.remove("ready");
  if (distance > 80 && window.scrollY === 0) refreshFromPull();
});

qs("#backToCustomers").addEventListener("click", () => showView("customers"));
qs("#closeBill").addEventListener("click", () => { qs("#billModal").hidden = true; updateBackButton(); });
qs("#billPdf").addEventListener("click", exportBillPdf);
qs("#billPng").addEventListener("click", exportBillPng);
qs("#exportContactsVcf").addEventListener("click", exportContactsVcf);
qs("#exportContactsCsv").addEventListener("click", exportContactsCsv);
if (qs("#applyLedger")) qs("#applyLedger").addEventListener("click", setLedgerFilters);
["ledgerFrom", "ledgerTo", "ledgerSearch"].forEach(id => qs(`#${id}`)?.addEventListener("input", setLedgerFilters));
qs("#ledgerPdf").addEventListener("click", exportLedgerPdf);
qs("#ledgerPng").addEventListener("click", exportLedgerPng);
qs("#ledgerCsv").addEventListener("click", exportLedgerCsv);
qs("#ledgerWhatsApp").addEventListener("click", sendLedgerWhatsApp);
qs("#ledgerSms").addEventListener("click", sendLedgerSms);
qs("#closeWhatsApp").addEventListener("click", () => { qs("#whatsappModal").hidden = true; updateBackButton(); });
qs("#waAppBusiness").addEventListener("click", () => setWhatsappApp("business"));
qs("#waAppStandard").addEventListener("click", () => setWhatsappApp("standard"));
qs("#waToneSoft").addEventListener("click", () => setReminderTone("soft"));
qs("#waToneMedium").addEventListener("click", () => setReminderTone("medium"));
qs("#waToneStrong").addEventListener("click", () => setReminderTone("strong"));
qs("#sendTextOnly").addEventListener("click", () => {
  if (state.whatsappCustomer) sendTextWhatsApp(state.whatsappCustomer);
  qs("#whatsappModal").hidden = true;
});
qs("#sendSmsOnly").addEventListener("click", () => {
  if (state.whatsappCustomer) sendTextSms(state.whatsappCustomer);
  qs("#whatsappModal").hidden = true;
});
qs("#sendPaymentWhatsapp").addEventListener("click", () => {
  if (state.whatsappCustomer) sendPaymentWhatsApp(state.whatsappCustomer);
  qs("#whatsappModal").hidden = true;
});
qs("#sendPaymentSms").addEventListener("click", () => {
  if (state.whatsappCustomer) sendPaymentSms(state.whatsappCustomer);
  qs("#whatsappModal").hidden = true;
});
qs("#sendTextPng").addEventListener("click", sendWhatsAppWithPng);
qs("#sendTextPdf").addEventListener("click", sendWhatsAppWithPdf);
qs("#sendTextCsv").addEventListener("click", sendWhatsAppWithCsv);
qs("#sendVoiceScript").addEventListener("click", sendVoiceScript);
qs("#sendUrduVoiceScript").addEventListener("click", sendUrduVoiceScript);
async function init() {
  applyTheme();
  installDatePickers();
  registerServiceWorker();
  qs("#cashDayDate").value ||= inputDate(new Date());
  const thisMonth = inputDate(new Date()).slice(0, 7);
  qs("#cashMonthFrom").value ||= thisMonth;
  qs("#cashMonthTo").value ||= thisMonth;
  if (isFileMode) {
    qs("#dbStatus").innerHTML = `Open the live app at <a href="http://localhost:3020">http://localhost:3020</a>`;
    qs("#kpis").innerHTML = card("Live Data", "Use localhost");
    qs("#customerRows").innerHTML = "";
    return;
  }
  qs("#dbStatus").textContent = "Loading live Retail Daddy data...";
  try {
    await loadKpis();
    qs("#dbStatus").textContent = "Loading customers and receivables...";
    await loadCustomers();
    qs("#dbStatus").textContent = `Connected to Retail Daddy on ${new Date().toLocaleString("en-IN")}`;
    await restoreSavedNavigation();
    welcomeSound();
  } catch (error) {
    await loadCachedDashboard(error);
    await restoreSavedNavigation();
    openSound();
  }
}

init().catch(error => {
  qs("#dbStatus").textContent = `No live or saved Retail Daddy data found: ${error.message}`;
});
