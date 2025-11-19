// app.js — perinatal companion (frontend) with trusted web search + extractive summaries
import * as webllm from "https://esm.run/@mlc-ai/web-llm@0.2.79?bundle";

/* --------------------------- MODEL (load once, reuse) --------------------------- */
let engine = null;
let loadingModel = false;
let engineReadyPromise = null;

// Status UI (safe no-op if #status missing)
const statusEl = document.querySelector("#status");
function setStatus(text) { if (statusEl) statusEl.textContent = text || ""; }

const DEBUG = true; // set to false in production



async function ensureModel() {
  if (engine) return engine;
  if (engineReadyPromise) return engineReadyPromise;

  engineReadyPromise = (async () => {
    const firstRunKey = "mlc_model_warmed";
    if (!localStorage.getItem(firstRunKey)) {
      setStatus("Preparing the language model… first run may take a bit.");
    }
    const modelId = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
    const e = await webllm.CreateMLCEngine(modelId, { initProgressCallback: () => {} });
    localStorage.setItem(firstRunKey, "1");
    setStatus("Model ready ✅");
    engine = e;
    return e;
  })().catch(err => {
    engineReadyPromise = null;
    setStatus("");
    addMsg("❌ Model failed to load: " + (err?.message || err), "bot");
    throw err;
  });

  return engineReadyPromise;
}

if ("requestIdleCallback" in window) requestIdleCallback(() => ensureModel());
else setTimeout(() => ensureModel(), 1200);

/* ---------------------------------- DOM refs ---------------------------------- */
const $ = (sel) => document.querySelector(sel);
const chat = $("#chat");
const form = $("#composer");
const input = $("#msg");
const chipsEl = $("#chips");

/* ------------------------------ Backend settings ------------------------------ */
const API_BASE = "http://127.0.0.1:8787";
const SEARCH_COUNT_DEFAULT = 3; // keep only 'count' per your rule

/* ------------------------------ Search state/UI ------------------------------- */
let lastSearch = { query: "", items: [] };
let picksSection = null;
let fetchingNow = false;

/* ------------------------------ Topics + memory ------------------------------- */
let topicsIndex = [];
const chatHistory = []; // {role:'user'|'assistant', content:string}

function pushHistory(role, content) {
  chatHistory.push({ role, content });
  while (chatHistory.length > 6) chatHistory.shift();
}

function addMsg(text, who = "bot") {
  if (!chat) return; // safety
  const div = document.createElement("div");
  div.className = `msg ${who}`;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  const role = who === "user" ? "user" : "assistant";
  pushHistory(role, text);
}

// greet (kept minimal)
addMsg("Hi 👋 I’m your perinatal companion—here to listen and keep you company. How can I help today?", "bot");

/* --------------------------- Session + light helpers --------------------------- */
let searchOptIn = false;                 // remember one-time web search consent
let awaitingSearchConsent = null;        // { text } while we wait for yes/no
let lastGreetTurn = -999;

