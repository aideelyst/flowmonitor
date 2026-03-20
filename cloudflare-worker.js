// ═══════════════════════════════════════════════════════════
// Flow Monitor · Worker (with Auth + Ably Realtime)
// ═══════════════════════════════════════════════════════════
// ENV SECRETS (set in Cloudflare dashboard):
//   API_KEY       — protects POST /fm (set same key in TV alert header)
//   ADMIN_KEY     — protects /admin/* endpoints
//   TG_TOKEN      — Telegram Bot token
//   TG_CHAT       — Telegram Chat ID
//   ABLY_API_KEY  — Ably full API key, e.g. xxx.yyy:zzz
//
// ENV VARS:
//   STREAK_TH     — streak threshold (default 5)
//
// KV NAMESPACE binding: FM
//
// KV KEYS:
//   fm:latest       — latest top N snapshot
//   fm:streaks      — streak counters per pair
//   fm:history      — last 50 snapshots
//   token:{token}   — user data { email, created, expires, devices[], maxDevices }
//
// ACCEPTED PAYLOAD KEYS:
//   "pairs" (Forex) | "items" (Commodity) | "coins" (Crypto) | "inst" (Indices)
// ═══════════════════════════════════════════════════════════

// Normalize payload — accept any asset key, output unified "entries"
// Aliases: "indices" → "inst"
// Entry normalization: { c: "BTC", r: 0.5 } → { p: "BTC", r: 0.5 }
function normalizePayload(data) {
  // Key aliases
  const ALIAS = { indices: "inst" };
  const KEYS = ["pairs", "items", "coins", "inst", "indices"];
  for (const k of KEYS) {
    if (data[k] && Array.isArray(data[k])) {
      const canonical = ALIAS[k] || k;
      // Normalize entries: ensure every entry has .p (not .c or other)
      const entries = data[k].map(e => {
        if (e.p) return e;
        if (e.c) return { p: e.c, r: e.r };
        if (e.n) return { p: e.n, r: e.r };
        return e;
      });
      return { key: canonical, entries };
    }
  }
  return null;
}

