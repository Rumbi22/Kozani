// app.js — perinatal companion (frontend) with trusted web search + extractive summaries
import * as webllm from "https://esm.run/@mlc-ai/web-llm@0.2.79?bundle";

/* --------------------------- MODEL (load once, reuse) --------------------------- */
let engine = null;
let engineReadyPromise = null;
let greeted = false; // ensure welcome message only once

// Status UI (safe no-op if #status missing)
const statusEl = document.querySelector("#status");
function setStatus(text) {
  if (statusEl) statusEl.textContent = text || "";
}





const DEBUG = true; // set to false in production

async function ensureModel() {
  if (engine) return engine;
  if (engineReadyPromise) return engineReadyPromise;

  engineReadyPromise = (async () => {
    const firstRunKey = "mlc_model_warmed";

    if (!localStorage.getItem(firstRunKey)) {
      setStatus("Preparing the language model… first run may take a bit.");
    } else {
      setStatus("Loading language model from cache…");
    }

   // const modelId = "Llama-3.2-3B-Instruct-q4f16_1-MLC";
    const modelId = "Gemma-2-2B–q4f16_1-MLC"

    const e = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (info) => {
        if (!info) return;

        // info.progress is usually 0 → 1
        if (typeof info.progress === "number") {
          const pct = Math.round(info.progress * 100);
          setStatus(`Loading model… ${pct}%`);

          if (progressBar) {
            progressBar.style.width = `${pct}%`;
          }
        }

        if (DEBUG) {
          console.log("Model init progress:", info);
        }
      }
    });

    localStorage.setItem(firstRunKey, "1");
    setStatus("Model ready ✅");

    if (progressBar) {
      progressBar.style.width = "100%";
    }

    engine = e;

    // Send welcome message only AFTER model is ready
    if (!greeted && chat) {
      addMsg("Hi 👋 I’m your perinatal companion. The model is ready. How can I support you today?", "bot");
      greeted = true;
    }

    return e;
  })().catch((err) => {
    engineReadyPromise = null;
    setStatus("");
    if (progressBar) {
      progressBar.style.width = "0%";
    }
    console.error("Model failed to load:", err);
    addMsg("❌ Model failed to load: " + (err?.message || err), "bot");
    throw err;
  });

  return engineReadyPromise;
}


// Warm the model in the background
if ("requestIdleCallback" in window) {
  requestIdleCallback(() => ensureModel());
} else {
  setTimeout(() => ensureModel(), 1200);
}

/* ---------------------------------- DOM refs ---------------------------------- */
const $ = (sel) => document.querySelector(sel);
const chat = $("#chat");
const form = $("#composer");
const input = $("#msg");
const chipsEl = $("#chips"); // optional / future use
const progressBar = $("#model-progress");

// ------------------------- Chat message helper -------------------------
function addMsg(text, sender = "bot") {
  if (!chat) return;

  const msgEl = document.createElement("div");
  msgEl.className = sender === "user" ? "msg user" : "msg bot";
  msgEl.textContent = text;

  chat.appendChild(msgEl);
  chat.scrollTop = chat.scrollHeight;
}

// -------------------------- Conversation state --------------------------
const conversation = [
  {
    role: "system",
    content:
      "You are Kozani, a gentle, calm perinatal companion. " +
      "You support people through pregnancy, birth and early parenting with " +
      "short, clear, kind answers. Avoid medical jargon. Always be empathetic."
  }
];



// ---------------------- Router prompts -----------------------------------


// --------- Build system prompt (LLM instructions) ---------
function buildSystemPrompt() {
  return `
You are an analyser for a perinatal support assistant.

Your task is to read a single user message and output a JSON object with:
- topic: short string (e.g. "newborn_sleep", "feeding", "pain", "bleeding", "emotions", "logistics", "general_info")
- intent: short description of what the user is trying to do (e.g. "ask_if_normal", "describe_symptom", "seek_reassurance", "vent_emotion", "ask_for_steps")
- emotionalState: {
    "label": short word/phrase (e.g. "overwhelmed", "worried", "relieved", "neutral"),
    "intensity": number from 0 to 1 (0=very calm, 1=extremely intense)
  }
- risk: {
    "level": one of ["none","low","medium","high"],
    "markers": list of short phrases describing possible danger signs (e.g. "heavy_bleeding","severe_pain","fever","suicidal_thoughts","baby_not_moving")
  }
- userContext: {
    "phase": one of ["pregnancy","postpartum","unknown"],
    "week": number or null,
    "babyAge": short string or null (e.g. "newborn","2_months"),
    "parity": one of ["first_baby","multiple","unknown"]
  }
- goal: short string describing the practical outcome the user seems to want (e.g. "understand_if_normal","help_baby_sleep","reduce_pain","feel_less_guilty","know_when_to_seek_care")

Guidelines:
- Be conservative with "high" risk. Only use "high" if there are clear danger signs.
- If information is missing, use null or "unknown" rather than guessing wildly.
- If the topic does not fit the perinatal space, set topic="other".
- Emotional intensity should reflect how urgent or strong the message feels.

CRITICAL:
- Output STRICT JSON ONLY.
- Do not include explanations, comments, or markdown.
  `.trim();
}

