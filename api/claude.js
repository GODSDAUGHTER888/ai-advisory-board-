// api/claude.js
// Vercel serverless function — keeps the API response shape your client expects.

const fetchFn = global.fetch || require('node-fetch');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', // change to your origin if you need credentials
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function safeParseJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function extractTextFromAnthropicResponse(parsed) {
  if (!parsed) return null;

  // Common possible locations (try many, return first found)
  if (parsed.content && Array.isArray(parsed.content) && parsed.content[0] && typeof parsed.content[0].text === 'string') {
    return parsed.content[0].text;
  }
  if (typeof parsed.completion === 'string') return parsed.completion;
  if (typeof parsed.output === 'string') return parsed.output;
  if (parsed.results && parsed.results[0] && parsed.results[0].content && parsed.results[0].content[0] && parsed.results[0].content[0].text) {
    return parsed.results[0].content[0].text;
  }
  if (parsed.choices && parsed.choices[0]) {
    const c = parsed.choices[0];
    if (typeof c.text === 'string') return c.text;
    if (c.message && c.message.content && Array.isArray(c.message.content) && c.message.content[0] && c.message.content[0].text) {
      return c.message.content[0].text;
    }
  }
  // Fallback: stringify a brief version of parsed
  try { return JSON.stringify(parsed).slice(0, 20000); } catch { return null; }
}

async function parseRequestBody(req) {
  if (req.body && Object.keys(req.body).length) return req.body;
  // If body isn't parsed, read raw stream
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (err) { resolve({}); }
    });
    req.on('error', err => reject(err));
  });
}

module.exports = async function (req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  if (req.method !== 'POST') {
    res.writeHead(405, CORS_HEADERS);
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  try {
    const bodyPayload = await parseRequestBody(req);

    // Basic validation (adjust to your client shape)
    if (!bodyPayload.model || (!bodyPayload.messages && !bodyPayload.prompt && !bodyPayload.system)) {
      res.writeHead(400, CORS_HEADERS);
      return res.end(JSON.stringify({ error: 'Missing model or messages/prompt/system in request body' }));
    }

    // Build a tight request proxy (don't forward everything blindly)
    const anthopicReq = {
      model: bodyPayload.model,
      messages: bodyPayload.messages,
      prompt: bodyPayload.prompt,
      system: bodyPayload.system,
      max_tokens: bodyPayload.max_tokens || 1000
    };

    const r = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(anthopicReq)
    });

    const rawText = await r.text();
    const parsed = safeParseJSON(rawText);

    // If not JSON, return a helpful structure so client doesn't try to render HTML
    if (!parsed) {
      res.writeHead(r.ok ? 200 : r.status, CORS_HEADERS);
      return res.end(JSON.stringify({ content: [{ text: rawText.slice(0, 4000) }], raw: rawText }));
    }

    const extracted = extractTextFromAnthropicResponse(parsed) || '';

    // Return normalized shape expected by the client
    const out = {
      ok: r.ok,
      status: r.status,
      content: [{ text: extracted }],
      raw: parsed
    };

    res.writeHead(r.ok ? 200 : r.status, CORS_HEADERS);
    res.end(JSON.stringify(out));
  } catch (err) {
    console.error('api/claude error:', err);
    res.writeHead(500, CORS_HEADERS);
    res.end(JSON.stringify({ error: err?.message || 'Internal error' }));
  }
};
