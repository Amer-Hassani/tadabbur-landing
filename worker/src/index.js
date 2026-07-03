// تدبّر — Cloudflare Worker bridge to the Tafsir MCP server (mcp.tafsir.net)
// Exposes plain JSON endpoints the static Astro site can call from the browser.

const MCP_URL = 'https://mcp.tafsir.net/mcp';
const ALLOWED_ORIGINS = new Set([
  'https://tadabbur.tarteeb.pro',
  'https://amer-hassani.github.io',
  'http://localhost:4321',
]);

// Curated set of tafsir sources shown to visitors (subset of the 28 available).
const DISPLAY_SOURCES = ['tabary', 'katheer', 'baghawy', 'saadi', 'moyassar'];

// Where waitlist notifications are sent, and who the welcome email comes from.
const NOTIFY_TO = 'amer19hs@gmail.com';
const FROM_EMAIL = 'Tadabbur تدبّر <salam@tarteeb.pro>'; // verified domain sender

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://tadabbur.tarteeb.pro';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

// --- Email (Resend) ----------------------------------------------------------

async function sendEmail(apiKey, { to, subject, html, text, replyTo, headers }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(text ? { text } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(headers ? { headers } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Resend ${res.status}: ${detail}`);
  }
  return res.json();
}

// Plain-text alternative for the welcome email (major deliverability signal).
function welcomeEmailText() {
  return [
    'أهلاً بك في رحلة التدبّر',
    '',
    'شكراً لانضمامك إلى قائمة الانتظار. سنخبرك فور إطلاق الإصدار الأول،',
    'وستكون من أوائل من يجرّب المنصة — تفسيرٌ أصيل بقالبٍ حديث،',
    'ليصل المعنى إلى القلب قبل العقل.',
    '',
    '— فريق تدبّر',
    '',
    '----------------------------------------',
    '',
    'Welcome to Tadabbur',
    '',
    'Thank you for joining the waitlist. We will let you know the moment',
    'the first release launches, and you will be among the first to try it —',
    'authentic tafsir in a modern form, so meaning reaches the heart before the mind.',
    '',
    '— The Tadabbur team',
    '',
    'tadabbur.tarteeb.pro',
  ].join('\n');
}

function welcomeEmailHtml() {
  // Bilingual welcome — Arabic first (RTL), then English.
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#23302a;">
    <div style="background:linear-gradient(140deg,#1f6f52,#17553f);padding:32px 28px;border-radius:16px 16px 0 0;text-align:center;">
      <div style="font-size:34px;color:#e0b354;font-family:Amiri,serif;font-weight:700;">تدبّر</div>
    </div>
    <div style="background:#fffdf7;padding:28px;border:1px solid #e2d7bf;border-top:none;border-radius:0 0 16px 16px;">
      <div dir="rtl" style="text-align:right;line-height:1.9;">
        <h2 style="color:#17553f;margin:0 0 12px;">أهلاً بك في رحلة التدبّر 🌿</h2>
        <p style="color:#4a4638;margin:0 0 14px;">
          شكراً لانضمامك إلى قائمة الانتظار. سنخبرك فور إطلاق الإصدار الأول،
          وستكون من أوائل من يجرّب المنصة — تفسيرٌ أصيل بقالبٍ حديث، ليصل المعنى
          إلى القلب قبل العقل.
        </p>
        <p style="color:#6b6455;margin:0;">— فريق تدبّر</p>
      </div>
      <hr style="border:none;border-top:1px solid #e2d7bf;margin:22px 0;" />
      <div dir="ltr" style="text-align:left;line-height:1.7;">
        <h2 style="color:#17553f;margin:0 0 12px;">Welcome to Tadabbur 🌿</h2>
        <p style="color:#4a4638;margin:0 0 14px;">
          Thank you for joining the waitlist. We'll let you know the moment the
          first release launches, and you'll be among the first to try it —
          authentic tafsir in a modern form, so meaning reaches the heart before
          the mind.
        </p>
        <p style="color:#6b6455;margin:0;">— The Tadabbur team</p>
      </div>
    </div>
  </div>`;
}

async function handleSubscribe(request, env, origin) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    return json({ error: 'email service not configured' }, origin, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid body' }, origin, 400);
  }

  const email = (body.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'invalid email' }, origin, 400);
  }

  // 1) Welcome email to the registrant (bilingual, with plain-text alternative,
  //    a real reply-to, and a List-Unsubscribe header — all improve inbox placement).
  await sendEmail(apiKey, {
    to: email,
    subject: 'أهلاً بك في تدبّر · Welcome to Tadabbur',
    html: welcomeEmailHtml(),
    text: welcomeEmailText(),
    replyTo: 'salam@tarteeb.pro',
    headers: {
      'List-Unsubscribe': '<mailto:salam@tarteeb.pro?subject=unsubscribe>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });

  // 2) Notification to the site owner. Failure here shouldn't fail the request
  //    for the visitor, since their welcome already went out.
  try {
    await sendEmail(apiKey, {
      to: NOTIFY_TO,
      replyTo: email,
      subject: `تسجيل جديد في قائمة الانتظار: ${email}`,
      html: `<p>New waitlist signup:</p><p><strong>${email}</strong></p>`,
    });
  } catch (e) {
    // swallow; owner notification is best-effort
  }

  return json({ ok: true }, origin);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    try {
      if (url.pathname === '/api/subscribe' && request.method === 'POST') {
        return await handleSubscribe(request, env, origin);
      }

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
