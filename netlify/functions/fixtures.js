exports.handler = async function(event, context) {
  const RAPID_KEY  = "6bebc9a495msh3e46b1cd76f8643p1ca878jsn73f39e431e93";
  const RAPID_HOST = "sofascore.p.rapidapi.com";
  const RAPID_BASE = "https://sofascore.p.rapidapi.com";
  const ODDS_KEY   = "060c8f90c05190fb13af0cb9551e1ec2";
  const ODDS_BASE  = "https://api.the-odds-api.com/v4";

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  async function sofaGet(path) {
    const r = await fetch(`${RAPID_BASE}${path}`, {
      headers: {
        "x-rapidapi-key": RAPID_KEY,
        "x-rapidapi-host": RAPID_HOST,
        "Content-Type": "application/json",
      }
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Sofascore ${r.status}: ${txt.slice(0,100)}`);
    }
    return r.json();
  }

  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

    // ── 1. FETCH TODAY'S FOOTBALL FIXTURES FROM SOFASCORE ──
    // categoryId=1 is football, returns all tournaments with matches today
    const schedData = await sofaGet(`/tournaments/get-scheduled-events?categoryId=1&date=${today}`);

    // Sofascore returns events grouped by tournament
    const tournaments = schedData?.uniqueTournaments || schedData?.sportItem?.tournaments || schedData?.tournaments || [];

    console.log(`Tournaments with fixtures today: ${tournaments.length}`);

    // Extract all matches from all tournaments
    const allMatches = [];
    for (const t of tournaments) {
      const tName = t.tournament?.name || t.name || "Football";
      const tCategory = t.tournament?.category?.name || t.category?.name || "";
      const events = t.events || t.matches || [];
      for (const e of events) {
        if (e.status?.type === "notstarted") {
          allMatches.push({
            id: e.id,
            home: e.homeTeam?.shortName || e.homeTeam?.name || "Home",
            away: e.awayTeam?.shortName || e.awayTeam?.name || "Away",
            homeFull: e.homeTeam?.name || "",
            awayFull: e.awayTeam?.name || "",
            league: tName,
            country: tCategory,
            kickoff: e.startTimestamp
              ? new Date(e.startTimestamp * 1000).toLocaleTimeString("en-GB", {
                  hour: "2-digit", minute: "2-digit", timeZone: "Europe/London"
                })
              : "TBC",
            ts: e.startTimestamp || 0,
          });
        }
      }
    }

    console.log(`Total fixtures: ${allMatches.length}`);

    // Sort by kickoff time
    allMatches.sort((a, b) => a.ts - b.ts);

    // ── 2. LIVE ODDS ──────────────────────────────────────────────
    let oddsData = [];
    try {
      const oddsRes = await fetch(
        `${ODDS_BASE}/sports/soccer/odds/?apiKey=${ODDS_KEY}&regions=uk,eu&markets=h2h,totals,btts&oddsFormat=decimal&dateFormat=iso`
      );
      if (oddsRes.ok) {
        oddsData = await oddsRes.json();
        console.log(`Odds: ${oddsData.length} events`);
      }
    } catch(e) {
      console.log("Odds fetch failed:", e.message);
    }

    // ── 3. MATCH ODDS TO FIXTURES ─────────────────────────────────
    function norm(n) {
      return (n || "").toLowerCase()
        .replace(/\b(fc|cf|sc|afc|ac|as|rc|cd|ud|sd|rcd)\b/g, "")
        .replace(/[^a-z0-9]/g, "").trim();
    }

    function findOdds(home, away) {
      const h = norm(home), a = norm(away);
      return oddsData.find(e => {
        const eh = norm(e.home_team || ""), ea = norm(e.away_team || "");
        return (eh.includes(h) || h.includes(eh)) && (ea.includes(a) || a.includes(ea));
      });
    }

    function extractOdds(event) {
      if (!event) return {};
      const out = {};
      for (const bm of (event.bookmakers || [])) {
        for (const mkt of (bm.markets || [])) {
          if (mkt.key === "h2h") {
            for (const o of mkt.outcomes || []) {
              const n = norm(o.name);
              const hN = norm(event.home_team);
              const aN = norm(event.away_team);
              if (n === hN || n === "home") { if (!out.hw || o.price < out.hw) out.hw = parseFloat(o.price.toFixed(2)); }
              else if (n === aN || n === "away") { if (!out.aw || o.price < out.aw) out.aw = parseFloat(o.price.toFixed(2)); }
              else if (n === "draw") { if (!out.draw || o.price < out.draw) out.draw = parseFloat(o.price.toFixed(2)); }
            }
          }
          if (mkt.key === "totals") {
            for (const o of mkt.outcomes || []) {
              const n = (o.name || "").toLowerCase();
              const pt = parseFloat(o.point);
              if (n === "over"  && pt === 2.5) out.ov25 = parseFloat(o.price.toFixed(2));
              if (n === "under" && pt === 2.5) out.un25 = parseFloat(o.price.toFixed(2));
              if (n === "over"  && pt === 1.5) out.ov15 = parseFloat(o.price.toFixed(2));
              if (n === "over"  && pt === 3.5) out.ov35 = parseFloat(o.price.toFixed(2));
            }
          }
          if (mkt.key === "btts" || mkt.key === "both_teams_to_score") {
            for (const o of mkt.outcomes || []) {
              const n = (o.name || "").toLowerCase();
              if (n === "yes") out.bttsY = parseFloat(o.price.toFixed(2));
              if (n === "no")  out.bttsN = parseFloat(o.price.toFixed(2));
            }
          }
        }
        if (out.hw && out.aw) break;
      }
      return out;
    }

    // ── 4. ENRICH WITH ODDS ───────────────────────────────────────
    const enriched = allMatches.map(m => {
      const oddsEvent = findOdds(m.homeFull || m.home, m.awayFull || m.away);
      const liveOdds = extractOdds(oddsEvent);
      return {
        ...m,
        liveOdds,
        hasOdds: Object.keys(liveOdds).length > 0,
        homeStats: null,
        awayStats: null,
        hasStats: false,
        utcDate: m.ts ? new Date(m.ts * 1000).toISOString() : new Date().toISOString(),
        homeTeam: { name: m.home },
        awayTeam: { name: m.away },
        competition: { name: m.league, code: "" },
      };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        matches: enriched,
        meta: {
          date: today,
          fixtureCount: enriched.length,
          withOdds: enriched.filter(m => m.hasOdds).length,
          withStats: 0,
          oddsEvents: oddsData.length,
          source: "sofascore",
        }
      }),
    };

  } catch (error) {
    console.error("Handler error:", error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message, matches: [] }),
    };
  }
};
