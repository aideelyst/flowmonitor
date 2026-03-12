export default {
  async fetch(request, env) {

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (request.method === "POST") {
      try {
        const raw = await request.text();
        const data = JSON.parse(raw);

        // Format Telegram? → skip, return OK biar tidak error di TradingView
        if (data.chat_id && data.text) {
          return new Response(JSON.stringify({ ok: true, skipped: "telegram_format" }), {
            headers: { ...cors, "Content-Type": "application/json" },
          });
        }

        // Format tidak dikenal → skip juga
        if (!data.forex || !data.time) {
          return new Response(JSON.stringify({ ok: true, skipped: "unknown_format" }), {
            headers: { ...cors, "Content-Type": "application/json" },
          });
        }

        // Format dashboard → simpan
        await env["dashboard-aideelyst"].put("latest", JSON.stringify(data));

        let history = [];
        const existing = await env["dashboard-aideelyst"].get("history");
        if (existing) {
          history = JSON.parse(existing);
        }

        history.push(data);
        if (history.length > 100) {
          history = history.slice(-100);
        }

        await env["dashboard-aideelyst"].put("history", JSON.stringify(history));

        return new Response(JSON.stringify({ ok: true, saved: true }), {
          headers: { ...cors, "Content-Type": "application/json" },
        });

      } catch (e) {
        // Parse error pun return 200 biar TradingView tidak complaint
        return new Response(JSON.stringify({ ok: true, skipped: "parse_error", error: e.message }), {
          headers: { ...cors, "Content-Type": "application/json" },
          status: 200,
        });
      }
    }

    if (request.method === "GET") {
      const url = new URL(request.url);

      if (url.pathname === "/latest") {
        const latest = await env["dashboard-aideelyst"].get("latest");
        if (!latest) {
          return new Response(JSON.stringify({ error: "No data yet" }), {
            headers: { ...cors, "Content-Type": "application/json" },
          });
        }
        return new Response(latest, {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/history") {
        const history = await env["dashboard-aideelyst"].get("history");
        if (!history) {
          return new Response(JSON.stringify([]), {
            headers: { ...cors, "Content-Type": "application/json" },
          });
        }
        return new Response(history, {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ status: "Kael Dashboard Worker running" }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    return new Response("Method not allowed", { status: 405 });
  },
};
