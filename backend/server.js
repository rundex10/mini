require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const config = require("./config");
const { stmts, getOrCreateUser } = require("./db");
const { validateInitData } = require("./telegramAuth");
const { createStarsInvoiceLink, answerPreCheckoutQuery } = require("./telegramBotApi");

const BOT_TOKEN = process.env.BOT_TOKEN;
const DEV_SKIP_AUTH = process.env.DEV_SKIP_AUTH === "true";
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

if (!BOT_TOKEN && !DEV_SKIP_AUTH) {
  console.error("Missing BOT_TOKEN in .env — set it or set DEV_SKIP_AUTH=true for local testing only.");
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(",") : "*"
  })
);

// ---------------------------------------------------------------------------
// Telegram bot webhook — receives pre_checkout_query and successful_payment
// updates for Stars payments. This is called by Telegram's servers directly,
// NOT by the Mini App, so it has no initData and must NOT go through
// authMiddleware. Instead it's protected by the secret token Telegram
// echoes back when you register the webhook with `secret_token` (see
// README for the setWebhook command).
// ---------------------------------------------------------------------------
app.post("/telegram-webhook", async (req, res) => {
  if (WEBHOOK_SECRET) {
    const incomingSecret = req.header("x-telegram-bot-api-secret-token");
    if (incomingSecret !== WEBHOOK_SECRET) {
      return res.sendStatus(401);
    }
  }

  // Always respond 200 quickly so Telegram doesn't retry the same update
  // forever; errors are logged but never surfaced to the caller.
  try {
    const update = req.body || {};

    if (update.pre_checkout_query) {
      const pcq = update.pre_checkout_query;
      const [upgradeId] = String(pcq.invoice_payload || "").split("|");
      const upgrade = config.UPGRADES.find((u) => u.id === upgradeId);
      const valid = !!upgrade && pcq.currency === "XTR" && pcq.total_amount === upgrade.costStars;
      try {
        await answerPreCheckoutQuery(pcq.id, valid, valid ? undefined : "Upgrade tidak valid atau harga berubah.");
      } catch (err) {
        console.error("answerPreCheckoutQuery failed:", err.message);
      }
    } else if (update.message && update.message.successful_payment) {
      const sp = update.message.successful_payment;
      const fromId = update.message.from.id;
      const [upgradeId] = String(sp.invoice_payload || "").split("|");
      const upgrade = config.UPGRADES.find((u) => u.id === upgradeId);
      const chargeId = sp.telegram_payment_charge_id;

      // The charge id is unique per real payment, so this is the
      // idempotency key that prevents double-crediting on webhook retries.
      const alreadyCredited = stmts.hasPayment.get(chargeId);
      if (upgrade && chargeId && !alreadyCredited) {
        // Make sure the user row exists (it always should, since buying an
        // upgrade requires having opened the Mini App first).
        getOrCreateUser({
          id: fromId,
          username: update.message.from.username,
          first_name: update.message.from.first_name
        });
        stmts.insertPayment.run({
          charge_id: chargeId,
          user_id: fromId,
          upgrade_id: upgrade.id,
          stars_amount: sp.total_amount,
          created_at: Date.now()
        });
        stmts.addRate.run(upgrade.rateBoost, fromId);
      }
    }
  } catch (err) {
    console.error("telegram-webhook error:", err);
  }

  res.sendStatus(200);
});

// ---------------------------------------------------------------------------
// Auth middleware: every request must carry the Telegram initData string in
// the `x-telegram-init-data` header. We verify it, then load/create the user.
// ---------------------------------------------------------------------------
function authMiddleware(req, res, next) {
  const initData = req.header("x-telegram-init-data");

  if (DEV_SKIP_AUTH) {
    // Local dev convenience only — never enable this in production.
    const devUser = { id: 1, username: "dev", first_name: "Dev" };
    req.tgUser = devUser;
    req.startParam = req.query.start_param || null;
    return next();
  }

  const result = validateInitData(initData, BOT_TOKEN);
  if (!result.ok) {
    return res.status(401).json({ error: "unauthorized", reason: result.reason });
  }
  req.tgUser = result.user;
  req.startParam = result.startParam;
  next();
}

app.use(authMiddleware);

function loadUser(req) {
  let referrerId = null;
  if (req.startParam && /^\d+$/.test(req.startParam)) {
    referrerId = parseInt(req.startParam, 10);
  }
  return getOrCreateUser({
    id: req.tgUser.id,
    username: req.tgUser.username,
    first_name: req.tgUser.first_name,
    referrer_id: referrerId
  });
}

