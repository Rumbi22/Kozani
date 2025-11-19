// app.js — LLM‑centered perinatal companion (frontend)
// Focus: move routing/intent, topic picking, tone, and summarization into the model.
// Works with @mlc-ai/web-llm and a very small helper backend (optional) for search.

import * as webllm from "https://esm.run/@mlc-ai/web-llm@0.2.79?bundle";

/* --------------------------------- Globals --------------------------------- */
let engine = null;
let loadingModel = false;

// Choose the on-device model id. You can override via window.MODEL_ID before loading.
const MODEL_ID = window.MODEL_ID || "Llama-3.2-1B-Instruct-q4f16_1-MLC";

/* ------------------------------- Ensure model ------------------------------ */
let loadingPromise = null;
async function ensureModel() {
  if (engine) return engine;
  if (loadingPromise) { await loadingPromise; return engine; }

  const firstRunKey = "mlc_model_warmed";
  if (!localStorage.getItem(firstRunKey)) {
    setStatus("Preparing the language model… first run may take a bit.");
  }

  loadingPromise = (async () => {
    try {
      if (typeof webllm?.CreateMLCEngine !== "function") {
        throw new Error("WebLLM module not loaded (CreateMLCEngine missing). Check <script type=\"module\"> and network/CSP.");
      }
      setStatus(`Loading model: ${MODEL_ID} …`);
      engine = await webllm.CreateMLCEngine(MODEL_ID, {
        initProgressCallback: (p) => setStatus(p?.text || `Loading ${MODEL_ID}…`)
      });
      localStorage.setItem(firstRunKey, "1");
      setStatus("");
      return engine;
    } catch (e) {
      console.error("ensureModel error", e);
      setStatus("");
      if (!window.__modelErrNotified) {
        addMsg(`❌ Model failed to load: ${e?.message || e}`, "bot");
        window.__modelErrNotified = true;
      }
      throw e;
    } finally {
      loadingPromise = null;
    }
  })();

  await loadingPromise;
  return engine;
}

// Warm the model when the browser is idle (non-blocking)
if ("requestIdleCallback" in window) requestIdleCallback(() => ensureModel());
else setTimeout(() => ensureModel(), 1200);

/* -------------------------- Robust element lookups ------------------------- */
function pickOne(selList) { for (const sel of selList.split(",")) { const el = document.querySelector(sel.trim()); if (el) return el; } return null; }

const SELECTORS = {
  chat:   "#chat, .chat, #messages, .messages, [data-chat-log]",
  form:   "#form, form[data-chat], form.chat, form#chat-form, form",
  input:  "#msg, #message, #msgInput, textarea#message, textarea[name=message], input#message, input[name=message], [data-chat-input]",
  send:   "#send, button#send, [data-send]",
  chips:  "#chips, .chips, [data-chips]",
  status: "#status, .status, [data-status]",
};

const getChat   = () => pickOne(SELECTORS.chat);
const getForm   = () => pickOne(SELECTORS.form);
const getInput  = () => pickOne(SELECTORS.input);
const getSend   = () => pickOne(SELECTORS.send);
const getChips  = () => pickOne(SELECTORS.chips);
const getStatus = () => pickOne(SELECTORS.status);

function setStatus(text) { const el = getStatus(); if (el) el.textContent = text || ""; }

// Configure your local/remote backend if you want web search. Keep undefined to disable.
const API_BASE = window.API_BASE || "http://127.0.0.1:8787"; // your server.js
const SEARCH_ENABLED = !!API_BASE;

// Short rolling history to keep prompts light
const chatHistory = []; // {role:'user'|'assistant', content}
function pushHistory(role, content) { chatHistory.push({ role, content }); while (chatHistory.length > 6) chatHistory.shift(); }

