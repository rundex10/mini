const fetch = require("node-fetch");

function apiUrl(method) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN is not set");
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function callTelegram(method, body) {
  const resp = await fetch(apiUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  if (!data.ok) {
    const err = new Error(data.description || `${method} failed`);
    err.telegram = data;
    throw err;
  }
  return data.result;
}

/**
 * Creates a one-time invoice link for a Telegram Stars purchase.
 * Stars payments use currency "XTR" and an empty provider_token — no
 * external payment provider is involved, Telegram settles it directly.
 *
 * @param {{title: string, description: string, payload: string, amountStars: number}} opts
 * @returns {Promise<string>} an https://t.me/$... invoice link
 */
async function createStarsInvoiceLink({ title, description, payload, amountStars }) {
  return callTelegram("createInvoiceLink", {
    title,
    description,
    payload,
    provider_token: "", // empty for Telegram Stars
    currency: "XTR",
    prices: [{ label: title, amount: amountStars }]
  });
}

/**
 * Must be called within ~10 seconds of receiving a pre_checkout_query
 * update, or Telegram will consider the payment failed.
 */
async function answerPreCheckoutQuery(preCheckoutQueryId, ok, errorMessage) {
  const body = { pre_checkout_query_id: preCheckoutQueryId, ok };
  if (!ok && errorMessage) body.error_message = errorMessage;
  return callTelegram("answerPreCheckoutQuery", body);
}

module.exports = { createStarsInvoiceLink, answerPreCheckoutQuery };
