// FlexFlix 2026 - Calendario de reservas (hora Argentina)
// Fuente de datos: hoja de Google Sheets publicada como CSV.
// Cada "horario" = fecha + bloque horario. Un horario ya reservado no puede volver a elegirse.
// Reservas disponibles solo de lunes a viernes.

const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRNCDg-VXEE-3ownBUr7ALGJiDSaobqGj1JYe9IOGUHh-dLjqQIySBIoT0EOiNjjCNbjI-opVdUgQvL/pub?gid=189689314&single=true&output=csv";
const FORM_BASE = "https://docs.google.com/forms/d/e/1FAIpQLScVKS-JhuCPqBCEe5tbcb4PNtCaEh7aiwsvUoo6S9-4A-m4Gw/viewform";
const ENTRY_DATE = "entry.836778582";
const ENTRY_TIME = "entry.1806573509";
const TIMEZONE = "America/Argentina/Buenos_Aires";
const YEAR = 2026;

// Bloques horarios de clase (hora Argentina). "start" es lo que se envia al formulario.
const TIME_SLOTS = [
  { start: "07:30", label: "07:30 a 09:00" },
  { start: "09:00", label: "09:00 a 10:20" },
  { start: "10:30", label: "10:30 a 11:50" },
  { start: "12:00", label: "12:00 a 13:10" }
];

const DAY_NAMES = ["Dom","Lun","Mar","Mie","Jue","Vie","Sab"];
const MONTH_NAMES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

let reservedSet = new Set();
let currentView = "month";
let currentMonth = { y: YEAR, m: 0 };
let weekStartMs = null; // lunes de la semana actual
let selectedDateIso = null;
let pendingKey = null;

function pad(n) { return String(n).padStart(2, "0"); }

function argNowParts() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const parts = fmt.formatToParts(new Date());
  const o = {};
  parts.forEach(p => { if (p.type !== "literal") o[p.type] = p.value; });
  return { y: +o.year, m: +o.month - 1, d: +o.day, hh: +o.hour, mm: +o.minute };
}

function dayKey(y, m, d) { return Date.UTC(y, m, d); }

function isoOf(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; }

function weekdayOf(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(dayKey(y, m - 1, d)).getUTCDay(); // 0=Dom ... 6=Sab
}

function isBusinessDay(iso) {
  const wd = weekdayOf(iso);
  return wd >= 1 && wd <= 5;
}

