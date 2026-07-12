const path = require("path");
const Database = require("better-sqlite3");

const db = new Database(path.join(__dirname, "spencer.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY,      -- Telegram user id
    username        TEXT,
    first_name      TEXT,
    balance         REAL    NOT NULL DEFAULT 0,
    mining_rate     REAL    NOT NULL DEFAULT 100,
    mining_start    INTEGER,                  -- ms timestamp, NULL if idle
    mining_active   INTEGER NOT NULL DEFAULT 0,
    referrer_id     INTEGER,
    referral_count  INTEGER NOT NULL DEFAULT 0,
    checkin_streak  INTEGER NOT NULL DEFAULT 0,
    last_checkin    INTEGER,                  -- ms timestamp of last check-in
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks_completed (
    user_id      INTEGER NOT NULL,
    task_id      TEXT    NOT NULL,
    completed_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, task_id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    charge_id    TEXT PRIMARY KEY,   -- telegram_payment_charge_id, guarantees no double-credit
    user_id      INTEGER NOT NULL,
    upgrade_id   TEXT    NOT NULL,
    stars_amount INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);

  CREATE INDEX IF NOT EXISTS idx_users_balance ON users(balance DESC);
`);

const stmts = {
  getUser: db.prepare("SELECT * FROM users WHERE id = ?"),
  insertUser: db.prepare(`
    INSERT INTO users (id, username, first_name, referrer_id, created_at)
    VALUES (@id, @username, @first_name, @referrer_id, @created_at)
  `),
  touchProfile: db.prepare(`
    UPDATE users SET username = @username, first_name = @first_name WHERE id = @id
  `),
  startMining: db.prepare(`
    UPDATE users SET mining_active = 1, mining_start = ? WHERE id = ?
  `),
  claimMining: db.prepare(`
    UPDATE users
    SET balance = balance + ?, mining_active = 0, mining_start = NULL
    WHERE id = ?
  `),
  addBalance: db.prepare(`UPDATE users SET balance = balance + ? WHERE id = ?`),
  addRate: db.prepare(`UPDATE users SET mining_rate = mining_rate + ? WHERE id = ?`),
  incrementReferralCount: db.prepare(`
    UPDATE users SET referral_count = referral_count + 1 WHERE id = ?
  `),
  setCheckin: db.prepare(`
    UPDATE users SET checkin_streak = ?, last_checkin = ? WHERE id = ?
  `),
  isTaskDone: db.prepare(`
    SELECT 1 FROM tasks_completed WHERE user_id = ? AND task_id = ?
  `),
  markTaskDone: db.prepare(`
    INSERT OR IGNORE INTO tasks_completed (user_id, task_id, completed_at)
    VALUES (?, ?, ?)
  `),
  completedTaskIds: db.prepare(`
    SELECT task_id FROM tasks_completed WHERE user_id = ?
  `),
  hasPayment: db.prepare(`SELECT 1 FROM payments WHERE charge_id = ?`),
  insertPayment: db.prepare(`
    INSERT OR IGNORE INTO payments (charge_id, user_id, upgrade_id, stars_amount, created_at)
    VALUES (@charge_id, @user_id, @upgrade_id, @stars_amount, @created_at)
  `),
  purchaseCounts: db.prepare(`
    SELECT upgrade_id, COUNT(*) AS n FROM payments WHERE user_id = ? GROUP BY upgrade_id
  `),
  leaderboard: db.prepare(`
    SELECT id, username, first_name, balance
    FROM users
    ORDER BY balance DESC
    LIMIT ?
  `),
  rankOf: db.prepare(`
    SELECT COUNT(*) + 1 AS rank FROM users WHERE balance > (SELECT balance FROM users WHERE id = ?)
  `)
};

function getOrCreateUser({ id, username, first_name, referrer_id }) {
  let user = stmts.getUser.get(id);
  if (!user) {
    stmts.insertUser.run({
      id,
      username: username || null,
      first_name: first_name || null,
      referrer_id: referrer_id || null,
      created_at: Date.now()
    });
    user = stmts.getUser.get(id);

    // Credit the referrer, if any, exactly once (only happens on creation).
    if (referrer_id && referrer_id !== id) {
      const referrer = stmts.getUser.get(referrer_id);
      if (referrer) {
        const config = require("./config");
        stmts.addBalance.run(config.REFERRAL_BONUS, referrer_id);
        stmts.incrementReferralCount.run(referrer_id);
      }
    }
  } else {
    stmts.touchProfile.run({ id, username: username || null, first_name: first_name || null });
    user = stmts.getUser.get(id);
  }
  return user;
}

module.exports = { db, stmts, getOrCreateUser };
