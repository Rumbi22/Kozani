// server.js — Google Programmable Search + hardened article fetcher
import express from "express";
import axios from "axios";
import cors from "cors";
import "dotenv/config";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const app = express();

/* ---------------------------- CORS (dev-friendly) ---------------------------- */
const allowAll = !process.env.CORS_ORIGINS || process.env.CORS_ORIGINS === "*";
app.use(
  allowAll
    ? cors()
    : cors({ origin: process.env.CORS_ORIGINS.split(",").map(s => s.trim()) })
);
app.use(express.json());

/* --------------------------------- Config ----------------------------------- */
const PORT = process.env.PORT || 8787;
const GOOGLE_KEY = process.env.GOOGLE_KEY;
const GOOGLE_CX  = process.env.GOOGLE_CX;

const ALLOW_LIST = (process.env.ALLOW_LIST || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean); // e.g. who.int,health.gov.za,unicef.org,nice.org.uk,bmj.com

if (ALLOW_LIST.length === 0) {
  console.warn("WARN: ALLOW_LIST is empty — /api/search and /api/fetch will reject requests.");
}

/* ------------------------- Fetch safety / performance ------------------------ */
const MAX_BYTES = Number(process.env.FETCH_MAX_BYTES || 2_000_000); // 2 MB cap
let activeFetches = 0;
const MAX_CONCURRENT_FETCHES = Number(process.env.FETCH_CONCURRENCY || 2);

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-ZA,en;q=0.9",
  "Referer": "https://www.google.com/"
};

/* -------------------------------- Helpers ----------------------------------- */
function hostIsAllowed(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return ALLOW_LIST.some(d => h === d || h.endsWith(`.${d}`));
  } catch { return false; }
}
function buildSiteClause() {
  if (!ALLOW_LIST.length) return "";
  return ` (${ALLOW_LIST.map(d => `site:${d}`).join(" OR ")})`;
}
function mapFreshnessToDateRestrict(f) {
  const x = String(f || "").toLowerCase();
  if (x === "day") return "d1";
  if (x === "week") return "w1";
  if (x === "month") return "m1";
  return undefined;
}
function mapMktToGl(mkt) {
  return (mkt && mkt.includes("-")) ? mkt.split("-")[1] : undefined; // en-ZA -> ZA
}

// Fetch HTML with a browser-like signature and a soft retry on 403/406/451
async function fetchHTMLWithRetry(url) {
  const opts = {
    timeout: 15000,
    headers: { ...BROWSER_HEADERS, "Accept-Encoding": "gzip, deflate, br" },
    maxContentLength: MAX_BYTES,
    maxBodyLength: MAX_BYTES,
    maxRedirects: 5,
    validateStatus: () => true // don't throw on non-2xx; we handle it
  };

  let r = await axios.get(url, opts);
  if ([403, 406, 451].includes(r.status)) {
    // retry once with site referer (some WAFs prefer same-site referer)
    const siteRef = new URL(url).origin + "/";
    r = await axios.get(url, { ...opts, headers: { ...opts.headers, Referer: siteRef } });
  }
  return r;
}

// Fallback extractor for index-like pages where Readability returns little
function fallbackExtractText(document) {
  const candidates = [
    "article", "main", "[role='main']",
    "#content", ".content", ".article", ".main",
    "section"
  ];
  let best = "";
  let bestLen = 0;

  for (const sel of candidates) {
    document.querySelectorAll(sel).forEach(node => {
      const txt = (node.textContent || "").trim();
      const len = txt.replace(/\s+/g, " ").length;
      if (len > bestLen) { best = txt; bestLen = len; }
    });
    if (bestLen > 500) break; // good enough
  }
  if (!bestLen) {
    const txt = (document.body?.textContent || "").trim();
    best = txt.replace(/\s+/g, " ");
  }
  return best;
}

