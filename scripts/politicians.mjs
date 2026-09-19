// Collects periodic transaction reports (PTRs) for tracked members of Congress into data/politicians/.
// House: Clerk disclosure index + PTR PDFs. Senate: eFD search + PTR pages.
// Usage: node scripts/politicians.mjs      (env LOOKBACK_DAYS, default 365)
// Members have up to 45 days to file, so a trade date is usually only visible weeks later.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";

const MEMBERS = [
  { name: "Donald Norcross", chamber: "House", last: "Norcross", state: "NJ01" },
  { name: "Terri Sewell", chamber: "House", last: "Sewell", state: "AL07" },
  { name: "Tim Moore", chamber: "House", last: "Moore", state: "NC14" },
  { name: "Ted Cruz", chamber: "Senate", last: "Cruz", first: "Ted" },
  { name: "Lisa McClain", chamber: "House", last: "McClain", state: "MI09" },
  { name: "Pete Ricketts", chamber: "Senate", last: "Ricketts", first: "Pete" },
  { name: "Thomas Suozzi", chamber: "House", last: "Suozzi", state: "NY03" },
  { name: "Shri Thanedar", chamber: "House", last: "Thanedar", state: "MI13" },
  { name: "Nancy Pelosi", chamber: "House", last: "Pelosi", state: "CA11" },
];

const OUT = "data/politicians";
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 365);
const UA = "insider-buy-scanner politician-tracker (public STOCK Act disclosures)";
const HOUSE = "https://disclosures-clerk.house.gov/public_disc";
const SENATE = "https://efdsearch.senate.gov";

mkdirSync(OUT, { recursive: true });
const readJson = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);
const prior = readJson(`${OUT}/transactions.json`, []);
const meta = readJson(`${OUT}/meta.json`, { parsed: [] });
const parsed = new Set(meta.parsed);
const errors = [];
const found = [];
const filings = {}; // member -> {count, latest}

