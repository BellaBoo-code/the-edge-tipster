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

  // ── EXACT LEAGUES TO COVER ─────────────────────────────────────
  // Only these leagues. Nothing else.
  const ALLOWED_LEAGUES = [
    // English
    "premier league",
    "championship",
    "league one",
    "league two",
    // Scottish
    "scottish premiership",
    // Dutch
    "eredivisie",
    // Spanish
    "la liga",
    "laliga",
    // Italian
    "serie a",
    // French
    "ligue 1",
    // German
    "bundesliga",
    // MLS
    "mls",
    "major league soccer",
    // European
    "champions league",
    "uefa champions league",
    "europa league",
    "uefa europa league",
    "conference league",
    "uefa conference league",
    // International tournaments
    "world cup",
    "fifa world cup",
    "european championship",
    "uefa euro",
    // Playoffs for English leagues
    "league one, playoffs",
    "league two, playoffs",
    "championship playoff",
  ];

  function isAllowed(leagueName) {
    const n = (leagueName || "").toLowerCase();
    return ALLOWED_LEAGUES.some(x => n.includes(x));
  }

  // Sofascore category IDs for our target leagues only
  // 1=England, 2=Germany, 3=Portugal, 4=Spain, 5=Italy,
  // 6=Netherlands, 7=France, 8=Scotland, 85=USA(MLS),
  // 200=World Cup, 201=Euros, 203=Champions League,
  // 204=Europa League, 205=Conference League
  const CATEGORY_IDS = [1, 2, 4, 5, 6, 7, 8, 85, 200, 201, 203, 204, 205];

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

    // ── 1. FETCH FIXTURES FROM SOFASCORE ─────────────────────────
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

    // Deduplicate by event ID
    const seen = new Set();
    const unique = allEvents.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });

    // Filter strictly to allowed leagues, today only, not started
    const fixtures = unique
      .filter(e => {
        // Must be not started
        if (e.status?.type !== "notstarted") return false;

        // Must be today in UK time
        const ts = e.startTimestamp || 0;
        if (ts) {
          const d = new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
          if (d !== today) return false;
        }

        // Must be in our allowed leagues — strict whitelist
        const leagueName = e.tournament?.name || "";
        if (!isAllowed(leagueName)) return false;

        // Must have proper team names (not individual players)
        const home = e.homeTeam?.name || "";
        const away = e.awayTeam?.name || "";
        if (!home || !away) return false;

        return true;
      })
      .map(e => ({
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
        trusted: true, // All allowed leagues are trusted
      }))
      .sort((a, b) => a.ts - b.ts);

    console.log(`Fixtures today: ${fixtures.length} across allowed leagues`);

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

    console.log(`Live stats for ${Object.keys(standingsMap).length / 2} teams`);

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

    // ── 4. ENRICH FIXTURES ────────────────────────────────────────
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
          source: "sofascore+football-data+odds-api",
          leagues: ALLOWED_LEAGUES.slice(0, 10),
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
