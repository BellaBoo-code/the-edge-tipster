exports.handler = async function(event, context) {
  const RAPID_KEY  = "6bebc9a495msh3e46b1cd76f8643p1ca878jsn73f39e431e93";
  const RAPID_HOST = "free-api-live-football-data.p.rapidapi.com";
  const RAPID_BASE = "https://free-api-live-football-data.p.rapidapi.com";
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

  async function apiGet(path) {
    const r = await fetch(`${RAPID_BASE}${path}`, {
      headers: {
        "x-rapidapi-key": RAPID_KEY,
        "x-rapidapi-host": RAPID_HOST,
        "Content-Type": "application/json",
      }
    });
    if (!r.ok) throw new Error(`API ${r.status}: ${path}`);
    return r.json();
  }

  // League IDs confirmed from API
  const LEAGUES = [
    // International (confirmed IDs)
    { id: 42,    name: "Champions League",     country: "Europe"      },
    { id: 73,    name: "Europa League",         country: "Europe"      },
    { id: 10216, name: "Conference League",     country: "Europe"      },
    { id: 77,    name: "World Cup",             country: "International"},
    { id: 50,    name: "EURO",                  country: "International"},
    // Domestic — IDs to be confirmed from fixtures response
    { id: 47,    name: "Premier League",        country: "England"     },
    { id: 48,    name: "Championship",          country: "England"     },
    { id: 49,    name: "League One",            country: "England"     },
    { id: 51,    name: "League Two",            country: "England"     },
    { id: 87,    name: "La Liga",               country: "Spain"       },
    { id: 54,    name: "Bundesliga",            country: "Germany"     },
    { id: 55,    name: "Serie A",               country: "Italy"       },
    { id: 53,    name: "Ligue 1",               country: "France"      },
    { id: 57,    name: "Eredivisie",            country: "Netherlands" },
    { id: 84,    name: "Scottish Premiership",  country: "Scotland"    },
    { id: 242,   name: "MLS",                   country: "USA"         },
  ];

  const LEAGUE_MAP = {};
  LEAGUES.forEach(l => { LEAGUE_MAP[l.id] = l; });

  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
    const dateFormatted = today.replace(/-/g, ""); // YYYYMMDD format

    // ── 1. TODAY'S FIXTURES ───────────────────────────────────────
    let allFixtures = [];
    try {
      const data = await apiGet(`/football-get-matches-by-date?date=${dateFormatted}`);
      
      // Log full structure for debugging
      const dataStr = JSON.stringify(data).slice(0, 1000);
      console.log("Raw response sample:", dataStr);
      
      // Handle all possible response structures
      let raw = data?.response || data?.matches || data?.events || data?.data || data?.result || data;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        raw = raw.matches || raw.events || raw.fixtures || raw.data || Object.values(raw)[0] || [];
      }
      allFixtures = Array.isArray(raw) ? raw : [];
      
      // Log league IDs from fixtures so we can identify correct IDs
      if (allFixtures.length > 0) {
        console.log("Sample fixture:", JSON.stringify(allFixtures[0]).slice(0, 500));
        // Get unique league IDs and names
        const leagueInfo = {};
        allFixtures.forEach(m => {
          const lid = m.league?.id || m.leagueId;
          const lname = m.league?.name || m.leagueName || "";
          if (lid && lname) leagueInfo[lid] = lname;
        });
        console.log("League IDs in fixtures:", JSON.stringify(leagueInfo).slice(0, 1000));
      }
      console.log(`Raw fixtures: ${allFixtures.length}`);
    } catch(e) {
      console.log("Fixtures fetch error:", e.message);
    }

    // Filter to our leagues and today only
    const leagueIds = new Set(LEAGUES.map(l => l.id));
    const leagueNames = [
      "premier league", "championship", "league one", "league two",
      "la liga", "bundesliga", "serie a", "ligue 1", "eredivisie",
      "scottish premiership", "mls", "major league soccer",
      "champions league", "europa league", "conference league",
      "world cup", "euro", "playoffs"
    ];

    const fixtures = allFixtures
      .filter(m => {
        // Check by ID first, then by name
        const lid = m.league?.id || m.leagueId || m.competition?.id;
        const lname = (m.league?.name || m.leagueName || m.competition?.name || "").toLowerCase();
        const idMatch = leagueIds.has(lid) || leagueIds.has(parseInt(lid));
        const nameMatch = leagueNames.some(n => lname.includes(n));
        if (!idMatch && !nameMatch) return false;
        // Exclude finished games
        const status = m.status?.short || m.status || m.statusShort || "";
        if (status === "FT" || status === "AET" || status === "PEN") return false;
        // Exclude women/youth
        if (lname.includes("women") || lname.includes("u21") || lname.includes("u18") || lname.includes("youth")) return false;
        return true;
      })
      .map(m => {
        const lid = m.league?.id || m.leagueId || m.competition?.id;
        const league = LEAGUE_MAP[lid] || LEAGUE_MAP[parseInt(lid)] || { name: "Football", country: "" };
        const ts = m.fixture?.timestamp || m.timestamp || m.startTimestamp || 0;
        return {
          id: m.fixture?.id || m.id || m.eventId,
          home: m.teams?.home?.name || m.homeTeam?.name || m.home?.name || "Home",
          away: m.teams?.away?.name || m.awayTeam?.name || m.away?.name || "Away",
          homeFull: m.teams?.home?.name || m.homeTeam?.name || "",
          awayFull: m.teams?.away?.name || m.awayTeam?.name || "",
          homeId: m.teams?.home?.id || m.homeTeam?.id,
          awayId: m.teams?.away?.id || m.awayTeam?.id,
          leagueId: lid,
          league: league.name,
          country: league.country,
          kickoff: ts
            ? new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" })
            : m.fixture?.date ? new Date(m.fixture.date).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }) : "TBC",
          ts,
        };
      })
      .filter(m => m.home !== "Home" && m.away !== "Away")
      .sort((a, b) => a.ts - b.ts);

    console.log(`Filtered fixtures: ${fixtures.length}`);

    // ── 2. LIVE STANDINGS for each league ─────────────────────────
    const standingsMap = {};

    await Promise.allSettled(LEAGUES.map(async league => {
      try {
        const data = await apiGet(`/football-get-standing-all?leagueid=${league.id}`);
        const table = data?.response || data?.standings || data?.data || [];
        const rows = Array.isArray(table) ? table : table?.standing || [];

        rows.forEach(row => {
          const teamName  = row?.team?.name || row?.teamName || row?.name || "";
          const teamShort = row?.team?.shortName || teamName;
          if (!teamName) return;

          const stats = {
            position: row?.rank || row?.position || row?.pos || 10,
            played:   row?.played || row?.games?.played || row?.gp || 30,
            won:      row?.won || row?.games?.win?.total || row?.w || 12,
            drawn:    row?.drawn || row?.games?.draw?.total || row?.d || 7,
            lost:     row?.lost || row?.games?.lose?.total || row?.l || 11,
            gf:       row?.goalsFor || row?.goals?.for?.total || row?.gf || 40,
            ga:       row?.goalsAgainst || row?.goals?.against?.total || row?.ga || 40,
            points:   row?.points || row?.pts || 43,
            form:     (row?.form || "").split("").filter(c => ["W","D","L"].includes(c)).slice(-5),
            league:   league.name,
          };

          standingsMap[teamName.toLowerCase()]  = stats;
          standingsMap[teamShort.toLowerCase()] = stats;
        });
      } catch(e) {
        // Silent fail
      }
    }));

    console.log(`Teams with stats: ${Object.keys(standingsMap).length / 2}`);

    // ── 3. LIVE ODDS ──────────────────────────────────────────────
    let oddsData = [];
    try {
      const oddsRes = await fetch(
        `${ODDS_BASE}/sports/soccer/odds/?apiKey=${ODDS_KEY}&regions=uk,eu&markets=h2h,totals&oddsFormat=decimal&dateFormat=iso`
      );
      if (oddsRes.ok) {
        oddsData = await oddsRes.json();
        console.log(`Odds: ${oddsData.length} events`);
      }
    } catch(e) {
      console.log("Odds error:", e.message);
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
          teamsWithStats: Object.keys(standingsMap).length / 2,
          source: "free-api-live-football-data + odds-api",
        }
      }),
    };

  } catch (error) {
    console.error("Error:", error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message, matches: [] }),
    };
  }
};
