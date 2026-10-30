/**
 * Paper Toolkit — Combined Proxy Worker
 * ==========================================
 * ONE Cloudflare Worker handling FOUR routes:
 * POST /rewrite    -> AI rewrite (via Anthropic Claude)
 * POST /copyscape  -> Web plagiarism check (via Copyscape Premium API)
 * POST /bookqa     -> AI explains an answer found in e-book excerpts (via Anthropic Claude)
 * POST /fetch-url  -> Server-side fetch of a public link for the E-Books tab
 *
 * SETUP (after deploying this to a Worker)
 * -------------------------------------------------
 * Settings -> Variables and Secrets, add:
 * ANTHROPIC_API_KEY = your Anthropic API key (needed for /rewrite and /bookqa)
 * COPYSCAPE_USERNAME = your Copyscape username (needed for /copyscape)
 * COPYSCAPE_API_KEY = your Copyscape API key (needed for /copyscape)
 *
 * NOTE: As of Anthropic API version 2026-10-21, the `temperature`, `top_p`,
 * and `top_k` sampling parameters are no longer accepted for current models
 * like Claude Sonnet 5.5 - any request including them returns a 400 error.
 * This worker intentionally omits them and relies on prompt wording instead.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const CLAUDE_MODEL = "claude-sonnet-5-5";

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function callClaude(env, systemPrompt, userContent, maxTokens) {
  const payload = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens || 4096,
    system: systemPrompt,
    messages: [
      { role: "user", content: userContent },
    ],
  };
  const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });
  const data = await aiResp.json();
  if (data.error) throw new Error(data.error.message || "Claude API error");
  const block = data.content && data.content[0];
  const content = block && block.type === "text" ? block.text.trim() : null;
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
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "Server missing ANTHROPIC_API_KEY. Add it as an encrypted secret in the Worker's settings." }, 500);
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

  const estimatedTokens = Math.min(8192, Math.max(2048, Math.ceil(text.split(/\s+/).length * 1.8)));

  try {
    const rewritten = await callClaude(env, systemPrompt, text, estimatedTokens);
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
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "Server missing ANTHROPIC_API_KEY. Add it as an encrypted secret in the Worker's settings." }, 500);
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
    const answer = await callClaude(env, systemPrompt, userContent, 1024);
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

async function handleFetchUrl(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const rawUrl = body.url;
  if (!rawUrl) return jsonResponse({ error: "Missing url" }, 400);

  let target;
  try {
    target = new URL(rawUrl);
  } catch (e) {
    return jsonResponse({ error: "Invalid URL" }, 400);
  }

  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return jsonResponse({ error: "Only http/https URLs are supported" }, 400);
  }

  try {
    const upstream = await fetch(target.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PaperToolkitBot/1.0)" },
      redirect: "follow",
    });

    if (!upstream.ok) {
      return jsonResponse({ error: "Upstream returned status " + upstream.status }, 502);
    }

    const contentType = upstream.headers.get("content-type") || "";

    if (contentType.includes("pdf")) {
      const buf = await upstream.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      const base64 = btoa(binary);
      return jsonResponse({ type: "pdf", base64: base64 });
    }

    if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
      let title = "";
      const textParts = [];
      let skipDepth = 0;

      const rewriter = new HTMLRewriter()
        .on("title", { text(t) { title += t.text; } })
        .on("script, style, nav, header, footer, noscript", {
          element(el) {
            skipDepth++;
            el.onEndTag(function () { skipDepth = Math.max(0, skipDepth - 1); });
          },
        })
        .on("body *", {
          text(t) { if (skipDepth === 0 && t.text.trim()) textParts.push(t.text); },
        });

      const transformed = rewriter.transform(upstream);
      await transformed.arrayBuffer();

      const fullText = textParts.join(" ").replace(/\s+/g, " ").trim();
      if (!fullText) {
        return jsonResponse({ error: "Could not extract readable text from that page." }, 422);
      }
      return jsonResponse({ type: "text", text: fullText, title: title.trim() });
    }

    if (contentType.includes("text/plain")) {
      const text = await upstream.text();
      return jsonResponse({ type: "text", text: text });
    }

    return jsonResponse({ error: "Unsupported content type: " + contentType }, 415);
  } catch (err) {
    return jsonResponse({ error: "Request to fetch-url failed", detail: String(err) }, 502);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed. POST to /rewrite, /copyscape, /bookqa, or /fetch-url." }, 405);
    }

    const url = new URL(request.url);

    if (url.pathname === "/rewrite") return handleRewrite(request, env);
    if (url.pathname === "/copyscape") return handleCopyscape(request, env);
    if (url.pathname === "/bookqa") return handleBookQA(request, env);
    if (url.pathname === "/fetch-url") return handleFetchUrl(request, env);

    return jsonResponse({ error: "Unknown route. Use POST /rewrite, /copyscape, /bookqa, or /fetch-url." }, 404);
  },
};