// --------- Build user prompt (what we send to the LLM) ---------
function buildUserPrompt(text, meta = {}) {
  return JSON.stringify(
    {
      user_text: text,
      meta: {
        locale: meta.locale || "en-ZA",
        localHour: meta.localHour ?? null
      }
    },
    null,
    2
  );
}




//---------------------------Analyzer -------------------------------------



// Safely parse JSON, even if the model wraps it in extra text
function safeParseJson(raw) {
  if (!raw) return null;
  let txt = raw.trim();

  // Try to extract between first { and last }
  const first = txt.indexOf("{");
  const last = txt.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    txt = txt.slice(first, last + 1);
  }

  try {
    return JSON.parse(txt);
  } catch (err) {
    if (DEBUG) {
      console.error("Failed to parse analysis JSON", { raw: txt, err });
    }
    return null;
  }
}

// Run a short analyser pass before main reply
async function analyzeMessage(userText) {
  const e = await ensureModel();

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    {
      role: "user",
      content: buildUserPrompt(userText, {
        locale: "en-ZA",
        localHour: new Date().getHours()
      })
    }
  ];

  const res = await e.chat.completions.create({
    messages,
    temperature: 0,        // deterministic
    max_tokens: 256
  });

  const raw = res?.choices?.[0]?.message?.content || "";
  const analysis = safeParseJson(raw);

  if (DEBUG) {
    console.log("Analysis raw:", raw);
    console.log("Analysis parsed:", analysis);
  }

  return analysis;
}






// -------------------------- Talk to the model ---------------------------
// -------------------------- Talk to the model ---------------------------
async function askModel(userText) {
  const e = await ensureModel();

  // 1) First pass: analyse the message into structured JSON
  /*
  const analysis = await analyzeMessage(userText);
  
  // 2) Build what we actually send to the companion
  //    We include the analysis as hidden context.
  let userContent;

  if (analysis) {
    userContent =
      `User message: "${userText}"\n\n` +
      `Here is a structured analysis of their state. ` +
      `Use it to guide your tone, risk awareness, and next steps, but DO NOT mention this JSON explicitly:\n` +
      JSON.stringify(analysis, null, 2);
  } else {
    // fallback if analysis failed
    userContent = userText;
  }
 
  // Add user message (plus context) to ongoing conversation
  conversation.push({ role: "user", content: userContent });

  */
  conversation.push({ role: "user", content: userText });

  if (DEBUG) console.log("➡️ Sending to WebLLM:", conversation);

  const reply = await e.chat.completions.create({
    messages: conversation,
    temperature: 0.3,
    max_tokens: 256
  });

  const botText =
    reply?.choices?.[0]?.message?.content?.trim() ||
    "I'm not sure how to respond to that.";

  // Add assistant reply to history
  conversation.push({ role: "assistant", content: botText });

  if (DEBUG) console.log("⬅️ Model reply:", botText);

  return botText;
}


// --------------------------- Form submit handler ------------------------
if (form && input) {
  form.addEventListener("submit", async (evt) => {
    evt.preventDefault();

    const text = input.value.trim();
    if (!text) return;

    // Show user's message
    addMsg(text, "user");
    input.value = "";
    setStatus("Thinking…");

    try {
        
     
      const answer = await askModel(text);
      addMsg(answer, "bot");
    } catch (err) {
      console.error(err);
      addMsg("⚠️ Something went wrong talking to the model.", "bot");
    } finally {
      setStatus("");
    }
  });
}

// --------------------------- Optional: greeting -------------------------
/*if (chat) {
  addMsg("Hi 👋 I’m your perinatal companion. How can I support you today?", "bot");
}*/
