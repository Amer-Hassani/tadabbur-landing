// تدبّر — Cloudflare Worker bridge to the Tafsir MCP server (mcp.tafsir.net)
// Exposes plain JSON endpoints the static Astro site can call from the browser.

const MCP_URL = 'https://mcp.tafsir.net/mcp';
const ALLOWED_ORIGINS = new Set([
  'https://amer-hassani.github.io',
  'http://localhost:4321',
]);

// Curated set of tafsir sources shown to visitors (subset of the 28 available).
const DISPLAY_SOURCES = ['tabary', 'katheer', 'baghawy', 'saadi', 'moyassar'];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://amer-hassani.github.io';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, origin, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin),
      ...extraHeaders,
    },
  });
}

// --- MCP session handling -------------------------------------------------
// The MCP server is stateful: initialize() returns a session id that must be
// sent on every subsequent call. We keep the session id in a KV-free module
// cache (fine for a low-traffic function; a cold start just re-initializes).

let cachedSessionId = null;

async function mcpInitialize() {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'tadabbur-web', version: '1.0' },
      },
    }),
  });
  const sessionId = res.headers.get('mcp-session-id');
  // Drain the body (required by some MCP transports before the session is usable).
  await res.text();
  if (!sessionId) throw new Error('MCP initialize did not return a session id');
  return sessionId;
}

function parseSseJson(rawText) {
  // Responses arrive as text/event-stream: "event: message\ndata: {...}\n\n"
  const line = rawText.split('\n').find((l) => l.startsWith('data:'));
  if (!line) throw new Error('No data line in MCP response');
  return JSON.parse(line.slice(5).trim());
}

async function mcpCall(method, params, retried = false) {
  if (!cachedSessionId) cachedSessionId = await mcpInitialize();

  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-session-id': cachedSessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }),
  });

  if (res.status === 404 && !retried) {
    // Session expired server-side; re-initialize once and retry.
    cachedSessionId = null;
    return mcpCall(method, params, true);
  }

  const raw = await res.text();
  const payload = parseSseJson(raw);
  if (payload.error) throw new Error(payload.error.message || 'MCP error');
  return payload.result;
}

async function callTool(name, args) {
  const result = await mcpCall('tools/call', { name, arguments: args });
  const textBlock = result?.content?.find((c) => c.type === 'text');
  if (!textBlock) throw new Error('MCP tool returned no text content');
  return JSON.parse(textBlock.text);
}

async function readResource(uri) {
  const result = await mcpCall('resources/read', { uri });
  const entry = result?.contents?.[0];
  if (!entry) throw new Error('MCP resource returned no content');
  return JSON.parse(entry.text);
}

// --- Simple in-memory cache (per Worker instance) --------------------------

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { value, at: Date.now() });
  return value;
}

// --- Route handlers ----------------------------------------------------------

async function handleSurahs() {
  return cached('surahs', 24 * 60 * 60 * 1000, () => readResource('quran://surahs'));
}

async function handleAyah(surah, ayah) {
  return cached(`ayah:${surah}:${ayah}`, 24 * 60 * 60 * 1000, () =>
    callTool('fetch_ayah', { surah, ayah })
  );
}

async function handleTafsir(surah, ayah) {
  return cached(`tafsir:${surah}:${ayah}`, 24 * 60 * 60 * 1000, () =>
    callTool('fetch_tafsir', { surah, ayah, sources: DISPLAY_SOURCES })
  );
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    try {
      if (url.pathname === '/api/surahs') {
        return json(await handleSurahs(), origin);
      }

      if (url.pathname === '/api/verse') {
        const surah = Number(url.searchParams.get('surah'));
        const ayah = Number(url.searchParams.get('ayah'));
        if (!surah || !ayah || surah < 1 || surah > 114 || ayah < 1) {
          return json({ error: 'رقم السورة أو الآية غير صحيح' }, origin, 400);
        }
        const [ayahData, tafsirData] = await Promise.all([
          handleAyah(surah, ayah),
          handleTafsir(surah, ayah),
        ]);
        return json(
          {
            surah,
            ayah,
            text: ayahData.text_uthmani || ayahData.text,
            tafsirs: tafsirData.tafsirs.map((t) => ({
              source: t.source,
              attribution: t.attribution,
              text: t.text_clean || t.text,
            })),
          },
          origin
        );
      }

      return json({ error: 'not found' }, origin, 404);
    } catch (err) {
      return json({ error: 'تعذّر الوصول إلى خادم التفسير، حاول مرة أخرى', detail: String(err) }, origin, 502);
    }
  },
};