const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
const usDate = (s) => { const [m, d, y] = s.split("/"); return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`; };
const strip = (s) => s.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const note = (m, filed) => { const f = (filings[m] ||= { count: 0, latest: null }); f.count++; if (!f.latest || filed > f.latest) f.latest = filed; };

const TYPE = { P: "Purchase", S: "Sale", "S (partial)": "Sale (partial)", E: "Exchange" };
const OWNER = { SP: "Spouse", DC: "Dependent child", JT: "Joint" };
const ASSET = { ST: "Stock", OP: "Options", EF: "ETF", MF: "Mutual fund", CS: "Corporate bond", GS: "Government security", CT: "Crypto", AB: "Asset-backed", RE: "Real estate", PS: "Private stock", OT: "Other" };

// ---------- House ----------
function parseHousePtr(text, ctx) {
  text = text.replace(/\u0000/g, "");
  const core = /\[([A-Z]{2})\]\s+(S \(partial\)|P|S|E)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(Over\s+\$[\d,]+|\$[\d,]+\s*-\s*\$[\d,]+|\$[\d,]+)/g;
  const hits = [...text.matchAll(core)];
  const out = [];
  let prevEnd = 0;
  hits.forEach((m, i) => {
    let seg = text.slice(prevEnd, m.index);
    const hdr = seg.lastIndexOf("$200?");
    let carried = null; // previous entry's trailing fields when a page break sits between entries
    if (hdr >= 0) { carried = seg.slice(0, hdr); seg = seg.slice(hdr + 5); }
    const lines = seg.split("\n").map((l) => l.trim()).filter(Boolean);
    // split off the previous entry's trailing fields (Filing Status / Description) from this asset's name
    let start = 0;
    const ownerLine = lines.map((l, j) => (/^(SP|DC|JT)\s/.test(l) ? j : -1)).filter((j) => j >= 0).pop();
    if (ownerLine !== undefined) start = ownerLine;
    else if (carried !== null) start = 0;
    else {
      const fs = lines.findIndex((l) => /^F\s*S:/.test(l));
      const dot = lines.map((l, j) => (j >= Math.max(fs, 0) && /[.]$/.test(l) ? j : -1)).filter((j) => j >= 0).pop();
      start = dot !== undefined ? dot + 1 : fs >= 0 ? fs + 1 : 0;
    }
    if (out.length) out[out.length - 1].description = describe(carried !== null ? carried + " " + lines.slice(0, start).join(" ") : lines.slice(0, start).join(" "));
    let asset = lines.slice(start).join(" ");
    let owner = "Self";
    const om = asset.match(/^(SP|DC|JT)\s+/);
    if (om) { owner = OWNER[om[1]]; asset = asset.slice(om[0].length); }
    // a few filings lay the name out after the "Filing Status" label; recover the ticker from the fragment before it
    const odd = asset.match(/^(.*?)\s*F\s*S:\s*\w+\s*(.*)$/);
    const tk = (odd ? odd[1] : asset).match(/\(([A-Z][A-Z0-9.\-]{0,5})\)\s*(?:\[\w+\])?[\s$\d,]*$/);
    if (odd && odd[2]) asset = odd[2];
    prevEnd = m.index + m[0].length;
    out.push({
      member: ctx.member, chamber: "House", txDate: usDate(m[3]), type: TYPE[m[2]], ticker: tk ? tk[1] : null,
      asset: asset.replace(/\s*\([A-Z][A-Z0-9.\-]{0,5}\)\s*$/, "").trim(), assetType: ASSET[m[1]] || m[1], owner,
      amount: m[5].replace(/\s+/g, " "), description: "", filed: ctx.filed, url: ctx.url,
    });
    if (i === hits.length - 1) {
      const tail = text.slice(prevEnd).split(/Filing ID #|\* For the complete|I\s+C\s*:/)[0];
      out[out.length - 1].description = describe(tail);
    }
  });
  return out;
}
const describe = (s) => {
  const m = s.replace(/\s+/g, " ").split(/Filing ID #/)[0].match(/D\s*:\s*(.*)$/);
  return (m ? m[1] : "").slice(0, 300).trim();
};

async function runHouse() {
  const wanted = MEMBERS.filter((m) => m.chamber === "House");
  const thisYear = new Date().getUTCFullYear();
  const years = [thisYear, ...(cutoff.slice(0, 4) < String(thisYear) ? [thisYear - 1] : [])];
  for (const year of years) {
    let xml;
    try {
      const res = await fetch(`${HOUSE}/financial-pdfs/${year}FD.zip`, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
      xml = strFromU8(files[`${year}FD.xml`]);
    } catch (e) { errors.push(`House ${year} index: ${e.message}`); continue; }
    for (const b of xml.match(/<Member>[\s\S]*?<\/Member>/g) || []) {
      const g = (t) => (b.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1]?.trim() || "";
      if (g("FilingType") !== "P") continue;
      const mem = wanted.find((w) => w.last === g("Last") && w.state === g("StateDst"));
      if (!mem) continue;
      const filed = usDate(g("FilingDate"));
      if (filed < cutoff) continue;
      note(mem.name, filed);
      const id = g("DocID");
      if (parsed.has("H" + id)) continue;
      const url = `${HOUSE}/ptr-pdfs/${year}/${id}.pdf`;
      try {
        const res = await fetch(url, { headers: { "User-Agent": UA } });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const pdf = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
        const { text } = await extractText(pdf, { mergePages: true });
        const rows = parseHousePtr(text, { member: mem.name, filed, url });
        if (!rows.length) throw new Error("no transactions parsed (scanned image or unexpected layout)");
        found.push(...rows); parsed.add("H" + id);
      } catch (e) { errors.push(`${mem.name} ${id}: ${e.message}`); }
    }
  }
}

// ---------- Senate ----------
async function runSenate() {
  const wanted = MEMBERS.filter((m) => m.chamber === "Senate");
  const jar = {};
  const cookies = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  const grab = (r) => { for (const c of r.headers.getSetCookie()) jar[c.split("=")[0]] = c.split(";")[0].split("=").slice(1).join("="); };
  try {
    let r = await fetch(SENATE + "/search/home/", { redirect: "manual", headers: { "User-Agent": UA } }); grab(r);
    const tok = (await r.text()).match(/csrfmiddlewaretoken" value="([^"]+)/)[1];
    r = await fetch(SENATE + "/search/home/", { method: "POST", redirect: "manual", headers: { "User-Agent": UA, "content-type": "application/x-www-form-urlencoded", cookie: cookies(), referer: SENATE + "/search/home/" }, body: new URLSearchParams({ csrfmiddlewaretoken: tok, prohibition_agreement: "1" }) }); grab(r);
    r = await fetch(SENATE + "/search/", { headers: { "User-Agent": UA, cookie: cookies() } }); grab(r);
  } catch (e) { errors.push("Senate session: " + e.message); return; }

  for (const mem of wanted) {
    try {
      const [y, m, d] = cutoff.split("-");
      const r = await fetch(SENATE + "/search/report/data/", {
        method: "POST",
        headers: { "User-Agent": UA, "content-type": "application/x-www-form-urlencoded", cookie: cookies(), referer: SENATE + "/search/", "x-csrftoken": jar.csrftoken },
        body: new URLSearchParams({ start: "0", length: "100", report_types: "[11]", filer_types: "[]", submitted_start_date: `${m}/${d}/${y} 00:00:00`, submitted_end_date: "", candidate_state: "", senator_state: "", office_id: "", first_name: "", last_name: mem.last, csrfmiddlewaretoken: jar.csrftoken }),
      });
      const rows = (await r.json()).data || [];
      for (const row of rows) {
        if (!new RegExp(`^${mem.last}, ${mem.first}`, "i").test(row[2])) continue;
        const href = (row[3].match(/href="([^"]+)"/) || [])[1];
        if (!href) continue;
        const filed = usDate(row[4]);
        note(mem.name, filed);
        if (parsed.has("S" + href)) continue;
        try {
          const page = await fetch(SENATE + href, { headers: { "User-Agent": UA, cookie: cookies() } });
          const html = await page.text();
          const trs = [...html.matchAll(/<tr>\s*<td>\d+<\/td>([\s\S]*?)<\/tr>/g)];
          if (!trs.length) throw new Error("no table (likely a scanned paper filing) - " + SENATE + href);
          for (const t of trs) {
            const c = [...t[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => strip(x[1]));
            // date, owner, ticker, asset, asset type, transaction type, amount, comment
            found.push({
              member: mem.name, chamber: "Senate", txDate: usDate(c[0]), type: c[5].replace("(Partial)", "(partial)"), ticker: c[2] && c[2] !== "--" ? c[2] : null,
              asset: c[3], assetType: c[4], owner: c[1], amount: c[6], description: c[7] && c[7] !== "--" ? c[7] : "", filed, url: SENATE + href,
            });
          }
          parsed.add("S" + href);
        } catch (e) { errors.push(`${mem.name} ${href}: ${e.message}`); }
      }
    } catch (e) { errors.push(`${mem.name} Senate search: ${e.message}`); }
  }
}

await runHouse();
await runSenate();

// merge with earlier runs (dedupe on the full row), newest trade first
const key = (t) => [t.member, t.txDate, t.type, t.ticker, t.asset, t.amount, t.owner, t.assetType, t.description, t.url].join("|");
const all = new Map(prior.map((t) => [key(t), t]));
for (const t of found) all.set(key(t), t);
const merged = [...all.values()].sort((a, b) => b.txDate.localeCompare(a.txDate) || a.member.localeCompare(b.member));

writeFileSync(`${OUT}/transactions.json`, JSON.stringify(merged));
writeFileSync(`${OUT}/meta.json`, JSON.stringify({
  generated: new Date().toISOString(), members: MEMBERS.map((m) => m.name), filings,
  latestFiled: Object.values(filings).map((f) => f.latest).sort().pop() || null,
  parsed: [...parsed], errors,
}));
console.log(`Politicians: +${found.length} new rows, ${merged.length} total, ${errors.length} errors`);
for (const e of errors) console.log("  !", e);
