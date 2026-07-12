// ---------------------------------------------------------------------------
// Central game-balance configuration. Tweak these numbers to rebalance the
// whole app without touching any logic elsewhere.
// ---------------------------------------------------------------------------

module.exports = {
  // How long a single mining session runs before it must be claimed, in ms.
  MINING_DURATION_MS: 24 * 60 * 60 * 1000, // 24 hours

  // Base coins earned per hour of mining, before any upgrades.
  BASE_MINING_RATE_PER_HOUR: 100,

  // How much permanent +coins/hour a completed "boost" task grants.
  TASK_RATE_BOOST: 10,

  // Referral reward paid to the *referrer* the moment a new user opens the
  // app through their link.
  REFERRAL_BONUS: 250,

  // Daily check-in reward, and the streak bonus added per consecutive day
  // (capped at MAX_STREAK_DAYS).
  CHECKIN_BASE_REWARD: 100,
  CHECKIN_STREAK_STEP: 20,
  MAX_STREAK_DAYS: 10,

  // Static list of tasks shown in the Tasks panel.
  // type: "verified_channel" | "verified_group" | "manual" | "referral" | "checkin"
  TASKS: [
    {
      id: "join_channel",
      type: "verified_channel",
      title: "Join the Spencer announcement channel",
      description: "Stay updated on drops and listing news.",
      reward: 500,
      boostsRate: true
    },
    {
      id: "join_group",
      type: "verified_group",
      title: "Join the Spencer community group",
      description: "Chat with other miners.",
      reward: 500,
      boostsRate: true
    },
    {
      id: "follow_x",
      type: "manual",
      title: "Follow Spencer on X",
      description: "Tap the link, follow, then come back and confirm.",
      reward: 300,
      boostsRate: false
    },
    {
      id: "invite_3",
      type: "referral",
      title: "Invite 3 friends",
      description: "Share your invite link. Reward unlocks automatically.",
      reward: 1000,
      threshold: 3,
      boostsRate: true
    },
    {
      id: "daily_checkin",
      type: "checkin",
      title: "Daily check-in",
      description: "Come back every day to build your streak.",
      reward: 100, // base reward; actual payout uses CHECKIN_BASE_REWARD + streak bonus
      boostsRate: false
    }
  ],

  // Hashrate upgrades, purchasable with Telegram Stars (currency "XTR").
  // Each purchase permanently adds `rateBoost` coins/hour and is repeatable
  // (buying the same upgrade twice stacks). costStars is a whole number of
  // Telegram Stars — Stars have no decimal subunits.
  UPGRADES: [
    {
      id: "rig_basic",
      title: "Rig Tambang Dasar",
      description: "Unit penambang entry-level. +50 koin/jam permanen.",
      rateBoost: 50,
      costStars: 50
    },
    {
      id: "rig_advanced",
      title: "Rig Tambang Lanjutan",
      description: "GPU lebih banyak, lebih dingin. +150 koin/jam permanen.",
      rateBoost: 150,
      costStars: 120
    },
    {
      id: "rig_pro",
      title: "Rig Tambang Pro",
      description: "Farm mini di kamar kosanmu. +400 koin/jam permanen.",
      rateBoost: 400,
      costStars: 300
    },
    {
      id: "cooling_system",
      title: "Sistem Pendingin Industrial",
      description: "Biar rig gak meleleh. +1000 koin/jam permanen.",
      rateBoost: 1000,
      costStars: 650
    }
  ]
};
