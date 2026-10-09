/**
 * Paper Toolkit — Combined Proxy Worker
 * ==========================================
 * ONE Cloudflare Worker handling THREE routes:
 *   POST /rewrite    -> AI rewrite (via OpenAI)
 *   POST /copyscape  -> Web plagiarism check (via Copyscape Premium API)
 *   POST /bookqa     -> AI explains an answer found in e-book excerpts (via OpenAI)
 *
 * SETUP (after deploying this to a Worker)
 * -------------------------------------------------
 * Settings -> Variables and Secrets, add:
 *   OPENAI_API_KEY       = your OpenAI API key       (needed for /rewrite and /bookqa)
 *   COPYSCAPE_USERNAME    = your Copyscape username   (needed for /copyscape)
 *   COPYSCAPE_API_KEY     = your Copyscape API key    (needed for /copyscape)
 *
 * You can add just OPENAI_API_KEY now and skip Copyscape until later.
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

async function callOpenAI(env, systemPrompt, userContent, temperature) {
  const payload = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: temperature,
  };
  const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.OPENAI_API_KEY,
    },
    body: JSON.stringify(payload),
  });
  const data = await aiResp.json();
  if (data.error) throw new Error(data.error.message || "OpenAI API error");
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
    ? data.choices[0].message.content.trim() : null;
  if (!content) throw new Error("No content returned from model");
  return content;
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

  try {
    const rewritten = await callOpenAI(env, systemPrompt, text, 0.85);
    return jsonResponse({ rewritten });
  } catch (err) {
    return jsonResponse({ error: String(err.message || err) }, 502);
  }
}

async function handleBookQA(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const question = (body.question || "").slice(0, 1000);
  const excerpts = Array.isArray(body.excerpts) ? body.excerpts.slice(0, 5) : [];

  if (!question.trim()) return jsonResponse({ error: "No question provided" }, 400);
  if (!excerpts.length) return jsonResponse({ error: "No excerpts provided" }, 400);
  if (!env.OPENAI_API_KEY) {
    return jsonResponse({ error: "Server missing OPENAI_API_KEY. Add it as an encrypted secret in the Worker's settings." }, 500);
  }

  const systemPrompt = "You are a patient, knowledgeable study tutor helping a graduate student (a U.S. Navy service member working toward a Master's in Healthcare Administration) understand their textbook. " +
    "You will be given several excerpts from the book, each labeled with its location (a page or chapter number), and a question. " +
    "Your job:\n" +
    "1. Find the information in the provided excerpts that answers the question. Use ONLY the provided excerpts — do not use outside knowledge or invent information not present in them.\n" +
    "2. Write a clear, friendly, conversational explanation that both teaches the underlying concept AND directly answers the specific question asked. Avoid dry textbook phrasing; explain it the way a good tutor would, in plain language.\n" +
    "3. If the excerpts genuinely do not contain the answer, say so honestly instead of guessing or making something up.\n" +
    "4. Do not repeat the raw excerpt text verbatim at length — synthesize and explain it in your own words, quoting only brief key phrases if truly helpful.\n" +
    "5. Keep the answer focused and reasonably concise (a few short paragraphs at most).\n" +
    "Output ONLY the explanation itself. No preamble like 'Based on the excerpts' and no restating the question.";

  const userContent = "QUESTION: " + question + "\n\n" +
    excerpts.map(function (e, i) {
      return "EXCERPT " + (i + 1) + " (" + e.location + "):\n" + e.text;
    }).join("\n\n---\n\n");

  try {
    const answer = await callOpenAI(env, systemPrompt, userContent, 0.4);
    return jsonResponse({ answer });
  } catch (err) {
    return jsonResponse({ error: String(err.message || err) }, 502);
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
      return jsonResponse({ error: "Method not allowed. POST to /rewrite, /copyscape, or /bookqa." }, 405);
    }

    const url = new URL(request.url);

    if (url.pathname === "/rewrite") return handleRewrite(request, env);
    if (url.pathname === "/copyscape") return handleCopyscape(request, env);
    if (url.pathname === "/bookqa") return handleBookQA(request, env);

    return jsonResponse({ error: "Unknown route. Use POST /rewrite, /copyscape, or /bookqa." }, 404);
  },
};
