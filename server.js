// AI ჩატის სერვერი — Google Gemini API (უფასო დონე). გასაღები ინახება მხოლოდ აქ
// (გარემოს ცვლადში), ბრაუზერში არასდროს ჩანს. დამოკიდებულებები არ სჭირდება (Node 18+).

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ""; // მაგ: https://moonfull4k.xyz (თუ Index.html სხვაგან ჰოსტდება)
const MAX_TOKENS = 8192;          // მოდელის ფიქრიც ამ ლიმიტში ითვლება, ამიტომ დიდი მარაგი გვჭირდება
const MAX_MESSAGES = 30;
const MAX_CHARS = 8000;          // ერთი შეტყობინების მაქსიმალური სიგრძე
const RATE_LIMIT = 20;           // მოთხოვნა ...
const RATE_WINDOW_MS = 60_000;   // ... წუთში, ერთ IP-ზე

const SEARCH = process.env.GEMINI_SEARCH !== "0"; // Google ძებნა ახალი ინფორმაციისთვის (გამოსართავად: GEMINI_SEARCH=0)

// მოდელს ყოველ მოთხოვნაზე ვეუბნებით დღევანდელ თარიღს, რომ "2024 წელზე" არ დარჩეს
function systemPrompt(tz) {
  let zone = "Asia/Tbilisi";
  if (typeof tz === "string" && tz.length < 60) {
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); zone = tz; } catch {}
  }
  const now = new Date();
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(now);
  return (
    "შენ ხარ MOON AI — მეგობრული და გამოცდილი AI ასისტენტი. პასუხობ მკაფიოდ და გასაგებად. " +
    "ყოველთვის უპასუხე იმ ენაზე, რომლითაც მომხმარებელი გწერს; თუ ენა გაურკვეველია, პასუხი ქართულად დაწერე.\n\n" +
    "დღევანდელი თარიღია " + iso + " (" + weekday + "), დროის სარტყელი: " + zone + ". " +
    "ეს არის სწორი, მიმდინარე თარიღი. შენი სწავლების მონაცემები უფრო ძველია, ამიტომ ახალ ამბებზე, ფასებზე, " +
    "პროდუქტებისა და პროგრამების ვერსიებზე, სპორტზე, პოლიტიკაზე და ყველაფერზე, რაც შეიძლებოდა შეცვლილიყო, " +
    "ჯერ გამოიყენე ძებნა და უპასუხე მიღებული ახალი ინფორმაციით. არასდროს თქვა, რომ ახლა 2024 წელია, და ძველი " +
    "მონაცემები დღევანდელად არ გაასაღო. თუ ახალი ინფორმაცია ვერ დაადასტურე, პირდაპირ თქვი, რომ ის შეიძლება მოძველებული იყოს.\n\n" +
    "ფორმატი: LaTeX-ს და დოლარის ნიშნებით მათემატიკურ ჩანაწერებს ($...$) არ იყენებ. ისრებისთვის წერე უბრალო სიმბოლოებს (→, ←, ⇒), " +
    "ტექსტი კი დაწერე მარტივი Markdown-ით: მოკლე აბზაცები, საჭიროებისას სია, მუქი ტექსტი მნიშვნელოვანისთვის."
  );
}

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    if (!arr.some(t => now - t < RATE_WINDOW_MS)) hits.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

