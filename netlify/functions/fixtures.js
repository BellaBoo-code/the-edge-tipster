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
      throw new Error(`Sofascore ${r.status}: ${txt.slice(0,200)}`);
    }
    return r.json();
  }

  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

    // Fetch raw response and expose structure for debugging
    const raw = await sofaGet(`/tournaments/get-scheduled-events?categoryId=1&date=${today}`);

    // Log top level keys so we can see the structure
    const topKeys = Object.keys(raw || {});
    const debugInfo = {
      topKeys,
      date: today,
    };

    // Try every possible path to find fixtures
    let allMatches = [];

    // Try path 1: raw.uniqueTournaments
    if (raw.uniqueTournaments) {
      debugInfo.path = "uniqueTournaments";
      debugInfo.count = raw.uniqueTournaments.length;
      for (const t of raw.uniqueTournaments) {
        const tName = t.tournament?.name || t.name || "Football";
        const events = t.events || t.scheduledEvents || [];
        for (const e of events) {
          allMatches.push({ src: "p1", league: tName, e });
        }
      }
    }

    // Try path 2: raw.sportItem
    if (raw.sportItem?.tournaments) {
      debugInfo.path2 = "sportItem.tournaments";
      debugInfo.count2 = raw.sportItem.tournaments.length;
      for (const t of raw.sportItem.tournaments) {
        const tName = t.tournament?.name || t.name || "Football";
        const events = t.events || t.scheduledEvents || [];
        for (const e of events) {
          allMatches.push({ src: "p2", league: tName, e });
        }
      }
    }

    // Try path 3: raw.events (flat list)
    if (raw.events) {
      debugInfo.path3 = "events";
      debugInfo.count3 = raw.events.length;
      for (const e of raw.events) {
        allMatches.push({ src: "p3", league: e.tournament?.name || "Football", e });
      }
    }

    // Try path 4: raw itself is array
    if (Array.isArray(raw)) {
      debugInfo.path4 = "raw array";
      debugInfo.count4 = raw.length;
      for (const e of raw) {
        allMatches.push({ src: "p4", league: e.tournament?.name || "Football", e });
      }
    }

    // Show first item of raw for inspection
    debugInfo.rawSample = JSON.stringify(raw).slice(0, 500);

    // Map to our format
    const fixtures = allMatches.map(({ league, e }) => ({
      id: e.id,
      home: e.homeTeam?.shortName || e.homeTeam?.name || "Home",
      away: e.awayTeam?.shortName || e.awayTeam?.name || "Away",
      homeFull: e.homeTeam?.name || "",
      awayFull: e.awayTeam?.name || "",
      league,
      country: e.tournament?.category?.name || "",
      kickoff: e.startTimestamp
        ? new Date(e.startTimestamp * 1000).toLocaleTimeString("en-GB", {
            hour: "2-digit", minute: "2-digit", timeZone: "Europe/London"
          })
        : "TBC",
      ts: e.startTimestamp || 0,
      liveOdds: {},
      hasOdds: false,
      hasStats: false,
      utcDate: e.startTimestamp ? new Date(e.startTimestamp * 1000).toISOString() : new Date().toISOString(),
      homeTeam: { name: e.homeTeam?.shortName || e.homeTeam?.name || "Home" },
      awayTeam: { name: e.awayTeam?.shortName || e.awayTeam?.name || "Away" },
      competition: { name: league, code: "" },
    })).filter(m => m.home !== "Home" && m.away !== "Away");

    // Try odds
    let oddsData = [];
    try {
      const oddsRes = await fetch(
        `${ODDS_BASE}/sports/soccer/odds/?apiKey=${ODDS_KEY}&regions=uk,eu&markets=h2h,totals,btts&oddsFormat=decimal&dateFormat=iso`
      );
      if (oddsRes.ok) oddsData = await oddsRes.json();
    } catch(e) {}

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        matches: fixtures,
        meta: {
          date: today,
          fixtureCount: fixtures.length,
          withOdds: 0,
          withStats: 0,
          oddsEvents: oddsData.length,
          source: "sofascore",
          debug: debugInfo,
        }
      }),
    };

  } catch (error) {
    console.error("Handler error:", error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message, matches: [], debug: error.message }),
    };
  }
};
