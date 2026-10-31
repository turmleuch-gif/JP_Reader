// Background script: owns the dictionary (loaded once, not per tab),
// does the longest-match tokenizing, and manages the word index.

// ---------- Dictionary ----------

// Flag bits stored per dictionary headword
const V1 = 1, V5 = 2, VS = 4, VK = 8, ADJ = 16, NSURU = 64;
// Extra "states" used only while deinflecting
const TE = 128, MASU = 256, ANY = 0xffff;

const MAX_LEN = 20;     // longest phrase we try to match
const DEINF_MAX = 12;   // longest surface string we try to deinflect

let D = null; // Map<headword, flags>
let dictPromise = null;

function loadDict() {
  if (!dictPromise) {
    dictPromise = (async () => {
      const res = await fetch(browser.runtime.getURL("dict.bin"));
      const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
      const text = await new Response(stream).text();
      const map = new Map();
      for (const line of text.split("\n")) {
        if (!line) continue;
        const tab = line.indexOf("\t");
        if (tab < 0) map.set(line, 0);
        else map.set(line.slice(0, tab), Number(line.slice(tab + 1)));
      }
      D = map;
    })();
  }
  return dictPromise;
}

// ---------- Deinflection rules ----------
// rule(from, to, cin, cout): a word ending in `from` may be the inflection of a
// word ending in `to`. `cin` = which state the current string must be in,
// `cout` = what the result must be (a dictionary class, or an intermediate form).

const rules = [];
const rule = (from, to, cin, cout) => rules.push({ from, to, cin, cout });

// Ichidan verbs
rule("た", "る", ANY, V1);       rule("て", "る", TE, V1);
rule("ない", "る", ADJ, V1);     rule("ます", "る", MASU, V1);
rule("れば", "る", ANY, V1);     rule("よう", "る", ANY, V1);
rule("たい", "る", ADJ, V1);     rule("られる", "る", V1, V1);
rule("れる", "る", V1, V1);      rule("させる", "る", V1, V1);
rule("させられる", "る", V1, V1);
rule("", "る", ANY, V1);         // masu-stem: 食べ -> 食べる

// Godan verbs
const GODAN = [ // [dictionary ending, a, i, e, o]
  ["う", "わ", "い", "え", "お"], ["く", "か", "き", "け", "こ"], ["ぐ", "が", "ぎ", "げ", "ご"],
  ["す", "さ", "し", "せ", "そ"], ["つ", "た", "ち", "て", "と"], ["ぬ", "な", "に", "ね", "の"],
  ["ぶ", "ば", "び", "べ", "ぼ"], ["む", "ま", "み", "め", "も"], ["る", "ら", "り", "れ", "ろ"],
];
for (const [u, a, i, e, o] of GODAN) {
  rule(a + "ない", u, ADJ, V5);   rule(i + "ます", u, MASU, V5);
  rule(i + "たい", u, ADJ, V5);   rule(i, u, ANY, V5);
  rule(e + "ば", u, ANY, V5);     rule(e + "る", u, V1, V5);      // potential
  rule(a + "れる", u, V1, V5);    rule(a + "せる", u, V1, V5);    // passive / causative
  rule(a + "される", u, V1, V5);  rule(o + "う", u, ANY, V5);     // short causative-passive / volitional
}
for (const [f, t] of [["って", "う"], ["って", "つ"], ["って", "る"], ["んで", "ぬ"], ["んで", "ぶ"],
                      ["んで", "む"], ["いて", "く"], ["いで", "ぐ"], ["して", "す"]]) {
  rule(f, t, TE, V5);
  rule(f.replace("て", "た").replace("で", "だ"), t, ANY, V5); // past
}

