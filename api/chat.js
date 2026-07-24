const GENERAL_MODELS = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
];
const SEARCH_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
const DAILY_MODEL_LIMITS = {
  "gemini-3.6-flash": 20,
  "gemini-3.5-flash": 20,
  "gemini-3.5-flash-lite": 500,
  "gemini-3.1-flash-lite": 500,
  "gemini-2.5-flash": 20,
  "gemini-2.5-flash-lite": 20,
};
const TRANSIENT_COOLDOWN_MS = 2 * 60 * 1000;

function getPacificDateParts(date) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  );
}

function getPacificOffset(date) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  );

  return (
    Date.UTC(
      values.year,
      values.month - 1,
      values.day,
      values.hour,
      values.minute,
      values.second,
    ) - date.getTime()
  );
}

function getNextQuotaReset() {
  const { year, month, day } = getPacificDateParts(new Date());
  const localReset = new Date(Date.UTC(year, month - 1, day + 1, 0, 10));

  return localReset.getTime() - getPacificOffset(localReset);
}

async function generateContent(model, contents, tools, apiKey) {
  const body = { contents };

  if (tools) body.tools = tools;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const data = await response.json();

  return { response, data };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    contents,
    useSearch = false,
    excludedModels = [],
    usageCounts = {},
    failureCounts = {},
  } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;
  const models = useSearch ? SEARCH_MODELS : GENERAL_MODELS;
  const tools = useSearch ? [{ googleSearch: {} }] : undefined;
  const dailyExclusions = models.filter(
    (model) =>
      DAILY_MODEL_LIMITS[model] &&
      (Number(usageCounts[model]) || 0) >= DAILY_MODEL_LIMITS[model],
  );
  const unavailableModels = new Set([
    ...dailyExclusions,
    ...(Array.isArray(excludedModels)
      ? excludedModels.filter((model) => models.includes(model))
      : []),
  ]);
  const modelCooldowns = [];
  const quotaResetAt = getNextQuotaReset();

  try {
    for (const model of models) {
      if (unavailableModels.has(model)) continue;

      const result = await generateContent(model, contents, tools, apiKey);

      if (result.response.status !== 429) {
        return res.status(result.response.status).json({
          ...result.data,
          modelUsed: model,
          modelCooldowns,
          quotaResetAt,
        });
      }

      const usageCount = Number(usageCounts[model]) || 0;
      const failureCount = Number(failureCounts[model]) || 0;
      const dailyLimit = DAILY_MODEL_LIMITS[model];
      const isDailyExclusion =
        (dailyLimit && usageCount >= dailyLimit) || failureCount >= 1;
      const disabledUntil = isDailyExclusion
        ? quotaResetAt
        : Date.now() + TRANSIENT_COOLDOWN_MS;

      modelCooldowns.push({ model, disabledUntil, isDailyExclusion });
    }

    return res.status(429).json({
      error: {
        message: "All available Gemini models have reached their limit.",
      },
      modelCooldowns,
      quotaResetAt,
    });
  } catch (error) {
    return res.status(500).json({ error: { message: error.message } });
  }
}