/* --------------------------------- Routes ----------------------------------- */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/api/search", async (req, res) => {
  try {
    if (!ALLOW_LIST.length) return res.status(503).json({ error: "ALLOW_LIST is empty on server" });
    if (!GOOGLE_KEY || !GOOGLE_CX) return res.status(500).json({ error: "Google API not configured" });

    const { q, count = 5, offset = 0, freshness, mkt } = req.query;
    if (!q || typeof q !== "string") return res.status(400).json({ error: "Missing ?q=" });

    const siteClause   = buildSiteClause();
    const dateRestrict = mapFreshnessToDateRestrict(freshness);
    const gl           = mapMktToGl(mkt);

    // Exclude heavy/non-HTML docs upstream to reduce 415/huge pages
    const exclude = "-filetype:pdf -filetype:doc -filetype:ppt -filetype:docx -filetype:pptx";

    const params = {
      key: GOOGLE_KEY,
      cx: GOOGLE_CX,
      q: `${q} ${exclude}${siteClause}`,
      num: Math.min(Number(count), 10),  // Google max 10
      start: Number(offset) + 1,         // 1-based
      safe: "active"
    };
    if (dateRestrict) params.dateRestrict = dateRestrict; // d1/w1/m1
    if (gl) params.gl = gl;                               // e.g., ZA

    const resp = await axios.get("https://www.googleapis.com/customsearch/v1", { params, timeout: 8000 });

    const raw = resp.data.items || [];
    const items = raw
      .filter(it => hostIsAllowed(it.link))
      .map(it => ({ name: it.title, url: it.link, snippet: it.snippet }));

    const totalResults = Number(resp.data.searchInformation?.totalResults || 0);

    res.json({ query: q, items, totalEstimatedMatches: totalResults });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

app.get("/api/fetch", async (req, res) => {
  if (activeFetches >= MAX_CONCURRENT_FETCHES) {
    return res.status(429).json({ error: "Fetcher is busy, please try again" });
  }
  activeFetches++;

  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Missing ?url=" });
    if (!hostIsAllowed(url)) return res.status(403).json({ error: "Domain not allowed" });

    const resp = await fetchHTMLWithRetry(url);

    // Upstream site explicitly blocked or errored
    if (resp.status >= 400) {
      if (resp.status === 403) return res.status(403).json({ error: "Forbidden by site (WAF/policy)", url });
      if (resp.status === 404) return res.status(404).json({ error: "Not found", url });
      if (resp.status === 429) return res.status(429).json({ error: "Rate limited", url });
      if (resp.status === 503) return res.status(503).json({ error: "Service unavailable upstream", url });
      return res.status(500).json({ error: `Upstream HTTP ${resp.status}`, url });
    }

    const ctype = String(resp.headers["content-type"] || "");
    const lowerUrl = String(url).toLowerCase();
    if (ctype.includes("application/pdf") || lowerUrl.endsWith(".pdf")) {
      return res.status(415).json({ error: "PDF not supported by extractor", url });
    }
    if (!ctype.includes("text/html") && !ctype.includes("application/xhtml+xml")) {
      return res.status(415).json({ error: `Unsupported content-type: ${ctype || "unknown"}`, url });
    }

    // Pre-trim heavy elements to save memory before DOM parse
    let html = String(resp.data)
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
      .replace(/<svg[\s\S]*?<\/svg>/gi, "")
      .replace(/<img[^>]*>/gi, "")
      .replace(/<video[\s\S]*?<\/video>/gi, "")
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, "");

    const dom = new JSDOM(html, { url }); // set base URL for relative links
    const reader = new Readability(dom.window.document);
    let article = reader.parse(); // { title, content, textContent, ... }

    // Use Readability text if present; otherwise fallback to biggest content block
    let fullText = (article?.textContent || "").trim();
    if (!fullText || fullText.length < 400) {
      fullText = fallbackExtractText(dom.window.document).trim();
    }

    if (!fullText || fullText.length < 200) {
      return res.status(422).json({ error: "Could not extract article", url });
    }

    const maxChars = Math.min(Number(req.query.maxChars) || 50000, 200000);
    const text = fullText.slice(0, maxChars);
    res.json({
      title: article?.title || dom.window.document.title || "Untitled",
      text,
      meta: {
        charCount: fullText.length,
        truncated: fullText.length > maxChars
      }
    });
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.toLowerCase().includes("maxcontentlength") || msg.toLowerCase().includes("maxbodylength")) {
      return res.status(413).json({ error: "Page too large to fetch safely", url: req.query.url });
    }
    res.status(err.response?.status || 500).json({ error: err.response?.data || msg });
  } finally {
    activeFetches--;
  }
});

app.listen(PORT, () => {
  console.log(`Server on http://127.0.0.1:${PORT}`);
});
