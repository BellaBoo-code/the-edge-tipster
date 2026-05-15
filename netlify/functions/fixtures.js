exports.handler = async function(event, context) {
  const FD_TOKEN  = "faf76b5f8a1f40da96253222b4c306a8";
  const ODDS_KEY  = "060c8f90c05190fb13af0cb9551e1ec2";
  const FD_BASE   = "https://api.football-data.org/v4";
  const ODDS_BASE = "https://api.the-odds-api.com/v4";

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  async function fdFetch(path) {
    const r = await fetch(`${FD_BASE}${path}`, { headers: { "X-Auth-Token": FD_TOKEN } });
    if (!r.ok) return null;
    return r.json();
  }

  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

    // ── 1. TODAY'S FIXTURES ──────────────────────────────────────
    const fixturesData = await fdFetch(`/matches?dateFrom=${today}&dateTo=${today}`);
    const matches = (fixturesData?.matches || []).filter(m =>
      m.status === "TIMED" || m.status === "SCHEDULED"
    );
    console.log(`Fixtures: ${matches.length}`);

    // ── 2. LIVE STANDINGS for all competitions in today's matches ──
    const compCodes = [...new Set(matches.map(m => m.competition?.code).filter(Boolean))];
    const standingsMap = {};

    await Promise.allSettled(compCodes.map(async code => {
      const data = await fdFetch(`/competitions/${code}/standings`);
      if (!data) return;
      const table = data.standings?.[0]?.table || [];
      table.forEach(entry => {
        const name = entry.team?.name || "";
        const short = entry.team?.shortName || name;
        standingsMap[name] = standingsMap[short] = {
          position:  entry.position,
          played:    entry.playedGames,
          won:       entry.won,
          drawn:     entry.draw,
          lost:      entry.lost,
          gf:        entry.goalsFor,
          ga:        entry.goalsAgainst,
          gd:        entry.goalDifference,
          points:    entry.points,
          form:      (entry.form || "").split(",").filter(Boolean).slice(-5),
          teamId:    entry.team?.id,
          name:      short || name,
        };
      });
    }));

    console.log(`Standings loaded for ${Object.keys(standingsMap).length / 2} teams`);

    // ── 3. LIVE ODDS ─────────────────────────────────────────────
    let oddsData = [];
    try {
      const oddsRes = await fetch(
        `${ODDS_BASE}/sports/soccer/odds/?apiKey=${ODDS_KEY}&regions=uk,eu&markets=h2h,totals,btts&oddsFormat=decimal&dateFormat=iso`
      );
      if (oddsRes.ok) {
        oddsData = await oddsRes.json();
        console.log(`Odds: ${oddsData.length} events`);
      }
    } catch(e) { console.log("Odds fetch failed:", e.message); }

    // ── 4. MATCH ODDS TO FIXTURES ────────────────────────────────
    function norm(n) {
      return (n||"").toLowerCase()
        .replace(/\b(fc|cf|sc|afc|ac|as|rc|cd|ud|sd|rcd)\b/g,"")
        .replace(/[^a-z0-9]/g,"").trim();
    }

    function findOdds(home, away) {
      const h = norm(home), a = norm(away);
      return oddsData.find(e => {
        const eh = norm(e.home_team||""), ea = norm(e.away_team||"");
        return (eh.includes(h)||h.includes(eh)) && (ea.includes(a)||a.includes(ea));
      });
    }

    function extractOdds(event) {
      if (!event) return {};
      const out = {};
      for (const bm of (event.bookmakers||[])) {
        for (const mkt of (bm.markets||[])) {
          if (mkt.key === "h2h") {
            for (const o of mkt.outcomes||[]) {
              const n = norm(o.name);
              const hNorm = norm(event.home_team);
              const aNorm = norm(event.away_team);
              if (n===hNorm||n==="home") { if(!out.hw||o.price<out.hw) out.hw=parseFloat(o.price.toFixed(2)); }
              else if (n===aNorm||n==="away") { if(!out.aw||o.price<out.aw) out.aw=parseFloat(o.price.toFixed(2)); }
              else if (n==="draw") { if(!out.draw||o.price<out.draw) out.draw=parseFloat(o.price.toFixed(2)); }
            }
          }
          if (mkt.key === "totals") {
            for (const o of mkt.outcomes||[]) {
              const n = (o.name||"").toLowerCase();
              const pt = parseFloat(o.point);
              if (n==="over"  && pt===2.5) out.ov25 = parseFloat(o.price.toFixed(2));
              if (n==="under" && pt===2.5) out.un25 = parseFloat(o.price.toFixed(2));
              if (n==="over"  && pt===1.5) out.ov15 = parseFloat(o.price.toFixed(2));
              if (n==="over"  && pt===3.5) out.ov35 = parseFloat(o.price.toFixed(2));
              if (n==="over"  && pt===4.5) out.ov45 = parseFloat(o.price.toFixed(2));
            }
          }
          if (mkt.key==="btts"||mkt.key==="both_teams_to_score") {
            for (const o of mkt.outcomes||[]) {
              const n = (o.name||"").toLowerCase();
              if (n==="yes") out.bttsY = parseFloat(o.price.toFixed(2));
              if (n==="no")  out.bttsN = parseFloat(o.price.toFixed(2));
            }
          }
        }
        if (out.hw && out.aw) break;
      }
      return out;
    }

    // ── 5. ENRICH FIXTURES WITH STANDINGS + ODDS ────────────────
    const enriched = matches.map(m => {
      const homeName = m.homeTeam?.name || "";
      const awayName = m.awayTeam?.name || "";
      const homeShort = m.homeTeam?.shortName || homeName;
      const awayShort = m.awayTeam?.shortName || awayName;

      const homeStats = standingsMap[homeName] || standingsMap[homeShort] || null;
      const awayStats = standingsMap[awayName] || standingsMap[awayShort] || null;

      const oddsEvent = findOdds(homeName, awayName);
      const liveOdds  = extractOdds(oddsEvent);

      return {
        id:       m.id,
        utcDate:  m.utcDate,
        status:   m.status,
        competition: {
          name: m.competition?.name,
          code: m.competition?.code,
        },
        homeTeam: { name: homeShort || homeName, fullName: homeName, id: m.homeTeam?.id },
        awayTeam: { name: awayShort || awayName, fullName: awayName, id: m.awayTeam?.id },
        homeStats,
        awayStats,
        liveOdds,
        hasOdds: Object.keys(liveOdds).length > 0,
        hasStats: !!(homeStats && awayStats),
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
          withOdds: enriched.filter(m=>m.hasOdds).length,
          withStats: enriched.filter(m=>m.hasStats).length,
          oddsEvents: oddsData.length,
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
