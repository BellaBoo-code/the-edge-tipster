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
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

    // Fetch all matches in one single call — works on free tier
    const url = `${FD_BASE}/matches?dateFrom=${today}&dateTo=${today}`;
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    
    const res = await fetch(url, {
      headers: { "X-Auth-Token": FD_TOKEN },
      signal: controller.signal,
    });
    
    clearTimeout(timeout);

    const data = await res.json();
    const matches = data?.matches || [];

    console.log(`Found ${matches.length} matches for ${today}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ matches }),
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
