"use strict";

/* ════════════════════════════════════════════════════════════════════
   LUNAR TRACKER — APPLICATION LOGIC
   Requires: astronomy.browser.js (global `Astronomy`) and data.js
   ════════════════════════════════════════════════════════════════════ */

(function () {
  const DEG = Math.PI / 180;
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;

  const SIGNS = [
    "Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
    "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces",
  ];
  // U+FE0E forces text (non-emoji) presentation of the sign glyphs.
  const SIGN_GLYPHS = ["♈", "♉", "♊", "♋", "♌", "♍", "♎", "♏", "♐", "♑", "♒", "♓"]
    .map((g) => g + "\uFE0E");
  const ORDINALS = [
    "", "1st", "2nd", "3rd", "4th", "5th", "6th",
    "7th", "8th", "9th", "10th", "11th", "12th",
  ];
  const CONJUNCTION_ORB = 5; // degrees

  const norm360 = (x) => ((x % 360) + 360) % 360;
  const wrap180 = (x) => {
    const n = norm360(x);
    return n > 180 ? n - 360 : n;
  };
  const pad2 = (n) => String(n).padStart(2, "0");

  /* ── Timezone helpers (all "local day" math uses LOCATION.timezone,
        never the browser's own timezone) ─────────────────────────── */

  function tzParts(date, timeZone) {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = {};
    for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
    return {
      y: +p.year, m: +p.month, d: +p.day,
      hh: +p.hour % 24, mm: +p.minute, ss: +p.second,
    };
  }

  // UTC instant for a wall-clock time in the configured timezone.
  function zonedTimeToUtc(y, m, d, hh, mm) {
    const wall = Date.UTC(y, m - 1, d, hh, mm, 0);
    let utc = wall;
    for (let i = 0; i < 3; i++) {
      const p = tzParts(new Date(utc), LOCATION.timezone);
      const shown = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
      utc += wall - shown;
    }
    return new Date(utc);
  }

  function localDateOf(date) {
    const p = tzParts(date, LOCATION.timezone);
    return { y: p.y, m: p.m, d: p.d };
  }

  function sameLocalDate(a, b) {
    return a.y === b.y && a.m === b.m && a.d === b.d;
  }

  function fmtTime(date) {
    if (!date) return "—";
    return new Intl.DateTimeFormat("en-US", {
      timeZone: LOCATION.timezone, hour: "numeric", minute: "2-digit", hour12: true,
    }).format(date).toLowerCase().replace(" ", " ");
  }

  function fmtLongDate(sel) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC", weekday: "long", year: "numeric", month: "long", day: "numeric",
    }).format(new Date(Date.UTC(sel.y, sel.m - 1, sel.d, 12)));
  }

  /* ── Zodiac / ayanāṁśa ──────────────────────────────────────────── */

  // Lahiri ayanāṁśa: 23°51′11.5″ (23.85320°) at J2000.0, moving ≈ 50.29″/yr.
  const ayanamsa = (yearFraction) => 23.8532 + (50.29 / 3600) * (yearFraction - 2000);
  const AY_NATAL = ayanamsa(NATAL.yearFraction); // ≈ 23.587° for Dec 1980

  function yearFractionOf(date) {
    const p = tzParts(date, "UTC");
    const start = Date.UTC(p.y, 0, 1);
    const end = Date.UTC(p.y + 1, 0, 1);
    return p.y + (date.getTime() - start) / (end - start);
  }

  // Convert a tropical longitude to the active zodiac mode.
  function modal(lonTropical, yearFraction) {
    if (state.mode === "sidereal") return norm360(lonTropical - ayanamsa(yearFraction));
    return norm360(lonTropical);
  }

  const signIndex = (lon) => Math.floor(norm360(lon) / 30);
  const signName = (lon) => SIGNS[signIndex(lon)];
  const signKey = (lon) => SIGNS[signIndex(lon)].toLowerCase();

  function degInSign(lon) {
    const within = norm360(lon) % 30;
    const d = Math.floor(within);
    const m = Math.round((within - d) * 60);
    return m === 60 ? `${d + 1}°00′` : `${d}°${pad2(m)}′`;
  }

  // Natal cusps in the active mode (sidereal uses the *natal* ayanāṁśa).
  function modalCusps() {
    if (state.mode === "sidereal") return NATAL.cusps.map((c) => norm360(c - AY_NATAL));
    return NATAL.cusps.slice();
  }

  function houseOf(lon, cusps) {
    for (let h = 0; h < 12; h++) {
      const a = cusps[h], b = cusps[(h + 1) % 12];
      if (norm360(lon - a) < norm360(b - a)) return h + 1;
    }
    return 12;
  }

  /* ── Astronomy ──────────────────────────────────────────────────── */

  const observer = new Astronomy.Observer(LOCATION.latitude, LOCATION.longitude, 0);

  const moonLonTropical = (date) => Astronomy.EclipticGeoMoon(date).lon;

  function riseSet(body, dayStart, dayEnd) {
    const limit = (dayEnd - dayStart) / DAY;
    const find = (dir) => {
      const t = Astronomy.SearchRiseSet(body, observer, dir, dayStart, limit + 0.05);
      return t && t.date < dayEnd ? t.date : null;
    };
    return { rise: find(+1), set: find(-1) };
  }

  // Principal-phase event (0=new, 90=first quarter, 180=full, 270=last quarter)
  // whose instant falls inside [from, to).
  function phaseEventBetween(targetLon, from, to) {
    const margin = HOUR;
    const start = new Date(from.getTime() - margin);
    const limit = (to.getTime() - start.getTime()) / DAY + 0.1;
    const t = Astronomy.SearchMoonPhase(targetLon, start, limit);
    if (t && t.date >= from && t.date < to) return t.date;
    return null;
  }

  function phaseName(angle) {
    if (angle < 90) return "Waxing Crescent";
    if (angle < 180) return "Waxing Gibbous";
    if (angle < 270) return "Waning Gibbous";
    return "Waning Crescent";
  }

  /* ── Moon phase SVG icon ────────────────────────────────────────── */

  function moonIcon(phaseAngle, size) {
    const c = size / 2;
    const r = c - size * 0.06;
    const frac = (1 - Math.cos(phaseAngle * DEG)) / 2;
    let lit = "";
    if (frac > 0.995) {
      lit = `<circle cx="${c}" cy="${c}" r="${r}" class="moon-lit"/>`;
    } else if (frac > 0.005) {
      const waxing = norm360(phaseAngle) <= 180;
      const rx = Math.abs(r * Math.cos(phaseAngle * DEG));
      const limbSweep = waxing ? 1 : 0;
      const termSweep = (frac < 0.5) === waxing ? 0 : 1;
      lit = `<path class="moon-lit" d="M ${c} ${c - r}
        A ${r} ${r} 0 0 ${limbSweep} ${c} ${c + r}
        A ${rx.toFixed(3)} ${r} 0 0 ${termSweep} ${c} ${c - r} Z"/>`;
    }
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"
      role="img" aria-label="Moon phase">
      <circle cx="${c}" cy="${c}" r="${r}" class="moon-dark"/>
      ${lit}
      <circle cx="${c}" cy="${c}" r="${r}" class="moon-edge" fill="none"/>
    </svg>`;
  }

  /* ── State ──────────────────────────────────────────────────────── */

  const THIS_YEAR = localDateOf(new Date()).y;

  const state = {
    mode: "tropical", // 'tropical' | 'sidereal'
    sel: localDateOf(new Date()),
  };

  // localStorage is unavailable in some embed contexts — degrade gracefully.
  const store = {
    get(key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    set(key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) { /* ignore */ }
    },
  };
  if (store.get("zodiacMode") === "sidereal") state.mode = "sidereal";

  function clampSel(sel) {
    const min = { y: THIS_YEAR, m: 1, d: 1 };
    const max = { y: THIS_YEAR, m: 12, d: 31 };
    const key = (s) => s.y * 10000 + s.m * 100 + s.d;
    if (key(sel) < key(min)) return min;
    if (key(sel) > key(max)) return max;
    return sel;
  }

  function shiftDay(sel, delta) {
    const t = Date.UTC(sel.y, sel.m - 1, sel.d + delta, 12);
    const p = tzParts(new Date(t), "UTC");
    return clampSel({ y: p.y, m: p.m, d: p.d });
  }

  /* ── Per-date computation ───────────────────────────────────────── */

  function computeDay(sel) {
    const dayStart = zonedTimeToUtc(sel.y, sel.m, sel.d, 0, 0);
    const next = shiftUnclamped(sel, 1);
    const dayEnd = zonedTimeToUtc(next.y, next.m, next.d, 0, 0);
    const noon = zonedTimeToUtc(sel.y, sel.m, sel.d, 12, 0);
    const yf = yearFractionOf(noon);

    const phaseAngle = Astronomy.MoonPhase(noon);
    const illum = Astronomy.Illumination("Moon", noon).phase_fraction;

    const moon = riseSet("Moon", dayStart, dayEnd);
    const sun = riseSet("Sun", dayStart, dayEnd);

    const moonTrop = moonLonTropical(noon);
    const moonLon = modal(moonTrop, yf);
    const cusps = modalCusps();
    const house = houseOf(moonLon, cusps);

    // Principal phase on this local day (event instant within the day)?
    const quarterEvents = {
      newMoon: phaseEventBetween(0, dayStart, dayEnd),
      firstQuarter: phaseEventBetween(90, dayStart, dayEnd),
      fullMoon: phaseEventBetween(180, dayStart, dayEnd),
      lastQuarter: phaseEventBetween(270, dayStart, dayEnd),
    };

    let phase = phaseName(phaseAngle);
    if (quarterEvents.newMoon) phase = "New Moon";
    else if (quarterEvents.firstQuarter) phase = "First Quarter";
    else if (quarterEvents.fullMoon) phase = "Full Moon";
    else if (quarterEvents.lastQuarter) phase = "Last Quarter";

    // New/full moon ±12h window: show the event's text when any part of
    // this local day overlaps [exact instant − 12h, exact instant + 12h].
    const windowEvent = (targetLon) => {
      const from = new Date(dayStart.getTime() - 12 * HOUR);
      const to = new Date(dayEnd.getTime() + 12 * HOUR);
      const t = phaseEventBetween(targetLon, from, to);
      if (!t) return null;
      const eyf = yearFractionOf(t);
      const lon = modal(moonLonTropical(t), eyf);
      return { instant: t, lon, house: houseOf(lon, cusps) };
    };
    const newMoonWindow = windowEvent(0);
    const fullMoonWindow = windowEvent(180);

    // Quarter text events use the exact local calendar day only.
    const quarterSign = (t) => t && modal(moonLonTropical(t), yearFractionOf(t));

    // New Moon affirmations: active from the exact New Moon instant until
    // 28 days later, keyed by the natal house of that New Moon. For today
    // the actual clock time decides (the quotes switch over at the exact
    // instant); for other dates, local noon.
    const isToday = sameLocalDate(sel, localDateOf(new Date()));
    const affRef = isToday ? new Date() : noon;
    let affirmations = null;
    {
      // Walk forward to the most recent New Moon at or before affRef.
      let nm = Astronomy.SearchMoonPhase(0, new Date(affRef.getTime() - 32 * DAY), 33);
      while (nm && nm.date <= affRef) {
        const next = Astronomy.SearchMoonPhase(0, new Date(nm.date.getTime() + HOUR), 31);
        if (next && next.date <= affRef) nm = next; else break;
      }
      if (nm && nm.date <= affRef && affRef - nm.date <= 28 * DAY) {
        const lon = modal(moonLonTropical(nm.date), yearFractionOf(nm.date));
        const list = (CONTENT.newMoonAffirmations || {})[houseOf(lon, cusps)] || [];
        const texts = list.filter((t) => t && String(t).trim());
        if (texts.length) affirmations = texts;
      }
    }

    // Eclipses: match the eclipse's local calendar date.
    const eclipse = ECLIPSES.map((e) => ({ ...e, date: new Date(e.utc) }))
      .find((e) => sameLocalDate(localDateOf(e.date), sel)) || null;

    // Transiting Moon → natal conjunctions (orb ≤ 5°).
    const natalYf = NATAL.yearFraction;
    const conjunctions = [];
    for (const [planet, lonTrop] of Object.entries(NATAL.planets)) {
      const natalLon = modal(lonTrop, natalYf);
      const sepNoon = wrap180(moonLon - natalLon);
      const orb = Math.abs(sepNoon);
      const sepStart = wrap180(modal(moonLonTropical(dayStart), yf) - natalLon);
      const sepEnd = wrap180(modal(moonLonTropical(dayEnd), yf) - natalLon);
      const exactToday = sepStart <= 0 && sepEnd >= 0 &&
        Math.abs(sepStart) < 15 && Math.abs(sepEnd) < 15;
      if (orb <= CONJUNCTION_ORB || exactToday) {
        conjunctions.push({
          planet,
          orb, // orb at local noon, per spec
          status: exactToday ? "exact today" : sepNoon < 0 ? "applying" : "separating",
        });
      }
    }
    conjunctions.sort((a, b) => a.orb - b.orb);

    return {
      sel, noon, phaseAngle, illum, moon, sun, moonLon, house,
      phase, quarterEvents, newMoonWindow, fullMoonWindow, quarterSign,
      eclipse, conjunctions, affirmations, isToday,
    };
  }

  function shiftUnclamped(sel, delta) {
    const p = tzParts(new Date(Date.UTC(sel.y, sel.m - 1, sel.d + delta, 12)), "UTC");
    return { y: p.y, m: p.m, d: p.d };
  }

  /* ── Rendering ──────────────────────────────────────────────────── */

  const $ = (id) => document.getElementById(id);
  let affirmationTimer = null;
  const esc = (s) => String(s).replace(/[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

  // Renders a pasted CONTENT entry verbatim, with light structure:
  // lines starting with ◗ become sub-headings, the first line becomes the
  // entry's title line, blank lines separate paragraphs.
  function contentOr(text) {
    if (!text) return `<p class="reading pending">— content pending —</p>`;
    const lines = String(text).split("\n");
    const hasMarks = lines.some((l) => l.trim().startsWith("◗"));
    const out = [];
    lines.forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      if (line.startsWith("◗")) {
        out.push(`<h4 class="reading-h"><span class="mark">◗ </span>${esc(line.slice(1).trim())}</h4>`);
      } else if (i === 0 && hasMarks) {
        out.push(`<p class="reading-title">${esc(line)}</p>`);
      } else {
        out.push(`<p class="reading">${esc(line)}</p>`);
      }
    });
    return out.join("");
  }

  // Each reading is collapsed behind a native <details> accordion.
  function section(title, body) {
    return `<details class="entry"><summary><h3>${title}</h3><span class="disclose" aria-hidden="true">+</span></summary><div class="entry-body">${body}</div></details>`;
  }

  function render() {
    const day = computeDay(state.sel);
    const signIdx = signIndex(day.moonLon);

    $("date-display").textContent = fmtLongDate(state.sel);
    $("date-input").value = `${state.sel.y}-${pad2(state.sel.m)}-${pad2(state.sel.d)}`;

    $("moon-icon").innerHTML = moonIcon(day.phaseAngle, 96);

    let phaseLabel = esc(day.phase);
    if (day.eclipse) {
      const label = day.eclipse.kind === "solar" ? "Solar Eclipse" : "Lunar Eclipse";
      phaseLabel += ` <span class="badge">${esc(day.eclipse.type)} ${label}</span>`;
    }
    $("phase-name").innerHTML = phaseLabel;
    $("illum").textContent = `${(day.illum * 100).toFixed(0)}% illuminated`;
    $("moon-sign").textContent =
      `${SIGN_GLYPHS[signIdx]} Moon in ${SIGNS[signIdx]} · ${degInSign(day.moonLon)}`;

    $("moonrise").textContent = fmtTime(day.moon.rise);
    $("moonset").textContent = fmtTime(day.moon.set);
    $("sunrise").textContent = fmtTime(day.sun.rise);
    $("sunset").textContent = fmtTime(day.sun.set);

    // House + conjunctions line
    let transit = `<p class="transit-house">Moon transiting your ${ORDINALS[day.house]} house</p>`;
    if (day.conjunctions.length) {
      transit += day.conjunctions.map((c) =>
        `<p class="conj">Moon ☌ Natal ${esc(c.planet)} <span class="orb">(orb ${c.orb.toFixed(1)}°, ${esc(c.status)})</span></p>`
      ).join("");
    } else {
      transit += `<p class="conj none">No natal conjunctions today</p>`;
    }
    $("transits").innerHTML = transit;

    // New Moon affirmations — free-floating cursive quotes.
    $("affirmations").innerHTML = (day.affirmations || [])
      .map((t) => `<p class="affirmation">‘${esc(t)}’</p>`)
      .join("");

    // When viewing today, re-render at the exact instant of the next New
    // Moon so the affirmations switch over on time.
    clearTimeout(affirmationTimer);
    if (day.isToday) {
      const next = Astronomy.SearchMoonPhase(0, new Date(), 32);
      if (next) {
        const ms = next.date.getTime() - Date.now();
        if (ms > 0 && ms < 36 * HOUR) {
          affirmationTimer = setTimeout(render, ms + 2000);
        }
      }
    }

    // Interpretive sections
    const parts = [];
    parts.push(section(`Moon in ${SIGNS[signIdx]}`,
      contentOr(CONTENT.dailyMoonInSign[signKey(day.moonLon)])));
    parts.push(section(`Moon in your ${ORDINALS[day.house]} house`,
      contentOr(CONTENT.dailyMoonInHouse[day.house])));

    if (day.newMoonWindow) {
      const w = day.newMoonWindow;
      const label = day.eclipse && day.eclipse.kind === "solar" ? "Solar Eclipse" : "New Moon";
      parts.push(section(`${label} in ${signName(w.lon)}`,
        contentOr(CONTENT.newMoonInSign[signKey(w.lon)])));
      parts.push(section(`${label} in your ${ORDINALS[w.house]} house`,
        contentOr(CONTENT.newMoonInHouse[w.house])));
    }
    if (day.fullMoonWindow) {
      const w = day.fullMoonWindow;
      const label = day.eclipse && day.eclipse.kind === "lunar" ? "Lunar Eclipse" : "Full Moon";
      parts.push(section(`${label} in ${signName(w.lon)}`,
        contentOr(CONTENT.fullMoonInSign[signKey(w.lon)])));
      parts.push(section(`${label} in your ${ORDINALS[w.house]} house`,
        contentOr(CONTENT.fullMoonInHouse[w.house])));
    }
    if (day.quarterEvents.firstQuarter) {
      const lon = day.quarterSign(day.quarterEvents.firstQuarter);
      parts.push(section(`First Quarter in ${signName(lon)}`,
        contentOr(CONTENT.firstQuarterInSign[signKey(lon)])));
    }
    if (day.quarterEvents.lastQuarter) {
      const lon = day.quarterSign(day.quarterEvents.lastQuarter);
      parts.push(section(`Last Quarter in ${signName(lon)}`,
        contentOr(CONTENT.lastQuarterInSign[signKey(lon)])));
    }
    $("readings").innerHTML = parts.join('<hr class="rule">');

    // Mode toggle visual state
    $("mode-tropical").classList.toggle("active", state.mode === "tropical");
    $("mode-sidereal").classList.toggle("active", state.mode === "sidereal");
  }

  /* ── Wiring ─────────────────────────────────────────────────────── */

  function setSel(sel) {
    state.sel = clampSel(sel);
    render();
  }

  $("prev-day").addEventListener("click", () => setSel(shiftDay(state.sel, -1)));
  $("next-day").addEventListener("click", () => setSel(shiftDay(state.sel, +1)));
  $("today-btn").addEventListener("click", () => setSel(localDateOf(new Date())));

  const dateInput = $("date-input");
  dateInput.min = `${THIS_YEAR}-01-01`;
  dateInput.max = `${THIS_YEAR}-12-31`;
  dateInput.addEventListener("change", () => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateInput.value);
    if (m) setSel({ y: +m[1], m: +m[2], d: +m[3] });
  });

  function setMode(mode) {
    state.mode = mode;
    store.set("zodiacMode", mode);
    render();
  }
  $("mode-tropical").addEventListener("click", () => setMode("tropical"));
  $("mode-sidereal").addEventListener("click", () => setMode("sidereal"));

  render();
})();
