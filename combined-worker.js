/**
 * Paper Toolkit — Combined Proxy Worker
 * ==========================================
 * ONE Cloudflare Worker handling BOTH:
 *   POST /rewrite    -> AI rewrite (via OpenAI)
 *   POST /copyscape  -> Web plagiarism check (via Copyscape Premium API)
 *
 * SETUP (after deploying this to a Worker)
 * -------------------------------------------------
 * Settings -> Variables and Secrets, add:
 *   OPENAI_API_KEY       = your OpenAI API key       (needed for /rewrite)
 *   COPYSCAPE_USERNAME    = your Copyscape username   (needed for /copyscape)
 *   COPYSCAPE_API_KEY     = your Copyscape API key    (needed for /copyscape)
 *
 * You can add just OPENAI_API_KEY now and skip Copyscape until later.
 * Then copy this Worker's URL and paste it into the app's Setup tab.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function handleRewrite(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const text = (body.text || "").slice(0, 20000);
  const targetWordCount = body.targetWordCount || null;

  if (!text.trim()) return jsonResponse({ error: "No text provided" }, 400);
  if (!env.OPENAI_API_KEY) {
    return jsonResponse({ error: "Server missing OPENAI_API_KEY. Add it as an encrypted secret in the Worker's settings." }, 500);
  }

  const wordInstruction = targetWordCount
    ? "Match the original word count as closely as possible (target: approximately " + targetWordCount + " words, within 10%)."
    : "Keep the total length roughly similar to the original.";

  const systemPrompt = "You are an experienced academic writer helping a graduate student genuinely restructure their own previously written paper for reuse in a new Master's-level course. The professors reading this are experienced academic readers, so the writing quality and authenticity of voice matter as much as the restructuring itself.\n\n" +
    "STRUCTURE AND ORIGINALITY\n" +
    "- Reorganize the order of points, paragraphs, or arguments where it improves flow — do not simply keep identical sentence order.\n" +
    "- Vary sentence structure, length, and construction substantially. Do NOT perform a light word-for-word synonym swap.\n" +
    "- Express the same underlying ideas, arguments, and evidence using fresh phrasing, different sentence openings, and restructured paragraphs.\n" +
    "- Preserve the same topic, thesis, argument, and overall academic focus and factual content.\n" +
    "- Keep any direct quotations and their citations EXACTLY as originally written, in quotation marks, unchanged.\n" +
    "- Keep all factual claims, data, and citations accurate — do not invent, remove, or alter substantive content or sources.\n" +
    "- " + wordInstruction + "\n\n" +
    "VOICE AND READABILITY — HIGHEST PRIORITY\n" +
    "- Study the original text's voice: its vocabulary level, typical sentence rhythm, tone, and any recurring phrasing habits unique to this writer. Reproduce that same voice — it must sound like the same person wrote it, not a different author or a generic AI assistant.\n" +
    "- Prioritize smooth, logical paragraph-to-paragraph flow with natural transitions rather than formulaic connectors.\n" +
    "- Avoid common AI writing tells: do not overuse words like 'delve,' 'underscore,' 'furthermore,' 'in conclusion,' 'it is important to note,' or 'leverage'; avoid repetitive sentence openers; avoid excessive hedging or robotic uniform sentence lengths.\n" +
    "- Write at the register appropriate for a Master's-level academic audience: precise, substantive, and confident, without sounding stiff or artificially polished.\n" +
    "- The final result should read as though the original author simply wrote a better second draft of their own paper.\n" +
    "- Output ONLY the rewritten paper text. No preamble, no explanation, no notes, no markdown formatting.";

  const payload = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
    temperature: 0.85,
  };

  try {
    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + env.OPENAI_API_KEY,
      },
      body: JSON.stringify(payload),
    });
    const data = await aiResp.json();
    if (data.error) return jsonResponse({ error: data.error.message || "OpenAI API error" }, 502);
    const rewritten = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
      ? data.choices[0].message.content.trim() : null;
    if (!rewritten) return jsonResponse({ error: "No content returned from model" }, 502);
    return jsonResponse({ rewritten });
  } catch (err) {
    return jsonResponse({ error: "Request to AI provider failed", detail: String(err) }, 502);
  }
}

async function handleCopyscape(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const text = (body.text || "").slice(0, 10000);
  if (!text.trim()) return jsonResponse({ error: "No text provided" }, 400);

  if (!env.COPYSCAPE_USERNAME || !env.COPYSCAPE_API_KEY) {
    return jsonResponse({ error: "Server missing Copyscape credentials. Add COPYSCAPE_USERNAME and COPYSCAPE_API_KEY as encrypted secrets." }, 500);
  }

  const params = new URLSearchParams({
    u: env.COPYSCAPE_USERNAME,
    k: env.COPYSCAPE_API_KEY,
    o: "csearch",
    c: "1",
    e: "UTF-8",
    f: "json",
    t: text,
  });

  try {
    const csResp = await fetch("https://www.copyscape.com/api/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const raw = await csResp.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return jsonResponse({ error: "Unexpected response from Copyscape", raw }, 502);
    }
    return jsonResponse(data);
  } catch (err) {
    return jsonResponse({ error: "Request to Copyscape failed", detail: String(err) }, 502);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed. POST to /rewrite or /copyscape." }, 405);
    }

    const url = new URL(request.url);

    if (url.pathname === "/rewrite") return handleRewrite(request, env);
    if (url.pathname === "/copyscape") return handleCopyscape(request, env);

    return jsonResponse({ error: "Unknown route. Use POST /rewrite or POST /copyscape." }, 404);
  },
};
