const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";

const FIELDS_SCHEMA = `{
  "name": string or null,
  "title": string or null,
  "company": string or null,
  "phones": array of strings (empty array if none),
  "emails": array of strings (empty array if none),
  "website": string or null,
  "address": string or null,
  "notes": string or null (anything else useful on the card, e.g. a tagline)
}`;

exports.handler = async (event) => {
  try {
    return await handle(event);
  } catch (err) {
    console.error("OCR function: unexpected error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Unexpected server error: ${err.message}` }),
    };
  }
};

async function handle(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("OCR function: ANTHROPIC_API_KEY is not set.");
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY is not configured on this Netlify site." }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }

  const { imageBase64, mediaType } = payload;
  if (!imageBase64 || !mediaType) {
    return { statusCode: 400, body: JSON.stringify({ error: "imageBase64 and mediaType are required." }) };
  }

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: imageBase64 },
            },
            {
              type: "text",
              text:
                "This is a photo of a business card. Extract its contact fields and respond with ONLY a single JSON object (no markdown fences, no commentary) matching this shape:\n" +
                FIELDS_SCHEMA +
                "\nIf a field isn't on the card, use null (or an empty array for phones/emails). Normalize phone numbers to the format shown on the card, don't invent area codes or country codes.",
            },
          ],
        },
      ],
    }),
  });

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    console.error(`OCR function: Anthropic API returned ${anthropicRes.status}: ${errText}`);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: `OCR provider error (${anthropicRes.status}): ${errText}`, detail: errText }),
    };
  }

  const data = await anthropicRes.json();
  const raw = (data.content || []).map((b) => b.text || "").join("").trim();

  let fields;
  try {
    const jsonText = raw.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    fields = JSON.parse(jsonText);
  } catch (err) {
    console.error(`OCR function: could not parse model output as JSON. Raw: ${raw}`);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: "Could not parse OCR response as JSON.", raw }),
    };
  }

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields }),
  };
}
