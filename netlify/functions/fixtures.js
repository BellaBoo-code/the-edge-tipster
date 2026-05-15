exports.handler = async function(event, context) {
  const RAPID_KEY  = "6bebc9a495msh3e46b1cd76f8643p1ca878jsn73f39e431e93";
  const RAPID_HOST = "sofascore.p.rapidapi.com";
  const RAPID_BASE = "https://sofascore.p.rapidapi.com";
  const FD_TOKEN   = "faf76b5f8a1f40da96253222b4c306a8";
  const FD_BASE    = "https://api.football-data.org/v4";
  const ODDS_KEY   = "053907056f68e2408aa33038cc56be7c";
  const ODDS_BASE  = "https://api.the-odds-api.com/v4";

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const ALLOWED_LEAGUES = [
    "premier league", "championship", "league one", "league two",
    "scottish premiership", "eredivisie", "la liga", "laliga",
    "serie a", "ligue 1", "bundesliga", "mls", "major league soccer",
    "champions league", "europa league", "conference league",
    "world cup", "fifa world cup", "european championship", "uefa euro",
    "playoffs", "relegation",
  ];

  function isAllowed(leagueName) {
    const n = (leagueName || "").toLowerCase();
    return ALLOWED_LEAGUES.some(x => n.includes(x));
  }

  const FD_COMPS = ["PL","ELC","PD","BL1","SA","FL1","DED","PPL","CL","EL","ECL"];

  async function fdGet(path) {
    const r = await fetch(`${FD_BASE}${path}`, {
      headers: { "X-Auth-Token": FD_TOKEN }
    });
    if (!r.ok) return null;
    return r.json();
  }

  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
    const debug = { today, steps: [] };

    // ── 1. TRY FOOTBALL-DATA.ORG FOR FIXTURES DIRECTLY ───────────
    // This avoids Sofascore entirely and uses what we know works
    const fdFixtures = await fdGet(`/matches?dateFrom=${today}&dateTo=${today}`);
    const fdMatches = (fdFixtures?.matches || []).filter(m =>
      m.status === "TIMED" || m.status === "SCHEDULED"
    );
    debug.steps.push(`football-data fixtures: ${fdMatches.length}`);

    // ── 2. TRY SOFASCORE FOR TODAY ────────────────────────────────
    let sofaMatches = [];
    try {
      const sofaRes = await fetch(
        `${RAPID_BASE}/tournaments/get-scheduled-events?categoryId=1&date=${today}`,
        {
          headers: {
            "x-rapidapi-key": RAPID_KEY,
            "x-rapidapi-host": RAPID_HOST,
          }
        }
      );
      const sofaData = await sofaRes.json();
      const events = sofaData?.events || [];
      debug.steps.push(`sofascore status: ${sofaRes.status}, events: ${events.length}`);
      sofaMatches = events.filter(e => {
        if (e.status?.type !== "notstarted") return false;
        const ts = e.startTimestamp || 0;
        if (ts) {
          const d = new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
          if (d !== today) return false;
        }
        return isAllowed(e.tournament?.name || "");
      });
      debug.steps.push(`sofascore filtered: ${sofaMatches.length}`);
    } catch(e) {
      debug.steps.push(`sofascore error: ${e.message}`);
    }

    // ── 3. COMBINE — use whichever has more data ──────────────────
    const useFD = fdMatches.length >= sofaMatches.length;
    debug.steps.push(`using: ${useFD ? "football-data" : "sofascore"}`);

    let fixtures = [];
    if (useFD && fdMatches.length > 0) {
      fixtures = fdMatches.map(m => ({
        id: m.id,
        home: m.homeTeam?.shortName || m.homeTeam?.name,
        away: m.awayTeam?.shortName || m.awayTeam?.name,
        homeFull: m.homeTeam?.name || "",
        awayFull: m.awayTeam?.name || "",
        league: m.competition?.name || "Football",
        country: m.area?.name || "",
        kickoff: new Date(m.utcDate).toLocaleTimeString("en-GB", {
          hour: "2-digit", minute: "2-digit", timeZone: "Europe/London"
        }),
        ts: new Date(m.utcDate).getTime() / 1000,
      }));
    } else if (sofaMatches.length > 0) {
      fixtures = sofaMatches.map(e => ({
        id: e.id,
        home: e.homeTeam?.shortName || e.homeTeam?.name,
        away: e.awayTeam?.shortName || e.awayTeam?.name,
        homeFull: e.homeTeam?.name || "",
        awayFull: e.awayTeam?.name || "",
        league: e.tournament?.name || "Football",
        country: e.tournament?.category?.name || "",
        kickoff: e.startTimestamp
          ? new Date(e.startTimestamp * 1000).toLocaleTimeString("en-GB", {
              hour: "2-digit", minute: "2-digit", timeZone: "Europe/London"
            })
          : "TBC",
        ts: e.startTimestamp || 0,
      }));
    }

    debug.steps.push(`total fixtures: ${fixtures.length}`);
    if (fixtures.length > 0) {
      debug.steps.push(`sample: ${fixtures[0].home} vs ${fixtures[0].away} (${fixtures[0].league})`);
    }

    // ── 4. LIVE STANDINGS ─────────────────────────────────────────
    const standingsMap = {};
    await Promise.allSettled(FD_COMPS.map(async code => {
      const data = await fdGet(`/competitions/${code}/standings`);
      if (!data) return;
      const table = data.standings?.[0]?.table || [];
      table.forEach(entry => {
        const name  = entry.team?.name || "";
        const short = entry.team?.shortName || name;
        const stats = {
          position: entry.position,
          played:   entry.playedGames,
          won:      entry.won,
          drawn:    entry.draw,
          lost:     entry.lost,
          gf:       entry.goalsFor,
          ga:       entry.goalsAgainst,
          gd:       entry.goalDifference,
          points:   entry.points,
          form:     (entry.form || "").split(",").filter(Boolean).slice(-5),
        };
        standingsMap[name.toLowerCase()]  = stats;
        standingsMap[short.toLowerCase()] = stats;
      });
    }));
    debug.steps.push(`teams with stats: ${Object.keys(standingsMap).length / 2}`);

    // ── 5. LIVE ODDS ──────────────────────────────────────────────
    let oddsData = [];
    try {
      const oddsRes = await fetch(
        `${ODDS_BASE}/sports/soccer/odds/?apiKey=${ODDS_KEY}&regions=uk,eu&markets=h2h,totals,btts&oddsFormat=decimal&dateFormat=iso`
      );
      const oddsText = await oddsRes.text();
      debug.steps.push(`odds status: ${oddsRes.status}, length: ${oddsText.length}`);
      if (oddsRes.ok) {
        oddsData = JSON.parse(oddsText);
        debug.steps.push(`odds events: ${oddsData.length}`);
      } else {
        debug.steps.push(`odds error: ${oddsText.slice(0,100)}`);
      }
    } catch(e) {
      debug.steps.push(`odds exception: ${e.message}`);
    }

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

    const enriched = fixtures.map(f => {
      const homeStats = standingsMap[f.homeFull.toLowerCase()] ||
                        standingsMap[f.home.toLowerCase()] || null;
      const awayStats = standingsMap[f.awayFull.toLowerCase()] ||
                        standingsMap[f.away.toLowerCase()] || null;
      const oddsEvent = findOdds(f.homeFull || f.home, f.awayFull || f.away);
      const liveOdds  = extractOdds(oddsEvent);

      return {
        id: f.id,
        utcDate: f.ts ? new Date(f.ts * 1000).toISOString() : new Date().toISOString(),
        homeTeam: { name: f.home, fullName: f.homeFull },
        awayTeam: { name: f.away, fullName: f.awayFull },
        competition: { name: f.league, code: "" },
        league: f.league,
        country: f.country,
        kickoff: f.kickoff,
        homeStats,
        awayStats,
        liveOdds,
        hasOdds:  Object.keys(liveOdds).length > 0,
        hasStats: !!(homeStats && awayStats),
        trusted:  true,
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
          withOdds:  enriched.filter(m => m.hasOdds).length,
          withStats: enriched.filter(m => m.hasStats).length,
          oddsEvents: oddsData.length,
          source: "football-data+sofascore+odds-api",
          debug,
        }
      }),
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message, matches: [] }),
    };
  }
};
