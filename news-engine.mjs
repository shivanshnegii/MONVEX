// MONVEX AI news engine — Node 20+, zero npm packages, free-tier services only.
//   Headlines/summaries : Google Gemini API free tier   (GEMINI_API_KEY)
//   News source         : public RSS feeds              (no key)
//   Cover images        : Cloudflare Workers AI FLUX    (CF_ACCOUNT_ID, CF_API_TOKEN) — optional
//   Company logos       : Brandfetch Logo API           (client ID is public, used in the website, not here)
// Output: docs/news.json + docs/covers/*.jpg  (served by GitHub Pages next to the website).

import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";

const { GEMINI_API_KEY, CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const MAX_NEW = +(process.env.MAX_NEW || 3), KEEP = 200, OUT = "./docs", DB = OUT + "/news.json", COVERS = OUT + "/covers";
const CATS = ["Markets", "India", "Crypto", "Commodities", "Tech"];
const MAX_IMG = +(process.env.MAX_IMG || 4);
let imgFail = false; // stop wasting time if the image service says no
const MOTIF = { Markets: "chart", India: "bank", Crypto: "coin", Commodities: "gold", Tech: "chip" };
const FEEDS = [ // a dead feed is skipped, not fatal. Check URLs in a browser if one stops producing news.
  ["CNBC", "https://www.cnbc.com/id/100003114/device/rss/rss.html"],
  ["MarketWatch", "https://feeds.marketwatch.com/marketwatch/topstories"],
  ["Yahoo Finance", "https://finance.yahoo.com/news/rssindex"],
  ["Bloomberg Markets", "https://feeds.bloomberg.com/markets/news.rss"],
  ["CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"],
  ["Cointelegraph", "https://cointelegraph.com/rss"],
  ["Economic Times", "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms"],
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => createHash("sha256").update(s).digest("hex").slice(0, 12);
const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const wc = s => s.trim().split(/\s+/).length;
const toks = t => new Set(norm(t).split(" ").filter(w => w.length > 3));
const similar = (a, b) => { const x = toks(a), y = toks(b); let i = 0; x.forEach(w => y.has(w) && i++); return i / Math.max(1, Math.min(x.size, y.size)) >= 0.7; };
const load = async () => { try { return JSON.parse(await readFile(DB, "utf8")); } catch { return []; } };
const exists = async f => { try { await readFile(f); return true; } catch { return false; } };

// ---- RSS (tiny parser) ----
const clean = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
const tag = (x, t) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")); return m ? clean(m[1]) : ""; };
async function readFeed([src, url]) {
  try {
    const r = await fetch(url, { headers: { "user-agent": "MONVEX-news/1.0" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(r.status);
    const xml = await r.text();
    return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].slice(0, 10).map(m => ({
      src, title: tag(m[0], "title"), link: tag(m[0], "link"), desc: tag(m[0], "description"), date: tag(m[0], "pubDate"),
    })).filter(a => /^https?:\/\/[^\s"<>]+$/.test(a.link) && a.title);
  } catch (e) { console.error("Feed failed:", src, e.message); return []; }
}

// ---- Gemini (free tier) ----
const MODELS = [...new Set([MODEL, "gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"])];
let goodModel = null;
async function gemini(prompt) {
  let last = "";
  for (const m of goodModel ? [goodModel] : MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } }),
    });
    if (r.status === 429) throw Object.assign(new Error("Gemini free-tier limit reached (429)"), { quota: true });
    if (r.status === 404) { last = `${m}: not found`; continue; } // try the next model name
    if (!r.ok) throw Object.assign(new Error(`Gemini ${m} HTTP ${r.status}: ${(await r.text()).slice(0, 250)}`), { fatal: true });
    goodModel = m;
    return (await r.json()).candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  }
  throw Object.assign(new Error("No Gemini model name worked. " + last), { fatal: true });
}

// RSS gives only a short snippet, so length adapts: 80-120 words only when the source has enough text.
// A shorter validated summary is better than a padded one that invents facts.
async function rewrite(a) {
  const src = `${a.title}. ${a.desc}`, sw = wc(src);
  const [lo, hi] = sw >= 100 ? [80, 120] : [20, Math.max(45, Math.min(80, Math.round(sw * 2)))];
  let note = "";
  for (let i = 0; i < 2; i++) {
    const out = await gemini(`You are a financial news editor. Using ONLY the source text below, return JSON:
{"headline":"clear professional headline","summary":"${lo}-${hi} words","category":"${CATS.join("|")}","sentiment":"up|down","company":{"name":"","domain":""} or null,"scene":"a distinct, concrete real-world scene specific to THIS story, as a news photographer would shoot it (e.g. a container port for trade news, an oil refinery for crude, a data centre for AI chips, a bank building for rates); no charts, no screens, no text, no logos, no people","change":"the percent move exactly as written in the source, e.g. -2%, else empty string"}
Write the headline and summary in your own words: do not copy sentences or long phrases from the source. Never add, infer, or change any fact, number, name or date. Use "company" only if one company is clearly the subject and you are certain of its official website domain. ${note}
SOURCE: ${src}`);
    try {
      const j = JSON.parse(out.replace(/```json|```/g, "").trim()), n = wc(j.summary);
      const bad = (`${j.headline} ${j.summary}`.match(/\d[\d,.]*\d|\d/g) || []).filter(x => !src.includes(x.replace(/[.,]$/, "")));
      if (n >= lo && n <= hi && !bad.length && CATS.includes(j.category)) { j.change = /^[+-]?\d+(\.\d+)?%$/.test(j.change || "") && src.includes(j.change.replace(/^[+-]/, "")) ? j.change : ""; return j; }
      note = `Previous attempt failed (${n} words; numbers not in source: ${bad.join(",") || "none"}). Fix it.`;
    } catch { note = "Previous output was not valid JSON."; }
  }
  console.error("Rejected:", a.title.slice(0, 70), "-", note);
  return null; // unvalidated -> not published
}

// Only keep a logo domain if the company is named in the source and the domain plausibly matches its name.
// The website hotlinks the logo from Brandfetch (their terms forbid storing logos), so nothing is saved here.
function logoDomain(c, src) {
  if (!c || !c.name || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(c.domain || "")) return null;
  const n = norm(c.name).replace(/ /g, ""), d = c.domain.toLowerCase().split(".").slice(-2)[0];
  if (!src.toLowerCase().includes(c.name.toLowerCase())) return null;
  return n.includes(d) || d.includes(norm(c.name).split(" ")[0]) ? c.domain.toLowerCase() : null;
}

// ---- Cover image (Cloudflare Workers AI, FLUX.1 schnell, free daily allowance) ----
async function cover(id, scene, dir) {
  if (imgFail || !CF_ACCOUNT_ID || !CF_API_TOKEN) return null;
  const rel = `covers/${id}.jpg`, f = `${OUT}/${rel}`;
  if (await exists(f)) return rel; // never regenerate
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
      method: "POST", headers: { Authorization: `Bearer ${CF_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: `${scene}. ${dir === "down" ? "Somber, moody lighting." : "Bright, optimistic lighting."} Photorealistic editorial news photograph, wide composition. No text, no letters, no logos, no brand marks, no charts, no people.`, steps: 4 }),
    });
    const b64 = (await r.json())?.result?.image;
    if (!r.ok || !b64) throw new Error("status " + r.status);
    await mkdir(COVERS, { recursive: true });
    await writeFile(f, Buffer.from(b64, "base64"));
    return rel;
  } catch (e) { console.error("Cover skipped:", e.message); imgFail = true; return null; } // article still publishes, site shows its chart
}

// ---- Market prices + charts (Yahoo Finance chart endpoint: free, no key, unofficial -> may change) ----
const SYMS = [["SENSEX", "^BSESN"], ["NIFTY 50", "^NSEI"], ["S&P 500", "^GSPC"], ["NASDAQ", "^IXIC"], ["GOLD", "GC=F"], ["BITCOIN", "BTC-USD"]];
const RANGES = { "1D": ["1d", "5m"], "1W": ["5d", "30m"], "1M": ["1mo", "1d"], "1Y": ["1y", "1wk"] };
const thin = (a, n = 60) => { if (a.length <= n) return a; return Array.from({ length: n }, (_, i) => a[Math.round(i * (a.length - 1) / (n - 1))]); };
async function yahoo(sym, [range, interval]) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`, { headers: { "user-agent": "Mozilla/5.0 (compatible; MONVEX-news/1.0)" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(r.status);
  const j = (await r.json()).chart?.result?.[0];
  if (!j) throw new Error("no data");
  return j;
}
async function markets() {
  const items = [];
  for (const [name, sym] of SYMS) {
    try {
      const series = {}; let meta;
      for (const [k, v] of Object.entries(RANGES)) {
        const j = await yahoo(sym, v);
        if (k === "1D") meta = j.meta; // previous close is only correct for the 1-day request
        series[k] = thin((j.indicators.quote[0].close || []).filter(x => x != null).map(x => +x.toFixed(2)));
        await sleep(400);
      }
      const price = meta.regularMarketPrice, prev = meta.chartPreviousClose ?? meta.previousClose;
      if (!(price > 0) || !(prev > 0)) throw new Error("bad price");
      items.push({ name, price, prev, chg: +((price - prev) / prev * 100).toFixed(2), high: meta.regularMarketDayHigh ?? price, low: meta.regularMarketDayLow ?? price, series });
    } catch (e) { console.error("Market skipped:", name, e.message); }
  }
  if (items.length) { await mkdir(OUT, { recursive: true }); await writeFile(OUT + "/markets.json", JSON.stringify({ updated: new Date().toISOString(), items })); }
  console.log(`Markets updated: ${items.length}/${SYMS.length}`);
}

async function run() {
  await markets().catch(err => console.error("Markets failed:", err.message));
  if (!GEMINI_API_KEY) { console.error("Missing GEMINI_API_KEY"); process.exit(1); }
  let db = await load(), added = 0;
  const lists = await Promise.all(FEEDS.map(readFeed)), items = [];
  for (let i = 0; items.length < 80 && lists.some(l => l[i]); i++) lists.forEach(l => l[i] && items.push(l[i])); // round-robin
  let tried = 0;
  for (const a of items) {
    if (added >= MAX_NEW) break;
    const t = Date.parse(a.date), id = "story-" + sha(a.link.split("?")[0]);
    if (t && Date.now() - t > 3 * 864e5) continue;
    if (db.some(x => x.id === id || similar(x.sourceTitle, a.title))) continue; // duplicate
    if (++tried > 12) break; // keep free-tier usage low
    try {
      const j = await rewrite(a);
      await sleep(5000); // stay well inside free-tier per-minute limits
      if (!j) continue;
      const img = await cover(id, j.scene, j.sentiment);
      db.unshift({
        id, cat: j.category, t: j.headline, s: j.summary, b: [j.summary],
        d: new Date(t || Date.now()).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
        up: j.sentiment === "up" ? 1 : 0, change: j.change || "", scene: j.scene, motif: img ? undefined : MOTIF[j.category], seed: parseInt(id.slice(6, 10), 16), img,
        logo: logoDomain(j.company, `${a.title}. ${a.desc}`), source: { name: a.src, url: a.link }, sourceTitle: a.title, published: new Date(t || Date.now()).toISOString(),
      });
      added++;
    } catch (e) { console.error("Skipped:", a.title, "-", e.message); if (e.quota || e.fatal) break; }
  }
  // Give a real AI cover to stories that still show the drawn placeholder (a few per run)
  let imgs = 0;
  for (const a of db) {
    if (imgs >= MAX_IMG || imgFail || !CF_ACCOUNT_ID || !CF_API_TOKEN) break;
    if (a.img || (a.published && Date.now() - Date.parse(a.published) > 3 * 864e5)) continue;
    const img = await cover(a.id, a.scene || `A photorealistic news photograph illustrating: ${a.t}`, a.up ? "up" : "down");
    imgs++;
    if (img) { a.img = img; delete a.motif; }
    await sleep(1000);
  }
  // text is kept; cover files of stories older than 14 days are removed to save space
  for (const a of db) if (a.img && a.published && Date.now() - Date.parse(a.published) > 14 * 864e5) { await unlink(`${OUT}/${a.img}`).catch(() => {}); delete a.img; a.motif = MOTIF[a.cat]; }
  for (const old of db.slice(KEEP)) if (old.img) await unlink(`${OUT}/${old.img}`).catch(() => {});
  db = db.slice(0, KEEP);
  await mkdir(OUT, { recursive: true });
  await writeFile(DB, JSON.stringify(db));
  console.log(`Feed items: ${items.length}. Tried: ${tried}. Added ${added}. Total ${db.length}.`);
}
run();