function serializeUser(user) {
  const now = Date.now();
  let miningEarnedSoFar = 0;
  let miningRemainingMs = 0;
  let miningReadyToClaim = false;

  if (user.mining_active && user.mining_start) {
    const elapsed = Math.min(now - user.mining_start, config.MINING_DURATION_MS);
    const hoursElapsed = elapsed / (1000 * 60 * 60);
    miningEarnedSoFar = Math.floor(hoursElapsed * user.mining_rate);
    miningRemainingMs = Math.max(0, config.MINING_DURATION_MS - (now - user.mining_start));
    miningReadyToClaim = now - user.mining_start >= config.MINING_DURATION_MS;
  }

  return {
    id: user.id,
    username: user.username,
    firstName: user.first_name,
    balance: Math.floor(user.balance),
    miningRate: user.mining_rate,
    miningActive: !!user.mining_active,
    miningEarnedSoFar,
    miningRemainingMs,
    miningReadyToClaim,
    miningDurationMs: config.MINING_DURATION_MS,
    referralCount: user.referral_count,
    checkinStreak: user.checkin_streak,
    lastCheckin: user.last_checkin
  };
}

// ---------------------------------------------------------------------------
// GET /api/me — fetch (and lazily create) the current user's profile
// ---------------------------------------------------------------------------
app.get("/api/me", (req, res) => {
  const user = loadUser(req);
  res.json(serializeUser(user));
});

// ---------------------------------------------------------------------------
// POST /api/mine/start — begin a 24h mining session
// ---------------------------------------------------------------------------
app.post("/api/mine/start", (req, res) => {
  const user = loadUser(req);
  if (user.mining_active) {
    return res.status(409).json({ error: "mining already active" });
  }
  stmts.startMining.run(Date.now(), user.id);
  const updated = stmts.getUser.get(user.id);
  res.json(serializeUser(updated));
});

// ---------------------------------------------------------------------------
// POST /api/mine/claim — collect coins once the 24h session has completed
// ---------------------------------------------------------------------------
app.post("/api/mine/claim", (req, res) => {
  const user = loadUser(req);
  if (!user.mining_active || !user.mining_start) {
    return res.status(409).json({ error: "no active mining session" });
  }
  const elapsed = Date.now() - user.mining_start;
  if (elapsed < config.MINING_DURATION_MS) {
    return res.status(409).json({
      error: "mining session not finished yet",
      remainingMs: config.MINING_DURATION_MS - elapsed
    });
  }
  const hoursElapsed = config.MINING_DURATION_MS / (1000 * 60 * 60);
  const earned = Math.floor(hoursElapsed * user.mining_rate);
  stmts.claimMining.run(earned, user.id);
  const updated = stmts.getUser.get(user.id);
  res.json({ earned, user: serializeUser(updated) });
});

// ---------------------------------------------------------------------------
// GET /api/tasks — list all tasks with per-user completion state
// ---------------------------------------------------------------------------
app.get("/api/tasks", (req, res) => {
  const user = loadUser(req);
  const doneIds = new Set(stmts.completedTaskIds.all(user.id).map((r) => r.task_id));

  const tasks = config.TASKS.map((t) => {
    let progress = null;
    if (t.type === "referral") {
      progress = { current: Math.min(user.referral_count, t.threshold), target: t.threshold };
    }
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      reward: t.reward,
      type: t.type,
      completed: doneIds.has(t.id),
      progress
    };
  });

  res.json({ tasks, checkinStreak: user.checkin_streak, lastCheckin: user.last_checkin });
});

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/complete — attempt to complete/verify a task
// ---------------------------------------------------------------------------
app.post("/api/tasks/:id/complete", async (req, res) => {
  const user = loadUser(req);
  const task = config.TASKS.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "unknown task" });
  if (task.type === "checkin") {
    return res.status(400).json({ error: "use /api/checkin for the daily check-in" });
  }

  const already = stmts.isTaskDone.get(user.id, task.id);
  if (already) return res.status(409).json({ error: "task already completed" });

  if (task.type === "referral") {
    if (user.referral_count < task.threshold) {
      return res.status(409).json({
        error: "not enough referrals yet",
        have: user.referral_count,
        need: task.threshold
      });
    }
  }

  if (task.type === "verified_channel" || task.type === "verified_group") {
    const chatId = task.type === "verified_channel" ? process.env.REQUIRED_CHANNEL : process.env.REQUIRED_GROUP;
    try {
      const member = await checkChatMembership(chatId, user.id);
      if (!member) {
        return res.status(409).json({ error: "membership not verified — join first, then confirm" });
      }
    } catch (err) {
      console.error("Membership check failed:", err.message);
      return res.status(502).json({ error: "could not verify membership right now, try again shortly" });
    }
  }

  // "manual" tasks (e.g. follow on X) are self-reported and simply trusted
  // once — this mirrors what BitNet-style apps do for off-platform actions.

  stmts.markTaskDone.run(user.id, task.id, Date.now());
  stmts.addBalance.run(task.reward, user.id);
  if (task.boostsRate) {
    stmts.addRate.run(config.TASK_RATE_BOOST, user.id);
  }

  const updated = stmts.getUser.get(user.id);
  res.json({ reward: task.reward, user: serializeUser(updated) });
});

