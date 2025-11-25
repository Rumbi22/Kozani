// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";


dotenv.config();

import Groq from "groq-sdk";

const app = express();
const PORT = process.env.PORT || 8787;

const groq = new Groq ({apiKey: process.env.GROQ_API_KEY})

// --- MIDDLEWARE ---
app.use(cors());            // later you can restrict origin (e.g. your frontend URL)
app.use(express.json());    // so req.body works for JSON

// --- HEALTH CHECK ---
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "kozani-backend",
    time: new Date().toISOString()
  });
});

// --- KOZANI CHAT ENDPOINT (STEP 1: dummy implementation) ---
app.post("/api/kozani-chat", async (req, res) => {
  try {
    const { query: rawQuery, snippets = [], language = "en", client } = req.body || {};

    if (!rawQuery) {
      return res.status(400).json({
        answer: "I didn’t receive anything to respond to.",
        safety: { ok: false, flags: ["empty_query"] },
        meta: { model: "none" }
      });
    }

    //const query = sanitizeUserText(rawQuery);
    const query = rawQuery;

    // 1) Build grounding text from snippets (later you’ll plug your KB here)
    const grounding = snippets.map(s => s.text).join("\n\n");

    // 2) System prompt: Kozani’s voice + rules
    const systemPrompt = `
You are Kozani, an empathetic perinatal companion for expectant and new mothers,
especially in under-resourced settings.

Your goals:
- Listen with warmth and respect.
- Reflect their feelings back gently.
- Offer clear, simple, practical guidance.
- Encourage seeking professional help when needed.
- Never judge, shame, or blame.

Safety rules:
- DO NOT diagnose or prescribe medication.
- DO NOT give exact doses or treatment plans.
- DO NOT contradict local healthcare professionals.
- If there is any sign of danger (severe pain, heavy bleeding, trouble breathing, thoughts of self-harm),
  clearly advise the user to seek urgent medical help or visit a clinic/hospital as soon as possible.

Keep responses:
- Short (4–7 sentences).
- In plain, simple language.
- Emotionally validating.

Use this trusted information as background context when relevant (but do not quote it word-for-word):

${grounding}
    `.trim();

    // 3) Call Groq (Gemma); you can swap gemma-2b-it / gemma-7b-it later
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query }
      ],
      temperature: 0.4,
      max_tokens: 400
    });

    const answer = completion.choices?.[0]?.message?.content ?? 
      "I’m sorry, I’m struggling to respond right now.";

    // 4) Send reply back to frontend
    res.json({
      answer,
      safety: { ok: true, flags: [] },
      meta: {
        model: "gemma-2b-it",
        provider: "groq",
        grounded: snippets.length > 0,
        language,
        client
      }
    });
  } catch (err) {
    console.error("Kozani /api/kozani-chat error:", err);
    res.status(500).json({
      answer: "I’m sorry, something went wrong while thinking. Please try again a bit later.",
      safety: { ok: false, flags: ["backend_error"] },
      meta: { model: "none" }
    });
  }
});


// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`Kozani backend running on http://localhost:${PORT}`);
});