function isGreeting(text) {
  const t = (text || "").trim().toLowerCase();
  return /^(hi|hey|hello|hie|heyy|hiya|howzit|yo|sup|morning|afternoon|evening)[!.,\s]?$/i.test(t) || /[👋🙂😊😉]/.test(t);
}
function isSocialCheckIn(text) {
  return /\b(how\s*(are|r)\s*(you|u)\??|how[’']?s it going|how is it going|how are things|you ok(ay)?|you alright)\b/i
    .test((text || "").trim());
}
const isInfoIntent = (intent) => intent === "info" || (intent && intent.startsWith("info:"));

/* ------------------------------ Load topic chips ------------------------------ */
async function loadChips() {
  try {
    const res = await fetch("content/topics.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    topicsIndex = await res.json();
    if (!chipsEl) return;
    chipsEl.innerHTML = "";
    topicsIndex.forEach((topic) => {
      const btn = document.createElement("button");
      btn.className = "chip";
      btn.textContent = topic.title;
      btn.addEventListener("click", async () => {
        addMsg(topic.title, "user");
        // pass chip title as fallback query
        await answerFromTopic(topic.path, topic.title);
      });
      chipsEl.appendChild(btn);
    });
  } catch (e) {
    if (!chipsEl) return;
    const msg = document.createElement("div");
    msg.textContent = `Could not load topics: ${e.message}`;
    msg.style.color = "var(--alert)";
    chipsEl.appendChild(msg);
  }
}
loadChips();

/* --------------------------- LLM wrapper + topic flow ------------------------- */
async function llmReply(messages, opts = {}) {
  await ensureModel();
  const resp = await engine.chat.completions.create({
    messages,
    stream: false,
    temperature: opts.temperature ?? 0.8,
    top_p: opts.top_p ?? 0.9
  });
  return resp?.choices?.[0]?.message?.content ?? "(no text)";
}


// --- helper: strip inline citation markers like contentReference[oaicite:..]{index=..}
function stripInlineRefs(s = "") {
  return String(s).replace(/contentReference\[[^\]]*\]\{[^}]*\}/g, "").replace(/\s+/g, " ").trim();
}

// --- Normalize old/new schemas into one predictable object
function normalizeTopicPack(raw = {}) {
  // handle both old and new keys
  const definition   = stripInlineRefs(raw.definition || "");
  const general_info = stripInlineRefs(raw.general_info || raw.summary || "");
  const reassurance  = stripInlineRefs(raw.reassurance || raw.reassure || "");
  const steps        = Array.isArray(raw.steps) ? raw.steps.map(stripInlineRefs) : [];

  // optional legacy fields we still support if present
  const red_flags     = Array.isArray(raw.red_flags) ? raw.red_flags.map(stripInlineRefs) : [];
  const seek_care_now = Array.isArray(raw.seek_care_now) ? raw.seek_care_now.map(stripInlineRefs) : [];

  return { definition, general_info, reassurance, steps, red_flags, seek_care_now };
}





// --- Build a compact context string for the LLM (uses new fields if present)
function buildContextFromPack(raw, maxSteps = 4) {
  const data = normalizeTopicPack(raw);
  const parts = [];

  if (data.definition) parts.push(`Definition: ${data.definition}`);
  if (data.general_info) parts.push(`General: ${data.general_info}`);
  if (data.reassurance) parts.push(`Reassure: ${data.reassurance}`);
  if (data.steps?.length) parts.push(`Steps: ${data.steps.slice(0, maxSteps).join(" | ")}`);
  if (data.red_flags?.length) parts.push(`Red flags: ${data.red_flags.slice(0, 3).join(" | ")}`);
  if (data.seek_care_now?.length) parts.push(`Seek care now if: ${data.seek_care_now.slice(0, 3).join(" | ")}`);

  return parts.join("\n");
}

// --- Load JSON → build context → ask LLM to paraphrase (new prompt supports definition/steps)
async function paraphraseTopicFromJSON(url, userText = "") {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const raw = await res.json();

  const ctx = buildContextFromPack(raw);

  // Simple heuristic: if user asked “what is …”, start with the Definition
  const isDefine = /^what\s+is\s+/i.test((userText || ""));

  const systemPrompt = [
    "You are a gentle perinatal companion. ONLY use facts inside <context>.",
    "Write in simple, warm language.",
    isDefine ? "Output 1–2 sentences that define the topic, then one short practical tip." 
             : "Keep to 2–3 short sentences (one reassurance + one practical tip).",
    "If info is missing, say you don’t know. Do not add new medical facts.",
  ].join("\n");

  const userMsg = `Here is <context>:\n${ctx}\n\nParaphrase for a parent in plain words.`;

  return await llmReply(
    [{ role: "system", content: systemPrompt }, { role: "user", content: userMsg }],
    { temperature: 0.6, top_p: 0.9 }
  );
}
/* --------------------------- Topic hint resolver --------------------------- */
const TOPIC_HINT_MAP = {
  // core
  "breastfeeding": "content/breastfeeding.json",
  "mental health": "content/mental_health.json",
  "antenatal care basics": "content/antenatal_care_basics.json",
  "warning signs": "content/warning_signs.json",
  "newborn basics": "content/newborn_basics.json",
  "pregnancy nutrition": "content/pregnancy_nutrition.json",
  "medicines in pregnancy": "content/medicines_in_pregnancy.json",
  "contraception postpartum": "content/contraception_postpartum.json",
  "labour and birth": "content/labour_and_birth.json",
  "postpartum care basics": "content/postpartum_care_basics.json",
  "antenatal visit schedule": "content/antenatal_visit_schedule.json",
  "infant immunization": "content/infant_immunization.json",
  "birth control": "content/contraception_postpartum.json",
  "birthcontrol": "content/contraception_postpartum.json",
  // synonyms
  "latching": "content/breastfeeding.json",
  "milk supply": "content/breastfeeding.json",
  "mastitis": "content/breastfeeding.json",
  "baby blues": "content/mental_health.json",
  "depression": "content/mental_health.json",
  "anxiety": "content/mental_health.json",
  "danger signs": "content/warning_signs.json",
  "vaccines": "content/infant_immunization.json",
  "immunisation": "content/infant_immunization.json",
  "scans": "content/antenatal_visit_schedule.json",
  "ultrasound schedule": "content/antenatal_visit_schedule.json",
  "kick counts": "content/antenatal_care_basics.json",
  "reduced movements": "content/warning_signs.json",
};

function resolveTopicFromHint(hint) {
  if (!hint) return null;
  const h = hint.toLowerCase().trim();
  if (TOPIC_HINT_MAP[h]) return TOPIC_HINT_MAP[h];
  const key = Object.keys(TOPIC_HINT_MAP).find(k => h.includes(k));
  if (key) return TOPIC_HINT_MAP[key];
  if (Array.isArray(topicsIndex) && topicsIndex.length) {
    let t = topicsIndex.find(t => t.title.toLowerCase().includes(h));
    if (!t) {
      t = topicsIndex.find(t => {
        const bag = [t.title, ...(t.keywords||[]), ...(t.aliases||[]), ...(t.tags||[])].join(" ").toLowerCase();
        return bag.includes(h);
      });
    }
    if (t) return t.path;
  }
  return null;
}

/* --------------------------- LLM Intent Router (JSON) --------------------------- */
async function routeWithLLM(userText) {
  const eng = await ensureModel().catch(err => {
    console.error("[routeWithLLM] ensureModel failed", err);
    return null;
  });
  if (!eng || !eng.chat?.completions) {
    console.warn("[routeWithLLM] engine not ready, using fallback router");
    return { action: "basic_chat", topic_hint: null, needs_sources: false, confidence: 0.5, reason: "fallback" };
  }
  const recent = chatHistory.slice(-6)
    .map(m => `[${m.role}] ${m.content}`)
    .join('\n')
    .slice(0, 1200);

  const system = [
    "You are an intent router for a perinatal companion.",
    "Treat questions about symptoms, signs, causes, diagnosis, or treatment as 'info_local' (with a topic_hint) unless the user explicitly asks for sources.",
    "Decide the BEST next action for the assistant.",
    "Allowed actions:",
    "- 'basic_chat' (supportive conversation, reflections, check-ins)",
    "- 'info_local' (answer from local JSON topic packs)",
    "- 'info_search' (trusted web search needed for precise facts/guidelines)",
    "- 'care_nav' (ask about care options / steps to seek care)",
    "- 'emergency' (red-flag symptoms or self-harm language)",
    "- 'clarify' (ask a short question to clarify the request)",
    "- 'gratitude' | 'greeting' | 'goodbye'",
    "",
    "Rules:",
    "• Prefer 'info_local' over 'info_search' unless the user asks for sources/guidelines, doses, schedules or stats.",
    "• Use 'basic_chat' when user needs empathy or is venting (no factual request).",
    "• Use 'emergency' if there are urgent physical red flags or self-harm terms.",
    "• If you think a local topic fits, suggest a short 'topic_hint' using the titles/areas already used by the app (e.g., 'breastfeeding', 'mental health', 'antenatal care basics', 'warning signs', 'labour and birth', 'postpartum care basics', 'newborn basics', 'pregnancy nutrition', 'medicines in pregnancy', 'contraception postpartum', 'antenatal visit schedule', 'infant immunization').",
    "Output STRICT JSON only. No prose.",
    `Schema: {"action": string, "topic_hint": string|null, "needs_sources": boolean, "confidence": number, "reason": string}`,
  ].join("\n");

  const user = [
    `USER_TEXT: ${userText}`,
    "RECENT:",
    recent || "(none)"
  ].join("\n");

  const resp = await engine.chat.completions.create({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0,
    top_p: 1,
    max_tokens: 180,
    stream: false
  });

  const raw = resp?.choices?.[0]?.message?.content || "{}";
  const match = raw.match(/\{[\s\S]*\}$/);
  const text = match ? match[0] : raw;
  let out;
  try { out = JSON.parse(text); } catch { out = {}; }
  return {
    action: out.action || "basic_chat",
    topic_hint: out.topic_hint ?? null,
    needs_sources: !!out.needs_sources,
    confidence: Number.isFinite(out.confidence) ? out.confidence : 60,
    reason: typeof out.reason === "string" ? out.reason.slice(0, 200) : ""
  };
}

/* --------------------------- Style & tone helpers --------------------------- */
function classifyEnergy(text) {
  const len = (text || "").trim().split(/\s+/).filter(Boolean).length;
  if (len <= 2) return "very_short";
  if (len <= 8) return "short";
  if (len <= 25) return "medium";
  return "long";
}

// Core-human-tone classifier (regex-only)
function classifyTone(text) {
  const t = (text || "").toLowerCase().trim();
  if (/^(hi|hey|hello|heyy|hiya|hie|howzit|yo|sup)\b/.test(t) || /\b(good (morning|afternoon|evening))\b/.test(t) || /[👋🙂😊😉✌️👌🤝]/.test(t)) return "greeting";
  if (/\b(happy|excited|good|great|awesome|yay|relieved|hopeful|proud)\b/.test(t) || /\b(lol|haha|hehe|lmao)\b/.test(t) || /[😄😁🤗✨🥳💖❤️‍🔥]/.test(t)) return "happy";
  if (/\b(thanks|thank you|appreciate|grateful|cheers)\b/.test(t) || /[🙏🌸]/.test(t)) return "thankful";
  if (/[?]$/.test(t) || /\b(can you|could you|how do|what is|why|explain|wonder)\b/.test(t)) return "curious";
  if (/\b(confused|unsure|don'?t know|not sure|unclear|huh)\b/.test(t) || /[🤔😕]/.test(t)) return "confused";
  if (/\b(sad|down|low|cry|teary|depressed|blue|heartbroken)\b/.test(t) || /[😔😢😞😭💙]/.test(t)) return "sad";
  if (/\b(anxious|anxiety|worried|scared|afraid|nervous|panic|panicky)\b/.test(t) || /[😟😰😨😥]/.test(t)) return "anxious";
  if (/\b(stressed|overwhelmed|burnt out|burned out|exhausted|tired|drained|frazzled)\b/.test(t) || /[😩😮‍💨😫]/.test(t)) return "stressed";
  if (/\b(angry|mad|furious|annoyed|irritated|frustrated|fed up)\b/.test(t) || /[😡🤬👿]/.test(t)) return "angry";
  return "neutral";
}

function weightedPick(items) {
  const total = items.reduce((s, it) => s + it.weight, 0);
  let r = Math.random() * total;
  for (const it of items) { if ((r -= it.weight) <= 0) return it.value; }
  return items[items.length - 1].value;
}

function sanitize(s="") {
  s = s.replace(/,?\s*(aren['’]t|isn['’]t|right)\s+you\??/gi, ""); // drop tag Qs
  s = s.replace(/\byou('?re| are)\s+feeling\b/gi, "it sounds like you’re feeling"); // de-parrot
  return s.trim();
}

function keepSentences(text, max = 3) {
  const parts = String(text||"").split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, max).join(" ");
}




function pickStyle(tone = "neutral") {
  // Global nudge away from therapy clichés + assumptions


const STYLES = {
  "warm-minimal": {
    name: "warm-minimal",
    cues: [
      "plain, human, warm; 2 short sentences + 1 brief question max",
      "no clichés ",
      "no assumptions or added causes; speak ONLY to what the user said",
      "no tag questions; no meta-commentary; no repeating exact user words"
    ].join(" | ")
  },
  "casual-chatty": {
    name: "casual-chatty",
    cues: [
      "friendly and light; simple contractions ok",
      "mirror the user’s energy but keep it short (<=3 sentences total)",
      "no slang unless the user used it; no emojis unless the user used them",
      "no assumptions/causes; ask one small, specific follow-up"
    ].join(" | ")
  },
  "coach-brief": {
    name: "coach-brief",
    cues: [
      "supportive + practical; one small step the user can try now",
      "ONE actionable suggestion only; then 1-choice question (this or talk more?)",
      "no medical advice; no diagnoses; no assumptions/causes",
      "avoid clichés and tag questions; keep to everyday words"
    ].join(" | ")
  },
  "reflective-soft": {
    name: "reflective-soft",
    cues: [
      "gently paraphrase the feeling WITHOUT repeating exact phrasing",
      "do NOT infer reasons, people, events, or timelines not mentioned, speak ONLY to what the user said",
      "skip therapy clichés; keep it concrete and brief",
      "end with one open, non-leading question"
    ].join(" | ")
  }
};

  const TABLE = {
    greeting: [
      { value: STYLES["casual-chatty"], weight: 5 },
      { value: STYLES["warm-minimal"],  weight: 3 },
      { value: STYLES["coach-brief"],   weight: 1 },
      { value: STYLES["reflective-soft"], weight: 1 }
    ],
    happy: [
      { value: STYLES["casual-chatty"], weight: 5 },
      { value: STYLES["warm-minimal"],  weight: 3 },
      { value: STYLES["coach-brief"],   weight: 1 },
      { value: STYLES["reflective-soft"], weight: 1 }
    ],
    thankful: [
      { value: STYLES["warm-minimal"],  weight: 5 },
      { value: STYLES["reflective-soft"], weight: 3 },
      { value: STYLES["casual-chatty"], weight: 1 },
      { value: STYLES["coach-brief"],   weight: 1 }
    ],
    curious: [
      { value: STYLES["coach-brief"],   weight: 5 },
      { value: STYLES["warm-minimal"],  weight: 3 },
      { value: STYLES["casual-chatty"], weight: 2 },
      { value: STYLES["reflective-soft"], weight: 1 }
    ],
    confused: [
      { value: STYLES["coach-brief"],   weight: 4 },
      { value: STYLES["reflective-soft"], weight: 3 },
      { value: STYLES["warm-minimal"],  weight: 2 },
      { value: STYLES["casual-chatty"], weight: 1 }
    ],
    sad: [
      { value: STYLES["reflective-soft"], weight: 6 },
      { value: STYLES["warm-minimal"],  weight: 3 },
      { value: STYLES["coach-brief"],   weight: 1 },
      { value: STYLES["casual-chatty"], weight: 1 }
    ],
    anxious: [
      { value: STYLES["reflective-soft"], weight:3},
      { value: STYLES["warm-minimal"],  weight: 6},
      { value: STYLES["coach-brief"],   weight: 2 },
      { value: STYLES["casual-chatty"], weight: 1 }
    ],
    stressed: [
      { value: STYLES["coach-brief"],   weight: 5 },
      { value: STYLES["warm-minimal"],  weight: 4 },
      { value: STYLES["reflective-soft"], weight: 2 },
      { value: STYLES["casual-chatty"], weight: 1 }
    ],
    angry: [
      { value: STYLES["coach-brief"],   weight: 5 },
      { value: STYLES["warm-minimal"],  weight: 3 },
      { value: STYLES["reflective-soft"], weight: 2 },
      { value: STYLES["casual-chatty"], weight: 1 }
    ],
    neutral: [
      { value: STYLES["warm-minimal"],  weight: 3 },
      { value: STYLES["casual-chatty"], weight: 3 },
      { value: STYLES["coach-brief"],   weight: 2 },
      { value: STYLES["reflective-soft"], weight: 2 }
    ]
  };
  const bucket = TABLE[tone] || TABLE.neutral;
  return weightedPick(bucket);
}

function sentenceLimitByEnergy(energy) {
  if (energy === "very_short") return 2;
  if (energy === "short") return 3;
  if (energy === "medium") return 5;
  return 4;
}

function recentBannedPhrases() {
  const recent = chatHistory.slice(-4).map(m => m.content.toLowerCase());
  const stock = [
    "it’s okay to feel overwhelmed","it's okay to feel overwhelmed",
    "what’s on your mind","what's on your mind",
    "i’m here for you","i'm here for you",
    "that sounds really hard"
  ];
  return stock.filter(p => recent.some(r => r.includes(p)));
}
function tidyEnd(s) {
  if (!s) return s;
  const m = s.match(/([\s\S]*?[\.?\!])(?:\s|$)/);
  return m ? m[1] : s;
}

/* ----------------------------- Topic lookup utils ----------------------------- */
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokenize(s) { return normalize(s).split(" ").filter(Boolean); }
function tokenOverlap(a, b) {
  const A = new Set(a), B = new Set(b);
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n;
}

// JSON-first topic resolver using title/keywords/aliases/tags + fuzzy overlap
function findTopicForMessage(text) {
  const q = normalize(text);

  // 1) direct title match
  let t = topicsIndex.find(t => q.includes(normalize(t.title)));
  if (t) return t;

  // 2) keyword/alias/tag match
  for (const topic of topicsIndex) {
    const kws = [...(topic.keywords||[]), ...(topic.aliases||[]), ...(topic.tags||[])].map(normalize);
    if (kws.some(k => q.includes(k))) return topic;
  }

  // 3) fuzzy token overlap
  const qTokens = tokenize(q);
  let best = null, bestScore = 0;
  for (const topic of topicsIndex) {

    const bag = [t.title, ...(t.keywords || []), ...(t.aliases || []), ...(t.tags || [])]
.join(" ").toLowerCase();
const score = tokenOverlap(new Set(qTokens), new Set(tokenize(bag)));
    if (score > bestScore) { best = topic; bestScore = score; }
  }
  return bestScore >= 2 ? best : undefined;
}

/* ------------------------------ Info flow helper ------------------------------ */
async function handleInfoLike(userText, scopedIntent) {
  // 1) try local topic first
  const topic = findTopicForMessage(userText);
  if (topic) { await answerFromTopic(topic.path, userText); return; }

  // 2) intent → topic mapping (serve JSON even without web-consent)
  const intentToTopic = {
    "info:breastfeeding": "content/breastfeeding.json",
    "info:newborn": "content/newborn_basics.json",
    "info:psych": "content/mental_health.json",
    "info:obstetric": "content/antenatal_care_basics.json", // unified
    "info:meds": "content/medicines_in_pregnancy.json",
    "info:contraception": "content/contraception_postpartum.json",
    "info:labour": "content/labour_and_birth.json",
    "info:postpartum": "content/postpartum_care_basics.json",
    "info:nutrition": "content/pregnancy_nutrition.json",
    "info:warning_signs": "content/warning_signs.json",
    "info:clinic_visits": "content/antenatal_visit_schedule.json",
    "info:immunization": "content/infant_immunization.json"
  };
  if (intentToTopic[scopedIntent]) { await answerFromTopic(intentToTopic[scopedIntent], userText); return; }

  // 3) fall back to web search
  await startWebSearch(userText);
}

/* --------------------------- Result re-ranking (expanded) --------------------------- */
function scoreResult(it) {
  const title = (it.name || "").toLowerCase();
  const url   = (it.url  || "").toLowerCase();
  let s = 0;

  const q = (typeof lastSearch?.query === "string" ? lastSearch.query : "").toLowerCase();

  try {
    const u = new URL(url);
    const host = u.hostname;

    const hostBoosts = [
      /(^|\.)who\.int$/,
      /(^|\.)www\.who\.int$/,
      /(^|\.)health\.gov\.za$/,
      /(^|\.)nice\.org\.uk$/,
      /(^|\.)bmj\.com$/,
      /(^|\.)unicef\.org$/
    ];
    if (hostBoosts.some(rx => rx.test(host))) s += 3;

    const hostPenalties = [
      /(^|\.)help\.unicef\.org$/,
      /(^|\.)apps\.who\.int$/,
      /(^|\.)platform\.who\.int$/,
      /(^|\.)iarc\.who\.int$/
    ];
    if (hostPenalties.some(rx => rx.test(host))) s -= 3;

    const depth = u.pathname.split("/").filter(Boolean).length;
    if (depth <= 1) s -= 1;

    const path = u.pathname.toLowerCase();
    if (/\/health-topics\//.test(path)) s += 4;
    if (/\/publications?(-|\/|$)/.test(path)) s += 2;
    if (/\/guidance|\/guidelines?/.test(path)) s += 3;
    if (/\/clinical|\/patients?\/|\/conditions?\/|\/topics?\/|\/fact-?sheet/.test(path)) s += 2;
    if (/\/press|\/news|\/stories|\/appeal|\/donate|\/fund|\/campaign/.test(path)) s -= 4;
  } catch {}

  const hasAny = (rx) => rx.test(q) || rx.test(title) || rx.test(url);

  const rx = {
    breastfeeding:   /\b(breast\s*feed(ing)?|breastfeed(ing)?|lactation|latch(?:ing)?|milk\s*supply|colostrum|mastitis|engorgement|wean(?:ing)?|exclusive)\b/i,
    newborn:         /\b(newborn|baby (sleep|feeding)|colic|burp(ing)?|nappy|diaper|jaundice|umbilical|cord care|skin(?:\s*-\s*| )to(?:\s*-\s*| )skin)\b/i,
    psych:           /\b(post(?:partum|natal)|perinatal)\b.*\b(depression|anxiety|pnd)\b|\b(baby\s*blues)\b/i,
    obstetric:       /\b(trimester|ultrasound|scan|screening|kick count|reduced movements|spotting|cramp|contractions?|waters? (broke|breaking)|swelling|pre[-\s]?eclampsia|gestational|gdm)\b/i,
    meds:            /\b(paracetamol|acetaminophen|ibuprofen|antibiotic|iron|folate|folic acid|prenatal|dose|dosage|mg|medication|medicine|safe to take)\b/i,
    contraception:   /\b(birth\s*-?\s*control|contracept|family planning|contraceptive|postpartum\s+contracept)\b/i,
    labour:          /\b(labou?r|contractions?|tim(ing|e) contractions?|waters? (broke|breaking)|mucus plug|bloody show|birth plan|delivery|active labour|latent labour)\b/i,
    postpartum:      /\b(post(?:partum|natal)|after birth|lochia|perineal|stitches|c-?section recovery|bleeding after birth|postpartum check|afterpains)\b/i,
    nutrition:       /\b(nutrition|diet|foods?|what (to|can i) eat|eat(ing)? well|supplements?|folate|folic acid|iron|calcium|iodine|vitamin\s*(d|b12)|caffeine|alcohol)\b/i,
    warningSigns:    /\b(warning signs?|red flags?|danger signs?|severe headache|blurred vision|fits|fever|reduced (baby )?movements?|heavy bleeding|severe pain|swelling of (face|hands))\b/i,
    clinicVisits:    /\b(antenatal|anc|prenatal|booking|first booking|visit schedule|how often|how many visits|when should i go|clinic card|maternity record)\b/i,
    immunization:    /\b(vaccin(e|ation)|immuni[sz]e|immuni[sz]ation|shots?|bcg|opv|ipv|hep(?:atitis)? ?b|dtap|mmr|6 ?weeks|10 ?weeks|14 ?weeks|measles)\b/i
  };

  for (const r of Object.values(rx)) {
    if (hasAny(r)) {
      if (/who\.int.*\/health-topics\//.test(url)) s += 4;
      s += 3;
    }
  }

  if (/\b(guideline|recommendation|fact sheet|overview|faq|qa)\b/.test(title)) s += 2;
  if (/\b(press release|appeal|donate|urgent|breaking)\b/.test(title)) s -= 3;

  return s;
}

function renderPicks(items) {
  if (picksSection) picksSection.remove();
  picksSection = document.createElement("section");
  picksSection.className = "chips";
  items.forEach((it, i) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = `${i + 1}. ${it.name}`;
    b.onclick = () => fetchAndSummarize(lastSearch.query, it.url, i);
    picksSection.appendChild(b);
  });
  const app = document.querySelector(".app");
  const composer = document.getElementById("composer");
  if (app && composer) app.insertBefore(picksSection, composer);
}


// Turn user text into a crisp search query using the local LLM
async function generateSearchQuery(userText, {trusted=true} = {}) {
  await ensureModel();

  const system = [
    "You rewrite user questions into a short, search-ready query.",
    "Rules:",
    "- Keep it under 12 words.",
    "- Use plain keywords; no filler like 'please' or 'can you'.",
    "- Expand obvious synonyms (e.g., birth control → contraception, family planning).",
    "- Prefer medical terms when clear (e.g., 'postpartum', 'antenatal').",
    "- NO punctuation except quotes for exact phrases; no question marks.",
    "- NO personal data, no emojis.",
    trusted
      ? "- If topic is perinatal/health, bias toward authoritative phrasing (e.g., 'WHO contraception fact sheet')."
      : ""
  ].filter(Boolean).join("\n");

  // Few-shot helps it learn the style
  const fewshot = [
    {role:"user", content:"Yes what is birthcontrol"},
    {role:"assistant", content:'contraception "birth control" family planning'},
    {role:"user", content:"what vaccines at 6 weeks"},
    {role:"assistant", content:'infant immunization "6 weeks" schedule'},
    {role:"user", content:"breast feeding tips"},
    {role:"assistant", content:'breastfeeding latching milk supply tips'}
  ];

  const resp = await engine.chat.completions.create({
    messages: [
      { role:"system", content: system },
      ...fewshot,
      { role:"user", content: userText }
    ],
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 24,
    stream: false
  });

  let q = resp?.choices?.[0]?.message?.content?.trim() || "";

  // Post-fix: sanitize and constrain
  q = q.replace(/[“”]/g,'"')
       .replace(/[^\w\s"%-:.]/g,"")  // keep simple chars
       .replace(/\s+/g," ")
       .trim();

  // Fallback if LLM returns something empty
  if (!q) q = userText.replace(/\b(please|yes|okay|ok|sure|can you|what is|explain|tell me about)\b/gi,"")
                      .replace(/\s+/g," ").trim();

  // Optional: add trusted domain scoping but keep LLM-crafted core
  const sites = trusted ? ' site:who.int OR site:health.gov.za OR site:unicef.org OR site:nice.org.uk' : '';
  return (q + sites).trim();
}



/* ------------------------------ Search pipeline ------------------------------- */
function rewriteForTrustedSearch(q) {
  return String(q || "").trim();
}

async function startWebSearch(userText) {
  try {
    const q = await generateSearchQuery(userText, { trusted: true });
    const url = `${API_BASE}/api/search?q=${encodeURIComponent(q)}&count=${SEARCH_COUNT_DEFAULT}`;

    // NEW: show the exact query in chat (so you can see what’s being searched)
    addMsg(`🔎 Searching trusted sources for: “${q}”`, "bot");        // NEW
    console.log("[search:start]", { q, url });


    // NEW: dev log
    if (DEBUG) console.log("[search:start]", { q, url });   
    const r = await fetch(url);
    if (!r.ok) throw new Error(`search failed: ${r.status}`);
    const data = await r.json();
    let items = data.items || [];


    
    if (DEBUG) console.log("[search:raw-items]", items);              // NEW


    if (!items.length) {
      addMsg("I didn’t find a solid source right now. What part should we focus on?", "bot");
      return;
    }

    items.sort((a, b) => scoreResult(b) - scoreResult(a));
    lastSearch = { query: userText, items };

    // NEW: small header that shows the query above the buttons
    addMsg(`Results for “${q}” (top ${Math.min(items.length, SEARCH_COUNT_DEFAULT)}):`, "bot"); // NEW



    renderPicks(items);

    const listText = items.map((it, i) => `${i + 1}. ${it.name}\n${it.url}`).join("\n\n");
    addMsg(`I found a few reliable pages — pick one and I’ll give you a short, clear summary:\n\n${listText}`, "bot");
  } catch (e) {
    addMsg("Hmm, I couldn’t reach the sources just now. Want to try again later, or keep chatting?", "bot");
    console.error(e);
  }
}

/* -------------------------- Fetch + extractive summary ------------------------ */
async function fetchAndSummarize(userText, url, index) {
  if (fetchingNow) return;
  fetchingNow = true;
  const btns = picksSection ? Array.from(picksSection.querySelectorAll("button")) : [];
  const btn = btns[index];
  if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }

  addMsg("Opening that source…", "bot");
  try {
    console.log("[fetch] url=", url);
    const r = await fetch(`${API_BASE}/api/fetch?url=${encodeURIComponent(url)}`);
    console.log("[fetch] status=", r.status);

    if (!r.ok) {
      let detail = "";
      try { const j = await r.json(); detail = j?.error ? ` – ${j.error}` : ""; } catch {}
      if (r.status === 415) addMsg("That link is a PDF and my extractor can’t read it yet.", "bot");
      else if (r.status === 413) addMsg("That page is very large and I couldn’t load it safely.", "bot");
      else if (r.status === 429) addMsg("I’m busy fetching another page. Trying the next one…", "bot");
      else addMsg(`I couldn’t fetch that page (HTTP ${r.status}${detail}). Trying the next one…`, "bot");

      const next = lastSearch.items[index + 1];
      if (next) return fetchAndSummarize(userText, next.url, index + 1);

      addMsg("No other sources left. Want me to search again?", "bot");
      if (btn) { btn.disabled = false; btn.textContent = `${index + 1}. (failed)`; }
      return;
    }

    const page = await r.json();
    if (!page?.text) {
      addMsg("That page didn’t load cleanly. Let’s try another.", "bot");
      const next = lastSearch.items[index + 1];
      if (next) return fetchAndSummarize(userText, next.url, index + 1);
      return;
    }


    if (DEBUG) console.log("[fetch:open]", { query: lastSearch.query, url }); // NEW
    addMsg(`Opening “${lastSearch.query}” → ${url}`, "bot");                  // NEW

    if (picksSection) { picksSection.remove(); picksSection = null; }

    const excerpt = page.text.slice(0, 4000);

    const systemPrompt = [
      "You are a careful assistant. Use ONLY the EXCERPT text verbatim.",
      "TASK: Select 3–5 short sentences that directly answer the user’s question.",
      "RULES: Do NOT paraphrase. Do NOT add new facts. Copy sentences exactly as they appear.",
      "FORMAT: Bullet list, each bullet is a single sentence from the excerpt."
    ].join("\n");
    const userMsg = `User question: ${userText}\nEXCERPT START\n${excerpt}\nEXCERPT END`;

    const draft = await llmReply(
      [{ role: "system", content: systemPrompt }, { role: "user", content: userMsg }],
      { temperature: 0.1, top_p: 0.9 }
    );

    const rawBullets = draft
      .split(/\n+/)
      .map(s => s.replace(/^[-*•]\s*/, "").trim())
      .filter(Boolean)
      .filter(s => excerpt.includes(s));

    const seen = new Set();
    const uniqueBullets = [];
    for (const b of rawBullets) {
      const key = b.toLowerCase().replace(/\s+/g, " ").trim();
      if (!seen.has(key)) { seen.add(key); uniqueBullets.push(b); }
    }

    const bullets = uniqueBullets.slice(0, 5).map(s => `• ${s}`).join("\n");
    if (!bullets) {
      addMsg("That page didn’t have clear sentences to quote. Want me to try another link?", "bot");
      return;
    }
    addMsg(`${bullets}\n\nSource: ${url}`, "bot");
  } catch (e) {
    addMsg("I couldn’t fetch that page cleanly. Want me to try the next link?", "bot");
    console.error(e);
  } finally {
    setTimeout(() => { fetchingNow = false; }, 300);
    if (btn) { btn.disabled = false; btn.textContent = btn.textContent.replace("Loading…", ""); }
  }
}

/* --------------------------- Guarded websearch trigger --------------------------- */
function shouldWebSearch(text = "") {
  const t = text.toLowerCase();
  const wantsSources = /\b(who|unicef|nice|bmj|department of health|guideline|source|citation|reference|evidence)\b/i.test(t);
  const facty = /\b(dose|dosage|mg|mcg|contraindicat|drug|medicine|statistic|prevalence|risk\s*percent|scan schedule|immuni[sz]ation|vaccine schedule|bcg|opv|ipv|hepb|mmr)\b/i.test(t);
  const precise = /(\b\d+\s*(mg|mcg|ml|weeks?|months?|%|percent)\b)/i.test(t);
  return wantsSources || facty || precise;
}

function suggestNearestLocalTopics(userText = "") {
  if (!Array.isArray(topicsIndex) || topicsIndex.length === 0) return;
  const qTokens = tokenize(userText);
  const scored = topicsIndex.map(t => {
    const bag = [t.title, ...(t.keywords||[]), ...(t.aliases||[]), ...(t.tags||[])].join(" ");
    return { t, s: tokenOverlap(new Set(qTokens), new Set(tokenize(bag))) };
  }).sort((a,b)=>b.s-a.s);

  const top = scored.slice(0, 3).map(({t}) => t);
  if (!top.length) return;

  const app = document.querySelector(".app");
  const box = document.createElement("section");
  box.className = "chips";
  top.forEach(topic => {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = topic.title;
    b.onclick = () => { addMsg(topic.title, "user"); answerFromTopic(topic.path, topic.title); };
    box.appendChild(b);
  });
  const composer = document.getElementById("composer");
  if (app && composer) app.insertBefore(box, composer);

  addMsg("These look close to what you asked — want to pick one?", "bot");
}



// --- basic supportive chat using the local LLM ---
async function chatReply(userText) {
  await ensureModel();
  const tone = classifyTone(userText);
  const energy = classifyEnergy(userText);
  const style = pickStyle(tone);
  const limit = sentenceLimitByEnergy(energy);
  const avoid = recentBannedPhrases();

const system = [
  "You are a calm, supportive perinatal companion.",
  "Do not infer causes, reasons, or life details the user didn’t mention. If unsure, ask briefly instead of stating.",
  "Never include meta-comments like ‘note: I will …’ or explain your reasoning.",
  "Goal: respond in 2–3 short sentences: 1) validate what the user said, 2) share one warm reflection (without adding new causes), 3) ask a gentle follow-up question.",
  `Keep it to ${limit} sentences. Use simple words.`,
  "Don’t use tag questions (e.g., 'aren’t you?', 'right?').",
  "Avoid repeating the user’s exact words; paraphrase emotions in plain words.",
  "Do NOT give medical advice unless the user asks for it.",
  "If the user seems upset, acknowledge the feeling and ask ONE gentle follow-up question.",
  avoid.length ? `Avoid repeating phrases: ${avoid.join(" | ")}` : "",
  `Style cues: ${style.cues}`
].filter(Boolean).join("\n");

  const messages = [
    { role: "system", content: system },
    { role: "user", content: userText }
  ];

  try {
    const r = await engine.chat.completions.create({
      messages,
      temperature: 0.9,
      top_p: 0.85,
      max_tokens: 140,
      stream: false
    });
    const out = r?.choices?.[0]?.message?.content || "";
    return keepSentences(sanitize(out), limit);

  } catch (e) {
    console.error("chatReply error", e);
    return "I’m here and listening. Want to tell me a bit more about what happened?";
  }
}

/* --------------------------- answerFromTopic (patched) --------------------------- */
async function answerFromTopic(path, fallbackQuery) {
  
  try {
    console.log("[answerFromTopic] path=", path, "fallbackQuery=", fallbackQuery);
    addMsg("Let me think about that…", "bot");

    // probe so we can handle 404 cleanly
    const probe = await fetch(path, { method: "GET" });
    if (!probe.ok) {
      if (probe.status === 404) {
// inside answerFromTopic(...) 404 case
addMsg("Looks like that topic isn’t in my local library yet.", "bot");

    if (fallbackQuery) {
      const infoy = isInfoIntent(detectIntent(fallbackQuery)); // NEW
      if (shouldWebSearch(fallbackQuery) || infoy) {           // UPDATED
        if (searchOptIn) {
          await startWebSearch(fallbackQuery);
        } else {
          awaitingSearchConsent = { text: fallbackQuery };
          addMsg("Want me to check trusted sources (WHO, SA DoH, UNICEF)?", "bot");
        }
      } else {
        suggestNearestLocalTopics(fallbackQuery);
      }
    }
    return;

      }
      throw new Error(`HTTP ${probe.status} for ${path}`);
    }

    // we have the file → normal paraphrase path
    const reply = await paraphraseTopicFromJSON(path, fallbackQuery);
    addMsg(reply, "bot");

    const ws = document.getElementById("websearch");
    if (ws) ws.style.display = "none";
  } catch (e) {
    addMsg("Sorry, I couldn’t load that right now. " + (e?.message || e), "bot");
  }
}

/* --------------------------- Intent detection (expanded) --------------------------- */
function detectIntent(text) {
  const t = (text || "").toLowerCase().trim();

  const selfHarm = /\b(kill myself|end my life|suicide|suicid|harm myself|hurt myself|i (do ?n'?t|dont) want to live)\b/i.test(t);
  const emergencyPhys = /\b(severe|heavy bleeding|passing clots|faint(ing)?|collapse|chest pain|can('?t)? breathe|difficulty breathing|shortness of breath|convulsion|seizure)\b/i.test(t);
  if (selfHarm || emergencyPhys) return "emergency";

  if (/^(hi|hey|hello|hie|heyy|howzit|morning|afternoon|evening)\b|👋/i.test(t)) return "greeting";
  if (/\b(thanks|thank you|much appreciated|appreciate it|cheers)\b/i.test(t)) return "gratitude";
  if (/\b(bye|goodbye|see you|gtg|talk later|catch you)\b/i.test(t)) return "goodbye";

  if (/\b(what do you mean|not clear|explain|clarify|make it simple|simple terms)\b/i.test(t)) return "clarify";
  if (/\b(tell me more|more detail|elaborate|expand|give me more)\b/i.test(t)) return "followup";

  if (/\b(clinic|hospital|midwife|sister|nurse|doctor|ob[-\s]?gyn|nearest|appointment|book|hotline|helpline|call|number|where can i go)\b/i.test(t)) return "care_nav";

  if (/\b(ideas?|tips?|suggestions?|how can i relax|help me relax|simple things to try)\b/i.test(t)) return "ideas";

  const isQuestion = /(\?|^how\b|^what\b|^when\b|^why\b|^which\b|^where\b|^can\b|^should\b|^is it\b)/i.test(t);
  const wantsSources = /\b(who|unicef|department of health|do[ht]\b|guideline|source|evidence|research|nice|bmj)\b/i.test(t);

  const breastfeeding = /\b(breast\s*feed(ing)?|breastfeed(ing)?|lactation|latching?|milk\s*supply|colostrum|mastitis|engorgement|wean(ing)?|exclusive\b)\b/i.test(t);
  const newborn      = /\b(newborn|baby (sleep|feeding)|colic|burp(ing)?|nappy|diaper|jaundice|umbilical|cord care|skin(?:\s*-\s*| )to(?:\s*-\s*| )skin)\b/i.test(t);
  const psych        = /\b(post(?:partum|natal)|perinatal)\b.*\b(depression|anxiety|pnd)\b|\b(baby\s*blues)\b/i.test(t);
  const obstetric    = /\b(trimester|ultrasound|scan|screening|kick count|reduced movements|spotting|cramp|contractions?|waters? (broke|breaking)|swelling|pre[-\s]?eclampsia|gestational|gdm)\b/i.test(t);
  const meds         = /\b(paracetamol|acetaminophen|ibuprofen|antibiotic|iron|folate|folic acid|prenatal|dose|dosage|mg|medication|medicine|safe to take)\b/i.test(t);
  const contraception= /\b(birth\s*-?\s*control|contracept|family planning|contraceptive|postpartum\s+contracept)\b/i.test(t);
 
  const labour       = /\b(labou?r|contractions?|tim(ing|e) contractions?|waters? (broke|breaking)|mucus plug|bloody show|birth plan|delivery|active labour|latent labour)\b/i.test(t);
  const postpartum   = /\b(post(?:partum|natal)|after birth|lochia|perineal|stitches|c-?section recovery|bleeding after birth|postpartum check|afterpains)\b/i.test(t);
  const nutrition    = /\b(nutrition|diet|foods?|what (to|can i) eat|eat(ing)? well|supplements?|folate|folic acid|iron|calcium|iodine|vitamin\s*(d|b12)|caffeine|alcohol)\b/i.test(t);
  const warningSigns = /\b(warning signs?|red flags?|danger signs?|severe headache|blurred vision|fits|fever|reduced (baby )?movements?|heavy bleeding|severe pain|swelling of (face|hands))\b/i.test(t);
  const clinicVisits = /\b(antenatal|anc|prenatal|booking|first booking|visit schedule|how often|how many visits|when should i go|clinic card|maternity record)\b/i.test(t);
  const immunization = /\b(vaccin(e|ation)|immuni[sz]e|immuni[sz]ation|shots?|bcg|opv|ipv|hep(?:atitis)? ?b|dtap|mmr|6 ?weeks|10 ?weeks|14 ?weeks|measles)\b/i.test(t);

  //const medical_terms = /\b(symptoms|eczema)\b/


  const medicalish = /\b(fever|bleeding|symptoms|pain|swelling|medicine|medication|dose|trimester|ultrasound|screening|mastitis|breast(?:\s*|-)feeding|latch|colic|contractions?|labou?r|dehydration|hypertension|pre[-\s]?eclampsia|gestational|post(?:partum|natal)|perinatal|depression|anxiety|baby blues|pnd|contracept|family planning|birth\s*-?\s*control|jaundice|umbilical)\b/i.test(t);
  // a question alone is not enough; require medicalish OR a topic bucket flag
  const hasTopicBucket = breastfeeding || newborn || psych || obstetric || meds || contraception || labour || postpartum || nutrition || warningSigns || clinicVisits || immunization ;
  const infoLike = wantsSources || medicalish || (isQuestion && hasTopicBucket);

  if (infoLike) {
    if (breastfeeding)  return "info:breastfeeding";
    if (newborn)        return "info:newborn";
    if (psych)          return "info:psych";
    if (obstetric)      return "info:obstetric";
    if (meds)           return "info:meds";
    if (contraception)  return "info:contraception";
    if (labour)         return "info:labour";
    if (postpartum)     return "info:postpartum";
    if (nutrition)      return "info:nutrition";
    if (warningSigns)   return "info:warning_signs";
    if (clinicVisits)   return "info:clinic_visits";
    if (immunization) return "info:immunization";
    
    return "info";
  }

  const lowMood = /\b(sad|down|overwhelmed|anxious|worried|confused|stressed|tired|lonely|drained|scared|fearful)\b/i.test(t);
  if (lowMood) return "comfort";
  if (/(^hmm$|lol|haha|hehe|😊|☺️|😅|😂|🤣|😉|🙂|❤️)/i.test(t)) return "smalltalk";
  return "feelings";
}

/* --------------------------- Main submit handler (updated) --------------------------- */
const intentToTopic = {
  "info:breastfeeding": "content/breastfeeding.json",
  "info:newborn": "content/newborn_basics.json",
  "info:psych": "content/mental_health.json",
  "info:obstetric": "content/antenatal_care_basics.json",
  "info:meds": "content/medicines_in_pregnancy.json",
  "info:contraception": "content/contraception_postpartum.json",
  "info:labour": "content/labour_and_birth.json",
  "info:postpartum": "content/postpartum_care_basics.json",
  "info:nutrition": "content/pregnancy_nutrition.json",
  "info:warning_signs": "content/warning_signs.json",
  "info:clinic_visits": "content/antenatal_visit_schedule.json",
  "info:immunization": "content/infant_immunization.json"
};

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input?.value?.trim() || "";
  if (!text) return;

  addMsg(text, "user");
  if (input) input.value = "";

  // 0) Social check-in
  if (isSocialCheckIn(text)) { addMsg("glad you’re doing okay. anything you want to talk about today?", "bot"); return; }

  // 1) Greetings
  if (isGreeting(text)) {
    if (chatHistory.length - lastGreetTurn <= 2) addMsg("still around 😊 what’s up?", "bot");
    else addMsg("hey 👋 how’s your day going?", "bot");
    lastGreetTurn = chatHistory.length;
    return;
  }

  // 2) Consent flow (answer yes/no from earlier search prompt)
  if (awaitingSearchConsent) {
    const yes = /\b(yes|sure|ok|okay|please|go ahead|yep|yeah)\b/i.test(text);
    const no  = /\b(no|nope|nah|not now|later)\b/i.test(text);
    if (yes) {
      const original = awaitingSearchConsent.text;
      awaitingSearchConsent = null;
      searchOptIn = true;
      const origIntent = detectIntent(original);
      await handleInfoLike(original, origIntent);
      return;
    } else if (no) {
      awaitingSearchConsent = null;
      addMsg("No problem — we can keep chatting. What’s on your mind?", "bot");
      return;
    } else {
      awaitingSearchConsent = null; // fall through
    }
  }

  // 2.4) DIRECT TOPIC SHORTCUTS (typed titles/aliases/synonyms) — run before router
  const norm = s => (s||"").toLowerCase().trim();
  const typed = norm(text);
  let directTopic = topicsIndex.find(t => norm(t.title) === typed)
                 || topicsIndex.find(t => (t.aliases||[]).map(norm).includes(typed));
  const directHintPath = resolveTopicFromHint(text); // handles "breast feeding", "won't latch", etc.
  if (directTopic)  { console.log("[direct-topic] title/alias", directTopic); await answerFromTopic(directTopic.path, text); return; }
  if (directHintPath){ console.log("[direct-topic] hint", directHintPath); await answerFromTopic(directHintPath, text); return; }

  // 2.5) If it's a "what is ..." question, try hint->topic before routing
  if (/^what\s+is\s+/i.test(text)) {
    const stripped = text.replace(/^what\s+is\s+/i, "").trim();
    const hintPath = resolveTopicFromHint(stripped);
    if (hintPath) { console.log("[what-is->hint]", hintPath); await answerFromTopic(hintPath, text); return; }
  }

  // 2.6) Hard safety stays priority (before routing)
  if (/\b(kill myself|end my life|suicide|harm myself)\b/i.test(text)) {
    addMsg("I’m really concerned. This sounds urgent. Please seek care immediately or call your local emergency number. If you’re in South Africa and need mental health support, SADAG: 0800 567 567 / 0800 21 22 23. I’m here with you.", "bot");
    return;
  }

  // ---- 3) LLM Router (priority after simple gates) ----
  const route = await routeWithLLM(text);
  console.log("[route]", route);

  // 3.1) If router says basic_chat but regex thinks it's info, prefer info path
  const forcedIntent = detectIntent(text);


  // only force if it's a specific info intent like "info:meds" OR clearly medical
  const specificInfo = forcedIntent && /^info:/.test(forcedIntent);
  const clearlyMedical = /\b(dose|symptoms|medicines?|medication|bleeding|contractions?|fever|hypertension|jaundice|immuni[sz]ation|ultrasound|trimester)\b/i.test(text);

  if (route.action === "basic_chat" && (specificInfo || clearlyMedical)) {
    const mappedPath = intentToTopic[forcedIntent];
    if (mappedPath) { console.log("[forced-info] mapped", mappedPath); await answerFromTopic(mappedPath, text); return; }
    const topic = findTopicForMessage(text);
    if (topic) { console.log("[forced-info] semantic", topic); await answerFromTopic(topic.path, text); return; }
    // else continue to basic_chat
  }
  // 3.2) Act on router result
  if (route.action === "greeting")  { addMsg("hey 👋 how’s your day going?", "bot"); return; }
  if (route.action === "gratitude") { addMsg("you’re welcome — happy to help 💛", "bot"); return; }
  if (route.action === "goodbye")   { addMsg("take care — here whenever you want to chat.", "bot"); return; }

  if (route.action === "emergency") {
    addMsg("This sounds urgent. Please seek care immediately or call your local emergency number. In South Africa, SADAG: 0800 567 567 / 0800 21 22 23.", "bot");
    return;
  }

  if (route.action === "clarify") {
    addMsg("got it — what part would you like help with exactly?", "bot");
    return;
  }

  if (route.action === "basic_chat") {
    try {
      const soft = await chatReply(text);
      addMsg(soft, "bot");
    } catch (e) {
      console.error(e);
      addMsg("I’m here and listening. Want to tell me a bit more?", "bot");
    }
    return;
  }

  // 4) Info flows
  if (route.action === "info_local" || (route.action === "info_search" && !route.needs_sources)) {
    const hintedPath = resolveTopicFromHint(route.topic_hint);
    if (hintedPath) { await answerFromTopic(hintedPath, text); return; }
    const topic = findTopicForMessage(text);
    if (topic) { await answerFromTopic(topic.path, text); return; }

    if (!route.needs_sources) {
      suggestNearestLocalTopics(text);
      addMsg("I can share a simple, general answer or we can pick one of those topics. what would you prefer?", "bot");
      return;
    }

  if (searchOptIn) {
      await startWebSearch(text);
    } else {
      awaitingSearchConsent = { text };
      addMsg("I might not have that in my library yet. Want me to check trusted sources (WHO, SA DoH, UNICEF)?", "bot");
    }
    return;
  }

  // 5) Only do trusted search when router says it's needed
  if (route.action === "info_search" && route.needs_sources) {
    if (searchOptIn) { await startWebSearch(text); return; }
    awaitingSearchConsent = { text };
    addMsg("Want me to check trusted sources (WHO, SA DoH, UNICEF)?", "bot");
    return;
  }

  // 6) Intent detection (backstop)
  const intent = detectIntent(text);

  // Emergencies
  if (intent === "emergency") {
    addMsg("I’m really concerned. This sounds urgent. Please seek care immediately or call your local emergency number. If you’re in South Africa and need mental health support, SADAG: 0800 567 567 / 0800 21 22 23. I’m here with you.", "bot");
    return;
  }

  // Quick intents
  if (intent === "gratitude") { addMsg("you’re welcome — happy to help 💛", "bot"); return; }
  if (intent === "goodbye")   { addMsg("take care — here whenever you want to chat.", "bot"); return; }
  if (intent === "clarify")   { addMsg("sure — which part should I make simpler?", "bot"); return; }
  if (intent === "followup")  { addMsg("happy to go deeper — which bit do you want more on?", "bot"); return; }
  if (intent === "care_nav")  { addMsg("I can help you think through next steps. If you’re in South Africa and need mental health support, SADAG: 0800 567 567 / 0800 21 22 23. Want me to check trusted sources for clinic guidance?", "bot"); return; }
  if (intent === "smalltalk") { addMsg("🙂 got you — tell me more?", "bot"); return; }

  // 7) JSON-first by semantic match (pass user text for web fallback)
  const topic = findTopicForMessage(text);
  if (topic) { await answerFromTopic(topic.path, text); return; }

  // 8) Non-medical ideas (guard both functions if defined)
  if (typeof asksForIdeas === "function" && typeof friendlyIdeas === "function" && asksForIdeas(text) && !isInfoIntent(intent)) {
    const ideas = await friendlyIdeas(text);
    addMsg(ideas, "bot");
    return;
  }

  // 9) Info-like
  if (isInfoIntent(intent)) {
    const mappedPath = intentToTopic[intent];
    if (mappedPath) { await answerFromTopic(mappedPath, text); return; }

    if (searchOptIn) { await handleInfoLike(text, intent); return; }

    awaitingSearchConsent = { text };
    addMsg("I might not have that in my library yet. Want me to check trusted sources (WHO, SA DoH, UNICEF)?", "bot");
    return;
  }

  // 10) Friend mode fallback
  try {
    const soft = await chatReply(text);
    addMsg(soft, "bot");
  } catch (e) {
    console.error(e);
    addMsg("I’m here. Want to tell me more so I can help?", "bot");
  }
});
