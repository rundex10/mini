const crypto = require("crypto");

/**
 * Validates the `initData` string that Telegram signs and hands to every
 * Mini App on launch. This is the ONLY reliable way to know a request really
 * came from Telegram and really belongs to the user it claims to belong to.
 *
 * Algorithm (per Telegram docs):
 *   secret_key   = HMAC_SHA256(key = "WebAppData", data = bot_token)
 *   check_string = all fields except `hash`, sorted by key, joined "k=v" with "\n"
 *   expected     = HMAC_SHA256(key = secret_key, data = check_string) as hex
 *   valid        = expected === hash from initData
 *
 * @param {string} initData raw initData string from Telegram.WebApp.initData
 * @param {string} botToken your bot token from BotFather
 * @param {number} maxAgeSeconds reject initData older than this (replay protection)
 * @returns {{ok: true, user: object, startParam?: string} | {ok: false, reason: string}}
 */
function validateInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || typeof initData !== "string") {
    return { ok: false, reason: "missing initData" };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing hash" };
  params.delete("hash");

  const pairs = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const checkString = pairs.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = crypto.createHmac("sha256", secretKey).update(checkString).digest("hex");

  if (expectedHash !== hash) {
    return { ok: false, reason: "signature mismatch" };
  }

  const authDate = parseInt(params.get("auth_date") || "0", 10);
  const ageSeconds = Date.now() / 1000 - authDate;
  if (!authDate || ageSeconds > maxAgeSeconds || ageSeconds < -60) {
    return { ok: false, reason: "stale initData" };
  }

  let user;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {
    return { ok: false, reason: "malformed user field" };
  }
  if (!user || !user.id) return { ok: false, reason: "missing user" };

  return { ok: true, user, startParam: params.get("start_param") || null };
}

module.exports = { validateInitData };
