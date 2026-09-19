// Scans one day of SEC EDGAR filings for large insider / 5%-holder BUYING.
// Usage: node scripts/scan.mjs [YYYY-MM-DD]   (default: yesterday, UTC)
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";

const UA = process.env.SEC_USER_AGENT;
if (!UA || !UA.includes("@")) {
  console.error('Set SEC_USER_AGENT to something like "Your Name you@email.com" (SEC requires contact info).');
  process.exit(1);
}
const MIN_USD = Number(process.env.MIN_USD || 10_000_000); // Form 4 hard filter
const MIN_USD_KEEP = Number(process.env.MIN_KEEP || 1_000_000); // stored in JSON so the site slider can go lower than the default

const arg = process.argv[2];
const d = arg ? new Date(arg + "T00:00:00Z") : new Date(Date.now() - 86400000);
const iso = d.toISOString().slice(0, 10);
const [Y, M, D] = iso.split("-");
const qtr = Math.ceil(Number(M) / 3);
const ymd = `${Y}${M}${D}`;

let last = 0;
async function get(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const wait = 130 - (Date.now() - last); // stay well under SEC's 10 req/s limit
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Encoding": "gzip, deflate" } });
    if (res.status === 404) return null;
    if (res.ok) return await res.text();
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw new Error("Failed: " + url);
}

const WS = /\s*/.source;
const tag = (s, t) => (s.match(new RegExp("<" + t + ">" + WS + "(?:<value>)?" + WS + "([^<]*?)" + WS + "(?:</value>)?" + WS + "</" + t + ">", "i")) || [])[1]?.trim();
const ANY = /[\s\S]*?/.source;
const blocks = (s, t) => [...s.matchAll(new RegExp("<" + t + ">" + ANY + "</" + t + ">", "gi"))].map((m) => m[0]);
const yes = (v) => v === "1" || v?.toLowerCase() === "true";
const num = (v) => Number(String(v ?? "").replace(/[$,]/g, ""));
const money = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

const idxText = await get(`https://www.sec.gov/Archives/edgar/daily-index/${Y}/QTR${qtr}/form.${ymd}.idx`);
if (!idxText) {
  console.log(`No EDGAR index for ${iso} (weekend, holiday, or not published yet).`);
  process.exit(0);
}

const filings = new Map(); // accession -> {form, name, path}
for (const line of idxText.split("\n")) {
  const m = line.match(/(\d+)\s+(\d{8})\s+(edgar\/data\/\S+)\s*$/);
  if (!m) continue;
  const form = line.slice(0, 17).trim();
  if (!(form === "4" || form === "4/A" || /^(SC|SCHEDULE) 13D(\/A)?$/.test(form))) continue;
  const acc = m[3].split("/").pop().replace(".txt", "");
  if (!filings.has(acc)) filings.set(acc, { form, cik: m[1], path: m[3], acc });
}
console.log(`${iso}: ${filings.size} candidate filings`);
const stats = { f4: 0, f4P: 0 };

