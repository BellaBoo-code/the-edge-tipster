exports.handler = async function(event, context) {
  const FD_TOKEN = "faf76b5f8a1f40da96253222b4c306a8";
  const FD_BASE  = "https://api.football-data.org/v4";

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    // Get today's date in YYYY-MM-DD
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

    // All competition codes on the free tier
    const competitions = [
      "PL","ELC","CL","EL","PD","BL1","SA","FL1","DED","PPL","BSA","WC"
    ];

    const competitionNames = {
      "PL":"Premier League","ELC":"Championship","CL":"Champions League",
      "EL":"Europa League","PD":"La Liga","BL1":"Bundesliga","SA":"Serie A",
      "FL1":"Ligue 1","DED":"Eredivisie","PPL":"Primeira Liga",
      "BSA":"Brasileirao","WC":"World Cup"
    };

    // Fetch from each competition in parallel
    const results = await Promise.allSettled(
      competitions.map(async (code) => {
        const url = `${FD_BASE}/competitions/${code}/matches?dateFrom=${today}&dateTo=${today}`;
        const res = await fetch(url, {
          headers: { "X-Auth-Token": FD_TOKEN },
        });
        if (!res.ok) return [];
        const data = await res.json();
        const matches = data?.matches || [];
        return matches.map(m => ({
          ...m,
          competition: {
            ...m.competition,
            name: competitionNames[code] || m.competition?.name,
            code,
          },
        }));
      })
    );

    const allMatches = results
      .filter(r => r.status === "fulfilled")
      .flatMap(r => r.value)
      .filter(m => m && m.homeTeam);

    console.log(`Found ${allMatches.length} matches today across all competitions`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ matches: allMatches }),
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
