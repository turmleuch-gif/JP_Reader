(() => {
  const PAGE_SIZE = 50;
  const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff]/;

  const COLUMNS = [
    { key: "kanji",   label: "Kanji",                numeric: false },
    { key: "reading", label: "Hiragana / Katakana",  numeric: false },
    { key: "meaning", label: "English",              numeric: false },
    { key: "count",   label: "Seen",                 numeric: true  },
    { key: "last",    label: "Last seen",            numeric: true  },
  ];

  const $ = (id) => document.getElementById(id);
  const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  const collator = new Intl.Collator("ja");

  let words = {}, lastSeen = {};
  const info = new Map();        // headword -> { kanji, reading, meaning }
  const tried = new Set();       // headwords we already looked up in info.bin
  let infoLoading = Promise.resolve();

  // ---------- State lives in the URL hash: #start=50&sort=count&dir=asc ----------

  function readState() {
    const p = new URLSearchParams(location.hash.slice(1));
    const sort = COLUMNS.some((c) => c.key === p.get("sort")) ? p.get("sort") : null;
    return {
      start: Math.max(0, parseInt(p.get("start"), 10) || 0),
      sort,
      dir: p.get("dir") === "asc" ? "asc" : "desc",
    };
  }

  function hashFor(state) {
    const p = new URLSearchParams();
    if (state.start) p.set("start", state.start);
    if (state.sort) { p.set("sort", state.sort); p.set("dir", state.dir); }
    const s = p.toString();
    return "#" + s;
  }

  // unsorted -> descending -> ascending -> descending -> ...
  function nextSort(state, key) {
    if (state.sort !== key) return { start: 0, sort: key, dir: "desc" };
    return { start: 0, sort: key, dir: state.dir === "desc" ? "asc" : "desc" };
  }

  // ---------- Dictionary info (readings + translations) ----------

  function loadInfo(wanted) {
    infoLoading = infoLoading.then(async () => {
      const res = await fetch(browser.runtime.getURL("info.bin"));
      const text = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text();
      for (const line of text.split("\n")) {
        const t = line.indexOf("\t");
        if (t < 0) continue;
        const hw = line.slice(0, t);
        if (!wanted.has(hw)) continue;
        const [kf, rd, gl] = line.slice(t + 1).split("\t");
        info.set(hw, {
          kanji: KANJI.test(hw) ? hw : kf || "",
          reading: KANJI.test(hw) ? rd || "" : hw,
          meaning: gl || "",
        });
      }
      for (const w of wanted) tried.add(w);
    });
    return infoLoading;
  }

  async function ensureInfo() {
    const wanted = new Set();
    for (const w of Object.keys(words)) {
      if (!tried.has(w)) wanted.add(w);
      if (w.endsWith("する") && w.length > 2 && !tried.has(w.slice(0, -2))) wanted.add(w.slice(0, -2));
    }
    if (wanted.size) await loadInfo(wanted);
  }

  function infoFor(w) {
    const hit = info.get(w);
    if (hit) return hit;
    // noun + する (e.g. 勉強する) is not a JMdict headword itself
    if (w.endsWith("する") && w.length > 2) {
      const base = info.get(w.slice(0, -2));
      if (base) {
        return {
          kanji: base.kanji ? base.kanji + "する" : "",
          reading: base.reading + "する",
          meaning: "to do: " + base.meaning,
        };
      }
    }
    return { kanji: KANJI.test(w) ? w : "", reading: KANJI.test(w) ? "" : w, meaning: "" };
  }

  // ---------- Rows, sorting ----------

  function buildRows() {
    return Object.keys(words).map((w) => {
      const i = infoFor(w);
      return { word: w, kanji: i.kanji, reading: i.reading, meaning: i.meaning,
               count: words[w], last: lastSeen[w] || 0 };
    });
  }

  function sortRows(rows, state) {
    const byLastDesc = (a, b) => b.last - a.last || b.count - a.count;
    if (!state.sort) return rows.sort(byLastDesc); // default "unsorted" order: most recently seen first
    const col = COLUMNS.find((c) => c.key === state.sort);
    const sign = state.dir === "asc" ? 1 : -1;
    return rows.sort((a, b) => {
      const cmp = col.numeric ? a[col.key] - b[col.key] : collator.compare(a[col.key], b[col.key]);
      return cmp * sign || byLastDesc(a, b);
    });
  }

  // ---------- Rendering ----------

  function renderHead(state) {
    const tr = $("head");
    tr.textContent = "";
    for (const col of COLUMNS) {
      const th = document.createElement("th");
      const active = state.sort === col.key;
      th.setAttribute("aria-sort", active ? (state.dir === "asc" ? "ascending" : "descending") : "none");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.append(col.label + " ");
      const arrow = document.createElement("span");
      arrow.className = "arrow";
      arrow.textContent = active ? (state.dir === "asc" ? "▲" : "▼") : "";
      btn.append(arrow);
      btn.addEventListener("click", () => { location.hash = hashFor(nextSort(readState(), col.key)); });
      th.append(btn);
      tr.append(th);
    }
  }

  function cell(text, cls) {
    const td = document.createElement("td");
    td.className = cls;
    td.textContent = text;
    return td;
  }

  function renderBody(pageRows) {
    const body = $("body");
    body.textContent = "";
    if (!pageRows.length) {
      const tr = document.createElement("tr");
      const td = cell("No words yet. Hover over a Japanese word and press Shift.", "empty");
      td.colSpan = COLUMNS.length;
      tr.append(td);
      body.append(tr);
      return;
    }
    for (const r of pageRows) {
      const tr = document.createElement("tr");
      tr.append(
        cell(r.kanji, "kanji"),
        cell(r.reading, "reading"),
        cell(r.meaning, "meaning"),
        cell(r.count, "num"),
        cell(r.last ? dateFmt.format(r.last) : "–", "date"),
      );
      body.append(tr);
    }
  }

  function renderPager(state, total) {
    const nav = $("pager");
    nav.textContent = "";
    const pages = Math.ceil(total / PAGE_SIZE);
    if (pages <= 1) return;
    const current = Math.floor(state.start / PAGE_SIZE);

    // all pages if few, otherwise first, last, and a window around the current one
    const show = new Set([0, pages - 1]);
    for (let p = current - 4; p <= current + 4; p++) if (p >= 0 && p < pages) show.add(p);
    if (pages <= 15) for (let p = 0; p < pages; p++) show.add(p);

    let prev = -1;
    for (const p of [...show].sort((a, b) => a - b)) {
      if (prev !== -1 && p - prev > 1) {
        const gap = document.createElement("span");
        gap.className = "gap";
        gap.textContent = "…";
        nav.append(gap);
      }
      prev = p;
      const from = p * PAGE_SIZE;
      const to = Math.min(from + PAGE_SIZE, total) - 1;
      const label = `${from}–${to}`;
      if (p === current) {
        const s = document.createElement("span");
        s.className = "current";
        s.textContent = label;
        nav.append(s);
      } else {
        const a = document.createElement("a");
        a.textContent = label;
        a.href = hashFor({ ...state, start: from });
        nav.append(a);
      }
    }
  }

  function render() {
    const state = readState();
    const rows = sortRows(buildRows(), state);
    const total = rows.length;
    if (state.start >= total && total > 0) state.start = Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE;
    const pageRows = rows.slice(state.start, state.start + PAGE_SIZE);

    $("summary").textContent = total
      ? `${total} word${total === 1 ? "" : "s"} · showing ${state.start}–${state.start + pageRows.length - 1}` +
        (state.sort ? "" : " · most recently seen first")
      : "Your index is empty.";
    renderHead(state);
    renderBody(pageRows);
    renderPager(state, total);
  }

  // ---------- Data loading ----------

  async function refresh() {
    const stored = await browser.storage.local.get(["words", "lastSeen"]);
    words = stored.words || {};
    lastSeen = stored.lastSeen || {};
    render();            // show something right away
    await ensureInfo();  // then fill in readings / translations
    render();
  }

  window.addEventListener("hashchange", render);
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.words || changes.lastSeen)) refresh();
  });
  refresh();
})();
