(function () {
  "use strict";

  /* ---------- API helpers ---------- */

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const err = new Error(`Request to ${url} failed (${response.status}): ${text}`);
      err.status = response.status; // lets callers distinguish a 401 (needs re-login) from other failures
      throw err;
    }
    return response.json();
  }

  function isoDate(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // A few table-rendering paths below build rows via innerHTML string
  // concatenation and now need to interpolate a device name — user-controlled
  // input (see the stored-XSS fix in renderDeviceRow) — so escape it first.
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function parseIsoDate(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function parseHHMMToMinutes(s) {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  }

  function formatShortDate(d) {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function formatWeekday(d) {
    return d.toLocaleDateString("en-US", { weekday: "short" });
  }

  function startOfDay(d) {
    const r = new Date(d);
    r.setHours(0, 0, 0, 0);
    return r;
  }

  const today = startOfDay(new Date());

  function mondayOf(d) {
    const r = startOfDay(d);
    const wd = r.getDay(); // 0 Sun .. 6 Sat
    const diff = (wd === 0 ? -6 : 1 - wd);
    r.setDate(r.getDate() + diff);
    return r;
  }

  /* ---------- Safe localStorage wrapper ---------- */
  // localStorage can throw (private browsing, disabled storage, quota) — every
  // call site goes through here so a failure is a silent no-op / fallback
  // rather than an uncaught exception that would break the app.

  function safeGetItem(key) {
    try {
      return localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }
  function safeSetItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      // Ignore — persistence is a nice-to-have, not required for this session to work.
    }
  }
  function safeRemoveItem(key) {
    try {
      localStorage.removeItem(key);
    } catch (err) {
      // Ignore, see safeSetItem.
    }
  }

  /* ---------- State ---------- */

  const DEVICE_STORAGE_KEY = "wtk_selected_device";
  const CORE_HOURS_ONLY_STORAGE_KEY = "wtk_timeline_core_hours_only";
  const DAY_TYPE_STORAGE_KEY = "wtk_day_type";
  const WORK_TYPE_STORAGE_KEY = "wtk_work_type";

  const state = {
    rangeDays: 7,        // used for stat tiles / trend / sessions; "all" resolves to a day count once first-activity is known
    rangeIsAllTime: false,
    rangePreset: null,   // null | "this-week" | "last-week" — a fixed calendar week instead of a trailing day count
    firstActivityDate: null, // Date or null; fetched once at startup
    periodMode: "week",  // "week" | "month"
    displayMode: "totals", // "totals" | "timeline" — timeline is week-only
    weekOffset: 0,        // 0 = current week (Mon-Sun), -1 = previous week, etc.
    monthOffset: 0,       // 0 = current calendar month, -1 = previous month, etc.
    coreHoursStartMinutes: 9 * 60,  // refreshed from settings; used by the timeline chart
    coreHoursEndMinutes: 18 * 60,
    deviceStaleThresholdHours: 24,  // refreshed from settings; used by the device health banner
    selectedDeviceId: safeGetItem(DEVICE_STORAGE_KEY) || "", // "" = all devices combined
    timelineCoreHoursOnly: safeGetItem(CORE_HOURS_ONLY_STORAGE_KEY) === "1", // crop the timeline y-axis to core hours ± 1h
    dayType: safeGetItem(DAY_TYPE_STORAGE_KEY) || "all", // "all" | "weekday" | "weekend"
    workType: safeGetItem(WORK_TYPE_STORAGE_KEY) || "all", // "all" | "work" | "leisure"
  };

  function setSelectedDeviceId(deviceId) {
    state.selectedDeviceId = deviceId || "";
    if (deviceId) {
      safeSetItem(DEVICE_STORAGE_KEY, deviceId);
    } else {
      safeRemoveItem(DEVICE_STORAGE_KEY);
    }
  }

  function setDayType(dayType) {
    state.dayType = dayType || "all";
    safeSetItem(DAY_TYPE_STORAGE_KEY, state.dayType);
  }

  function setWorkType(workType) {
    state.workType = workType || "all";
    safeSetItem(WORK_TYPE_STORAGE_KEY, state.workType);
  }

  function setRangeFromParam(range) {
    state.rangePreset = range === "this-week" || range === "last-week" ? range : null;
    state.rangeIsAllTime = range === "all";
    if (!state.rangeIsAllTime && !state.rangePreset) state.rangeDays = +range;
  }

  // Bounds of a fixed calendar-week preset, expressed the same way the rest of
  // the app expresses ranges: a day count plus an exclusive end date (passed
  // as `?end=` to the stats endpoints; see effectiveRangeEnd()).
  function presetRangeBounds(preset) {
    const monday = mondayOf(today);
    if (preset === "this-week") {
      const days = Math.floor((today - monday) / 86400000) + 1;
      return { days, end: addDaysToToday(1) };
    }
    // last-week
    return { days: 7, end: monday };
  }

  // Reflects the current filter state into the URL (via replaceState, so
  // filter clicks don't pollute browser history) so the dashboard's state can
  // be bookmarked or shared as a link.
  function updateUrlFromState() {
    const params = new URLSearchParams(location.search);
    if (state.workType !== "all") params.set("workType", state.workType);
    else params.delete("workType");

    if (state.rangePreset) params.set("range", state.rangePreset);
    else if (state.rangeIsAllTime) params.set("range", "all");
    else params.set("range", String(state.rangeDays));

    if (state.dayType !== "all") params.set("dayType", state.dayType);
    else params.delete("dayType");

    const query = params.toString();
    history.replaceState(null, "", query ? "?" + query : location.pathname);
  }

  const VALID_WORK_TYPES = ["all", "work", "leisure"];
  const VALID_DAY_TYPES = ["all", "weekday", "weekend"];
  const VALID_RANGES = ["1", "7", "30", "90", "all", "this-week", "last-week"];

  // Applies workType/range/dayType from the URL query string (if present and
  // valid) on top of whatever setDayType/setWorkType already loaded from
  // localStorage above — a shared/bookmarked link is meant to override the
  // viewer's own last-used filters, not just seed a default. Invalid or
  // unrecognized values are ignored, falling back to the localStorage value,
  // so a malformed query string can't put the dashboard in a broken state.
  function bootstrapStateFromUrl() {
    const params = new URLSearchParams(location.search);

    const workType = params.get("workType");
    if (VALID_WORK_TYPES.includes(workType)) setWorkType(workType);

    const dayType = params.get("dayType");
    if (VALID_DAY_TYPES.includes(dayType)) setDayType(dayType);

    const range = params.get("range");
    if (VALID_RANGES.includes(range)) setRangeFromParam(range);
  }

  // Re-syncs the segmented-button / filter-chip aria-pressed state (and the
  // range filter-chips, which don't go through setDayType/setWorkType) after
  // bootstrapStateFromUrl() may have changed state without going through a
  // click handler.
  function syncFilterButtonsFromState() {
    document.querySelectorAll(".filter-chip").forEach(chip => {
      const range = chip.getAttribute("data-range");
      const active = state.rangePreset
        ? range === state.rangePreset
        : state.rangeIsAllTime ? range === "all" : +range === state.rangeDays;
      chip.setAttribute("aria-pressed", active ? "true" : "false");
    });

    document.getElementById("dayTypeGroup").querySelectorAll(".segmented-btn").forEach(btn => {
      btn.setAttribute("aria-pressed", btn.getAttribute("data-day-type") === state.dayType ? "true" : "false");
    });

    document.getElementById("workTypeGroup").querySelectorAll(".segmented-btn").forEach(btn => {
      btn.setAttribute("aria-pressed", btn.getAttribute("data-work-type") === state.workType ? "true" : "false");
    });
  }

  function withDeviceParam(params) {
    if (state.selectedDeviceId) params.set("deviceId", state.selectedDeviceId);
    return params;
  }

  // Every stats endpoint that supports day-of-week scoping shares this —
  // "live" and "first-activity" deliberately don't call it (see their fetch
  // functions below).
  function withStatsParams(params) {
    withDeviceParam(params);
    if (state.dayType !== "all") params.set("dayType", state.dayType);
    if (state.workType !== "all") params.set("workType", state.workType);
    return params;
  }

  /* ---------- Formatting ---------- */

  function fmtHours(h) {
    let hrs = Math.floor(h);
    let mins = Math.round((h - hrs) * 60);
    if (mins === 60) { hrs += 1; mins = 0; }
    return hrs + "h " + String(mins).padStart(2, "0") + "m";
  }

  function fmtMinutes(m) {
    const hrs = Math.floor(m / 60);
    const mins = Math.round(m % 60);
    return hrs > 0 ? hrs + "h " + String(mins).padStart(2, "0") + "m" : mins + "m";
  }

  function deltaHtml(current, previous, higherIsGood) {
    if (previous === 0 && current === 0) return "";
    const diff = current - previous;
    const pct = previous === 0 ? 100 : Math.round((diff / previous) * 100);
    const dir = diff >= 0 ? "up" : "down";
    const good = (diff >= 0) === higherIsGood;
    const arrow = diff >= 0 ? "↑" : "↓";
    return '<span class="delta ' + dir + ' ' + (good ? "good" : "bad") + '">' + arrow + " " + Math.abs(pct) + "% vs prior period</span>";
  }

  function sparklinePath(values, w, h) {
    if (!values.length) return { line: "", lastX: 0, lastY: h / 2 };
    const max = Math.max.apply(null, values.concat([0.001]));
    const stepX = w / (values.length - 1 || 1);
    const pts = values.map((v, i) => [i * stepX, h - (v / max) * h]);
    const d = pts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    const last = pts[pts.length - 1];
    return { line: d, lastX: last[0], lastY: last[1] };
  }

  /* ---------- Tooltip helper ---------- */

  const tooltip = document.getElementById("tooltip");
  const ttLabel = document.getElementById("ttLabel");
  const ttValue = document.getElementById("ttValue");

  function showTooltip(x, y, label, value) {
    tooltip.style.left = x + "px";
    tooltip.style.top = (y - 10) + "px";
    ttLabel.textContent = label;
    ttValue.textContent = value;
    tooltip.classList.add("visible");
  }
  function hideTooltip() { tooltip.classList.remove("visible"); }

  /* ---------- Data fetching ---------- */

  async function fetchSummary(rangeDays, endDate) {
    const params = withStatsParams(new URLSearchParams({ days: String(rangeDays) }));
    if (endDate) params.set("end", isoDate(endDate));
    return fetchJson("/api/stats/summary?" + params.toString());
  }

  async function fetchWeek(mondayDate) {
    const params = withStatsParams(new URLSearchParams({ start: isoDate(mondayDate) }));
    return fetchJson("/api/stats/week?" + params.toString());
  }

  async function fetchWeekTimeline(mondayDate) {
    const params = withStatsParams(new URLSearchParams({ start: isoDate(mondayDate) }));
    return fetchJson("/api/stats/week-timeline?" + params.toString());
  }

  async function fetchMonth(anyDateInMonth) {
    const params = withStatsParams(new URLSearchParams({ month: isoDate(anyDateInMonth) }));
    return fetchJson("/api/stats/month?" + params.toString());
  }

  async function fetchFirstActivity() {
    // Deliberately not day-type-scoped: this anchors the "All time" range
    // filter and should reflect the first activity ever tracked, regardless
    // of which day-of-week filter happens to be selected.
    const params = withDeviceParam(new URLSearchParams());
    const query = params.toString();
    return fetchJson("/api/stats/first-activity" + (query ? "?" + query : ""));
  }

  async function fetchSessions(rangeDays, endDate) {
    const params = withStatsParams(new URLSearchParams({ days: String(rangeDays) }));
    if (endDate) params.set("end", isoDate(endDate));
    return fetchJson("/api/stats/sessions?" + params.toString());
  }

  async function fetchSettings() {
    return fetchJson("/api/settings");
  }

  async function saveSettings(dto) {
    return fetchJson("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dto),
    });
  }

  /* ---------- Stat tiles ---------- */

  async function renderStatTiles() {
    const rangeDays = effectiveRangeDays();
    const rangeEnd = effectiveRangeEnd();
    // Previous-period comparison always covers the same number of days
    // immediately before the current window, whether that window trails from
    // today or is anchored to a fixed preset end date.
    const previousEnd = rangeEnd
      ? new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate() - rangeDays)
      : addDaysToToday(-rangeDays);
    const [current, previous, trendSummary] = await Promise.all([
      fetchSummary(rangeDays, rangeEnd || undefined),
      fetchSummary(rangeDays, previousEnd),
      fetchSummary(12),
    ]);

    const sparkValues = trendSummary.daily.map(d => d.hours);
    const spark = sparklinePath(sparkValues, 96, 28);

    const activeDaysLabel = current.activeDayCount + " / " + current.rangeDayCount;
    const prevActiveDaysLabel = previous.activeDayCount;

    const tiles = [
      {
        label: "Total hours",
        value: fmtHours(current.totalHours),
        deltaHtml: deltaHtml(current.totalHours, previous.totalHours, true),
        spark: true,
      },
      {
        label: "Avg hours / active day",
        value: fmtHours(current.averageHoursPerActiveDay),
        deltaHtml: deltaHtml(current.averageHoursPerActiveDay, previous.averageHoursPerActiveDay, true),
        spark: false,
      },
      {
        label: "Active days",
        value: activeDaysLabel,
        deltaHtml: deltaHtml(current.activeDayCount, prevActiveDaysLabel, true),
        spark: false,
      },
      {
        label: "Longest session",
        value: fmtMinutes(current.longestSessionMinutes),
        deltaHtml: deltaHtml(current.longestSessionMinutes, previous.longestSessionMinutes, true),
        spark: false,
      },
    ];

    const grid = document.getElementById("statGrid");
    grid.innerHTML = "";
    tiles.forEach(t => {
      const tile = document.createElement("div");
      tile.className = "stat-tile";
      const sparkSvg = t.spark
        ? '<svg class="spark" width="96" height="28" viewBox="0 0 96 28"><path d="' + spark.line + '" fill="none" stroke="var(--text-muted)" stroke-width="1.5"/><circle cx="' + spark.lastX.toFixed(1) + '" cy="' + spark.lastY.toFixed(1) + '" r="2.5" fill="var(--series-1)"/></svg>'
        : "";
      const label = document.createElement("div");
      label.className = "label";
      label.textContent = t.label;
      tile.appendChild(label);

      const valueRow = document.createElement("div");
      valueRow.className = "value-row";
      const value = document.createElement("span");
      value.className = "value";
      value.textContent = t.value;
      valueRow.appendChild(value);
      tile.appendChild(valueRow);

      const deltaWrap = document.createElement("div");
      deltaWrap.innerHTML = t.deltaHtml || "";
      if (!t.deltaHtml) deltaWrap.style.height = "16px";
      tile.appendChild(deltaWrap);

      if (sparkSvg) {
        const sparkWrap = document.createElement("div");
        sparkWrap.innerHTML = sparkSvg;
        tile.appendChild(sparkWrap.firstChild);
      }

      grid.appendChild(tile);
    });
  }

  /// Resolves the "All time" filter to a concrete day count once the first tracked
  /// activity date is known; falls back to a generous default before that resolves.
  function effectiveRangeDays() {
    if (state.rangePreset) return presetRangeBounds(state.rangePreset).days;
    if (!state.rangeIsAllTime) return state.rangeDays;
    if (!state.firstActivityDate) return 3650; // nothing tracked yet, or still loading
    const days = Math.floor((today - startOfDay(state.firstActivityDate)) / 86400000) + 1;
    return Math.max(1, days);
  }

  // The fixed exclusive end date a range preset ("this-week"/"last-week")
  // anchors to, or null for the usual trailing-from-today ranges (where every
  // fetch*() call already defaults to ending "tomorrow" server-side).
  function effectiveRangeEnd() {
    return state.rangePreset ? presetRangeBounds(state.rangePreset).end : null;
  }

  function addDaysToToday(offset) {
    const d = new Date(today);
    d.setDate(d.getDate() + offset);
    return d;
  }

  /* ---------- Weekly / monthly bar chart ---------- */

  async function renderWeeklyChart() {
    const isMonth = state.periodMode === "month";
    document.getElementById("periodTitle").textContent = isMonth ? "Monthly overview" : "Weekly overview";

    // Timeline mode is week-only; disable it (falling back to totals) once in month mode.
    document.getElementById("displayModeGroup").classList.toggle("segmented-disabled", isMonth);
    document.querySelectorAll('#displayModeGroup .segmented-btn').forEach(btn => { btn.disabled = isMonth; });
    if (isMonth && state.displayMode === "timeline") {
      state.displayMode = "totals";
      document.querySelectorAll('#displayModeGroup .segmented-btn').forEach(b =>
        b.setAttribute("aria-pressed", b.getAttribute("data-display") === "totals" ? "true" : "false"));
    }

    const totalsSvg = document.getElementById("weeklySvg");
    const timelineSvg = document.getElementById("timelineSvg");
    const showTimeline = !isMonth && state.displayMode === "timeline";
    totalsSvg.style.display = showTimeline ? "none" : "";
    timelineSvg.style.display = showTimeline ? "" : "none";
    document.getElementById("coreHoursOnlyLabel").style.display = showTimeline ? "" : "none";

    let days, rangeLabel;
    if (isMonth) {
      const anchor = new Date(today.getFullYear(), today.getMonth() + state.monthOffset, 1);
      const monthData = await fetchMonth(anchor);
      days = monthData.days.map(d => ({ date: parseIsoDate(d.date), hours: d.hours }));
      rangeLabel = anchor.toLocaleDateString("en-US", { month: "long", year: "numeric" });
      document.getElementById("periodNext").disabled = state.monthOffset >= 0;
    } else {
      const baseMonday = mondayOf(today);
      const monday = new Date(baseMonday);
      monday.setDate(monday.getDate() + state.weekOffset * 7);
      const weekData = await fetchWeek(monday);
      days = weekData.days.map(d => ({ date: parseIsoDate(d.date), hours: d.hours }));
      const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6);
      rangeLabel = formatShortDate(monday) + " – " + formatShortDate(sunday);
      document.getElementById("periodNext").disabled = state.weekOffset >= 0;
    }

    document.getElementById("periodRange").textContent = rangeLabel;
    document.getElementById("periodPrev").disabled = false;

    const periodTotalHours = days.reduce((sum, d) => sum + d.hours, 0);
    const activeDayCount = days.filter(d => d.hours > 0).length;
    const periodAvgHours = activeDayCount > 0 ? periodTotalHours / activeDayCount : 0;
    document.getElementById("weeklySummaryLine").textContent =
      "Total " + fmtHours(periodTotalHours) + " · Avg " + fmtHours(periodAvgHours) + "/day";

    if (showTimeline) {
      await renderTimelineChart();
      return;
    }

    const W = 1040, H = 260;
    const padL = 36, padR = 12, padT = 24, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxHours = Math.max(9, Math.ceil(Math.max.apply(null, days.map(d => d.hours))));
    const targetHours = 8;

    const slotW = plotW / days.length;
    // Bars get thinner as more days share the same width (up to 24px for a week,
    // narrower for a 28-31 day month) — always leaving visible air between bars.
    const barW = Math.min(24, slotW * 0.65);

    function yFor(h) { return padT + plotH - (h / maxHours) * plotH; }

    const svg = document.getElementById("weeklySvg");
    const parts = [];

    const steps = [0, maxHours / 2, maxHours];
    steps.forEach(v => {
      const y = yFor(v);
      parts.push('<line class="gridline" x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '"></line>');
      parts.push('<text class="axis-label" x="' + (padL - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + Math.round(v) + 'h</text>');
    });

    if (targetHours <= maxHours) {
      const ty = yFor(targetHours);
      parts.push('<line class="target-line" x1="' + padL + '" y1="' + ty.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + ty.toFixed(1) + '"></line>');
      parts.push('<text class="target-label" x="' + (W - padR) + '" y="' + (ty - 5).toFixed(1) + '" text-anchor="end">8h target</text>');
    }

    const baseY = yFor(0);
    parts.push('<line class="baseline" x1="' + padL + '" y1="' + baseY.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + baseY.toFixed(1) + '"></line>');

    // Values are shown on hover only (see the tooltip wiring below) — inline labels
    // above every bar would collide once a month's 28-31 bars share this width.
    const labelEvery = isMonth ? Math.max(1, Math.round(days.length / 10)) : 1;

    days.forEach((d, i) => {
      const cx = padL + slotW * i + slotW / 2;
      const x = cx - barW / 2;
      const h = (d.hours / maxHours) * plotH;
      const y = baseY - h;
      const r = Math.min(4, h);
      const todayFlag = startOfDay(d.date).getTime() === today.getTime();

      if (h > 0.5) {
        parts.push(
          '<path class="bar" data-idx="' + i + '" d="M' + x.toFixed(1) + ',' + (y + r).toFixed(1) +
          ' a' + r + ',' + r + ' 0 0 1 ' + r + ',-' + r +
          ' h' + (barW - 2 * r).toFixed(1) +
          ' a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
          ' v' + (h - r).toFixed(1) +
          ' h-' + barW.toFixed(1) + ' z"></path>'
        );
      }

      const axisLabel = isMonth ? String(d.date.getDate()) : formatWeekday(d.date);
      if (i % labelEvery === 0 || i === days.length - 1) {
        parts.push('<text class="axis-label" x="' + cx.toFixed(1) + '" y="' + (baseY + 18).toFixed(1) + '" text-anchor="middle"' +
          (todayFlag ? ' font-weight="600" fill="var(--text-primary)"' : '') + '>' + axisLabel + '</text>');
      }

      parts.push('<rect class="hit-col" tabindex="0" data-idx="' + i + '" x="' + (padL + slotW * i).toFixed(1) + '" y="' + padT + '" width="' + slotW.toFixed(1) + '" height="' + plotH + '"></rect>');
    });

    svg.innerHTML = parts.join("");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label",
      (isMonth ? "Monthly" : "Weekly") + " hours bar chart, " + rangeLabel + ", totaling " + fmtHours(periodTotalHours) + ".");

    function showBarTooltip(idx, clientY) {
      const d = days[idx];
      const svgRect = svg.getBoundingClientRect();
      const scaleX = svgRect.width / W;
      const cx = padL + slotW * idx + slotW / 2;
      const label = isMonth
        ? d.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : formatWeekday(d.date) + ", " + formatShortDate(d.date);
      showTooltip(svgRect.left + cx * scaleX, clientY,
        label, d.hours > 0 ? fmtHours(d.hours) : "No activity");
      svg.querySelectorAll(".bar").forEach(b => b.classList.remove("active"));
      const bar = svg.querySelector('.bar[data-idx="' + idx + '"]');
      if (bar) bar.classList.add("active");
    }
    function hideBarTooltip() {
      hideTooltip();
      svg.querySelectorAll(".bar").forEach(b => b.classList.remove("active"));
    }

    // pointermove/pointerleave cover hover; focus/blur (via the hit-col rects'
    // tabindex="0") give keyboard users the same per-bar tooltip on Tab.
    svg.querySelectorAll(".hit-col").forEach(rect => {
      const idx = +rect.getAttribute("data-idx");
      rect.addEventListener("pointermove", evt => showBarTooltip(idx, evt.clientY));
      rect.addEventListener("pointerleave", hideBarTooltip);
      rect.addEventListener("focus", () => showBarTooltip(idx, rect.getBoundingClientRect().top));
      rect.addEventListener("blur", hideBarTooltip);
    });

    renderWeeklyTable(days);
  }

  function renderWeeklyTable(days) {
    const isMonth = state.periodMode === "month";
    const rows = days.map(d =>
      "<tr><td>" + (isMonth ? d.date.toLocaleDateString("en-US", { month: "short", day: "numeric", weekday: "short" }) : formatWeekday(d.date) + ", " + formatShortDate(d.date)) +
      '</td><td class="num">' + (d.hours > 0 ? fmtHours(d.hours) : "—") + "</td></tr>"
    ).join("");
    document.getElementById("weeklyTableWrap").innerHTML =
      '<table class="data-table"><thead><tr><th>Day</th><th class="num">Hours</th></tr></thead><tbody>' + rows + "</tbody></table>";
  }

  /* ---------- Weekly timeline (24h-per-day) chart ---------- */

  function formatMinutesAsClock(totalMinutes) {
    const m = Math.round(totalMinutes);
    const hrs = Math.floor(m / 60);
    const mins = m % 60;
    return String(hrs).padStart(2, "0") + ":" + String(mins).padStart(2, "0");
  }

  async function renderTimelineChart() {
    const baseMonday = mondayOf(today);
    const monday = new Date(baseMonday);
    monday.setDate(monday.getDate() + state.weekOffset * 7);

    const timelineData = await fetchWeekTimeline(monday);
    const days = timelineData.days.map(d => ({
      date: parseIsoDate(d.date),
      segments: d.segments,
    }));

    const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6);
    document.getElementById("periodRange").textContent = formatShortDate(monday) + " – " + formatShortDate(sunday);
    document.getElementById("periodPrev").disabled = false;
    document.getElementById("periodNext").disabled = state.weekOffset >= 0;

    const W = 1040, H = 320;
    const padL = 36, padR = 12, padT = 12, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;

    const slotW = plotW / 7;
    const trackW = Math.min(48, slotW * 0.55);

    // "Core hours only" crops the y-axis to [coreHoursStart - 1h, coreHoursEnd + 1h]
    // instead of the full day, clamped to the day's own [0, 24h] bounds. Activity
    // outside that window is simply not drawn (clipped below), not auto-expanded —
    // this is a zoom into the usual work window, not a data filter.
    const rangeStart = state.timelineCoreHoursOnly ? Math.max(0, state.coreHoursStartMinutes - 60) : 0;
    const rangeEnd = state.timelineCoreHoursOnly ? Math.min(1440, state.coreHoursEndMinutes + 60) : 1440;
    const rangeSpan = Math.max(1, rangeEnd - rangeStart);

    function yForMinute(minute) { return padT + ((minute - rangeStart) / rangeSpan) * plotH; }

    const svg = document.getElementById("timelineSvg");
    const parts = [];

    // Core-hours band spans the full chart width, behind the day tracks, so the
    // configured core hours (e.g. 09:00–18:00) read as a highlighted reference zone.
    const coreY = yForMinute(state.coreHoursStartMinutes);
    const coreH = yForMinute(state.coreHoursEndMinutes) - coreY;
    if (coreH > 0) {
      parts.push('<rect class="timeline-core-hours" x="' + padL + '" y="' + coreY.toFixed(1) + '" width="' + plotW.toFixed(1) + '" height="' + coreH.toFixed(1) + '"></rect>');
      parts.push('<text class="timeline-core-hours-label" x="' + (W - padR) + '" y="' + (coreY + 11).toFixed(1) + '" text-anchor="end">Core hours</text>');
    }

    // Hour reference lines, recessive like the bar charts' gridlines. Step adapts
    // to how much of the day is visible, so a cropped (core-hours-only) range
    // still gets a handful of gridlines instead of just one or two.
    const hourStep = rangeSpan <= 6 * 60 ? 1 : rangeSpan <= 14 * 60 ? 2 : 4;
    for (let hour = 0; hour <= 24; hour += hourStep) {
      const minute = hour * 60;
      if (minute < rangeStart || minute > rangeEnd) continue;
      const y = yForMinute(minute);
      parts.push('<line class="timeline-hour-line" x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '"></line>');
      parts.push('<text class="axis-label" x="' + (padL - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + String(hour).padStart(2, "0") + '</text>');
    }

    days.forEach((d, i) => {
      const cx = padL + slotW * i + slotW / 2;
      const x = cx - trackW / 2;
      const todayFlag = startOfDay(d.date).getTime() === today.getTime();

      // The visible-range track (idle time), with work segments layered on top.
      const trackR = Math.min(6, trackW / 2);
      parts.push('<rect class="timeline-track" x="' + x.toFixed(1) + '" y="' + padT + '" width="' + trackW.toFixed(1) + '" height="' + plotH.toFixed(1) + '" rx="' + trackR + '"></rect>');

      d.segments.forEach((seg, segIdx) => {
        // Clip to the visible range rather than the segment's own true extent —
        // segments (partially) outside a cropped "core hours only" window are
        // shortened or skipped, but the tooltip below still reports true times.
        const visStart = Math.max(seg.startMinutes, rangeStart);
        const visEnd = Math.min(seg.endMinutes, rangeEnd);
        if (visEnd <= visStart) return;
        const segY = yForMinute(visStart);
        const segH = yForMinute(visEnd) - segY;
        if (segH <= 0) return;
        // Per-segment fill by device (or the neutral overlap gray for
        // simultaneous-device segments); .timeline-segment's CSS fill is only
        // the default/fallback, overridden here. When a single device is
        // already selected via the header filter, every segment trivially
        // has one deviceId, so this resolves to that one color everywhere —
        // visually identical to the old single-color rendering.
        const fill = segmentFillColor(seg);
        parts.push(
          '<rect class="timeline-segment" tabindex="0" data-day-idx="' + i + '" data-seg-idx="' + segIdx + '" x="' + x.toFixed(1) +
          '" y="' + segY.toFixed(1) + '" width="' + trackW.toFixed(1) + '" height="' + segH.toFixed(1) + '" style="fill:' + fill + '"></rect>'
        );
      });

      parts.push('<text class="axis-label" x="' + cx.toFixed(1) + '" y="' + (H - 8).toFixed(1) + '" text-anchor="middle"' +
        (todayFlag ? ' font-weight="600" fill="var(--text-primary)"' : '') + '>' + formatWeekday(d.date) + '</text>');
    });

    svg.innerHTML = parts.join("");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label",
      "Timeline chart of daily work periods, " + formatShortDate(monday) + " – " + formatShortDate(sunday) + ".");

    function showSegmentTooltip(rect, dayIdx, segIdx, clientY) {
      const d = days[dayIdx];
      const seg = d.segments[segIdx];
      const svgRect = svg.getBoundingClientRect();
      const scaleX = svgRect.width / W;
      const cx = padL + slotW * dayIdx + slotW / 2;
      const durationLabel = fmtMinutes(seg.endMinutes - seg.startMinutes);
      const timeLabel = formatMinutesAsClock(seg.startMinutes) + "–" + formatMinutesAsClock(seg.endMinutes);
      // Device name(s) are the accessibility-primary channel for device
      // coloring — the color is a shortcut layered on top of this text, not
      // the only signal, so it's included here even though a color is also shown.
      const deviceLabel = segmentDeviceLabel(seg);
      const valueLabel = timeLabel + " (" + durationLabel + ")" + (deviceLabel ? " · " + deviceLabel : "");
      showTooltip(svgRect.left + cx * scaleX, clientY,
        formatWeekday(d.date) + ", " + formatShortDate(d.date), valueLabel);
      rect.classList.add("active");
    }
    function hideSegmentTooltip(rect) {
      hideTooltip();
      rect.classList.remove("active");
    }

    // pointermove/pointerleave cover hover; focus/blur (via tabindex="0" on each
    // segment rect) give keyboard users the same per-segment tooltip on Tab.
    svg.querySelectorAll(".timeline-segment").forEach(rect => {
      const dayIdx = +rect.getAttribute("data-day-idx");
      const segIdx = +rect.getAttribute("data-seg-idx");
      rect.addEventListener("pointermove", evt => showSegmentTooltip(rect, dayIdx, segIdx, evt.clientY));
      rect.addEventListener("pointerleave", () => hideSegmentTooltip(rect));
      rect.addEventListener("focus", () => showSegmentTooltip(rect, dayIdx, segIdx, rect.getBoundingClientRect().top));
      rect.addEventListener("blur", () => hideSegmentTooltip(rect));
    });

    renderTimelineLegend(days);
    renderTimelineTable(days);
  }

  // Shown above the Timeline chart only in the aggregated ("All devices")
  // view — a specific device selection already has just one color, so
  // there's nothing to key. Only devices that actually appear in the
  // current week's segments get a swatch (not every device on the account),
  // plus an "Overlap" swatch whenever any segment has 2+ deviceIds.
  function renderTimelineLegend(days) {
    const legendEl = document.getElementById("timelineLegend");

    const seenDeviceIds = new Set();
    let hasOverlap = false;
    if (state.selectedDeviceId === "") {
      days.forEach(d => d.segments.forEach(seg => {
        if (!seg.deviceIds || seg.deviceIds.length === 0) return;
        if (seg.deviceIds.length >= 2) hasOverlap = true;
        else seenDeviceIds.add(seg.deviceIds[0]);
      }));
    }

    if (seenDeviceIds.size === 0 && !hasOverlap) {
      legendEl.style.display = "none";
      legendEl.innerHTML = "";
      return;
    }

    legendEl.innerHTML = "";
    devicesCache.forEach((device, idx) => {
      if (!seenDeviceIds.has(device.id)) return;
      const item = document.createElement("div");
      item.className = "legend-item";
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = colorForDeviceIndex(idx);
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(device.name));
      legendEl.appendChild(item);
    });
    if (hasOverlap) {
      const item = document.createElement("div");
      item.className = "legend-item";
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = "var(--overlap)";
      item.appendChild(swatch);
      item.appendChild(document.createTextNode("Overlap"));
      legendEl.appendChild(item);
    }
    legendEl.style.display = "flex";
  }

  function renderTimelineTable(days) {
    const showDeviceColumn = state.selectedDeviceId === "";
    const rows = days.map(d => {
      const segmentsLabel = d.segments.length
        ? d.segments.map(s => formatMinutesAsClock(s.startMinutes) + "–" + formatMinutesAsClock(s.endMinutes)).join(", ")
        : "—";
      const deviceCell = showDeviceColumn
        ? "<td>" + (d.segments.length ? d.segments.map(s => escapeHtml(segmentDeviceLabel(s))).join(", ") : "—") + "</td>"
        : "";
      return "<tr><td>" + formatWeekday(d.date) + ", " + formatShortDate(d.date) + "</td><td>" + segmentsLabel + "</td>" + deviceCell + "</tr>";
    }).join("");
    const deviceHeader = showDeviceColumn ? "<th>Device</th>" : "";
    document.getElementById("weeklyTableWrap").innerHTML =
      '<table class="data-table"><thead><tr><th>Day</th><th>Worked periods</th>' + deviceHeader + '</tr></thead><tbody>' + rows + "</tbody></table>";
  }

  /* ---------- Trend line chart ---------- */

  async function renderTrendChart() {
    const rangeDays = effectiveRangeDays();
    const trendDays = Math.max(rangeDays, 14);
    const summary = await fetchSummary(trendDays, effectiveRangeEnd() || undefined);
    const series = summary.daily.map(d => ({ date: parseIsoDate(d.date), hours: d.hours }));

    document.getElementById("trendCaption").textContent =
      "Last " + trendDays + " days" + (trendDays > rangeDays ? " (extended for readability)" : "");

    const W = 1040, H = 260;
    const padL = 36, padR = 12, padT = 24, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxHours = Math.max(9, Math.ceil(Math.max.apply(null, series.map(d => d.hours))));

    function xFor(i) { return padL + (i / (series.length - 1 || 1)) * plotW; }
    function yFor(h) { return padT + plotH - (h / maxHours) * plotH; }

    const svg = document.getElementById("trendSvg");
    const parts = [];

    const steps = [0, maxHours / 2, maxHours];
    steps.forEach(v => {
      const y = yFor(v);
      parts.push('<line class="gridline" x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '"></line>');
      parts.push('<text class="axis-label" x="' + (padL - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + Math.round(v) + 'h</text>');
    });

    const baseY = yFor(0);
    parts.push('<line class="baseline" x1="' + padL + '" y1="' + baseY.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + baseY.toFixed(1) + '"></line>');

    const linePts = series.map((d, i) => [xFor(i), yFor(d.hours)]);
    const lineD = linePts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    const areaD = series.length
      ? lineD + " L" + linePts[linePts.length - 1][0].toFixed(1) + "," + baseY.toFixed(1) + " L" + linePts[0][0].toFixed(1) + "," + baseY.toFixed(1) + " Z"
      : "";

    if (series.length) {
      parts.push('<path class="trend-area" d="' + areaD + '"></path>');
      parts.push('<path class="trend-line" d="' + lineD + '"></path>');
    }

    const labelEvery = Math.max(1, Math.round(series.length / 6));
    series.forEach((d, i) => {
      if (i % labelEvery === 0 || i === series.length - 1) {
        parts.push('<text class="axis-label" x="' + xFor(i).toFixed(1) + '" y="' + (baseY + 18).toFixed(1) + '" text-anchor="middle">' + formatShortDate(d.date) + '</text>');
      }
    });

    if (series.length) {
      const last = linePts[linePts.length - 1];
      parts.push('<circle class="trend-dot" cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="4"></circle>');
      parts.push('<text class="bar-label" x="' + last[0].toFixed(1) + '" y="' + (last[1] - 10).toFixed(1) + '" text-anchor="end">' + fmtHours(series[series.length - 1].hours) + '</text>');
    }

    parts.push('<line class="crosshair" id="trendCrosshair" x1="0" y1="' + padT + '" x2="0" y2="' + (padT + plotH) + '"></line>');

    const slotW = plotW / (series.length || 1);
    series.forEach((d, i) => {
      parts.push('<rect class="hit-col" tabindex="0" data-idx="' + i + '" x="' + (padL + slotW * i).toFixed(1) + '" y="' + padT + '" width="' + slotW.toFixed(1) + '" height="' + plotH + '"></rect>');
    });

    svg.innerHTML = parts.join("");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Line chart of daily hours worked over the last " + trendDays + " days.");

    const crosshair = svg.querySelector("#trendCrosshair");

    function showTrendTooltip(idx, clientY) {
      const d = series[idx];
      const x = xFor(idx);
      crosshair.setAttribute("x1", x); crosshair.setAttribute("x2", x);
      crosshair.style.opacity = 1;
      const svgRect = svg.getBoundingClientRect();
      const scaleX = svgRect.width / W;
      showTooltip(svgRect.left + x * scaleX, clientY,
        formatWeekday(d.date) + ", " + formatShortDate(d.date), d.hours > 0 ? fmtHours(d.hours) : "No activity");
    }
    function hideTrendTooltip() {
      crosshair.style.opacity = 0;
      hideTooltip();
    }

    // pointermove/pointerleave cover hover; focus/blur (via tabindex="0" on each
    // hit-col rect) give keyboard users the same per-point tooltip on Tab.
    svg.querySelectorAll(".hit-col").forEach(rect => {
      const idx = +rect.getAttribute("data-idx");
      rect.addEventListener("pointermove", evt => showTrendTooltip(idx, evt.clientY));
      rect.addEventListener("pointerleave", hideTrendTooltip);
      rect.addEventListener("focus", () => showTrendTooltip(idx, rect.getBoundingClientRect().top));
      rect.addEventListener("blur", hideTrendTooltip);
    });

    renderTrendTable(series);
  }

  function renderTrendTable(series) {
    const rows = series.map(d =>
      "<tr><td>" + formatWeekday(d.date) + ", " + formatShortDate(d.date) + '</td><td class="num">' + (d.hours > 0 ? fmtHours(d.hours) : "—") + "</td></tr>"
    ).join("");
    document.getElementById("trendTableWrap").innerHTML =
      '<table class="data-table"><thead><tr><th>Day</th><th class="num">Hours</th></tr></thead><tbody>' + rows + "</tbody></table>";
  }

  /* ---------- Session log table ---------- */

  async function renderSessionTable() {
    const sessions = await fetchSessions(effectiveRangeDays(), effectiveRangeEnd() || undefined);

    const CAP = 30;
    const shown = sessions.slice(0, CAP);

    document.getElementById("sessionCaption").textContent =
      sessions.length > CAP
        ? "Showing latest " + CAP + " of " + sessions.length + " sessions in range"
        : sessions.length + " session" + (sessions.length === 1 ? "" : "s") + " in range";

    if (shown.length === 0) {
      document.getElementById("sessionTableWrap").innerHTML =
        '<div class="empty-state">No tracked sessions in this range.</div>';
      return;
    }

    const rows = shown.map(s => {
      const date = parseIsoDate(s.date);
      return "<tr><td>" + formatWeekday(date) + ", " + formatShortDate(date) + "</td><td>" +
        s.start + " – " + s.end + '</td><td class="num">' + fmtMinutes(s.durationMinutes) + "</td></tr>";
    }).join("");

    document.getElementById("sessionTableWrap").innerHTML =
      '<table class="data-table"><thead><tr><th>Day</th><th>Time</th><th class="num">Duration</th></tr></thead><tbody>' + rows + "</tbody></table>";
  }

  /* ---------- Render all ---------- */

  async function renderAll() {
    await Promise.all([
      renderStatTiles(),
      renderWeeklyChart(),
      renderTrendChart(),
      renderSessionTable(),
    ]);
  }

  /* ---------- Wiring: filters ---------- */

  document.querySelectorAll(".filter-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".filter-chip").forEach(c => c.setAttribute("aria-pressed", "false"));
      chip.setAttribute("aria-pressed", "true");
      const range = chip.getAttribute("data-range");
      setRangeFromParam(range);
      updateUrlFromState();
      renderAll();
    });
  });

  const dayTypeGroup = document.getElementById("dayTypeGroup");
  dayTypeGroup.querySelectorAll(".segmented-btn").forEach(btn => {
    if (btn.getAttribute("data-day-type") === state.dayType) {
      dayTypeGroup.querySelectorAll(".segmented-btn").forEach(b => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
    }
    btn.addEventListener("click", () => {
      dayTypeGroup.querySelectorAll(".segmented-btn").forEach(b => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      setDayType(btn.getAttribute("data-day-type"));
      updateUrlFromState();
      renderAll();
    });
  });

  const workTypeGroup = document.getElementById("workTypeGroup");
  workTypeGroup.querySelectorAll(".segmented-btn").forEach(btn => {
    if (btn.getAttribute("data-work-type") === state.workType) {
      workTypeGroup.querySelectorAll(".segmented-btn").forEach(b => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
    }
    btn.addEventListener("click", () => {
      workTypeGroup.querySelectorAll(".segmented-btn").forEach(b => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      setWorkType(btn.getAttribute("data-work-type"));
      updateUrlFromState();
      renderAll();
    });
  });

  /* ---------- Wiring: week/month period navigation & mode toggle ---------- */

  document.getElementById("periodPrev").addEventListener("click", () => {
    if (state.periodMode === "month") state.monthOffset -= 1;
    else state.weekOffset -= 1;
    renderWeeklyChart();
  });
  document.getElementById("periodNext").addEventListener("click", () => {
    if (state.periodMode === "month") {
      if (state.monthOffset < 0) { state.monthOffset += 1; renderWeeklyChart(); }
    } else {
      if (state.weekOffset < 0) { state.weekOffset += 1; renderWeeklyChart(); }
    }
  });

  document.querySelectorAll('[aria-label="Period view"] .segmented-btn').forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll('[aria-label="Period view"] .segmented-btn').forEach(b => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      state.periodMode = btn.getAttribute("data-period");
      renderWeeklyChart();
    });
  });

  const displayModeGroup = document.getElementById("displayModeGroup");
  document.querySelectorAll('#displayModeGroup .segmented-btn').forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll('#displayModeGroup .segmented-btn').forEach(b => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      state.displayMode = btn.getAttribute("data-display");
      renderWeeklyChart();
    });
  });

  const coreHoursOnlyToggle = document.getElementById("coreHoursOnlyToggle");
  coreHoursOnlyToggle.checked = state.timelineCoreHoursOnly;
  coreHoursOnlyToggle.addEventListener("change", () => {
    state.timelineCoreHoursOnly = coreHoursOnlyToggle.checked;
    safeSetItem(CORE_HOURS_ONLY_STORAGE_KEY, state.timelineCoreHoursOnly ? "1" : "0");
    renderWeeklyChart();
  });

  /* ---------- Wiring: table view toggles ---------- */

  // Screen-reader users navigating by button lose the "weekly" vs. "trend"
  // distinction if both buttons just say "View as table" — the aria-label
  // carries the chart name explicitly and is kept in sync with the toggle state.
  const CHART_NAMES_BY_TARGET = { weekly: "weekly overview", trend: "daily hours trend" };

  document.querySelectorAll(".table-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-target");
      const chartName = CHART_NAMES_BY_TARGET[target] || "chart";
      const wrap = document.getElementById(target + "ChartWrap");
      const isTable = wrap.getAttribute("data-view") === "table";
      const willBeTable = !isTable;
      wrap.setAttribute("data-view", willBeTable ? "table" : "chart");
      btn.textContent = willBeTable ? "View as chart" : "View as table";
      btn.setAttribute("aria-label", "View " + chartName + (willBeTable ? " as chart" : " as table"));
    });
  });

  /* ---------- Wiring: theme toggle ---------- */

  const sunPath = '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path>';
  const moonPath = '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"></path>';

  const THEME_STORAGE_KEY = "worktracker-theme";

  function systemPrefersDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function loadStoredTheme() {
    const stored = safeGetItem(THEME_STORAGE_KEY);
    return stored === "dark" || stored === "light" ? stored : null;
  }

  function storeTheme(theme) {
    safeSetItem(THEME_STORAGE_KEY, theme);
  }

  let currentTheme = loadStoredTheme() ?? (systemPrefersDark() ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", currentTheme);

  function updateThemeIcon() {
    document.getElementById("themeIcon").innerHTML = currentTheme === "dark" ? sunPath : moonPath;
  }
  updateThemeIcon();

  document.getElementById("themeToggle").addEventListener("click", () => {
    currentTheme = currentTheme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", currentTheme);
    storeTheme(currentTheme);
    updateThemeIcon();
    renderAll();
  });

  /* ---------- Modal helpers: focus trap + focus restore ---------- */
  // Lightweight, dependency-free focus management shared by every
  // .modal-overlay: move focus into the dialog on open, keep Tab/Shift+Tab
  // cycling inside it while open, and return focus to whatever opened it
  // on close — the accessibility baseline for a modal dialog.

  function getFocusableElements(container) {
    return Array.from(container.querySelectorAll(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(el => el.offsetParent !== null);
  }

  function trapFocus(overlay, evt) {
    if (evt.key !== "Tab") return;
    const modal = overlay.querySelector(".modal");
    const focusables = getFocusableElements(modal);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (evt.shiftKey && document.activeElement === first) {
      evt.preventDefault();
      last.focus();
    } else if (!evt.shiftKey && document.activeElement === last) {
      evt.preventDefault();
      first.focus();
    }
  }

  function setupModalFocusTrap(overlay) {
    overlay.addEventListener("keydown", evt => trapFocus(overlay, evt));
  }

  function openModal(overlay) {
    overlay._returnFocusTo = document.activeElement;
    overlay.classList.add("open");
    const modal = overlay.querySelector(".modal");
    const focusables = getFocusableElements(modal);
    (focusables[0] || modal).focus();
  }

  function closeModal(overlay) {
    overlay.classList.remove("open");
    const returnTo = overlay._returnFocusTo;
    overlay._returnFocusTo = null;
    if (returnTo && typeof returnTo.focus === "function") {
      returnTo.focus();
    }
  }

  ["settingsOverlay", "devicesOverlay", "loginOverlay", "connectionErrorOverlay"].forEach(id => {
    setupModalFocusTrap(document.getElementById(id));
  });

  /* ---------- Wiring: settings modal (dashboard-global: core hours only) ---------- */

  const overlay = document.getElementById("settingsOverlay");
  const coreHoursStartInput = document.getElementById("coreHoursStart");
  const coreHoursEndInput = document.getElementById("coreHoursEnd");
  const deviceStaleThresholdHoursInput = document.getElementById("deviceStaleThresholdHours");
  const toast = document.getElementById("toast");

  function showToast(message, isError) {
    toast.textContent = message;
    toast.classList.toggle("error", !!isError);
    toast.classList.add("visible");
    setTimeout(() => toast.classList.remove("visible"), 1800);
  }

  document.getElementById("settingsToggle").addEventListener("click", async () => {
    try {
      const settings = await fetchSettings();
      coreHoursStartInput.value = settings.coreHoursStart;
      coreHoursEndInput.value = settings.coreHoursEnd;
      deviceStaleThresholdHoursInput.value = settings.deviceStaleThresholdHours;
      openModal(overlay);
    } catch (err) {
      showToast("Could not load settings", true);
    }
  });

  document.getElementById("settingsCancel").addEventListener("click", () => closeModal(overlay));
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(overlay); });

  document.getElementById("settingsSave").addEventListener("click", async () => {
    if (!coreHoursStartInput.value || !coreHoursEndInput.value || coreHoursEndInput.value <= coreHoursStartInput.value) {
      showToast("Core hours end must be after start", true);
      return;
    }
    const staleThresholdHours = Number(deviceStaleThresholdHoursInput.value);
    if (!Number.isFinite(staleThresholdHours) || staleThresholdHours <= 0) {
      showToast("Device stale warning must be a positive number of hours", true);
      return;
    }

    try {
      const saved = await saveSettings({
        coreHoursStart: coreHoursStartInput.value,
        coreHoursEnd: coreHoursEndInput.value,
        deviceStaleThresholdHours: staleThresholdHours,
      });
      state.coreHoursStartMinutes = parseHHMMToMinutes(saved.coreHoursStart);
      state.coreHoursEndMinutes = parseHHMMToMinutes(saved.coreHoursEnd);
      state.deviceStaleThresholdHours = saved.deviceStaleThresholdHours;
      closeModal(overlay);
      showToast("Settings saved");
      renderAll();
      updateDeviceHealthBanner(devicesCache);
    } catch (err) {
      showToast("Could not save settings", true);
    }
  });

  /* ---------- Wiring: devices modal (per-device idle threshold / poll interval) ---------- */

  // Cached here (creation-order sorted, as returned by the API) so the
  // Timeline chart's per-device coloring can reuse whichever device list was
  // last fetched (by the device filter dropdown or the devices modal)
  // instead of adding a redundant fetch on every renderAll(). Updated on
  // every successful fetchDevices() call, from any call site.
  let devicesCache = [];

  async function fetchDevices() {
    const devices = await fetchJson("/api/devices");
    devicesCache = devices;
    return devices;
  }

  // Category color for a device's position in devicesCache (creation order):
  // index 0 -> --series-1, ... index 7 -> --series-8. A 9th+ device, or a
  // device id no longer present in devicesCache, falls back to the neutral
  // --overlap gray — a deliberate, documented fallback (not expected for a
  // personal-use tool), not a bug.
  function colorForDeviceIndex(index) {
    if (index >= 0 && index < 8) return "var(--series-" + (index + 1) + ")";
    return "var(--overlap)";
  }

  function segmentFillColor(seg) {
    if (!seg.deviceIds || seg.deviceIds.length !== 1) return "var(--overlap)";
    const index = devicesCache.findIndex(d => d.id === seg.deviceIds[0]);
    return colorForDeviceIndex(index);
  }

  function deviceNameById(id) {
    const device = devicesCache.find(d => d.id === id);
    return device ? device.name : "Unknown device";
  }

  function segmentDeviceLabel(seg) {
    if (!seg.deviceIds || seg.deviceIds.length === 0) return "";
    if (seg.deviceIds.length === 1) return deviceNameById(seg.deviceIds[0]);
    return "Multiple devices";
  }

  async function createDevice(name, platform) {
    return fetchJson("/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, platform }),
    });
  }

  async function updateDeviceSettings(id, patch) {
    return fetchJson("/api/devices/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  async function revokeDevice(id) {
    const response = await fetch("/api/devices/" + encodeURIComponent(id), { method: "DELETE" });
    if (!response.ok) throw new Error("Failed to revoke device (" + response.status + ")");
  }

  async function deleteDevicePermanently(id) {
    const response = await fetch("/api/devices/" + encodeURIComponent(id) + "?permanent=true", { method: "DELETE" });
    if (!response.ok) throw new Error("Failed to permanently delete device (" + response.status + ")");
  }

  async function restoreDevice(id) {
    const response = await fetch("/api/devices/" + encodeURIComponent(id) + "/restore", { method: "POST" });
    if (!response.ok) throw new Error("Failed to restore device (" + response.status + ")");
  }

  const devicesOverlay = document.getElementById("devicesOverlay");
  const devicesList = document.getElementById("devicesList");
  const newApiKeyBox = document.getElementById("newApiKeyBox");

  function renderDeviceRow(device) {
    const row = document.createElement("div");
    row.className = "device-row";

    // Built via DOM APIs (not innerHTML string concatenation) because device.name
    // is arbitrary user input (POST /api/devices) with no HTML-escaping anywhere
    // in the pipeline — concatenating it into innerHTML would be a stored XSS hole.
    const nameDiv = document.createElement("div");
    nameDiv.className = "device-row-name";
    nameDiv.appendChild(document.createTextNode(device.name + " (" + device.platform + ")"));
    if (device.revoked) {
      const revokedSpan = document.createElement("span");
      revokedSpan.className = "hint";
      revokedSpan.textContent = " revoked";
      nameDiv.appendChild(revokedSpan);
    }
    row.appendChild(nameDiv);

    const fieldRow = document.createElement("div");
    fieldRow.className = "field-row";

    const idleLabel = document.createElement("label");
    idleLabel.appendChild(document.createTextNode("Idle (min) "));
    const idleInput = document.createElement("input");
    idleInput.type = "number";
    idleInput.min = "1";
    idleInput.className = "device-idle";
    idleInput.value = device.idleThresholdMinutes;
    idleInput.disabled = !!device.revoked;
    idleLabel.appendChild(idleInput);
    fieldRow.appendChild(idleLabel);

    const pollLabel = document.createElement("label");
    pollLabel.appendChild(document.createTextNode("Poll (s) "));
    const pollInput = document.createElement("input");
    pollInput.type = "number";
    pollInput.min = "1";
    pollInput.className = "device-poll";
    pollInput.value = device.pollIntervalSeconds;
    pollInput.disabled = !!device.revoked;
    pollLabel.appendChild(pollInput);
    fieldRow.appendChild(pollLabel);

    let saveBtn = null;
    let revokeBtn = null;
    if (!device.revoked) {
      saveBtn = document.createElement("button");
      saveBtn.className = "btn device-save";
      saveBtn.textContent = "Save";
      fieldRow.appendChild(saveBtn);

      revokeBtn = document.createElement("button");
      revokeBtn.className = "btn device-revoke";
      revokeBtn.textContent = "Revoke";
      fieldRow.appendChild(revokeBtn);
    }

    row.appendChild(fieldRow);

    // Work/leisure tracking-mode override (dimension 2 — independent of the
    // idle/poll settings above, so it's its own field-row and its own PATCH
    // on click rather than bundled into the "Save" button).
    const modeRow = document.createElement("div");
    modeRow.className = "field-row";
    const modeLabel = document.createElement("label");
    modeLabel.appendChild(document.createTextNode("Tracking "));
    const modeGroup = document.createElement("span");
    modeGroup.className = "tracking-mode-group";
    modeGroup.setAttribute("role", "group");
    modeGroup.setAttribute("aria-label", "Tracking mode");
    const MODE_LABELS = { auto: "Auto", alwaysWork: "Always work", alwaysLeisure: "Always leisure" };
    const modeButtons = Object.keys(MODE_LABELS).map(mode => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tracking-mode-btn";
      btn.textContent = MODE_LABELS[mode];
      btn.setAttribute("aria-pressed", mode === device.trackingMode ? "true" : "false");
      btn.disabled = !!device.revoked;
      btn.addEventListener("click", async () => {
        try {
          await updateDeviceSettings(device.id, { trackingMode: mode });
          modeButtons.forEach(b => b.setAttribute("aria-pressed", "false"));
          btn.setAttribute("aria-pressed", "true");
          showToast("Tracking mode saved");
        } catch (err) {
          showToast("Could not save tracking mode", true);
        }
      });
      modeGroup.appendChild(btn);
      return btn;
    });
    modeLabel.appendChild(modeGroup);
    modeRow.appendChild(modeLabel);
    row.appendChild(modeRow);

    // Permanent deletion is only offered once a device is already revoked —
    // a safety gate against removing a device that's still actively
    // sending data, and a natural fit for the UI: a revoked row otherwise
    // has no actions of its own at all.
    let deleteBtn = null;
    let restoreBtn = null;
    if (device.revoked) {
      const revokedActionsRow = document.createElement("div");
      revokedActionsRow.className = "field-row";

      // Revoking is reversible (it only sets revoked_at; the API key hash is
      // untouched, so the device's existing key works again immediately).
      // Offered first, so the recoverable action reads before the permanent one.
      restoreBtn = document.createElement("button");
      restoreBtn.className = "btn device-restore";
      restoreBtn.textContent = "Restore";
      revokedActionsRow.appendChild(restoreBtn);

      deleteBtn = document.createElement("button");
      deleteBtn.className = "btn device-delete-permanently";
      deleteBtn.textContent = "Delete permanently";
      revokedActionsRow.appendChild(deleteBtn);

      row.appendChild(revokedActionsRow);
    }

    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        try {
          await updateDeviceSettings(device.id, {
            idleThresholdMinutes: Number(idleInput.value),
            pollIntervalSeconds: Number(pollInput.value),
          });
          showToast("Device settings saved");
        } catch (err) {
          showToast("Could not save device settings", true);
        }
      });
    }
    if (revokeBtn) {
      revokeBtn.addEventListener("click", async () => {
        try {
          await revokeDevice(device.id);
          await refreshDevicesList();
          showToast("Device revoked");
        } catch (err) {
          showToast("Could not revoke device", true);
        }
      });
    }
    if (restoreBtn) {
      restoreBtn.addEventListener("click", async () => {
        try {
          await restoreDevice(device.id);
          await refreshDevicesList();
          await refreshDeviceFilterDropdown();
          showToast("Device restored");
        } catch (err) {
          showToast("Could not restore device", true);
        }
      });
    }
    if (deleteBtn) {
      deleteBtn.addEventListener("click", async () => {
        const confirmed = confirm(
          "Permanently delete \"" + device.name + "\"? This cannot be undone. " +
          "Its historical hours stay in your totals, but without a device name attached.",
        );
        if (!confirmed) return;
        try {
          await deleteDevicePermanently(device.id);
          await refreshDevicesList();
          showToast("Device permanently deleted");
        } catch (err) {
          showToast("Could not delete device", true);
        }
      });
    }

    return row;
  }

  async function refreshDevicesList() {
    devicesList.innerHTML = "";
    try {
      const devices = await fetchDevices();
      if (devices.length === 0) {
        devicesList.innerHTML = '<div class="hint">No devices yet — add one below.</div>';
        return;
      }
      devices.forEach(d => devicesList.appendChild(renderDeviceRow(d)));
    } catch (err) {
      devicesList.innerHTML = '<div class="hint">Could not load devices.</div>';
    }
  }

  document.getElementById("devicesToggle").addEventListener("click", async () => {
    newApiKeyBox.style.display = "none";
    // Chrome deliberately ignores autocomplete="off" on inputs its heuristics
    // classify as contact fields, so the attribute alone doesn't stop it from
    // autofilling an email address into the device-name box (verified: the
    // attribute is present and :-webkit-autofill still matched). Clearing the
    // value on open is heuristic-independent and always wins.
    document.getElementById("newDeviceName").value = "";
    await refreshDevicesList();
    openModal(devicesOverlay);
  });

  document.getElementById("devicesClose").addEventListener("click", () => {
    closeModal(devicesOverlay);
    refreshDeviceFilterDropdown().catch(err => console.error(err)); // pick up any add/revoke made while the panel was open
  });
  devicesOverlay.addEventListener("click", e => { if (e.target === devicesOverlay) closeModal(devicesOverlay); });

  document.getElementById("addDeviceBtn").addEventListener("click", async () => {
    const nameInput = document.getElementById("newDeviceName");
    const platformSelect = document.getElementById("newDevicePlatform");
    if (!nameInput.value.trim()) {
      showToast("Device name is required", true);
      return;
    }
    try {
      const created = await createDevice(nameInput.value.trim(), platformSelect.value);
      nameInput.value = "";
      newApiKeyBox.style.display = "block";
      newApiKeyBox.textContent = "API key for \"" + created.name + "\" (shown once): " + created.apiKey;
      await refreshDevicesList();
    } catch (err) {
      showToast("Could not create device", true);
    }
  });

  /* ---------- Device health banner ---------- */

  // A device that's gone this quiet almost certainly isn't just idle — idle
  // gaps close within the idle threshold (minutes), not hours. The default
  // 24h (configurable in Dashboard settings, state.deviceStaleThresholdHours)
  // is deliberately generous so a normal evening/weekend away from the
  // computer never triggers it; the goal is catching real breakage (dead
  // server URL, revoked key, crashed tracker process) within the same day,
  // not flagging every quiet night.

  const DEVICE_HEALTH_SNOOZE_STORAGE_KEY = "wtk_device_health_snoozed_until";

  // Per-device snooze, keyed by device id -> epoch ms the snooze expires.
  // Deliberately per-device (not one mute for the whole banner) so silencing
  // a known-offline device doesn't also hide a genuinely new problem on
  // another device. Browser-local by design — same tradeoff as the device
  // filter / timeline toggle: no server round-trip, but doesn't follow you
  // to a different browser.
  function getDeviceHealthSnoozeMap() {
    try {
      return JSON.parse(safeGetItem(DEVICE_HEALTH_SNOOZE_STORAGE_KEY) || "{}");
    } catch (err) {
      return {};
    }
  }

  function isDeviceHealthSnoozed(deviceId) {
    const until = getDeviceHealthSnoozeMap()[deviceId];
    return typeof until === "number" && until > Date.now();
  }

  function snoozeDeviceHealthWarning(deviceId, days) {
    const map = getDeviceHealthSnoozeMap();
    map[deviceId] = Date.now() + days * 24 * 60 * 60 * 1000;
    safeSetItem(DEVICE_HEALTH_SNOOZE_STORAGE_KEY, JSON.stringify(map));
  }

  function formatRelativeTime(ms) {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return minutes + "m";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h";
    return Math.floor(hours / 24) + "d";
  }

  function buildDeviceHealthRow(device, message) {
    const row = document.createElement("div");
    row.className = "device-health-row";

    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", "icon");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "2");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.innerHTML =
      '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"></path><path d="M12 9v4M12 17h.01"></path>';
    row.appendChild(icon);

    // device.name is arbitrary user input — via textContent, not innerHTML,
    // same XSS-avoidance rule as the devices panel's rows.
    const textEl = document.createElement("div");
    textEl.className = "device-health-row-text";
    textEl.textContent = message;
    row.appendChild(textEl);

    const actions = document.createElement("div");
    actions.className = "device-health-row-actions";
    [
      { label: "Snooze 1 day", days: 1 },
      { label: "Snooze 5 days", days: 5 },
    ].forEach(({ label, days }) => {
      const btn = document.createElement("button");
      btn.className = "btn device-health-snooze";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        snoozeDeviceHealthWarning(device.id, days);
        updateDeviceHealthBanner(devicesCache);
      });
      actions.appendChild(btn);
    });
    row.appendChild(actions);

    return row;
  }

  function updateDeviceHealthBanner(devices) {
    const banner = document.getElementById("deviceHealthBanner");
    const list = document.getElementById("deviceHealthBannerList");
    const now = Date.now();
    const thresholdMs = state.deviceStaleThresholdHours * 60 * 60 * 1000;

    const warnings = devices
      .filter(d => !d.revoked && !isDeviceHealthSnoozed(d.id))
      .map(d => {
        if (!d.lastSeenAt) {
          return { device: d, message: d.name + " has never sent data — check its server URL and API key." };
        }
        const elapsed = now - new Date(d.lastSeenAt).getTime();
        if (elapsed > thresholdMs) {
          return { device: d, message: d.name + " hasn't checked in for " + formatRelativeTime(elapsed) + "." };
        }
        return null;
      })
      .filter(Boolean);

    list.innerHTML = "";
    if (warnings.length === 0) {
      banner.classList.remove("visible");
      return;
    }

    warnings.forEach(({ device, message }) => list.appendChild(buildDeviceHealthRow(device, message)));
    banner.classList.add("visible");
  }

  /* ---------- Wiring: device filter dropdown (header) ---------- */

  const deviceFilterSelect = document.getElementById("deviceFilter");

  async function refreshDeviceFilterDropdown() {
    let devices;
    try {
      devices = await fetchDevices();
    } catch (err) {
      console.error(err);
      return;
    }

    updateDeviceHealthBanner(devices);

    const stillExists = devices.some(d => d.id === state.selectedDeviceId);
    if (state.selectedDeviceId && !stillExists) {
      // The previously selected device was removed/revoked since we last saw
      // it (e.g. from another session) — fall back to the combined view
      // rather than keep filtering by a device that's no longer listed.
      setSelectedDeviceId("");
    }

    deviceFilterSelect.innerHTML = "";
    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "All devices";
    deviceFilterSelect.appendChild(allOption);

    devices.forEach(d => {
      const option = document.createElement("option");
      option.value = d.id;
      option.textContent = d.name + (d.revoked ? " (revoked)" : "");
      deviceFilterSelect.appendChild(option);
    });

    deviceFilterSelect.value = state.selectedDeviceId;
  }

  deviceFilterSelect.addEventListener("change", () => {
    setSelectedDeviceId(deviceFilterSelect.value);
    syncLive();
    function retry() {
      return renderAll().catch(err => {
        console.error(err);
        if (err && err.status === 401) {
          handleAuthFailureAndRetry(retry);
        } else {
          showToast("Could not load dashboard data", true);
        }
      });
    }
    retry();
  });

  /* ---------- Live timer (today worked + current session) ---------- */

  async function fetchLive() {
    const params = withDeviceParam(new URLSearchParams());
    const query = params.toString();
    return fetchJson("/api/stats/live" + (query ? "?" + query : ""));
  }

  function formatClock(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    return String(hrs).padStart(2, "0") + ":" + String(mins).padStart(2, "0") + ":" + String(secs).padStart(2, "0");
  }

  const DAILY_GOAL_SECONDS = 8 * 3600;
  const RING_CIRCUMFERENCE = 2 * Math.PI * 78;

  const liveBar = document.getElementById("liveBar");
  const liveRingProgress = document.getElementById("liveRingProgress");
  const liveTodayValue = document.getElementById("liveTodayValue");
  const liveSessionValue = document.getElementById("liveSessionValue");
  const liveSessionLabel = document.getElementById("liveSessionLabel");
  const liveSessionHint = document.getElementById("liveSessionHint");

  // Local seconds counters, advanced every second by the tick timer. Resynced
  // with the server periodically so drift, idle transitions, and activity from
  // the tracker are reflected without needing a full page reload.
  const live = {
    isActive: false,
    todaySeconds: 0,
    currentSessionSeconds: 0,
    sessionStartedAt: null,
    activeDeviceIds: [],
  };

  function renderLive() {
    liveBar.setAttribute("data-active", live.isActive ? "true" : "false");
    liveTodayValue.textContent = formatClock(live.todaySeconds);
    liveSessionValue.textContent = live.isActive ? formatClock(live.currentSessionSeconds) : "00:00:00";
    liveSessionLabel.textContent = live.isActive ? "Current session" : "Idle since last session";

    let hint = "";
    if (live.isActive && live.sessionStartedAt) {
      hint = "Started at " + live.sessionStartedAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      // Only worth naming the device(s) in the "all devices" view — with a
      // single-device filter active, the hint would just repeat what the
      // filter dropdown already says.
      if (state.selectedDeviceId === "" && live.activeDeviceIds.length > 0) {
        const names = live.activeDeviceIds.map(deviceNameById);
        hint += " · " + names.join(" + ");
      }
    }
    liveSessionHint.textContent = hint;

    const pct = Math.min(1, live.todaySeconds / DAILY_GOAL_SECONDS);
    liveRingProgress.setAttribute("stroke-dasharray", RING_CIRCUMFERENCE.toFixed(1));
    liveRingProgress.setAttribute("stroke-dashoffset", (RING_CIRCUMFERENCE * (1 - pct)).toFixed(1));
  }

  async function syncLive() {
    try {
      const data = await fetchLive();
      live.isActive = data.isActive;
      live.todaySeconds = data.todaySeconds;
      live.currentSessionSeconds = data.currentSessionSeconds;
      live.sessionStartedAt = data.isActive
        ? new Date(Date.now() - data.currentSessionSeconds * 1000)
        : null;
      live.activeDeviceIds = data.activeDeviceIds || [];
      renderLive();
    } catch (err) {
      console.error(err);
      // The live poll runs every 15s regardless of which card is visible, so it's
      // the most likely place to first notice an expired session — route back to
      // login rather than silently failing this tile forever.
      if (err && err.status === 401) {
        handleAuthFailureAndRetry(syncLive);
      }
    }
  }

  function tickLive() {
    if (live.isActive) {
      live.todaySeconds += 1;
      live.currentSessionSeconds += 1;
      renderLive();
    }
  }

  /* ---------- Login gate ---------- */
  // The API requires a signed session cookie (see src/server/auth.ts); Vercel's
  // Hobby plan has no built-in way to password-protect a production domain, so
  // the dashboard gates itself. On first load we probe a cheap endpoint; a 401
  // shows the login overlay before any real data is fetched. A network failure
  // (server unreachable) is distinct from a 401 and gets its own "can't reach
  // the server" state with a Retry button, rather than either silently
  // proceeding as if authenticated or showing the login form as if the
  // password were wrong.

  function showLoginOverlay() {
    return new Promise(resolve => {
      const loginOverlay = document.getElementById("loginOverlay");
      const loginPassword = document.getElementById("loginPassword");
      const loginError = document.getElementById("loginError");
      const loginSubmit = document.getElementById("loginSubmit");
      openModal(loginOverlay);
      loginPassword.focus();
      loginPassword.value = "";

      async function submit() {
        loginError.style.display = "none";
        try {
          const res = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: loginPassword.value }),
          });
          if (res.ok) {
            loginSubmit.removeEventListener("click", submit);
            loginPassword.removeEventListener("keydown", onKeydown);
            closeModal(loginOverlay);
            resolve();
          } else {
            loginError.style.display = "block";
          }
        } catch (err) {
          loginError.style.display = "block";
        }
      }
      function onKeydown(e) { if (e.key === "Enter") submit(); }

      loginSubmit.addEventListener("click", submit);
      loginPassword.addEventListener("keydown", onKeydown);
    });
  }

  function showConnectionErrorOverlay() {
    return new Promise(resolve => {
      const connectionErrorOverlay = document.getElementById("connectionErrorOverlay");
      const retryBtn = document.getElementById("connectionErrorRetry");
      openModal(connectionErrorOverlay);

      function onRetry() {
        retryBtn.removeEventListener("click", onRetry);
        closeModal(connectionErrorOverlay);
        resolve();
      }
      retryBtn.addEventListener("click", onRetry);
    });
  }

  // Guards against multiple overlapping login prompts if several in-flight
  // requests all 401 around the same time (e.g. the initial Promise.all in
  // renderAll()) — only the first one triggers the re-login flow.
  let handlingAuthFailure = false;

  async function handleAuthFailureAndRetry(retry) {
    if (handlingAuthFailure) return;
    handlingAuthFailure = true;
    try {
      await showLoginOverlay();
      await retry();
    } finally {
      handlingAuthFailure = false;
    }
  }

  async function ensureAuthenticated() {
    let res;
    try {
      res = await fetch("/api/stats/first-activity");
    } catch (err) {
      // Genuine network failure (fetch threw — server unreachable, offline, etc.),
      // not a 401. Show a dedicated "can't reach the server" state and let the
      // user retry, rather than treating it as either "authenticated" or
      // "wrong password".
      await showConnectionErrorOverlay();
      return ensureAuthenticated();
    }
    if (res.status === 401) {
      await showLoginOverlay();
    }
  }

  /* ---------- App version (shown in the header, no auth required) ---------- */

  fetch("/api/version")
    .then(res => res.ok ? res.json() : Promise.reject())
    .then(data => { document.getElementById("appVersion").textContent = "v" + data.version; })
    .catch(() => {}); // non-critical — leave the badge empty if this fails

  /* ---------- Initial render (after authentication) ---------- */

  ensureAuthenticated()
    .then(() => refreshDeviceFilterDropdown().catch(err => console.error(err))) // clears a stale stored deviceId first, so later fetches don't 404 on it
    .then(() => {
      syncLive();
      setInterval(tickLive, 1000);
      setInterval(syncLive, 15000);
      // Staleness is purely time-based (no new data needed to detect it), so
      // this recomputes from the already-fetched device list rather than
      // polling the API again — refreshDeviceFilterDropdown()'s own periodic
      // (device-add/revoke-triggered) fetches keep devicesCache fresh enough.
      setInterval(() => updateDeviceHealthBanner(devicesCache), 5 * 60 * 1000);

      fetchFirstActivity()
        .then(data => { state.firstActivityDate = data.date ? parseIsoDate(data.date) : null; })
        .catch(err => console.error(err));

      fetchSettings()
        .then(settings => {
          state.coreHoursStartMinutes = parseHHMMToMinutes(settings.coreHoursStart);
          state.coreHoursEndMinutes = parseHHMMToMinutes(settings.coreHoursEnd);
          state.deviceStaleThresholdHours = settings.deviceStaleThresholdHours;
          // The banner may already have rendered once using the built-in
          // default (24h) before this resolved — recompute now in case the
          // saved threshold differs.
          updateDeviceHealthBanner(devicesCache);
        })
        .catch(err => console.error(err));

      bootstrapStateFromUrl();
      syncFilterButtonsFromState();

      function renderAllWithAuthHandling() {
        renderAll().catch(err => {
          console.error(err);
          if (err && err.status === 401) {
            // The session cookie expired/was revoked after the initial check
            // (e.g. long-lived tab, or another session logged out) — route
            // back to the login screen instead of just toasting an error
            // that reappears on every subsequent poll.
            handleAuthFailureAndRetry(renderAllWithAuthHandling);
          } else {
            showToast("Could not load dashboard data", true);
          }
        });
      }
      renderAllWithAuthHandling();

      window.addEventListener("resize", () => renderAll().catch(() => {}));
    });
})();