function formatIsoHuman(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${pad(d)}/${pad(m)}/${y}`;
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* ignore */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function normalizeDateDMY(str) {
  if (!str) return null;
  const m = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const d = +m[1], mo = +m[2], y = +m[3];
  return isoOf(y, mo - 1, d);
}

function normalizeTime(str) {
  if (!str) return null;
  const m = str.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return `${pad(+m[1])}:${m[2]}`;
}

async function loadReservations() {
  try {
    const res = await fetch(CSV_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    const rows = parseCSV(text).filter(r => r.length > 1);
    rows.shift(); // header
    const set = new Set();
    rows.forEach(r => {
      const iso = normalizeDateDMY(r[5]);
      const time = normalizeTime(r[6]);
      if (iso && time) set.add(iso + "|" + time);
    });
    reservedSet = set;
    const loadingMsg = document.getElementById("loadingMsg");
    if (loadingMsg) loadingMsg.style.display = "none";
    renderCurrentView();
    if (selectedDateIso) renderDaySlots(selectedDateIso);
    checkPendingConflict();
  } catch (e) {
    const loadingMsg = document.getElementById("loadingMsg");
    if (loadingMsg) {
      loadingMsg.style.display = "block";
      loadingMsg.textContent = "No se pudieron cargar las reservas desde Google Sheets. Reintentando...";
    }
  }
}

function isSlotAvailable(iso, start, todayIso, nowMinutes) {
  const key = iso + "|" + start;
  if (reservedSet.has(key)) return false;
  if (iso === todayIso) {
    const [hh, mm] = start.split(":").map(Number);
    if (hh * 60 + mm <= nowMinutes) return false;
  }
  return true;
}

function isPastDay(iso, todayIso) { return iso < todayIso; }

function renderCurrentView() {
  if (currentView === "month") renderMonth(); else renderWeek();
}

function renderMonth() {
  document.getElementById("monthTable").style.display = "";
  document.getElementById("weekGrid").style.display = "none";
  document.getElementById("monthNav").style.display = "flex";
  document.getElementById("weekNav").style.display = "none";

  const { y, m, d: todayD, hh, mm } = argNowParts();
  const todayIso = isoOf(y, m, todayD);
  const nowMinutes = hh * 60 + mm;

  document.getElementById("monthLabel").textContent = `${MONTH_NAMES[currentMonth.m]} ${currentMonth.y}`;

  const firstDay = new Date(dayKey(currentMonth.y, currentMonth.m, 1));
  const startWeekday = firstDay.getUTCDay();
  const daysInMonth = new Date(dayKey(currentMonth.y, currentMonth.m + 1, 0)).getUTCDate();

  const tbody = document.getElementById("calendarBody");
  tbody.innerHTML = "";
  let cellCount = 0;
  let row = document.createElement("tr");

  for (let i = 0; i < startWeekday; i++) {
    const td = document.createElement("td");
    td.className = "empty";
    row.appendChild(td);
    cellCount++;
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const iso = isoOf(currentMonth.y, currentMonth.m, d);
    const td = document.createElement("td");
    const past = isPastDay(iso, todayIso);
    const businessDay = isBusinessDay(iso);

    if (!businessDay) {
      td.className = "weekend";
    } else {
      const freeCount = TIME_SLOTS.filter(t => isSlotAvailable(iso, t.start, todayIso, nowMinutes)).length;
      if (past) td.className = "past";
      else if (freeCount === 0) td.className = "day-full";
      else td.className = "day-available";
    }

    if (iso === todayIso) td.className += " today";
    if (iso === selectedDateIso) td.className += " selected-day";

    const numSpan = document.createElement("span");
    numSpan.className = "day-num";
    numSpan.textContent = d;
    td.appendChild(numSpan);

    const infoSpan = document.createElement("span");
    infoSpan.className = "day-info";
    if (!businessDay) {
      infoSpan.textContent = "No habil";
    } else {
      const freeCount = TIME_SLOTS.filter(t => isSlotAvailable(iso, t.start, todayIso, nowMinutes)).length;
      infoSpan.textContent = past ? "Pasado" : (freeCount === 0 ? "Completo" : `${freeCount}/${TIME_SLOTS.length} libres`);
    }
    td.appendChild(infoSpan);

    if (businessDay && !past) {
      td.addEventListener("click", () => {
        selectedDateIso = iso;
        renderMonth();
        renderDaySlots(iso);
        document.getElementById("daySlots").scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }

    row.appendChild(td);
    cellCount++;
    if (cellCount % 7 === 0) { tbody.appendChild(row); row = document.createElement("tr"); }
  }

  while (cellCount % 7 !== 0) {
    const td = document.createElement("td");
    td.className = "empty";
    row.appendChild(td);
    cellCount++;
  }
  if (row.children.length) tbody.appendChild(row);
}

function startOfWeekMondayMs(ms) {
  const dt = new Date(ms);
  const weekday = dt.getUTCDay(); // 0=Dom
  const diff = weekday === 0 ? 6 : weekday - 1; // dias desde el lunes
  return ms - diff * 86400000;
}

function renderWeek() {
  document.getElementById("monthTable").style.display = "none";
  document.getElementById("weekGrid").style.display = "block";
  document.getElementById("monthNav").style.display = "none";
  document.getElementById("weekNav").style.display = "flex";

  const { y, m, d: todayD, hh, mm } = argNowParts();
  const todayIso = isoOf(y, m, todayD);
  const nowMinutes = hh * 60 + mm;

  if (weekStartMs === null) {
    weekStartMs = startOfWeekMondayMs(dayKey(y, m, todayD));
  }

  const days = [];
  for (let i = 0; i < 5; i++) { // Lunes a viernes
    const ms = weekStartMs + i * 86400000;
    const dt = new Date(ms);
    days.push({ y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate(), iso: isoOf(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) });
  }

  const first = days[0], last = days[4];
  document.getElementById("weekLabel").textContent =
    `${pad(first.d)}/${pad(first.m + 1)} - ${pad(last.d)}/${pad(last.m + 1)}/${last.y}`;

  const table = document.createElement("table");
  table.className = "week";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.appendChild(document.createElement("th"));
  days.forEach((day, idx) => {
    const th = document.createElement("th");
    th.textContent = `${DAY_NAMES[idx + 1]} ${pad(day.d)}/${pad(day.m + 1)}`;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  TIME_SLOTS.forEach(slot => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = slot.label;
    tr.appendChild(th);
    days.forEach(day => {
      const td = document.createElement("td");
      const past = isPastDay(day.iso, todayIso) || (day.iso === todayIso && (() => {
        const [hh2, mm2] = slot.start.split(":").map(Number);
        return hh2 * 60 + mm2 <= nowMinutes;
      })());
      const key = day.iso + "|" + slot.start;
      const reserved = reservedSet.has(key);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slot-btn";
      if (past) { btn.classList.add("past"); btn.disabled = true; btn.textContent = "-"; }
      else if (reserved) {
        btn.classList.add("reserved");
        btn.textContent = "No disponible";
        btn.addEventListener("click", () => showSorry(day.iso, slot));
      } else {
        if (pendingKey === key) btn.classList.add("selected");
        btn.textContent = "Disponible";
        btn.addEventListener("click", () => attemptReserve(day.iso, slot));
      }
      td.appendChild(btn);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  const container = document.getElementById("weekGrid");
  container.innerHTML = "";
  container.appendChild(table);
}

function renderDaySlots(iso) {
  const { y, m, d: todayD, hh, mm } = argNowParts();
  const todayIso = isoOf(y, m, todayD);
  const nowMinutes = hh * 60 + mm;

  const container = document.getElementById("daySlots");
  container.innerHTML = "";

  if (!isBusinessDay(iso)) {
    const p = document.createElement("p");
    p.textContent = "Los fines de semana no hay reservas disponibles. Elegi un dia de lunes a viernes.";
    container.appendChild(p);
    return;
  }

  const h3 = document.createElement("h3");
  h3.textContent = `Horarios para el ${formatIsoHuman(iso)} (hora Argentina)`;
  container.appendChild(h3);

  const list = document.createElement("div");
  list.className = "slots-list";
  TIME_SLOTS.forEach(slot => {
    const key = iso + "|" + slot.start;
    const reserved = reservedSet.has(key);
    const past = isPastDay(iso, todayIso) || (iso === todayIso && (() => {
      const [hh2, mm2] = slot.start.split(":").map(Number);
      return hh2 * 60 + mm2 <= nowMinutes;
    })());
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slot-btn";
    if (past) { btn.classList.add("past"); btn.disabled = true; btn.textContent = slot.label + " - pasado"; }
    else if (reserved) {
      btn.classList.add("reserved");
      btn.textContent = slot.label + " - no disponible";
      btn.addEventListener("click", () => showSorry(iso, slot));
    } else {
      if (pendingKey === key) btn.classList.add("selected");
      btn.textContent = slot.label + " - disponible";
      btn.addEventListener("click", () => attemptReserve(iso, slot));
    }
    list.appendChild(btn);
  });
  container.appendChild(list);
}

function showSorry(iso, slot) {
  const status = document.getElementById("status");
  status.className = "error";
  status.textContent = `Lo siento, el horario ${slot.label} del ${formatIsoHuman(iso)} ya fue reservado (no disponible). Por favor elegi otro horario disponible.`;
  status.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function attemptReserve(iso, slot) {
  await loadReservations();
  const key = iso + "|" + slot.start;
  if (reservedSet.has(key)) {
    showSorry(iso, slot);
    if (selectedDateIso) renderDaySlots(selectedDateIso);
    renderCurrentView();
    return;
  }
  pendingKey = key;
  const iframe = document.getElementById("formFrame");
  iframe.src = `${FORM_BASE}?embedded=true&${ENTRY_DATE}=${iso}&${ENTRY_TIME}=${slot.start}`;
  const status = document.getElementById("status");
  status.className = "success";
  status.textContent = `Horario seleccionado: ${slot.label} del ${formatIsoHuman(iso)} (hora Argentina). Completa tus datos en el formulario de abajo para confirmar la reserva.`;
  if (selectedDateIso) renderDaySlots(selectedDateIso);
  renderCurrentView();
  iframe.scrollIntoView({ behavior: "smooth", block: "start" });
}

function checkPendingConflict() {
  if (!pendingKey) return;
  if (reservedSet.has(pendingKey)) {
    pendingKey = null;
  }
}

function clampMonth() {
  if (currentMonth.y < YEAR) { currentMonth.y = YEAR; currentMonth.m = 0; }
  if (currentMonth.y > YEAR) { currentMonth.y = YEAR; currentMonth.m = 11; }
  if (currentMonth.m < 0) currentMonth.m = 0;
  if (currentMonth.m > 11) currentMonth.m = 11;
}

function initViewToggle() {
  document.getElementById("viewMonthBtn").addEventListener("click", () => {
    currentView = "month";
    document.getElementById("viewMonthBtn").classList.add("active");
    document.getElementById("viewWeekBtn").classList.remove("active");
    renderCurrentView();
  });
  document.getElementById("viewWeekBtn").addEventListener("click", () => {
    currentView = "week";
    document.getElementById("viewWeekBtn").classList.add("active");
    document.getElementById("viewMonthBtn").classList.remove("active");
    renderCurrentView();
  });
}

function initNav() {
  document.getElementById("prevMonth").addEventListener("click", () => {
    currentMonth.m -= 1;
    if (currentMonth.m < 0) { currentMonth.m = 11; currentMonth.y -= 1; }
    clampMonth();
    renderMonth();
  });
  document.getElementById("nextMonth").addEventListener("click", () => {
    currentMonth.m += 1;
    if (currentMonth.m > 11) { currentMonth.m = 0; currentMonth.y += 1; }
    clampMonth();
    renderMonth();
  });
  document.getElementById("prevWeek").addEventListener("click", () => {
    const minWs = startOfWeekMondayMs(dayKey(YEAR, 0, 1));
    const next = weekStartMs - 7 * 86400000;
    weekStartMs = next < minWs ? minWs : next;
    renderWeek();
  });
  document.getElementById("nextWeek").addEventListener("click", () => {
    const maxWs = startOfWeekMondayMs(dayKey(YEAR, 11, 31));
    const next = weekStartMs + 7 * 86400000;
    weekStartMs = next > maxWs ? maxWs : next;
    renderWeek();
  });
}

function init() {
  const { y, m } = argNowParts();
  currentMonth = (y === YEAR) ? { y, m } : { y: YEAR, m: 0 };
  clampMonth();
  initViewToggle();
  initNav();
  renderCurrentView();
  loadReservations();
  setInterval(loadReservations, 30000);
}

document.addEventListener("DOMContentLoaded", init);
