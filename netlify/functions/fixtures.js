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

  const EXCLUDE = [
    "women", "u18", "u21", "u23", "u17", "u16", "u15", "youth",
    "reserve", "reserves", "b team", "friendly", "friendlies",
    "indoor", "futsal", "beach", "esport", "amateur", "fa youth"
  ];

  function isExcluded(name) {
    const n = (name || "").toLowerCase();
    return EXCLUDE.some(x => n.includes(x));
  }

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

  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

    // Sofascore football category IDs covering all major regions
    // 1=England, 2=Germany, 3=Portugal, 4=Spain, 5=Italy, 6=Netherlands,
    // 7=France, 8=Scotland, 10=Turkey, 12=Belgium, 13=Greece, 15=Russia,
    // 17=Poland, 22=Switzerland, 23=Austria, 24=Czech Rep, 27=Romania,
    // 32=Denmark, 34=Norway, 35=Sweden, 37=Finland, 44=Croatia, 52=Serbia,
    // 56=Slovakia, 60=Slovenia, 66=Bulgaria, 72=Israel, 77=Japan, 78=South Korea,
    // 80=Australia, 85=USA, 110=Brazil, 130=Argentina, 132=Mexico,
    // 155=Saudi Arabia, 156=UAE, 168=South Africa, 200=World Cup, 201=Euro,
    // 202=Nations League, 203=Champions League, 204=Europa League, 205=Conference League
    const CATEGORY_IDS = [
      1,2,3,4,5,6,7,8,10,12,13,15,17,22,23,24,27,32,34,35,37,
      44,52,56,60,66,72,77,78,80,85,110,130,132,155,156,168,
      200,201,202,203,204,205
    ];

    // Fetch all categories in parallel - limit to avoid timeout
    const results = await Promise.allSettled(
      CATEGORY_IDS.map(id =>
        sofaGet(`/tournaments/get-scheduled-events?categoryId=${id}&date=${today}`)
          .then(raw => ({ id, events: raw.events || [] }))
          .catch(() => ({ id, events: [] }))
      )
    );

    // Collect all events
    const allEvents = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        allEvents.push(...r.value.events);
      }
    }

    console.log(`Total raw events: ${allEvents.length}`);

    // Deduplicate by event ID
    const seen = new Set();
    const unique = allEvents.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });

    console.log(`Unique events: ${unique.length}`);

    // Filter and map
    const allMatches = unique
      .filter(e => {
        if (e.status?.type !== "notstarted") return false;
        const ts = e.startTimestamp || 0;
        if (ts) {
          const d = new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
          if (d !== today) return false;
        }
        const leagueName = e.tournament?.name || "";
        if (isExcluded(leagueName)) return false;
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
        liveOdds: {},
        hasOdds: false,
        hasStats: false,
        utcDate: e.startTimestamp
          ? new Date(e.startTimestamp * 1000).toISOString()
          : new Date().toISOString(),
        homeTeam: { name: e.homeTeam?.shortName || e.homeTeam?.name || "Home" },
        awayTeam: { name: e.awayTeam?.shortName || e.awayTeam?.name || "Away" },
        competition: { name: e.tournament?.name || "Football", code: "" },
      }))
      .filter(m => m.home !== "Home" && m.away !== "Away")
      .sort((a, b) => a.ts - b.ts);

    console.log(`Filtered fixtures: ${allMatches.length}`);

    // Live odds
    let oddsData = [];
    try {
      const oddsRes = await fetch(
        `${ODDS_BASE}/sports/soccer/odds/?apiKey=${ODDS_KEY}&regions=uk,eu&markets=h2h,totals,btts&oddsFormat=decimal&dateFormat=iso`
      );
      if (oddsRes.ok) oddsData = await oddsRes.json();
    } catch(e) {}

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

    const enriched = allMatches.map(m => {
      const oddsEvent = findOdds(m.homeFull || m.home, m.awayFull || m.away);
      const liveOdds = extractOdds(oddsEvent);
      return { ...m, liveOdds, hasOdds: Object.keys(liveOdds).length > 0 };
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
          source: "sofascore-global",
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