function cors(res, req) {
  if (ALLOWED_ORIGIN && req.headers.origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cleanMessages(input) {
  if (!Array.isArray(input) || !input.length) return null;
  const out = [];
  for (const m of input.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
    const content = m.content.slice(0, MAX_CHARS);
    if (!content.trim()) continue;
    out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  if (!out.length || out[out.length - 1].role !== "user") return null;
  return out;
}

async function chat(req, res) {
  cors(res, req);
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (limited(ip)) return json(res, 429, { error: "ძალიან ბევრი მოთხოვნაა. ერთი წუთით მოიცადე." });
  if (!API_KEY) return json(res, 500, { error: "სერვერზე GEMINI_API_KEY არ არის დაყენებული." });

  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return json(res, 400, { error: "არასწორი მოთხოვნა." }); }

  const messages = cleanMessages(body.messages);
  if (!messages) return json(res, 400, { error: "შეტყობინებები არასწორია." });

  const ctrl = new AbortController();
  res.on("close", () => ctrl.abort());

  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(MODEL) + ":streamGenerateContent?alt=sse";
  const system = systemPrompt(body.tz);
  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));
  const call = withSearch => fetch(url, {
    method: "POST",
    signal: ctrl.signal,
    headers: { "content-type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      ...(withSearch ? { tools: [{ google_search: {} }] } : {}),
      generationConfig: { maxOutputTokens: MAX_TOKENS }
    })
  });

  let up, usedSearch = SEARCH;
  try {
    up = await call(SEARCH);
    // თუ ძებნით მოთხოვნა არ გავიდა (ფორმატი, ლიმიტი) — ერთხელ ვცადოთ ძებნის გარეშე, ჩატი არ გაჩერდეს
    if (!up.ok && SEARCH && (up.status === 400 || up.status === 429)) {
      console.error("Gemini (ძებნით) შეცდომა", up.status, await up.text().catch(() => ""));
      up = await call(false);
      usedSearch = false;
    }
  } catch (e) {
    if (ctrl.signal.aborted) return;
    return json(res, 502, { error: "AI სერვისთან კავშირი ვერ მოხერხდა." });
  }

  if (!up.ok) {
    console.error("Gemini error", up.status, await up.text().catch(() => ""));
    let msg = "AI სერვისმა შეცდომა დააბრუნა (" + up.status + ").";
    if (up.status === 429) msg = "უფასო ლიმიტი ამოიწურა ან სერვისი დატვირთულია. სცადე რამდენიმე წუთში.";
    else if (up.status === 400 || up.status === 403) msg = "გასაღები ან მოდელი არასწორია. შეამოწმე სერვერის პარამეტრები.";
    else if (up.status === 404) msg = "მოდელი ვერ მოიძებნა. შეამოწმე GEMINI_MODEL.";
    return json(res, 502, { error: msg });
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no"
  });

  // Gemini-ს ნაკადს ვაქცევთ იმ ფორმატად, რომელსაც Index.html კითხულობს
  const sources = new Map(); // ძებნის წყაროები (uri -> სათაური)
  let st = { emitted: false, reason: "", error: "" };
  const send = text => {
    st.emitted = true;
    res.write("data: " + JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } }) + "\n\n");
  };
  const handle = line => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    try {
      const j = JSON.parse(data);
      if (j.error) { st.error = String(j.error.message || "error").slice(0, 300); return; }
      if (j.promptFeedback && j.promptFeedback.blockReason) st.reason = "BLOCKED_" + j.promptFeedback.blockReason;
      const cand = (j.candidates || [])[0];
      if (!cand) return;
      if (cand.finishReason && cand.finishReason !== "STOP") st.reason = cand.finishReason;
      for (const p of cand.content?.parts || []) if (typeof p.text === "string" && p.text && !p.thought) send(p.text);
      for (const c of cand.groundingMetadata?.groundingChunks || []) {
        const w = c && c.web;
        if (w && typeof w.uri === "string" && /^https?:\/\//.test(w.uri) && !sources.has(w.uri)) {
          sources.set(w.uri, String(w.title || w.uri).slice(0, 120));
        }
      }
    } catch {}
  };
  const pump = async stream => {
    st = { emitted: false, reason: "", error: "" };
    try {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of stream.body) {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        lines.forEach(handle);
      }
      handle(buf);
    } catch {}
  };

  await pump(up);

  // თუ ძებნით პასუხი ცარიელი დაბრუნდა, ავტომატურად ვცადოთ ძებნის გარეშე
  if (!st.emitted && usedSearch && !ctrl.signal.aborted) {
    console.error("ცარიელი პასუხი ძებნით:", st.reason || "-", st.error || "-", "→ ვცდით ძებნის გარეშე");
    try {
      const up2 = await call(false);
      if (up2.ok) await pump(up2);
      else console.error("Gemini (ძებნის გარეშე) შეცდომა", up2.status, await up2.text().catch(() => ""));
    } catch {}
  }

  if (!st.emitted) {
    console.error("ცარიელი პასუხი:", st.reason || "-", st.error || "-");
    let message = "AI-მ ცარიელი პასუხი დააბრუნა. სცადე თავიდან.";
    if (st.reason === "MAX_TOKENS") message = "პასუხი ძალიან გრძელი გამოვიდა და ვერ დასრულდა. სცადე უფრო მოკლე კითხვა.";
    else if (/SAFETY|BLOCK|PROHIBITED|RECITATION|SPII/i.test(st.reason)) message = "ამ კითხვაზე პასუხს ვერ გაგცემ. სცადე სხვაგვარად ჩამოაყალიბე.";
    else if (st.error) message = "AI სერვისმა შეცდომა დააბრუნა. სცადე რამდენიმე წუთში.";
    if (!res.writableEnded) res.write("data: " + JSON.stringify({ type: "error", message }) + "\n\n");
  }

  if (sources.size && st.emitted) {
    const list = [...sources].slice(0, 5).map(([uri, title]) => ({ uri, title }));
    res.write("data: " + JSON.stringify({ type: "sources", sources: list }) + "\n\n");
  }
  res.end();
}

const INDEX = path.join(__dirname, "Index.html");

const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];

  if (req.method === "OPTIONS" && url === "/api/chat") {
    cors(res, req);
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url === "/api/chat") return chat(req, res);

  if (req.method === "GET" && url === "/health") return json(res, 200, { ok: true });

  if (req.method === "GET" && (url === "/" || url === "/Index.html" || url === "/index.html")) {
    fs.readFile(INDEX, (err, data) => {
      if (err) { res.writeHead(500); return res.end("Index.html not found"); }
      // no-cache: ბრაუზერი ყოველთვის უახლეს ვერსიას იღებს განახლების შემდეგ
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log("AI ჩატი გაშვებულია: http://localhost:" + PORT);
  if (!API_KEY) console.warn("გაფრთხილება: GEMINI_API_KEY არ არის დაყენებული.");
});