// する / 来る
rule("し", "する", ANY, VS);      rule("した", "する", ANY, VS);   rule("して", "する", TE, VS);
rule("しない", "する", ADJ, VS);  rule("します", "する", MASU, VS); rule("したい", "する", ADJ, VS);
rule("しよう", "する", ANY, VS);  rule("すれば", "する", ANY, VS);
rule("させる", "する", V1, VS);   rule("される", "する", V1, VS);
for (const [k, kr, ko] of [["き", "こ", "く"], ["来", "来", "来"]]) {
  const base = k === "来" ? "来る" : "くる";
  rule(k + "た", base, ANY, VK);     rule(k + "て", base, TE, VK);
  rule(kr + "ない", base, ADJ, VK);  rule(k + "ます", base, MASU, VK);
  rule(k + "たい", base, ADJ, VK);   rule(kr + "よう", base, ANY, VK);
  rule(ko + "れば", base, ANY, VK);  rule(kr + "られる", base, V1, VK);
  rule(kr + "させる", base, V1, VK);
}

// i-adjectives (and ない)
rule("かった", "い", ANY, ADJ);  rule("くない", "い", ADJ, ADJ);  rule("くて", "い", ANY, ADJ);
rule("ければ", "い", ANY, ADJ);  rule("く", "い", ANY, ADJ);      rule("さ", "い", ANY, ADJ);
rule("なくて", "ない", ANY, ADJ); rule("なければ", "ない", ANY, ADJ);
rule("なく", "ない", ANY, ADJ);   rule("ないで", "ない", ANY, ADJ);

// Polite forms
for (const f of ["ました", "ません", "ませんでした", "ましょう"]) rule(f, "ます", ANY, MASU);

// て-form helpers: 食べている, 読んでおく, 見ちゃった ...
const AUX = [["ている", V1], ["てる", V1], ["ておく", V5], ["とく", V5], ["てある", V5],
             ["てしまう", V5], ["ちゃう", V5], ["てみる", V1], ["ていく", V5], ["てくる", VK],
             ["てあげる", V1], ["てもらう", V5], ["てくれる", V1]];
for (const [f, cin] of AUX) {
  rule(f, "て", cin, TE);
  const voiced = f.replace(/^て/, "で").replace(/^と/, "ど").replace(/^ち/, "じ");
  if (voiced !== f) rule(voiced, "で", cin, TE);
}

const byLast = new Map();
const emptyRules = [];
for (const r of rules) {
  if (!r.from) { emptyRules.push(r); continue; }
  const k = r.from[r.from.length - 1];
  if (!byLast.has(k)) byLast.set(k, []);
  byLast.get(k).push(r);
}

function dictAccepts(text, type) {
  const fl = D.get(text);
  if (fl !== undefined && (fl & type)) return true;
  if ((type & VS) && text.length > 2 && text.endsWith("する")) {
    const noun = D.get(text.slice(0, -2));
    if (noun !== undefined && (noun & NSURU)) return true; // 勉強 + する
  }
  return false;
}

// Returns the dictionary form if `surface` is a valid inflection of a dictionary word.
function deinflectLookup(surface) {
  const queue = [{ text: surface, type: ANY, depth: 0 }];
  const seen = new Set([surface + "|" + ANY]);
  for (let qi = 0; qi < queue.length && qi < 150; qi++) {
    const cur = queue[qi];
    if (cur.depth > 0 && dictAccepts(cur.text, cur.type)) return cur.text;
    if (cur.depth >= 8) continue;
    const cands = (byLast.get(cur.text[cur.text.length - 1]) || []).concat(emptyRules);
    for (const r of cands) {
      if (!(cur.type & r.cin) || !cur.text.endsWith(r.from)) continue;
      const nt = cur.text.slice(0, cur.text.length - r.from.length) + r.to;
      const key = nt + "|" + r.cout;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ text: nt, type: r.cout, depth: cur.depth + 1 });
    }
  }
  return null;
}

// ---------- Tokenizer (greedy longest match) ----------

const isJP = (c) =>
  (c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf) ||
  (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xff66 && c <= 0xff9f) || c === 0x3005;
// characters that may appear inside a dictionary entry (JP + latin/digits/・)
const isWordChar = (c) =>
  isJP(c) || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) ||
  c === 0x30fb || (c >= 0xff10 && c <= 0xff19) || (c >= 0xff21 && c <= 0xff3a) || (c >= 0xff41 && c <= 0xff5a);