// Asset class label for Telegram
function assetLabel(key) {
  return { pairs: "Forex", items: "Commodity", coins: "Crypto", inst: "Indices" }[key] || "Unknown";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── CORS preflight ──
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders()
      });
    }

    // ═════════════════════════════════════════════════════════
    // POST /fm — TradingView webhook (protected by API_KEY)
    // ═════════════════════════════════════════════════════════
    if (request.method === "POST" && url.pathname === "/fm") {
      if (url.searchParams.get("key") !== env.API_KEY) {
        return json({ error: "unauthorized" }, 401);
      }

      try {
        const data = await request.json();
        const norm = normalizePayload(data);
        if (!norm) {
          return json({ error: "invalid payload — expected pairs|items|coins|inst|indices" }, 400);
        }

        const { key, entries } = norm;
        const asset = assetLabel(key);

        // Build normalized payload for storage (always use .p key)
        const normalized = { t: data.t, [key]: entries };

        // KV prefix per asset class
        const pfx = `fm:${key}`;

        // 1. Store latest
        await env.FM.put(`${pfx}:latest`, JSON.stringify(normalized));

        // 2. History (keep last 50)
        let history = [];
        try {
          const raw = await env.FM.get(`${pfx}:history`);
          if (raw) history = JSON.parse(raw);
        } catch (e) {}
        history.push(normalized);
        if (history.length > 50) history = history.slice(-50);
        await env.FM.put(`${pfx}:history`, JSON.stringify(history));

        // 3. Streak tracking
        const th = parseInt(env.STREAK_TH || "5", 10);
        let streaks = {};
        try {
          const raw = await env.FM.get(`${pfx}:streaks`);
          if (raw) streaks = JSON.parse(raw);
        } catch (e) {}

        const sorted = [...entries].sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
        const topNames = sorted.slice(0, 5).map(p => p.p);
        const allItems = new Set([...Object.keys(streaks), ...topNames]);
        const fired = [];

        for (const item of allItems) {
          if (topNames.includes(item)) {
            streaks[item] = (streaks[item] || 0) + 1;
            if (streaks[item] === th) {
              const itemData = entries.find(p => p.p === item);
              fired.push({ pair: item, roc: itemData ? itemData.r : 0, streak: th });
            }
          } else {
            delete streaks[item];
          }
        }

        await env.FM.put(`${pfx}:streaks`, JSON.stringify(streaks));

        if (fired.length > 0) {
          await sendTelegram(env, data.t, fired, asset);
        }

        // 4. Publish realtime update to Ably
        await publishToAbly(env, {
          asset: key,
          latest: normalized,
          streaks,
          fired
        });

        return json({ ok: true, asset, streaks, fired: fired.length });
      } catch (e) {
        return json({ error: e.message || "internal error" }, 500);
      }
    }

    // ═════════════════════════════════════════════════════════
    // GET /fm — Dashboard data (protected by user token)
    //   ?asset=pairs|items|coins|inst (default: pairs)
    // ═════════════════════════════════════════════════════════
    if (request.method === "GET" && url.pathname === "/fm") {
      const auth = await verifyToken(url, request, env);
      if (!auth.ok) return json({ error: auth.error }, 401);

      const asset = url.searchParams.get("asset") || "pairs";
      const pfx = `fm:${asset}`;

      const latest = await env.FM.get(`${pfx}:latest`);
      const streaks = await env.FM.get(`${pfx}:streaks`);

      return json({
        asset,
        latest: latest ? JSON.parse(latest) : null,
        streaks: streaks ? JSON.parse(streaks) : {}
      });
    }

    // ═════════════════════════════════════════════════════════
    // GET /fm/history — Dashboard history (protected)
    //   ?asset=pairs|items|coins|inst (default: pairs)
    // ═════════════════════════════════════════════════════════
    if (request.method === "GET" && url.pathname === "/fm/history") {
      const auth = await verifyToken(url, request, env);
      if (!auth.ok) return json({ error: auth.error }, 401);

      const asset = url.searchParams.get("asset") || "pairs";
      const pfx = `fm:${asset}`;

      const history = await env.FM.get(`${pfx}:history`);
      return json(history ? JSON.parse(history) : []);
    }

    // ═════════════════════════════════════════════════════════
    // GET /fm/all — All asset classes at once (protected)
    // ═════════════════════════════════════════════════════════
    if (request.method === "GET" && url.pathname === "/fm/all") {
      const auth = await verifyToken(url, request, env);
      if (!auth.ok) return json({ error: auth.error }, 401);

      const keys = ["pairs", "items", "coins", "inst"];
      const result = {};

      for (const k of keys) {
        const pfx = `fm:${k}`;
        const latest = await env.FM.get(`${pfx}:latest`);
        const streaks = await env.FM.get(`${pfx}:streaks`);
        result[k] = {
          label: assetLabel(k),
          latest: latest ? JSON.parse(latest) : null,
          streaks: streaks ? JSON.parse(streaks) : {}
        };
      }

      return json(result);
    }

    // ═════════════════════════════════════════════════════════
    // GET /verify — Check if token is valid (for dashboard login)
    //   ?token=xxx&device=yyy
    // ═════════════════════════════════════════════════════════
    if (request.method === "GET" && url.pathname === "/verify") {
      const auth = await verifyToken(url, request, env);
      return json({
        valid: auth.ok,
        email: auth.email || null,
        devices: auth.devices || 0,
        maxDevices: auth.maxDevices || 0,
        error: auth.error || null
      });
    }

    // ═════════════════════════════════════════════════════════
    // GET /ably/token — Frontend gets short-lived Ably token
    // ═════════════════════════════════════════════════════════
    if (request.method === "GET" && url.pathname === "/ably/token") {
      const auth = await verifyToken(url, request, env);
      if (!auth.ok) return json({ error: auth.error }, 401);

      try {
        const fullKey = env.ABLY_API_KEY;
        if (!fullKey) return json({ error: "ABLY_API_KEY missing" }, 500);

        const keyName = fullKey.split(":")[0];

        const ablyRes = await fetch(
          `https://main.realtime.ably.net/keys/${encodeURIComponent(keyName)}/requestToken`,
          {
            method: "POST",
            headers: {
              "Authorization": `Basic ${btoa(fullKey)}`,
              "Content-Type": "application/json",
              "Accept": "application/json"
            },
            body: JSON.stringify({
              keyName,
              ttl: 60 * 60 * 1000,
              capability: JSON.stringify({
                "flow-monitor": ["subscribe"]
              })
            })
          }
        );

        return new Response(await ablyRes.text(), {
          status: ablyRes.status,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders()
          }
        });
      } catch (e) {
        return json({ error: e.message || "ably token error" }, 500);
      }
    }

    // ═════════════════════════════════════════════════════════
    // ADMIN ENDPOINTS (protected by ADMIN_KEY)
    // ═════════════════════════════════════════════════════════

    // ── POST /admin/token — Create user token ──
    // Body: { "email": "user@email.com", "days": 30, "maxDevices": 2 }
    if (request.method === "POST" && url.pathname === "/admin/token") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);

      try {
        const body = await request.json();
        const email = body.email;
        const days = body.days || 30;
        const maxDevices = body.maxDevices || 2;

        if (!email) return json({ error: "email required" }, 400);

        const token = generateToken();
        const expires = Date.now() + days * 86400000;

        await env.FM.put(`token:${token}`, JSON.stringify({
          email,
          created: Date.now(),
          expires,
          devices: [],
          maxDevices
        }));

        return json({ token, email, expires: new Date(expires).toISOString(), maxDevices });
      } catch (e) {
        return json({ error: e.message || "internal error" }, 500);
      }
    }

    // ── DELETE /admin/token — Revoke token ──
    // Body: { "token": "abc123..." }
    if (request.method === "DELETE" && url.pathname === "/admin/token") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);

      try {
        const { token } = await request.json();
        if (!token) return json({ error: "token required" }, 400);
        await env.FM.delete(`token:${token}`);
        return json({ ok: true, revoked: token });
      } catch (e) {
        return json({ error: e.message || "internal error" }, 500);
      }
    }

    // ── GET /admin/tokens — List all tokens ──
    if (request.method === "GET" && url.pathname === "/admin/tokens") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);

      const list = await env.FM.list({ prefix: "token:" });
      const tokens = [];

      for (const key of list.keys) {
        const raw = await env.FM.get(key.name);
        if (raw) {
          const data = JSON.parse(raw);
          tokens.push({
            token: key.name.replace("token:", ""),
            ...data,
            active: data.expires > Date.now()
          });
        }
      }

      return json(tokens);
    }

    // ── POST /admin/token/reset-devices — Clear device list for a token ──
    // Body: { "token": "abc123..." }
    if (request.method === "POST" && url.pathname === "/admin/token/reset-devices") {
      if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);

      try {
        const body = await request.json();
        const token = body.token;
        if (!token) return json({ error: "token required" }, 400);

        const raw = await env.FM.get(`token:${token}`);
        if (!raw) return json({ error: "token not found" }, 404);

        const data = JSON.parse(raw);
        data.devices = [];
        await env.FM.put(`token:${token}`, JSON.stringify(data));

        return json({ ok: true, token, devicesCleared: true });
      } catch (e) {
        return json({ error: e.message || "internal error" }, 500);
      }
    }

    return json({ error: "not found" }, 404);
  }
};

