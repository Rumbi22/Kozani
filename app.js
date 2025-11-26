/* ---------------------------------- DOM refs ---------------------------------- */
const $ = (sel) => document.querySelector(sel);
const chat = $("#chat");
const form = $("#composer");
const input = $("#msg");
const chipsEl = $("#chips"); // optional / future use
const progressBar = $("#model-progress");

// If you use this, make sure setStatus is defined somewhere:
function setStatus(text) {
  if (!progressBar) return;
  progressBar.textContent = text;
}

// ------------------------- Chat message helper -------------------------
function addMsg(text, sender = "bot") {
  if (!chat) return;

  const msgEl = document.createElement("div");
  msgEl.className = sender === "user" ? "msg user" : "msg bot";
  msgEl.textContent = text;

  chat.appendChild(msgEl);
  chat.scrollTop = chat.scrollHeight;
}

/*-------------------- Ask backend ---------------------------------------*/

const API_BASE =
  window.location.hostname === "localhost"
    ? "http://localhost:8787"
    : "https://kozani-backend.onrender.com";


async function sendToKozaniBackend(userText, retrievedSnippets = []) {
  try {
    const response = await fetch("https://kozani-backend.onrender.com/api/kozani-chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: userText,
        snippets: retrievedSnippets,
        language: "en",
        client: "kozani-web-v3"
      })
    });

    const data = await response.json();
    return data; // { answer, safety, meta }
  } catch (err) {
    console.error("Error talking to Kozani backend:", err);
    return {
      answer: "Sorry, I couldn’t connect to Kozani’s brain. Please check your connection.",
      safety: { ok: false, flags: ["network_error"] },
      meta: { model: "none", mode: "offline-error" }
    };
  }
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
      const res = await sendToKozaniBackend(text);
      addMsg(res.answer, "bot");  // ⬅️ use the answer string
    } catch (err) {
      console.error(err);
      addMsg("⚠️ Something went wrong talking to the model.", "bot");
    } finally {
      setStatus("");
    }
  });
}