// Greedy longest match starting at i. A match is preferred if it ends on a natural word
// boundary (according to Intl.Segmenter); otherwise the longest match is the fallback.
// This stops e.g. はま (浜) from eating the は of 彼は|まだ.
function longestMatch(text, i, runEnd, bounds) {
  const maxEnd = Math.min(runEnd, i + MAX_LEN);
  let fallback = null;
  for (let end = maxEnd; end > i; end--) {
    const s = text.slice(i, end);
    let word = D.has(s) ? s : null;
    if (!word && end - i <= DEINF_MAX) word = deinflectLookup(s);
    if (!word) continue;
    if (end === text.length || bounds.has(end)) return { end, word };
    if (!fallback) fallback = { end, word };
  }
  return fallback;
}

const segmenter = new Intl.Segmenter("ja", { granularity: "word" });

const tokenCache = new Map();

function tokenize(text) {
  const hit = tokenCache.get(text);
  if (hit) return hit;
  const tokens = [];
  const n = text.length;
  const bounds = new Set();
  for (const seg of segmenter.segment(text)) bounds.add(seg.index + seg.segment.length);
  let i = 0;
  while (i < n) {
    if (!isJP(text.charCodeAt(i))) { i++; continue; }
    let runEnd = i + 1;
    while (runEnd < n && runEnd - i < MAX_LEN && isWordChar(text.charCodeAt(runEnd))) runEnd++;
    const m = longestMatch(text, i, runEnd, bounds);
    if (m) { tokens.push({ s: i, e: m.end, w: m.word }); i = m.end; }
    else i++;
  }
  if (tokenCache.size > 3000) tokenCache.clear();
  tokenCache.set(text, tokens);
  return tokens;
}

// ---------- Word index ----------

let wordsPromise = null;
const getWords = () => {
  if (!wordsPromise) wordsPromise = browser.storage.local.get("words").then((r) => r.words || {});
  return wordsPromise;
};
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.words) wordsPromise = Promise.resolve(changes.words.newValue || {});
});
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------- Messages from content scripts ----------

browser.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "scan":   return handleScan(msg);
    case "lookup": return handleLookup(msg);
    case "add":    return handleAdd(msg);
  }
});

// texts -> for each text, [[start, end, count], ...] of words already in the index
async function handleScan({ texts }) {
  await loadDict();
  const words = await getWords();
  return texts.map((t) => {
    const out = [];
    for (const tok of tokenize(t)) if (has(words, tok.w)) out.push([tok.s, tok.e, words[tok.w]]);
    return out;
  });
}

// text + candidate character offsets -> tokens covering those offsets
async function handleLookup({ text, offsets }) {
  await loadDict();
  const words = await getWords();
  const tokens = tokenize(text);
  const found = [];
  for (const off of offsets) {
    const tok = tokens.find((t) => t.s <= off && off < t.e);
    if (tok && !found.includes(tok)) {
      found.push(tok);
    }
  }
  return found.map((t) => ({ s: t.s, e: t.e, word: t.w, surface: text.slice(t.s, t.e), count: has(words, t.w) ? words[t.w] : 0 }));
}

async function handleAdd({ word }) {
  const words = Object.assign({}, await getWords());
  words[word] = (has(words, word) ? words[word] : 0) + 1;
  wordsPromise = Promise.resolve(words);
  const { lastSeen = {} } = await browser.storage.local.get("lastSeen");
  lastSeen[word] = Date.now();
  await browser.storage.local.set({ words, lastSeen });
  return { count: words[word] };
}

// ---------- Toolbar button opens the word list page ----------

browser.browserAction.onClicked.addListener(async () => {
  const url = browser.runtime.getURL("list.html");
  const [existing] = await browser.tabs.query({ url });
  if (existing) {
    await browser.tabs.update(existing.id, { active: true });
    await browser.windows.update(existing.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url });
  }
});
