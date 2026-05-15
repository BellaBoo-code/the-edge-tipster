exports.handler = async function(event, context) {
  const RAPID_KEY  = "6bebc9a495msh3e46b1cd76f8643p1ca878jsn73f39e431e93";
  const RAPID_HOST = "sofascore.p.rapidapi.com";
  const RAPID_BASE = "https://sofascore.p.rapidapi.com";
  const FD_TOKEN   = "faf76b5f8a1f40da96253222b4c306a8";
  const FD_BASE    = "https://api.football-data.org/v4";
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

  // Only pick from leagues we have reliable stats for
  const TRUSTED_LEAGUES = [
    "premier league", "la liga", "bundesliga", "serie a", "ligue 1",
    "championship", "champions league", "europa league", "conference league",
    "eredivisie", "primeira liga", "super lig", "scottish premiership",
    "league one", "league two", "playoffs", "mls", "brasileirao",
    "primera division", "serie b", "serie b brasil"
  ];

  const EXCLUDE = [
    "women", "u18", "u21", "u23", "u17", "u16", "u15", "youth",
    "reserve", "reserves", "b team", "friendly", "friendlies",
    "indoor", "futsal", "beach", "esport", "amateur", "fa youth"
  ];

  function isExcluded(name) {
    const n = (name || "").toLowerCase();
    return EXCLUDE.some(x => n.includes(x));
  }

  function isTrusted(name) {
    const n = (name || "").toLowerCase();
    return TRUSTED_LEAGUES.some(x => n.includes(x));
  }

  // football-data.org competition codes for live standings
  const FD_COMPS = ["PL","ELC","PD","BL1","SA","FL1","DED","PPL","CL","EL","ECL"];

  async function sofaGet(path) {
    const r = await fetch(`${RAPID_BASE}${path}`, {
      headers: {
        "x-rapidapi-key": RAPID_KEY,
        "x-rapidapi-host": RAPID_HOST,
        "Content-Type": "application/json",
      }
    });
    if (!r.ok) throw new Error(`Sofascore ${r.status}`);
    return r.json();
  }

  async function fdGet(path) {
    const r = await fetch(`${FD_BASE}${path}`, {
      headers: { "X-Auth-Token": FD_TOKEN }
    });
    if (!r.ok) return null;
    return r.json();
  }

  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

    // ── 1. FIXTURES FROM SOFASCORE (worldwide) ────────────────────
    const CATEGORY_IDS = [
      1,2,3,4,5,6,7,8,10,12,13,15,17,22,23,24,27,32,34,35,37,
      44,52,56,60,66,72,77,78,80,85,110,130,132,155,156,168,
      200,201,202,203,204,205
    ];

    const sofaResults = await Promise.allSettled(
      CATEGORY_IDS.map(id =>
        sofaGet(`/tournaments/get-scheduled-events?categoryId=${id}&date=${today}`)
          .then(raw => raw.events || [])
          .catch(() => [])
      )
    );

    const allEvents = [];
    for (const r of sofaResults) {
      if (r.status === "fulfilled") allEvents.push(...r.value);
    }

    // Deduplicate
    const seen = new Set();
    const unique = allEvents.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });

    // Filter to today, senior men's football only
    const fixtures = unique
      .filter(e => {
        if (e.status?.type !== "notstarted") return false;
        const ts = e.startTimestamp || 0;
        if (ts) {
          const d = new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
          if (d !== today) return false;
        }
        // Must be football sport
        const sport = e.tournament?.category?.sport?.slug || 
                      e.tournament?.sport?.slug || "";
        if (sport && sport !== "football") return false;
        // Must have team names (not individual players like tennis)
        const home = e.homeTeam?.name || "";
        const away = e.awayTeam?.name || "";
        // Individual sport check — names with initials like "J. Smith" are not football teams
        const individualPattern = /^[A-Z]\.\s[A-Z]/;
        if (individualPattern.test(home) || individualPattern.test(away)) return false;
        if (isExcluded(e.tournament?.name || "")) return false;
        return true;
      })
      .map(e => ({
        id: e.id,
        home: e.homeTeam?.shortName || e.homeTeam?.name || "Home",
        away: e.awayTeam?.shortName || e.awayTeam?.name || "Away",
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
        trusted: isTrusted(e.tournament?.name || ""),
      }))
      .filter(m => m.home !== "Home" && m.away !== "Away")
      .sort((a, b) => a.ts - b.ts);

    console.log(`Fixtures today: ${fixtures.length} (${fixtures.filter(f=>f.trusted).length} trusted leagues)`);

    // ── 2. LIVE STANDINGS FROM FOOTBALL-DATA.ORG ─────────────────
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

    console.log(`Live stats loaded for ${Object.keys(standingsMap).length / 2} teams`);

    // ── 3. LIVE ODDS ──────────────────────────────────────────────
    let oddsData = [];
    try {
      const oddsRes = await fetch(
        `${ODDS_BASE}/sports/soccer/odds/?apiKey=${ODDS_KEY}&regions=uk,eu&markets=h2h,totals,btts&oddsFormat=decimal&dateFormat=iso`
      );
      if (oddsRes.ok) oddsData = await oddsRes.json();
      console.log(`Odds: ${oddsData.length} events`);
    } catch(e) {
      console.log("Odds unavailable:", e.message);
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

    // ── 4. ENRICH EACH FIXTURE ────────────────────────────────────
    const enriched = fixtures.map(f => {
      const hKey = f.homeFull.toLowerCase() || f.home.toLowerCase();
      const aKey = f.awayFull.toLowerCase() || f.away.toLowerCase();
      const homeStats = standingsMap[hKey] ||
                        standingsMap[f.home.toLowerCase()] ||
                        null;
      const awayStats = standingsMap[aKey] ||
                        standingsMap[f.away.toLowerCase()] ||
                        null;

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
        trusted:  f.trusted,
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
          trustedCount: enriched.filter(m => m.trusted).length,
          withOdds:  enriched.filter(m => m.hasOdds).length,
          withStats: enriched.filter(m => m.hasStats).length,
          oddsEvents: oddsData.length,
          source: "sofascore+football-data+odds-api",
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