async function checkChatMembership(chatUsernameOrId, userId) {
  if (!chatUsernameOrId) throw new Error("required chat not configured");
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(
    chatUsernameOrId
  )}&user_id=${userId}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!data.ok) throw new Error(data.description || "getChatMember failed");
  const status = data.result.status;
  return ["creator", "administrator", "member"].includes(status);
}

// ---------------------------------------------------------------------------
// POST /api/checkin — daily check-in with a streak bonus
// ---------------------------------------------------------------------------
app.post("/api/checkin", (req, res) => {
  const user = loadUser(req);
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (user.last_checkin && now - user.last_checkin < oneDayMs) {
    return res.status(409).json({
      error: "already checked in today",
      nextAvailableMs: oneDayMs - (now - user.last_checkin)
    });
  }

  // Streak continues if the previous check-in was within the last 2 days,
  // otherwise it resets to 1.
  const withinStreakWindow = user.last_checkin && now - user.last_checkin < oneDayMs * 2;
  const newStreak = withinStreakWindow ? Math.min(user.checkin_streak + 1, config.MAX_STREAK_DAYS) : 1;
  const reward = config.CHECKIN_BASE_REWARD + (newStreak - 1) * config.CHECKIN_STREAK_STEP;

  stmts.setCheckin.run(newStreak, now, user.id);
  stmts.addBalance.run(reward, user.id);

  const updated = stmts.getUser.get(user.id);
  res.json({ reward, streak: newStreak, user: serializeUser(updated) });
});

// ---------------------------------------------------------------------------
// GET /api/leaderboard — top miners by balance, plus the caller's own rank
// ---------------------------------------------------------------------------
app.get("/api/leaderboard", (req, res) => {
  const user = loadUser(req);
  const top = stmts.leaderboard.all(100).map((row, i) => ({
    rank: i + 1,
    id: row.id,
    name: row.username ? `@${row.username}` : row.first_name || `Miner ${row.id}`,
    balance: Math.floor(row.balance)
  }));
  const myRank = stmts.rankOf.get(user.id).rank;
  res.json({ top, myRank });
});

// ---------------------------------------------------------------------------
// GET /api/referral-link — build the user's personal invite link
// ---------------------------------------------------------------------------
app.get("/api/referral-link", (req, res) => {
  const user = loadUser(req);
  const botUsername = process.env.BOT_USERNAME || "your_bot";
  res.json({
    link: `https://t.me/${botUsername}?startapp=${user.id}`,
    referralCount: user.referral_count
  });
});

// ---------------------------------------------------------------------------
// GET /api/upgrades — list hashrate upgrades with how many times bought
// ---------------------------------------------------------------------------
app.get("/api/upgrades", (req, res) => {
  const user = loadUser(req);
  const counts = {};
  stmts.purchaseCounts.all(user.id).forEach((row) => { counts[row.upgrade_id] = row.n; });

  const upgrades = config.UPGRADES.map((u) => ({
    id: u.id,
    title: u.title,
    description: u.description,
    rateBoost: u.rateBoost,
    costStars: u.costStars,
    owned: counts[u.id] || 0
  }));

  res.json({ upgrades, miningRate: user.mining_rate });
});

// ---------------------------------------------------------------------------
// POST /api/upgrades/:id/invoice — create a Telegram Stars invoice link for
// this upgrade. The Mini App opens the returned link with
// Telegram.WebApp.openInvoice(); Telegram then talks to our bot webhook
// directly to complete (or cancel) the purchase.
// ---------------------------------------------------------------------------
app.post("/api/upgrades/:id/invoice", async (req, res) => {
  const user = loadUser(req);
  const upgrade = config.UPGRADES.find((u) => u.id === req.params.id);
  if (!upgrade) return res.status(404).json({ error: "unknown upgrade" });

  try {
    const link = await createStarsInvoiceLink({
      title: upgrade.title,
      description: upgrade.description,
      payload: `${upgrade.id}|${user.id}`,
      amountStars: upgrade.costStars
    });
    res.json({ link });
  } catch (err) {
    console.error("createInvoiceLink failed:", err.message);
    res.status(502).json({ error: "could not create invoice right now, try again shortly" });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Spencer mining API listening on port ${PORT}`);
});