const form4 = [], sc13d = [];
const indexUrl = (f) => {
  const [, cik, acc] = f.path.match(/edgar\/data\/(\d+)\/(.+)\.txt/);
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}/${acc}-index.htm`;
};

function parseForm4(f, txt) {
  const doc = txt.match(/<ownershipDocument>[\s\S]*<\/ownershipDocument>/i)?.[0];
  if (!doc) return;
  const issuer = { name: tag(doc, "issuerName"), ticker: tag(doc, "issuerTradingSymbol"), cik: tag(doc, "issuerCik") };
  const owners = blocks(doc, "reportingOwner").map((o) => {
    const roles = [];
    if (yes(tag(o, "isDirector"))) roles.push("Director");
    if (yes(tag(o, "isOfficer"))) roles.push(tag(o, "officerTitle") || "Officer");
    if (yes(tag(o, "isTenPercentOwner"))) roles.push("10% Owner");
    if (yes(tag(o, "isOther"))) roles.push(tag(o, "otherText") || "Other");
    return { name: tag(o, "rptOwnerName"), roles };
  });
  let shares = 0, value = 0, dates = new Set(), postHeld = null, tenb51 = /10b5-1/i.test(doc);
  for (const t of blocks(doc, "nonDerivativeTransaction")) {
    if (tag(t, "transactionCode") !== "P") continue; // P = open-market or private purchase
    if (tag(t, "transactionAcquiredDisposedCode") === "D") continue;
    const s = num(tag(t, "transactionShares")), p = num(tag(t, "transactionPricePerShare"));
    if (!s || !p) continue;
    shares += s; value += s * p;
    dates.add(tag(t, "transactionDate"));
    postHeld = num(tag(t, "sharesOwnedFollowingTransaction")) || postHeld;
  }
  if (value < MIN_USD_KEEP) return;
  form4.push({
    form: f.form, issuer, owners, shares: Math.round(shares), avgPrice: +(value / shares).toFixed(4),
    value: Math.round(value), tradeDates: [...dates].sort(), sharesAfter: postHeld,
    plan10b5_1: tenb51, url: indexUrl(f),
  });
}

function parse13D(f, txt) {
  const plain = txt.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#?[a-z0-9]+;/gi, " ").replace(/\s+/g, " ");
  const subject = tag(txt, "issuerName") || (plain.match(/SUBJECT COMPANY:\s+COMPANY CONFORMED NAME:\s+(.+?)\s+CENTRAL/i) || [])[1];
  const filerName = tag(txt, "reportingPersonName") || (plain.match(/FILED BY:\s+COMPANY CONFORMED NAME:\s+(.+?)\s+CENTRAL/i) || [])[1];
  const pct = tag(txt, "percentOfClass") || (plain.match(/Percent of class[^0-9]{0,80}([\d.]+)\s*%/i) || [])[1];
  const owned = tag(txt, "aggregateAmountOwned");
  const cusip = tag(txt, "issuerCusip") || tag(txt, "issuerCUSIP");
  // Look for price/consideration language in the narrative.
  const snippets = [];
  const re = /[^.]{0,200}(?:\$\s?[\d,]+(?:\.\d+)?(?:\s*(?:million|billion))?)[^.]{0,200}\./gi;
  for (const m of plain.matchAll(re)) {
    if (/purchas|acquir|bought|consideration|open market/i.test(m[0]) && !/par value/i.test(m[0])) snippets.push(m[0].trim());
    if (snippets.length >= 4) break;
  }
  // Recent trades: rows like "09/08/2026 4,001 $6.72" within 30 days of the filing date (Item 5(c) tables).
  const filed = new Date(iso + "T00:00:00Z");
  let tradeShares = 0, tradeValue = 0;
  const seen = new Set();
  for (const m of plain.matchAll(/(\d{2})\/(\d{2})\/(\d{4})\s+([\d,]+)\s+\$\s?([\d,]+(?:\.\d+)?)/g)) {
    const dt = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
    const age = (filed - dt) / 86400000;
    const key = m[0];
    if (age < -1 || age > 30 || seen.has(key)) continue;
    seen.add(key);
    const sh = num(m[4]), px = num(m[5]);
    if (sh && px) { tradeShares += sh; tradeValue += sh * px; }
  }
  const price = tradeShares ? +(tradeValue / tradeShares).toFixed(4) : null;
  const value = tradeValue || null;
  sc13d.push({
    form: f.form, subject, filer: filerName, percentOfClass: pct ? +pct : null, cusip,
    sharesOwned: owned ? num(owned) : null, recentTradeShares: tradeShares || null, avgPrice: price, recentTradeValue: value ? Math.round(value) : null,
    snippets, url: indexUrl(f),
  });
}

let n = 0;
for (const f of filings.values()) {
  n++;
  if (n % 200 === 0) console.log(`  ...${n}/${filings.size}`);
  try {
    const txt = await get(`https://www.sec.gov/Archives/${f.path}`);
    if (!txt) continue;
    f.form.startsWith("4") ? parseForm4(f, txt) : parse13D(f, txt);
  } catch (e) { console.error(e.message); }
}

form4.sort((a, b) => b.value - a.value);
sc13d.sort((a, b) => (b.recentTradeValue || 0) - (a.recentTradeValue || 0));
mkdirSync("data", { recursive: true });
writeFileSync(`data/${iso}.json`, JSON.stringify({ date: iso, generated: new Date().toISOString(), defaultMinUsd: MIN_USD, form4, sc13d }, null, 1));

const files = existsSync("data/index.json") ? JSON.parse(readFileSync("data/index.json", "utf8")) : [];
if (!files.includes(iso)) files.push(iso);
files.sort().reverse();
writeFileSync("data/index.json", JSON.stringify(files));
console.log(`Wrote data/${iso}.json — ${form4.length} Form 4 buys >= $${money(MIN_USD_KEEP)}, ${sc13d.length} 13D filings`);
