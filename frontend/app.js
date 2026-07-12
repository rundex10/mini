(function () {
  "use strict";

  const API_BASE = (window.SPENCER_CONFIG && window.SPENCER_CONFIG.API_BASE_URL) || "http://localhost:3000";

  // Telegram.WebApp is injected by the telegram-web-app.js script. When this
  // page is opened outside Telegram (e.g. testing in a plain browser) that
  // object won't exist, so we fall back to a harmless stub and let the
  // backend's DEV_SKIP_AUTH mode handle authentication instead.
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : {
    ready() {}, expand() {}, initData: "", initDataUnsafe: {},
    HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
    openTelegramLink() {}, showAlert(msg) { alert(msg); },
    setHeaderColor() {}, colorScheme: "dark"
  };

  tg.ready();
  tg.expand();
  if (tg.setHeaderColor) { try { tg.setHeaderColor("#1B140F"); } catch (e) {} }

  const state = {
    me: null,
    tasks: [],
    countdownTimer: null
  };

  // ---------------------------------------------------------------------
  // API helper — attaches Telegram's signed initData to every request so
  // the backend can verify who is calling.
  // ---------------------------------------------------------------------
  async function api(path, options = {}) {
    const res = await fetch(API_BASE + path, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-init-data": tg.initData || ""
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function showToast(message) {
    const el = document.getElementById("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove("show"), 2400);
  }

  function formatDuration(ms) {
    if (ms < 0) ms = 0;
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
  }

  function formatCoins(n) {
    return Math.floor(n).toLocaleString("id-ID");
  }

  // ---------------------------------------------------------------------
  // Tab navigation
  // ---------------------------------------------------------------------
  function initTabs() {
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const name = btn.dataset.tab;
        document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
        document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.dataset.screen === name));
        if (name === "board") loadLeaderboard();
        if (name === "tasks") loadTasks();
        if (name === "upgrade") loadUpgrades();
        if (name === "invite") loadReferral();
      });
    });
  }

  // ---------------------------------------------------------------------
  // Mine screen — the strata gauge is the visual signature of the app: a
  // vertical shaft divided into 24 hourly bands. As mining progresses the
  // bands fill from the top (surface) down to the bottom (deepest ore),
  // with a small drill marker sitting at the current depth.
  // ---------------------------------------------------------------------
  function renderGauge(fractionComplete, active) {
    const svg = document.getElementById("gaugeSvg");
    const bands = 24;
    const bandHeight = 220 / bands;
    let markup = "";

    for (let i = 0; i < bands; i++) {
      const y = i * bandHeight;
      const bandFilled = fractionComplete * bands > i;
      const partialFill = Math.max(0, Math.min(1, fractionComplete * bands - i));
      const color = bandFilled ? (active ? "var(--ember)" : "var(--gold)") : "var(--surface-2)";
      const opacity = bandFilled ? (0.55 + partialFill * 0.45) : 1;
      markup += `<rect x="8" y="${y.toFixed(2)}" width="44" height="${(bandHeight - 2).toFixed(2)}" rx="3" fill="${color}" opacity="${opacity.toFixed(2)}"></rect>`;
    }

    const drillY = Math.min(214, fractionComplete * 220);
    markup += `<polygon points="30,${drillY} 44,${drillY - 10} 44,${drillY + 10}" fill="var(--gold)"></polygon>`;

    svg.innerHTML = markup;
  }

  function stopCountdown() {
    if (state.countdownTimer) clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }

  function renderMineScreen() {
    const me = state.me;
    if (!me) return;

    document.getElementById("rateValue").textContent = me.miningRate;
    document.getElementById("balanceValue").textContent = formatCoins(me.balance);

    const btn = document.getElementById("mineActionBtn");
    const hint = document.getElementById("mineHint");
    const earnedEl = document.getElementById("earnedSoFar");
    const countdownEl = document.getElementById("countdown");

    stopCountdown();

    if (!me.miningActive) {
      renderGauge(0, false);
      earnedEl.textContent = "0";
      countdownEl.textContent = formatDuration(me.miningDurationMs);
      btn.textContent = "Mulai Menambang";
      btn.disabled = false;
      hint.textContent = "Tekan untuk memulai sesi 24 jam. Kamu tidak perlu membuka aplikasi terus — datang lagi setelah waktu habis untuk klaim.";
      btn.onclick = startMining;
      return;
    }

    if (me.miningReadyToClaim) {
      renderGauge(1, false);
      earnedEl.textContent = formatCoins(me.miningEarnedSoFar);
      countdownEl.textContent = "00:00:00";
      btn.textContent = `Klaim ${formatCoins(me.miningEarnedSoFar)} Koin`;
      btn.disabled = false;
      hint.textContent = "Sesi selesai! Klaim koinmu lalu mulai sesi berikutnya.";
      btn.onclick = claimMining;
      return;
    }

    // Actively mining, still counting down.
    hint.textContent = "Sedang menambang. Layar ini akan memperbarui hitungan mundur secara otomatis.";
    btn.textContent = "Sedang Menambang…";
    btn.disabled = true;
    btn.onclick = null;

    const startedAt = Date.now() - (me.miningDurationMs - me.miningRemainingMs);
    function tick() {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, me.miningDurationMs - elapsed);
      const fraction = Math.min(1, elapsed / me.miningDurationMs);
      const earned = Math.floor((elapsed / (1000 * 60 * 60)) * me.miningRate);

      renderGauge(fraction, true);
      earnedEl.textContent = formatCoins(earned);
      countdownEl.textContent = formatDuration(remaining);

      if (remaining <= 0) {
        stopCountdown();
        refreshMe(); // pull fresh state so the claim button appears
      }
    }
    tick();
    state.countdownTimer = setInterval(tick, 1000);
  }

  async function startMining() {
    try {
      tg.HapticFeedback.impactOccurred("medium");
      state.me = await api("/api/mine/start", { method: "POST" });
      renderMineScreen();
      showToast("Penambangan dimulai. Sampai jumpa dalam 24 jam!");
    } catch (e) {
      showToast(e.message);
    }
  }

  async function claimMining() {
    try {
      const result = await api("/api/mine/claim", { method: "POST" });
      state.me = result.user;
      renderMineScreen();
      showToast(`+${formatCoins(result.earned)} koin diklaim!`);
      tg.HapticFeedback.notificationOccurred("success");
    } catch (e) {
      showToast(e.message);
    }
  }

  async function refreshMe() {
    state.me = await api("/api/me");
    renderMineScreen();
    document.getElementById("balanceValue").textContent = formatCoins(state.me.balance);
    document.getElementById("streakLine").textContent = `Streak: ${state.me.checkinStreak} hari`;
    document.getElementById("helloName").textContent = state.me.firstName || state.me.username || "Miner";
    document.getElementById("avatar").textContent = (state.me.firstName || state.me.username || "M").charAt(0).toUpperCase();
  }

  // ---------------------------------------------------------------------
  // Tasks screen
  // ---------------------------------------------------------------------
  const TASK_LINKS = {
    join_channel: "https://t.me/your_channel",
    join_group: "https://t.me/your_group",
    follow_x: "https://x.com/your_handle"
  };

  async function loadTasks() {
    try {
      const data = await api("/api/tasks");
      state.tasks = data.tasks;
      document.getElementById("checkinSub").textContent = `Streak ${data.checkinStreak} hari`;
      renderTasks();
    } catch (e) {
      showToast(e.message);
    }
  }

  function renderTasks() {
    const list = document.getElementById("taskList");
    list.innerHTML = "";
    state.tasks.forEach((task) => {
      const item = document.createElement("div");
      item.className = "task-item";

      const info = document.createElement("div");
      info.className = "task-info";
      info.innerHTML = `
        <p class="task-title">${task.title}</p>
        <p class="task-desc">${task.description}</p>
        <span class="task-reward">+${task.reward} koin</span>
      `;
      if (task.progress) {
        const pct = Math.min(100, (task.progress.current / task.progress.target) * 100);
        const bar = document.createElement("div");
        bar.className = "task-progress-bar";
        bar.innerHTML = `<div class="task-progress-fill" style="width:${pct}%"></div>`;
        info.appendChild(bar);
        const label = document.createElement("p");
        label.className = "task-desc";
        label.style.marginTop = "4px";
        label.textContent = `${task.progress.current}/${task.progress.target} teman`;
        info.appendChild(label);
      }

      const btn = document.createElement("button");
      btn.className = "task-btn";
      if (task.completed) {
        btn.textContent = "Selesai";
        btn.classList.add("done");
        btn.disabled = true;
      } else if (task.type === "referral") {
        const ready = task.progress && task.progress.current >= task.progress.target;
        btn.textContent = ready ? "Klaim" : "Belum cukup";
        btn.disabled = !ready;
        if (ready) btn.classList.add("primary");
        btn.onclick = () => completeTask(task.id, btn);
      } else if (task.type === "manual") {
        btn.textContent = "Buka & Konfirmasi";
        btn.classList.add("primary");
        btn.onclick = () => {
          if (TASK_LINKS[task.id]) tg.openTelegramLink ? window.open(TASK_LINKS[task.id], "_blank") : window.open(TASK_LINKS[task.id]);
          completeTask(task.id, btn);
        };
      } else {
        // verified_channel / verified_group
        btn.textContent = "Gabung & Verifikasi";
        btn.classList.add("primary");
        btn.onclick = () => {
          if (TASK_LINKS[task.id]) window.open(TASK_LINKS[task.id], "_blank");
          completeTask(task.id, btn);
        };
      }

      item.appendChild(info);
      item.appendChild(btn);
      list.appendChild(item);
    });
  }

  async function completeTask(taskId, btnEl) {
    btnEl.disabled = true;
    const originalText = btnEl.textContent;
    btnEl.textContent = "Memverifikasi…";
    try {
      const result = await api(`/api/tasks/${taskId}/complete`, { method: "POST" });
      showToast(`+${result.reward} koin!`);
      tg.HapticFeedback.notificationOccurred("success");
      state.me = result.user;
      renderMineScreen();
      await loadTasks();
    } catch (e) {
      showToast(e.message);
      btnEl.disabled = false;
      btnEl.textContent = originalText;
    }
  }

  document.getElementById("checkinBtn").addEventListener("click", async () => {
    try {
      const result = await api("/api/checkin", { method: "POST" });
      showToast(`+${result.reward} koin — streak ${result.streak} hari`);
      state.me = result.user;
      renderMineScreen();
      document.getElementById("checkinSub").textContent = `Streak ${result.streak} hari`;
      document.getElementById("streakLine").textContent = `Streak: ${result.streak} hari`;
    } catch (e) {
      showToast(e.message);
    }
  });

  // ---------------------------------------------------------------------
  // Leaderboard screen
  // ---------------------------------------------------------------------
  async function loadLeaderboard() {
    try {
      const data = await api("/api/leaderboard");
      document.getElementById("myRankLine").textContent = `Peringkatmu: #${data.myRank}`;
      const list = document.getElementById("leaderboardList");
      list.innerHTML = "";
      data.top.forEach((row) => {
        const li = document.createElement("li");
        li.innerHTML = `
          <span class="lb-rank">${row.rank}</span>
          <span class="lb-name">${row.name}</span>
          <span class="lb-balance">${formatCoins(row.balance)}</span>
        `;
        list.appendChild(li);
      });
    } catch (e) {
      showToast(e.message);
    }
  }

  // ---------------------------------------------------------------------
  // Upgrades screen — hashrate boosts paid with Telegram Stars.
  // Flow: ask backend for an invoice link -> hand it to Telegram's native
  // openInvoice() -> Telegram handles the whole payment UI itself -> once
  // paid, Telegram calls OUR BOT'S WEBHOOK (not this page) to confirm the
  // charge, which is what actually credits the hashrate. We just refresh
  // state afterwards to reflect it.
  // ---------------------------------------------------------------------
  async function loadUpgrades() {
    try {
      const data = await api("/api/upgrades");
      document.getElementById("currentRateLine").textContent = `${data.miningRate} koin/jam`;
      renderUpgrades(data.upgrades);
    } catch (e) {
      showToast(e.message);
    }
  }

  function renderUpgrades(upgrades) {
    const list = document.getElementById("upgradeList");
    list.innerHTML = "";
    upgrades.forEach((u) => {
      const item = document.createElement("div");
      item.className = "upgrade-item";

      const info = document.createElement("div");
      info.className = "upgrade-info";
      info.innerHTML = `
        <p class="upgrade-title">${u.title} ${u.owned > 0 ? `<span class="upgrade-owned">Dimiliki ${u.owned}x</span>` : ""}</p>
        <p class="upgrade-desc">${u.description}</p>
        <span class="upgrade-boost">+${u.rateBoost} koin/jam</span>
      `;

      const btn = document.createElement("button");
      btn.className = "upgrade-btn";
      btn.innerHTML = `<span class="star">⭐</span> ${u.costStars}`;
      btn.onclick = () => buyUpgrade(u.id, btn);

      item.appendChild(info);
      item.appendChild(btn);
      list.appendChild(item);
    });
  }

  async function buyUpgrade(upgradeId, btnEl) {
    btnEl.disabled = true;
    const original = btnEl.innerHTML;
    btnEl.textContent = "Menyiapkan…";
    try {
      const { link } = await api(`/api/upgrades/${upgradeId}/invoice`, { method: "POST" });

      if (typeof tg.openInvoice === "function") {
        tg.openInvoice(link, async (status) => {
          btnEl.disabled = false;
          btnEl.innerHTML = original;
          if (status === "paid") {
            showToast("Pembayaran berhasil! Menyesuaikan laju tambang…");
            tg.HapticFeedback.notificationOccurred("success");
            // The webhook that actually credits the boost is called by
            // Telegram server-to-server and may land a moment after this
            // callback fires, so we poll briefly instead of refreshing once.
            for (let i = 0; i < 5; i++) {
              await new Promise((r) => setTimeout(r, 1200));
              await loadUpgrades();
              await refreshMe();
            }
          } else if (status === "cancelled") {
            showToast("Pembayaran dibatalkan.");
          } else if (status === "failed") {
            showToast("Pembayaran gagal. Coba lagi.");
          }
        });
      } else {
        // Fallback for testing outside Telegram, where openInvoice doesn't exist.
        window.open(link, "_blank");
        showToast("Selesaikan pembayaran di tab yang terbuka, lalu kembali ke sini.");
        btnEl.disabled = false;
        btnEl.innerHTML = original;
      }
    } catch (e) {
      showToast(e.message);
      btnEl.disabled = false;
      btnEl.innerHTML = original;
    }
  }

  // ---------------------------------------------------------------------
  // Invite screen
  // ---------------------------------------------------------------------
  async function loadReferral() {
    try {
      const data = await api("/api/referral-link");
      document.getElementById("referralLink").textContent = data.link;
      document.getElementById("referralCountLine").textContent = `${data.referralCount} teman diundang`;

      document.getElementById("copyLinkBtn").onclick = async () => {
        try {
          await navigator.clipboard.writeText(data.link);
          showToast("Tautan disalin!");
        } catch (e) {
          showToast("Tidak bisa menyalin otomatis — salin manual dari kotak di atas.");
        }
      };
      document.getElementById("shareLinkBtn").onclick = () => {
        const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(data.link)}&text=${encodeURIComponent("Ayo mulai menambang bareng aku di Spencer!")}`;
        if (tg.openTelegramLink) tg.openTelegramLink(shareUrl);
        else window.open(shareUrl, "_blank");
      };
    } catch (e) {
      showToast(e.message);
    }
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  async function boot() {
    initTabs();
    try {
      await refreshMe();
      await loadTasks();
    } catch (e) {
      showToast("Gagal memuat data: " + e.message);
    }
  }

  boot();
})();