function addMsg(text, who = "bot") {
  const chatEl = getChat();
  const role = who === "user" ? "user" : "assistant";
  if (!chatEl) { console.warn("Chat container not found"); pushHistory(role, text); return; }
  const div = document.createElement("div");
  div.className = `msg ${who}`;
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  pushHistory(role, text);
}

/* ------------------------------- LLM wrapper ------------------------------- */
async function llmReply(messages, opts = {}) {
  await ensureModel();
  if (!engine?.chat?.completions?.create) {
    throw new Error("LLM engine not ready (webllm create unavailable)");
  }
  const res = await engine.chat.completions.create({
    messages,
    stream: false,
    temperature: opts.temperature ?? 0.7,
    top_p: opts.top_p ?? 0.9,
    max_tokens: opts.max_tokens ?? 320
  });
  return res?.choices?.[0]?.message?.content?.trim() || "";
}

/* ------------------------------ Topics & chips ------------------------------ */
let topicsIndex = []; // [{ title, path, aliases?, keywords?, tags? }]

async function loadChips() {
  try {
    const res = await fetch("content/topics.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    topicsIndex = await res.json();
    const chipsEl = getChips();
    if (!chipsEl) return;
    chipsEl.innerHTML = "";
    topicsIndex.forEach((topic) => {
      const btn = document.createElement("button");
      btn.className = "chip";
      btn.textContent = topic.title;
      btn.addEventListener("click", async () => {
        addMsg(topic.title, "user");
        await answerFromTopic(topic.path, topic.title);
      });
      chipsEl.appendChild(btn);
    });
  } catch (e) {
    const chipsEl = getChips();
    if (!chipsEl) return;
    const msg = document.createElement("div");
    msg.textContent = `Could not load topics: ${e.message}`;
    msg.style.color = "var(--alert)";
    chipsEl.appendChild(msg);
  }
}

/* ----------------------------- Router (LLM plan) ---------------------------- */
async function planNext() {
  const system = [
    "You are the conversation router for a perinatal companion.",
    "Rules:",
    "- Do NOT guess feelings or diagnoses. Avoid lines like \"You're feeling...\" unless the user said it.",
    "- Prefer 'reply' that contains exactly two sentences: (1) a brief validation, (2) one open question to understand more.",
    "- Choose 'topic' only if the user explicitly asks about a topic or clearly seeks factual info that matches a known topic.",
    "- Choose 'search' when the user asks for information not covered in local topics; set needs_consent true.",
    "- Choose 'safety' if there's self-harm, harm to others, suicidal thoughts, or obstetric emergency keywords (e.g., heavy bleeding, seizures, chest pain, trouble breathing).",
    "Return strict JSON: {\"action\":\"reply|topic|search|safety\",\"topic_slug\":null|\"...\",\"explicit_topic_request\":true|false,\"needs_consent\":true|false,\"style\":\"warm-minimal|reflective-soft\",\"sentence_budget\":1|2}"
  ].join("
");

  const user = JSON.stringify({ history: chatHistory.slice(-6) });
  const out = await llmReply([
    { role: "system", content: system },
    { role: "user", content: user }
  ], { temperature: 0.1 });

  try {
    const parsed = JSON.parse(out);
    if (!parsed.action) parsed.action = "reply";
    if (!parsed.style) parsed.style = "warm-minimal";
    if (!parsed.sentence_budget) parsed.sentence_budget = 2;
    if (typeof parsed.explicit_topic_request !== "boolean") parsed.explicit_topic_request = false;
    return parsed;
  } catch (_) {
    return { action: "reply", style: "warm-minimal", sentence_budget: 2, explicit_topic_request: false };
  }
}

/* ---------------------------- Topic picking (LLM) --------------------------- */
async function pickTopicLLM(userText) {
  if (!topicsIndex?.length) return null;
  const catalog = topicsIndex.map(t => ({
    title: t.title,
    slug: (t.aliases?.[0] || t.title),
    hints: [...(t.keywords || []), ...(t.aliases || []), ...(t.tags || [])].slice(0, 6)
  }));

  const system = "Pick the single best topic. Return JSON {\"slug\":\"...\"} or {\"slug\":null}.";
  const user = JSON.stringify({ question: userText, topics: catalog });
  const out = await llmReply([
    { role: "system", content: system },
    { role: "user", content: user }
  ], { temperature: 0.0 });
  try { const { slug } = JSON.parse(out); return slug || null; } catch (_) { return null; }
}

/* ------------------------------ Answer from topic --------------------------- */
async function answerFromTopic(path, userQuestion) {
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const sections = Array.isArray(data.sections) ? data.sections : [];
    function toSentences(s) {
      if (!s) return [];
      const matches = s.match(/[^.!?]+[.!?]+/g) || [];
      const consumed = matches.join("");
      const rest = s.slice(consumed.length).trim();
      if (rest) matches.push(rest);
      return matches.map(t => t.trim()).filter(Boolean);
    }

    const sentences = [];
    for (const sec of sections) {
      const src = sec.source || data.source || data.title || "Local";
      const parts = toSentences(String(sec.content || ""));
      for (const p of parts) sentences.push({ text: p, source: src });
    }

    if (!sentences.length) {
      addMsg("I may not have enough local info on this. Want me to check trusted sources?", "bot");
      awaitingSearchConsent = { text: userQuestion };
      return;
    }

    const limit = 180;
    const limited = sentences.slice(0, limit);

    const system = [
      "You will receive an array SENTENCES where each item is a full sentence string.",
      "Choose up to 4 indices whose sentences directly answer the QUESTION.",
      "Return strict JSON: {\\"idx\\":[...]} or {\\"fallback\\":true}.",
      "Pick only indices; do not write new text."
    ].join("
");

    const payload = { QUESTION: userQuestion, SENTENCES: limited.map(s => s.text) };
    const out = await llmReply([
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(payload).slice(0, 25000) }
    ], { temperature: 0.0, max_tokens: 120 });

    let idx = [];
    try {
      const parsed = JSON.parse(out);
      if (!parsed.fallback && Array.isArray(parsed.idx)) {
        idx = parsed.idx.filter(i => Number.isInteger(i) && i >= 0 && i < limited.length).slice(0, 4);
      }
    } catch (_) { idx = []; }

    if (!idx.length) {
      addMsg("I may not have that locally. Want me to check trusted sources?", "bot");
      awaitingSearchConsent = { text: userQuestion };
      return;
    }

    const bullets = idx.map(i => `• ${limited[i].text} (${limited[i].source})`).join("
");
    addMsg(bullets, "bot");
  } catch (e) {
    console.error(e);
    addMsg("I couldn't open that topic just now.", "bot");
  }
}

/* --------------------------------- Search ---------------------------------- */
let awaitingSearchConsent = null;

async function startWebSearch(query) {
  if (!SEARCH_ENABLED) { addMsg("Web search isn’t enabled here.", "bot"); return; }
  try {
    setStatus("Searching trusted sources…");
    const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(query)}&count=3`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const items = payload?.items || payload?.results || [];

    if (!items.length) { addMsg("No results from trusted sources.", "bot"); return; }

    const system = [
      "Using these search snippets, write a short, factual answer (2–4 sentences).",
      "Include short inline source tags like (WHO) or (NICE)."
    ].join("\n");

    const out = await llmReply([
      { role: "system", content: system },
      { role: "user", content: JSON.stringify({ question: query, snippets: items.map(({ title, url, snippet }) => ({ title, url, snippet })) }) }
    ], { temperature: 0.2, max_tokens: 220 });

    addMsg(out, "bot");
  } catch (e) { console.error(e); addMsg("Search failed just now.", "bot"); }
  finally { setStatus(""); }
}

/* ------------------------- Main submit (LLM‑first loop) --------------------- */
let sending = false;
async function handleSubmit(e){
  if (e) e.preventDefault();
  if (sending) return; // debounce double-submits
  const inputEl = getInput();
  const text = inputEl?.value?.trim();
  if (!text) return;
  sending = true; try { const sendEl = getSend(); if (sendEl) sendEl.disabled = true; } catch(_){ }
  try {
    // Ensure model is loaded before routing/reply to avoid mid-call failures
    try { await ensureModel(); } catch (mErr) { console.error("Model load failed", mErr); setStatus("Model failed to load. Check MODEL_ID or network."); }

    addMsg(text, "user");
    if (inputEl) inputEl.value = "";

    let plan = { action: "reply", style: "warm-minimal", sentence_budget: 2 };
    try { plan = await planNext() || plan; } catch (err) { console.error("router failed", err); }

    if (plan.action === "safety") { addMsg("I’m really concerned. This sounds urgent. Please seek care immediately or call your local emergency number. In South Africa, mental health support: SADAG 0800 567 567 / 0800 21 22 23.", "bot"); return; }

    if (plan.action === "topic" && plan.explicit_topic_request) {
      let slug = plan.topic_slug; if (!slug) slug = await pickTopicLLM(text);
      const topic = topicsIndex.find(t => [t.title, ...(t.aliases||[]), ...(t.keywords||[])].some(s => s?.toLowerCase?.() === slug?.toLowerCase?.()));
      if (topic) { await answerFromTopic(topic.path, text); return; }
      awaitingSearchConsent = { text }; addMsg("I don’t have that in my library yet — shall I check trusted sources?", "bot"); return;
    }

    if (plan.action === "search") {
      if (plan.needs_consent || !SEARCH_ENABLED) { awaitingSearchConsent = { text }; addMsg("Want me to check trusted sources (WHO, SA DoH, UNICEF)?", "bot"); }
      else { await startWebSearch(text); }
      return;
    }

    const reply = await llmReply([
      { role: "system", content: [
        "You are a gentle perinatal companion.",
        "Use simple, warm language (Grade ~8).",
        "Do not guess the user's feelings or diagnoses. Avoid phrasing like ‘You're feeling…’.",
        "Your reply must be exactly two sentences: (1) a brief validation based only on what the user said; (2) one open question to understand more or to offer a tiny next step (ask permission before suggesting techniques).",
        "Style: warm-minimal. Max sentences: 2."
      ].join("
") },
      ...chatHistory.slice(-6), { role: "user", content: text }
    ], { temperature: 0.7, top_p: 0.9, max_tokens: 220 });
    addMsg(reply, "bot");
  } catch (err) { console.error(err); addMsg("Hmm, something went wrong sending that. Try again in a moment.", "bot"); }
  finally { sending = false; try { const sendEl = getSend(); if (sendEl) sendEl.disabled = false; } catch(_){ } }
}

/* ------------------------ Bind after DOM is available ----------------------- */
document.addEventListener("DOMContentLoaded", () => {
  const formEl = getForm();
  const sendEl = getSend();

  if (formEl) formEl.addEventListener("submit", handleSubmit);
  if (sendEl) sendEl.addEventListener("click", handleSubmit);
  if (!formEl && !sendEl) {
    console.warn("No form or send button found — add id=#form or #send.");
  }

  // Consent chips (optional)
  const yesBtn = document.querySelector("#yes");
  const noBtn  = document.querySelector("#no");
  yesBtn?.addEventListener("click", async () => {
    if (!awaitingSearchConsent) return;
    const q = awaitingSearchConsent.text; awaitingSearchConsent = null; await startWebSearch(q);
  });
  noBtn?.addEventListener("click", () => { awaitingSearchConsent = null; addMsg("Okay — we can stick to our local library.", "bot"); });

  // Safe place to greet
  addMsg("Hi 👋 I’m your perinatal companion—here to listen and keep you company. How can I help today?", "bot");

  // Load chips once DOM exists
  loadChips();
});