// ═══════════════════════════════════════════════════════════
// AUTH — with device tracking
// ═══════════════════════════════════════════════════════════

async function verifyToken(url, request, env) {
  const token = url.searchParams.get("token")
    || (request.headers.get("Authorization") || "").replace("Bearer ", "");
  const deviceId = url.searchParams.get("device") || null;

  if (!token) return { ok: false, error: "token required" };

  const raw = await env.FM.get(`token:${token}`);
  if (!raw) return { ok: false, error: "invalid token" };

  const data = JSON.parse(raw);

  // Check expiry
  if (data.expires < Date.now()) {
    return { ok: false, error: "token expired" };
  }

  // ── Device tracking ──
  // Backward-compatible: old tokens tanpa devices[] tetap jalan
  if (deviceId && Array.isArray(data.devices)) {
    const maxDev = data.maxDevices || 2;
    const alreadyRegistered = data.devices.includes(deviceId);

    if (!alreadyRegistered) {
      if (data.devices.length >= maxDev) {
        // Slot penuh, device baru → tolak
        return {
          ok: false,
          error: "device limit reached",
          maxDevices: maxDev,
          devices: data.devices.length
        };
      }

      // Register device baru
      data.devices.push(deviceId);
      await env.FM.put(`token:${token}`, JSON.stringify(data));
    }
  }

  return {
    ok: true,
    email: data.email,
    devices: data.devices ? data.devices.length : 0,
    maxDevices: data.maxDevices || 0
  };
}

function checkAdmin(request, env) {
  return request.headers.get("Authorization") === `Bearer ${env.ADMIN_KEY}`;
}

function generateToken() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const segments = [];
  for (let s = 0; s < 4; s++) {
    let seg = "";
    for (let i = 0; i < 8; i++) {
      seg += chars[Math.floor(Math.random() * chars.length)];
    }
    segments.push(seg);
  }
  return segments.join("-");
}

// ═══════════════════════════════════════════════════════════
// TELEGRAM
// ═══════════════════════════════════════════════════════════

async function sendTelegram(env, timestamp, fired, asset) {
  const token = env.TG_TOKEN;
  const chat  = env.TG_CHAT;
  if (!token || !chat) return;

  const d = new Date(timestamp);
  const timeStr = d.toLocaleString("en-GB", {
    timeZone: "Asia/Jakarta",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });

  let lines = `<b>FM Sustained Momentum · ${asset}</b>\n${timeStr} WIB\n\n`;
  for (const f of fired) {
    const arrow = f.roc > 0 ? "▲" : "▼";
    const roc = f.roc > 0 ? `+${f.roc}` : `${f.roc}`;
    lines += `${arrow} <b>${f.pair}</b> · ${f.streak}x Top 5 · ${roc}%\n`;
  }

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      text: lines.trim(),
      parse_mode: "HTML"
    })
  });
}

// ═══════════════════════════════════════════════════════════
// ABLY
// ═══════════════════════════════════════════════════════════

async function publishToAbly(env, payload) {
  const fullKey = env.ABLY_API_KEY;
  if (!fullKey) return;

  const res = await fetch("https://main.realtime.ably.net/channels/flow-monitor/messages", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(fullKey)}`,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({
      name: "snapshot",
      data: payload
    })
  });

  if (!res.ok) {
    console.log("Ably publish failed:", res.status, await res.text());
  }
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
}
