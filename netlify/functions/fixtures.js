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
    const params = event.queryStringParameters || {};
    const apiPath = params.path || "/matches";
    const url = `${FD_BASE}${apiPath}`;
    console.log("Fetching:", url);

    const response = await fetch(url, {
      headers: { "X-Auth-Token": FD_TOKEN },
    });

    const data = await response.json();

    return {
      statusCode: response.status,
      headers,
      body: JSON.stringify(data),
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
