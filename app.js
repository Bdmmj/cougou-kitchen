(() => {
  "use strict";

  /* =========================================================
     Constants
     ========================================================= */

  const MEALS = [
    { key: "breakfast", label: "早餐", short: "早" },
    { key: "lunch", label: "午餐", short: "午" },
    { key: "dinner", label: "晚餐", short: "晚" },
    { key: "snack", label: "加餐", short: "加" },
  ];
  const MEAL_KEYS = MEALS.map((meal) => meal.key);
  const DAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const DAY_SHORT = ["一", "二", "三", "四", "五", "六", "日"];
  const TARGET_MIN = 500;
  const TARGET_MAX = 6000;
  const FOOD_MAX = 5000;
  const ROLE_LABELS = { owner: "主人", editor: "共建者", viewer: "观看者" };
  const ROLE_INVITE_LABELS = { editor: "一起编辑", viewer: "只能观看" };
  const CATEGORY_META = {
    staple: { label: "主食", color: "var(--cat-staple)" },
    protein: { label: "蛋白质", color: "var(--cat-protein)" },
    vegetable: { label: "蔬菜", color: "var(--cat-vegetable)" },
    fruit: { label: "水果", color: "var(--cat-fruit)" },
    drink: { label: "饮品乳品", color: "var(--cat-drink)" },
    other: { label: "其他", color: "var(--cat-other)" },
  };
  const ACTIVE_KITCHEN_KEY = "cougou.activeKitchen.v2";
  const SAMPLE_DISMISSED_PREFIX = "cougou.sampleDismissed.";
  const CLIENT_ID = getClientId();

  const numberFormatter = new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
  });

  /* =========================================================
     State & DOM
     ========================================================= */

  const state = {
    user: null,
    kitchens: [],
    activeKitchenId: null,
    kitchen: null,
    members: [],
    invites: [],
    plan: null,
    ingredients: [],
    weekStart: startOfWeek(new Date()),
    view: "planner",
    authMode: "login",
    pendingInviteCode: null,
    invitePreview: null,
    inviteError: null,
    generatedInviteLink: null,
    generatedInviteRole: null,
    ingredientCategory: "all",
    ingredientQuery: "",
    stream: null,
    loadSequence: 0,
    planSequence: 0,
    tableSequence: 0,
    loading: false,
    confirmAction: null,
    quickIngredient: null,
    remoteToastAt: 0,
    realtime: true,
    pollTimer: null,
    pollTick: 0,
    activeDayIndex: 0,
    renderedWeekStart: null,
    pendingPlannerJump: false,
    ingredientBulkMode: false,
    selectedIngredients: new Set(),
    clearMode: "week",
    clearDate: null,
    presetQuery: "",
    presetCategory: "all",
    presetPanelOpen: false,
    wellnessWeekStart: null,
    wellnessDate: null,
    wellnessDays: null,
    wellnessLoading: false,
    messages: [],
    table: null,
    tableWeekStart: null,
    tableLoading: false,
    tableError: null,
    pollVoting: false,
    templates: [],
    favorites: [],
    recipeToolsLoaded: false,
    recipeTab: "templates",
    cookDate: null,
    favoriteSource: null,
    pendingFavorite: null,
    pendingTemplate: null,
  };

  const dom = {};
  let activeModal = null;
  let modalReturnFocus = null;
  let editContext = null;
  let ingredientEditId = null;
  let toastTimer = null;
  let toastHideTimer = null;
  let bootHideTimer = null;
  let remoteSyncTimer = null;
  let sessionExpiring = false;
  const modalTimers = new WeakMap();

  /* =========================================================
     General utilities
     ========================================================= */

  function getClientId() {
    try {
      let id = sessionStorage.getItem("cougou.clientId");
      if (!id) {
        id = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
        sessionStorage.setItem("cougou.clientId", id);
      }
      return id;
    } catch (error) {
      return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    }
  }

  const pad = (value) => String(value).padStart(2, "0");

  function dateKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function parseDateKey(key) {
    if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
    const parts = key.split("-").map(Number);
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    return dateKey(date) === key ? date : null;
  }

  function startOfWeek(date) {
    const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const offset = (result.getDay() + 6) % 7;
    result.setDate(result.getDate() - offset);
    return result;
  }

  function addDays(date, amount) {
    const result = new Date(date);
    result.setDate(result.getDate() + amount);
    return result;
  }

  function getWeekDates(monday) {
    return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
  }

  function getWeekdayIndex(date) {
    return (date.getDay() + 6) % 7;
  }

  function getISOWeekInfo(date) {
    const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = utc.getUTCDay() || 7;
    utc.setUTCDate(utc.getUTCDate() + 4 - day);
    const year = utc.getUTCFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const week = Math.ceil(((utc - yearStart) / 86400000 + 1) / 7);
    return { week, year };
  }

  function isCurrentWeek(monday) {
    return dateKey(monday) === dateKey(startOfWeek(new Date()));
  }

  function formatRange(start, end) {
    const startYear = start.getFullYear();
    const endYear = end.getFullYear();
    if (startYear !== endYear) {
      return `${startYear}年${start.getMonth() + 1}月${start.getDate()}日 — ${endYear}年${end.getMonth() + 1}月${end.getDate()}日`;
    }
    if (start.getMonth() === end.getMonth()) {
      return `${start.getMonth() + 1}月${start.getDate()}日 — ${end.getDate()}日`;
    }
    return `${start.getMonth() + 1}月${start.getDate()}日 — ${end.getMonth() + 1}月${end.getDate()}日`;
  }

  function formatShortDate(date) {
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  function formatDayLong(key) {
    const date = parseDateKey(key);
    if (!date) return "";
    return `${DAY_NAMES[getWeekdayIndex(date)]} ${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function formatCreatedAt(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function formatMessageTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const sameYear = date.getFullYear() === new Date().getFullYear();
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    return sameYear
      ? `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
      : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  }

  function formatExpiry(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "即将到期";
    return `${date.getMonth() + 1}月${date.getDate()}日到期`;
  }

  function formatNumber(value) {
    return numberFormatter.format(value);
  }

  function escapeHtml(value) {
    const replacements = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return String(value).replace(/[&<>"']/g, (character) => replacements[character]);
  }

  function firstCharacter(value) {
    return Array.from(String(value || "厨").trim())[0] || "厨";
  }

  function roleLabel(role) {
    return ROLE_LABELS[role] || "成员";
  }

  function categoryLabel(category) {
    return CATEGORY_META[category]?.label || "其他";
  }

  function formatTarget(target) {
    return formatNumber(target || 1800);
  }

  function getTarget() {
    return state.kitchen?.dailyTarget || state.plan?.dailyTarget || 1800;
  }

  function canEdit() {
    return Boolean(state.kitchen && state.kitchen.role !== "viewer");
  }

  function isOwner() {
    return state.kitchen?.role === "owner";
  }

  function getActiveKitchenStored() {
    try {
      return localStorage.getItem(ACTIVE_KITCHEN_KEY);
    } catch (error) {
      return null;
    }
  }

  function storeActiveKitchen(id) {
    try {
      if (id) localStorage.setItem(ACTIVE_KITCHEN_KEY, id);
    } catch (error) {
      // Storage can be unavailable; the session still works.
    }
  }

  function hasDismissedSample(kitchenId) {
    try {
      return localStorage.getItem(`${SAMPLE_DISMISSED_PREFIX}${kitchenId}`) === "1";
    } catch (error) {
      return false;
    }
  }

  function dismissSampleFor(kitchenId) {
    try {
      localStorage.setItem(`${SAMPLE_DISMISSED_PREFIX}${kitchenId}`, "1");
    } catch (error) {
      // Ignore.
    }
  }

  function getInviteCodeFromLocation() {
    const match = location.pathname.match(/^\/join\/([A-Za-z0-9_-]+)\/?$/);
    if (match) return match[1];
    if (location.pathname === "/join") {
      return new URLSearchParams(location.search).get("code");
    }
    return null;
  }

  function extractInviteCode(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed) return "";
    const pathMatch = trimmed.match(/\/join\/([A-Za-z0-9_-]+)/);
    if (pathMatch) return pathMatch[1];
    return trimmed.replace(/[^A-Za-z0-9_-]/g, "");
  }

  function viewFromHash() {
    const raw = location.hash.replace(/^#\/?/, "").split("?")[0];
    if (raw === "messages") return "table";
    return ["planner", "ingredients", "table", "wellness", "kitchen"].includes(raw)
      ? raw
      : "planner";
  }

  /* =========================================================
     API
     ========================================================= */

  async function api(path, { method = "GET", body = null, allowUnauthorized = false } = {}) {
    const headers = { "x-cougou-client-id": CLIENT_ID };
    if (method !== "GET") headers["x-cougou-client"] = "web";
    if (body !== null) headers["Content-Type"] = "application/json";

    let response;
    try {
      response = await fetch(path, {
        method,
        headers,
        credentials: "same-origin",
        body: body !== null ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      const networkError = new Error("网络连接失败，请确认本地服务仍在运行。");
      networkError.status = 0;
      throw networkError;
    }

    let data = null;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        data = await response.json();
      } catch (error) {
        data = null;
      }
    }

    if (response.status === 401 && state.user && !allowUnauthorized) {
      handleSessionExpired();
    }

    if (!response.ok) {
      const requestError = new Error(data?.error || `请求失败（${response.status}）`);
      requestError.status = response.status;
      requestError.data = data;
      throw requestError;
    }

    return data;
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    clearTimeout(toastHideTimer);
    dom.toastText.textContent = message;
    dom.toast.hidden = false;

    requestAnimationFrame(() => {
      dom.toast.classList.add("is-visible");
    });

    toastTimer = setTimeout(() => {
      dom.toast.classList.remove("is-visible");
      toastHideTimer = setTimeout(() => {
        dom.toast.hidden = true;
      }, 240);
    }, 2900);
  }

  function showBoot() {
    clearTimeout(bootHideTimer);
    dom.bootScreen.hidden = false;
    dom.bootScreen.classList.remove("is-hidden");
  }

  function hideBoot() {
    dom.bootScreen.classList.add("is-hidden");
    clearTimeout(bootHideTimer);
    bootHideTimer = setTimeout(() => {
      dom.bootScreen.hidden = true;
    }, 340);
  }

  /* =========================================================
     Authentication UI
     ========================================================= */

  function setAuthMode(mode) {
    state.authMode = mode;
    const isRegister = mode === "register";
    dom.displayNameField.hidden = !isRegister;
    dom.authDisplayName.required = isRegister;
    dom.authTabLogin.classList.toggle("is-active", !isRegister);
    dom.authTabRegister.classList.toggle("is-active", isRegister);
    dom.authTabLogin.setAttribute("aria-selected", String(!isRegister));
    dom.authTabRegister.setAttribute("aria-selected", String(isRegister));
    dom.authKicker.textContent = isRegister ? "OPEN YOUR KITCHEN" : "WELCOME BACK";
    dom.authTitle.textContent = isRegister ? "开一间自己的厨房" : "回到你的厨房";
    dom.authSub.textContent = isRegister
      ? "先为你建好第一间厨房，再邀请朋友一起添菜。"
      : "登录后继续安排这一周的每一餐。";
    dom.authSubmitLabel.textContent = isRegister ? "创建账号" : "登录";
    dom.authPassword.autocomplete = isRegister ? "new-password" : "current-password";
    hideAuthError();
  }

  function showAuthError(message) {
    dom.authError.textContent = message;
    dom.authError.hidden = false;
  }

  function hideAuthError() {
    dom.authError.textContent = "";
    dom.authError.hidden = true;
  }

  function renderAuthInviteBanner() {
    if (!state.pendingInviteCode) {
      dom.authInviteBanner.hidden = true;
      return;
    }

    dom.authInviteBanner.hidden = false;
    dom.authInviteBanner.classList.toggle("is-error", Boolean(state.inviteError));

    if (state.invitePreview) {
      const invite = state.invitePreview;
      dom.authInviteTitle.textContent = `${invite.inviterName} 邀请你加入「${invite.kitchenName}」`;
      dom.authInviteText.textContent = `加入后身份：${ROLE_INVITE_LABELS[invite.role] || "观看者"}。登录或创建账号后会自动加入。`;
    } else if (state.inviteError) {
      dom.authInviteTitle.textContent = "这份邀请暂时不可用";
      dom.authInviteText.textContent = state.inviteError;
    } else {
      dom.authInviteTitle.textContent = "你收到一份厨房邀请";
      dom.authInviteText.textContent = "正在确认邀请…";
    }
  }

  async function loadInvitePreview(code) {
    state.pendingInviteCode = code;
    state.invitePreview = null;
    state.inviteError = null;
    try {
      const data = await api(`/api/invites/${encodeURIComponent(code)}`, {
        allowUnauthorized: true,
      });
      state.invitePreview = data.invite;
    } catch (error) {
      state.inviteError = error.message;
    }
    renderAuthInviteBanner();
  }

  async function acceptPendingInvite() {
    if (!state.pendingInviteCode) return null;
    try {
      const data = await api(`/api/invites/${encodeURIComponent(state.pendingInviteCode)}/accept`, {
        method: "POST",
        body: {},
      });
      state.kitchens = data.kitchens || state.kitchens;
      state.activeKitchenId = data.kitchenId;
      storeActiveKitchen(data.kitchenId);
      const result = {
        kitchenId: data.kitchenId,
        kitchenName: data.kitchenName,
        joined: data.joined,
      };
      state.pendingInviteCode = null;
      state.invitePreview = null;
      state.inviteError = null;
      history.replaceState(null, "", "/#/planner");
      return result;
    } catch (error) {
      state.pendingInviteCode = null;
      state.invitePreview = null;
      state.inviteError = error.message;
      history.replaceState(null, "", "/#/planner");
      return { error: error.message };
    }
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    if (dom.authSubmit.disabled) return;

    const mode = state.authMode;
    const username = dom.authUsername.value.trim();
    const password = dom.authPassword.value;
    const displayName = dom.authDisplayName.value.trim();

    hideAuthError();
    if (mode === "register" && !displayName) {
      showAuthError("先告诉朋友怎么称呼你吧。");
      dom.authDisplayName.focus();
      return;
    }
    if (!username || !password) {
      showAuthError("请输入用户名和密码。");
      (username ? dom.authPassword : dom.authUsername).focus();
      return;
    }
    if (mode === "register" && password.length < 8) {
      showAuthError("密码至少需要 8 位。");
      dom.authPassword.focus();
      return;
    }

    setAuthBusy(true);
    try {
      const data = await api(
        mode === "register" ? "/api/auth/register" : "/api/auth/login",
        {
          method: "POST",
          body:
            mode === "register"
              ? { username, password, displayName }
              : { username, password },
          allowUnauthorized: true,
        },
      );

      state.user = data.user;
      state.kitchens = data.kitchens;
      dom.authForm.reset();
      setAuthMode("login");

      let inviteResult = null;
      if (state.pendingInviteCode) {
        inviteResult = await acceptPendingInvite();
      }

      showBoot();
      dom.bootScreen.querySelector(".boot-copy").textContent = "正在打开你的厨房…";
      const preferredId =
        inviteResult?.kitchenId ||
        getActiveKitchenStored() ||
        state.kitchens[0]?.id ||
        null;

      const loaded = await enterAppWithKitchen(preferredId);
      if (!loaded) {
        showAuthError("厨房加载失败，请稍后重试。");
        dom.appView.hidden = true;
        dom.authView.hidden = false;
        hideBoot();
        return;
      }

      hideBoot();
      if (inviteResult?.kitchenId) {
        showToast(
          inviteResult.joined
            ? `已加入「${inviteResult.kitchenName}」`
            : `已切换到「${inviteResult.kitchenName}」`,
        );
      } else if (inviteResult?.error) {
        showToast(inviteResult.error);
      }
    } catch (error) {
      showAuthError(error.message);
      if (error.status === 429) {
        dom.authPassword.focus();
      }
    } finally {
      setAuthBusy(false);
    }
  }

  function setAuthBusy(isBusy) {
    dom.authSubmit.disabled = isBusy;
    dom.authSubmit.classList.toggle("is-loading", isBusy);
    dom.authSubmitLabel.textContent = isBusy
      ? state.authMode === "register"
        ? "正在创建…"
        : "正在登录…"
      : state.authMode === "register"
        ? "创建账号"
        : "登录";
  }

  function showAuth() {
    disconnectStream();
    state.wellnessWeekStart = null;
    state.wellnessDate = null;
    state.wellnessDays = null;
    state.wellnessLoading = false;
    state.messages = [];
    dom.bootScreen.hidden = true;
    dom.appView.hidden = true;
    dom.authView.hidden = false;
    document.body.classList.add("auth-mode");
    closeAllPopovers();
    hideAuthError();
    setAuthMode(state.authMode === "register" ? "register" : "login");
    renderAuthInviteBanner();
    // Do not pop the mobile keyboard before the user taps a field.
    requestAnimationFrame(() => {
      if (window.matchMedia("(max-width: 880px)").matches) return;
      dom.authUsername.focus({ preventScroll: true });
    });
  }

  async function logout() {
    try {
      await api("/api/auth/logout", {
        method: "POST",
        body: {},
        allowUnauthorized: true,
      });
    } catch (error) {
      // Even if the request fails, clear the local view.
    }

    disconnectStream();
    state.user = null;
    state.kitchens = [];
    state.activeKitchenId = null;
    state.kitchen = null;
    state.plan = null;
    state.ingredients = [];
    state.members = [];
    state.invites = [];
    state.pendingInviteCode = null;
    state.invitePreview = null;
    state.inviteError = null;
    state.authMode = "login";
    history.replaceState(null, "", "/");
    closeAllPopovers();
    dom.authUsername.value = "";
    dom.authPassword.value = "";
    dom.authDisplayName.value = "";
    showAuth();
  }

  function handleSessionExpired() {
    if (sessionExpiring) return;
    sessionExpiring = true;
    disconnectStream();
    state.user = null;
    state.kitchen = null;
    state.plan = null;
    dom.appView.hidden = true;
    dom.authView.hidden = false;
    showAuth();
    showAuthError("登录已过期，请重新登录。");
    setTimeout(() => {
      sessionExpiring = false;
    }, 700);
  }

  /* =========================================================
     App entry & kitchen loading
     ========================================================= */

  async function ensureKitchenExists() {
    if (state.kitchens.length) return true;
    if (!state.user) return false;
    try {
      const data = await api("/api/kitchens", {
        method: "POST",
        body: { name: `${state.user.displayName}的厨房`.slice(0, 30) },
      });
      state.kitchens = data.kitchens;
      return true;
    } catch (error) {
      showToast(error.message);
      return false;
    }
  }

  async function enterAppWithKitchen(preferredId) {
    dom.authView.hidden = true;
    dom.appView.hidden = false;
    document.body.classList.remove("auth-mode");

    if (!(await ensureKitchenExists())) return false;

    const membershipIds = new Set(state.kitchens.map((kitchen) => kitchen.id));
    const storedId = getActiveKitchenStored();
    const candidates = [
      preferredId,
      membershipIds.has(storedId) ? storedId : null,
      state.kitchens[0]?.id,
    ].filter((id) => id && membershipIds.has(id));
    const seen = new Set();
    let loaded = false;

    for (const kitchenId of candidates) {
      if (seen.has(kitchenId)) continue;
      seen.add(kitchenId);
      try {
        await loadKitchenData(kitchenId, { initial: true });
        loaded = true;
        break;
      } catch (error) {
        if (error.status === 401) return false;
      }
    }

    if (!loaded) return false;

    if (location.pathname.startsWith("/join")) {
      history.replaceState(null, "", "/#/planner");
    }
    if (!location.hash) {
      history.replaceState(null, "", `${location.pathname}#/planner`);
    }
    if (location.hash === "#/messages") {
      history.replaceState(null, "", `${location.pathname}#/table`);
    }

    renderChrome();
    setView(viewFromHash(), { updateHash: false });
    hideBoot();
    return true;
  }

  async function loadKitchenData(kitchenId, { initial = false, resetWeek = false, silent = false } = {}) {
    const isChangingKitchen = state.activeKitchenId && state.activeKitchenId !== kitchenId;
    if (resetWeek || isChangingKitchen || initial) {
      state.weekStart = startOfWeek(new Date());
    }

    const sequence = ++state.loadSequence;
    if (!silent) {
      dom.appView.classList.add("is-loading");
      if (state.view === "planner") {
        dom.boardLoading.hidden = false;
        dom.weekBoard.setAttribute("aria-busy", "true");
      }
    }
    disconnectStream();

    try {
      const weekStartString = dateKey(state.weekStart);
      const [detail, plan, ingredientsData] = await Promise.all([
        api(`/api/kitchens/${encodeURIComponent(kitchenId)}`),
        api(
          `/api/kitchens/${encodeURIComponent(kitchenId)}/plan?weekStart=${encodeURIComponent(weekStartString)}`,
        ),
        api(`/api/kitchens/${encodeURIComponent(kitchenId)}/ingredients`),
      ]);

      if (sequence !== state.loadSequence) return false;

      state.activeKitchenId = kitchenId;
      state.kitchen = detail.kitchen;
      state.members = detail.members;
      state.invites = detail.invites || [];
      state.messages = detail.messages || [];
      state.plan = plan;
      state.ingredients = ingredientsData.ingredients || [];
      state.table = null;
      state.tableWeekStart = null;
      state.recipeToolsLoaded = false;
      state.generatedInviteLink = null;
      state.generatedInviteRole = null;
      storeActiveKitchen(kitchenId);

      connectStream(kitchenId);
      renderChrome();
      renderPlanner();
      renderIngredients();
      renderKitchen();
      return true;
    } finally {
      if (sequence === state.loadSequence) {
        dom.appView.classList.remove("is-loading");
        dom.boardLoading.hidden = true;
        dom.weekBoard.removeAttribute("aria-busy");
      }
    }
  }

  async function switchKitchen(kitchenId, { targetView = state.view } = {}) {
    if (!kitchenId) return;
    closeAllPopovers();
    if (kitchenId === state.activeKitchenId && state.kitchen) {
      if (targetView) navigate(targetView);
      return;
    }

    dom.appView.classList.add("is-loading");
    try {
      await loadKitchenData(kitchenId, { resetWeek: true });
      renderChrome();
      navigate(targetView || "planner");
    } catch (error) {
      showToast(error.message);
      if (error.status === 404 || error.status === 403) {
        await handleKitchenAccessLost();
      }
    } finally {
      dom.appView.classList.remove("is-loading");
    }
  }

  async function refreshMe() {
    try {
      const data = await api("/api/auth/me");
      state.user = data.user;
      state.kitchens = data.kitchens;
      renderChrome();
      return data;
    } catch (error) {
      return null;
    }
  }

  async function handleKitchenAccessLost() {
    showToast("你已不在这个厨房里，已为你切换到其他厨房。");
    disconnectStream();
    state.kitchen = null;
    state.plan = null;
    const data = await refreshMe();
    if (!data || !state.kitchens.length) {
      showAuth();
      return;
    }
    const fallback = state.kitchens[0];
    await switchKitchen(fallback.id, { targetView: "kitchen" });
  }

  async function refreshKitchenDetail({ render = true } = {}) {
    if (!state.kitchen) return;
    try {
      const detail = await api(`/api/kitchens/${encodeURIComponent(state.kitchen.id)}`);
      state.kitchen = detail.kitchen;
      state.members = detail.members;
      state.invites = detail.invites || [];
      state.messages = detail.messages || [];
      if (render) {
        renderChrome();
        renderKitchen();
        renderMessages();
        renderPlanner();
        renderIngredients();
      }
    } catch (error) {
      if (error.status === 404 || error.status === 403) {
        await handleKitchenAccessLost();
      }
    }
  }

  /* =========================================================
     Stream sync
     ========================================================= */

  function connectStream(kitchenId) {
    disconnectStream();
    if (state.realtime === false) {
      startPolling();
      setSyncStatus(true);
      return;
    }
    if (!("EventSource" in window)) {
      startPolling();
      setSyncStatus(true);
      return;
    }

    try {
      const stream = new EventSource(
        `/api/kitchens/${encodeURIComponent(kitchenId)}/events?clientId=${encodeURIComponent(CLIENT_ID)}`,
      );
      state.stream = stream;
      setSyncStatus(false);

      stream.addEventListener("ready", () => {
        setSyncStatus(true);
      });
      stream.addEventListener("kitchen", (event) => {
        setSyncStatus(true);
        handleRemoteEvent(event);
      });
      stream.onerror = () => {
        setSyncStatus(false);
      };
      stream.onopen = () => {
        setSyncStatus(true);
      };
    } catch (error) {
      setSyncStatus(false);
    }
  }

  function disconnectStream() {
    if (state.stream) {
      state.stream.close();
      state.stream = null;
    }
    stopPolling();
    setSyncStatus(false);
  }

  function startPolling() {
    stopPolling();
    state.pollTick = 0;
    state.pollTimer = setInterval(async () => {
      if (document.hidden || !state.user || !state.kitchen) return;
      state.pollTick += 1;
      try {
        if (state.view === "planner") {
          await refreshPlan({ silent: true });
        } else if (state.view === "ingredients") {
          await refreshIngredients({ silent: true });
        } else if (state.view === "table") {
          await loadTable({ silent: true });
        } else if (state.view === "kitchen") {
          await refreshKitchenDetail();
        }
        if (state.pollTick % 4 === 0) {
          await refreshMe();
        }
      } catch (error) {
        // Polling is best-effort; the next tick retries.
      }
    }, 10000);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function setSyncStatus(online) {
    if (!dom.syncStatus) return;
    const polling = state.realtime === false;
    dom.syncStatus.classList.toggle("is-offline", !polling && !online);
    dom.syncStatus.innerHTML = `<i></i>${polling ? "定时同步" : online ? "实时共享" : "正在重连"}`;
  }

  function handleRemoteEvent(event) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    if (!data || data.clientId === CLIENT_ID) return;

    if (data.type === "plan") {
      if (data.weekStart !== dateKey(state.weekStart)) return;
      scheduleRemoteSync("plan");
      return;
    }
    if (data.type === "table") {
      scheduleRemoteSync("table");
      return;
    }
    if (data.type === "ingredients") {
      scheduleRemoteSync("ingredients");
      return;
    }
    if (data.type === "members" || data.type === "kitchen" || data.type === "messages") {
      scheduleRemoteSync("kitchen");
    }
  }

  function scheduleRemoteSync(kind) {
    clearTimeout(remoteSyncTimer);
    const now = Date.now();
    if (now - state.remoteToastAt > 4200 && !document.hidden) {
      state.remoteToastAt = now;
      showToast("厨房里有新的变化，已经同步。");
    }

    remoteSyncTimer = setTimeout(async () => {
      if (!state.kitchen) return;
      if (kind === "plan") {
        await refreshPlan({ silent: true });
      } else if (kind === "ingredients") {
        await refreshIngredients({ silent: true });
      } else if (kind === "table") {
        if (state.view === "table") {
          await loadTable({ silent: true });
        } else if (state.view === "planner") {
          await refreshPlan({ silent: true });
        }
      } else {
        await refreshKitchenDetail();
        await refreshMe();
      }
    }, 220);
  }

  /* =========================================================
     Chrome rendering
     ========================================================= */

  function renderChrome() {
    if (!state.user) return;
    const initial = firstCharacter(state.user.displayName || state.user.username);
    dom.userInitial.textContent = initial;
    dom.userMenuInitial.textContent = initial;
    dom.userMenuName.textContent = state.user.displayName;
    dom.userMenuUsername.textContent = `@${state.user.username}`;
    dom.adminLink.hidden = !state.user.isAdmin;
    dom.footerYear.textContent = String(new Date().getFullYear());

    if (!state.kitchen) {
      dom.kitchenSwitchName.textContent = "还没有厨房";
      dom.kitchenSwitchRole.textContent = "去创建一间";
      dom.kitchenAvatar.textContent = "厨";
      selectNav("kitchen");
      return;
    }

    const role = state.kitchen.role;
    dom.kitchenSwitchName.textContent = state.kitchen.name;
    dom.kitchenSwitchRole.textContent = `${roleLabel(role)} · ${state.kitchen.memberCount} 人`;
    dom.kitchenAvatar.textContent = firstCharacter(state.kitchen.name);
    dom.heroRoleBadge.textContent = roleLabel(role);
    dom.heroRoleBadge.dataset.role = role;

    dom.targetCurrent.textContent = formatTarget(getTarget());
    dom.targetButton.disabled = !canEdit();
    dom.targetButton.title = canEdit() ? "修改每日目标" : "只有共建者和主人可以修改目标";

    dom.readonlyBanner.hidden = canEdit();
    dom.clearWeek.hidden = !canEdit();
    dom.addIngredientButton.hidden = !canEdit();
    dom.plannerTools.hidden = !canEdit();
    dom.tableAddGrocery.hidden = !canEdit();
    dom.groceryEmptyAction.hidden = !canEdit();
    if (canEdit()) {
      dom.plannerSub.innerHTML = '点任意食物编辑，按每餐的 <span>＋</span> 添加新食物。';
    } else {
      dom.plannerSub.textContent = "这是共享的周食谱，只有主人和共建者可以编辑。";
    }
    dom.emptyAddIngredient.hidden = !canEdit();
    dom.ingredientRoleNote.textContent = canEdit()
      ? "食材库由厨房成员共享"
      : "你以观看者身份查看这间厨房的食材库";

    renderKitchenMenu();
    selectNav(state.view);
    document.title = `${state.kitchen.name} · 凑狗厨房`;
  }

  function renderKitchenMenu() {
    if (!state.kitchens.length) {
      dom.kitchenMenuList.innerHTML =
        '<p class="menu-empty">还没有厨房。去创建一间吧。</p>';
      return;
    }
    dom.kitchenMenuList.innerHTML = state.kitchens
      .map(
        (kitchen) => `
          <button class="kitchen-menu-item${kitchen.id === state.activeKitchenId ? " is-current" : ""}" type="button" data-kitchen-id="${escapeHtml(kitchen.id)}">
            <span class="kitchen-menu-avatar">${escapeHtml(firstCharacter(kitchen.name))}</span>
            <span class="kitchen-menu-copy">
              <strong>${escapeHtml(kitchen.name)}</strong>
              <small>${roleLabel(kitchen.role)} · ${kitchen.memberCount} 位成员</small>
            </span>
            ${
              kitchen.id === state.activeKitchenId
                ? '<svg class="icon kitchen-menu-check" aria-hidden="true"><use href="#icon-check"></use></svg>'
                : ""
            }
          </button>
        `,
      )
      .join("");
  }

  function selectNav(view) {
    document.querySelectorAll("[data-view]").forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  }

  /* =========================================================
     Planner calculations
     ========================================================= */

  function getDayEntry(key) {
    return state.plan?.days?.[key] || { breakfast: [], lunch: [], dinner: [], snack: [] };
  }

  function getMealItems(key, mealKey) {
    const day = getDayEntry(key);
    return Array.isArray(day[mealKey]) ? day[mealKey] : [];
  }

  function getMealTotal(key, mealKey) {
    return getMealItems(key, mealKey).reduce((total, item) => total + item.calories, 0);
  }

  function getDayTotal(key) {
    return MEAL_KEYS.reduce((total, mealKey) => total + getMealTotal(key, mealKey), 0);
  }

  function getDayItemCount(key) {
    return MEAL_KEYS.reduce(
      (count, mealKey) => count + getMealItems(key, mealKey).length,
      0,
    );
  }

  function getWeekTotals() {
    return getWeekDates(state.weekStart).map((date) => {
      const key = dateKey(date);
      return {
        key,
        date,
        total: getDayTotal(key),
        count: getDayItemCount(key),
      };
    });
  }

  /* =========================================================
     Planner rendering
     ========================================================= */

  function renderHeaderDates() {
    const dates = getWeekDates(state.weekStart);
    const start = dates[0];
    const end = dates[6];
    const weekInfo = getISOWeekInfo(start);
    const current = isCurrentWeek(state.weekStart);
    const thisYear = new Date().getFullYear();

    dom.heroWeekNo.textContent = `第 ${weekInfo.week} 周`;
    dom.heroRange.textContent = formatRange(start, end);
    dom.heroYear.textContent = String(weekInfo.year);
    dom.boardRange.textContent = formatRange(start, end);
    dom.boardWeekNo.textContent = `第 ${weekInfo.week} 周${
      current ? " · 本周" : weekInfo.year !== thisYear ? ` · ${weekInfo.year}` : ""
    }`;
    dom.todayButton.hidden = current;
    dom.ingredientWeekLabel.textContent = formatRange(start, end);
    dom.clearModalCopy.textContent = `${formatRange(start, end)} 的食物和热量记录都会被移除。其他周不受影响。`;
  }

  function renderPlanner() {
    if (!state.kitchen) return;
    renderHeaderDates();

    const target = getTarget();
    dom.targetCurrent.textContent = formatTarget(target);
    dom.targetButton.disabled = !canEdit();
    dom.readonlyBanner.hidden = canEdit();
    dom.heroRoleBadge.textContent = roleLabel(state.kitchen.role);
    dom.heroRoleBadge.dataset.role = state.kitchen.role;

    const showDemo =
      canEdit() &&
      Boolean(state.kitchen.isSample) &&
      !hasDismissedSample(state.kitchen.id) &&
      state.plan &&
      getWeekTotals().some((day) => day.count > 0);
    dom.demoBanner.hidden = !showDemo;

    renderSummary();
    renderBoard({ preserveScroll: true });
  }

  function renderSummary() {
    const weekTotals = getWeekTotals();
    const target = getTarget();
    const weeklyTotal = weekTotals.reduce((total, day) => total + day.total, 0);
    const recorded = weekTotals.filter((day) => day.count > 0).length;
    const over = weekTotals.filter((day) => day.total > target).length;
    const average = recorded ? Math.round(weeklyTotal / recorded) : 0;

    dom.weekTotal.textContent = formatNumber(weeklyTotal);
    dom.recordedDays.innerHTML = `${recorded}<span>/7 天</span>`;
    dom.overDays.innerHTML = `${over}<span> 天</span>`;

    let comparison;
    if (!recorded) {
      comparison = "这一周还没有开火，先安排第一顿吧。";
    } else {
      const difference = average - target;
      if (difference === 0) {
        comparison = `日均 ${formatNumber(average)} kcal · 刚好落在目标上`;
      } else if (difference > 0) {
        comparison = `日均 ${formatNumber(average)} kcal · 高于目标 ${formatNumber(difference)} kcal`;
      } else {
        comparison = `日均 ${formatNumber(average)} kcal · 低于目标 ${formatNumber(Math.abs(difference))} kcal`;
      }
    }
    dom.weekCompare.textContent = comparison;

    const scale = Math.max(target * 1.05, ...weekTotals.map((day) => day.total), 1);
    const targetLineBottom = 12.5 + (target / scale) * 50;
    const todayKey = dateKey(new Date());

    const chartColumns = weekTotals
      .map((day, index) => {
        const isToday = day.key === todayKey;
        const hasData = day.count > 0;
        const isOver = day.total > target;
        const height = hasData ? Math.max(3, Math.round((day.total / scale) * 50)) : 2;
        return `
          <div class="chart-col${isToday ? " is-today" : ""}" title="${escapeHtml(DAY_NAMES[index])} ${formatNumber(day.total)} kcal">
            <div class="chart-bar-wrap">
              <div class="chart-bar${hasData ? " has-data" : ""}${isOver ? " is-over" : ""}" style="height:${height}px"></div>
            </div>
            <span class="chart-day">${DAY_SHORT[index]}</span>
          </div>
        `;
      })
      .join("");

    dom.weekChart.innerHTML = `
      <div class="chart-grid">
        <div class="chart-target-line" style="bottom:${targetLineBottom.toFixed(1)}px" aria-hidden="true"></div>
        ${chartColumns}
      </div>
    `;

    const chartDescription = weekTotals
      .map((day, index) => `${DAY_NAMES[index]} ${formatNumber(day.total)} 千卡`)
      .join("，");
    dom.weekChart.setAttribute("aria-label", `本周每日热量：${chartDescription}`);
  }

  function isMobileBoard() {
    return window.matchMedia("(max-width: 880px)").matches;
  }

  function currentDayIndex() {
    return (new Date().getDay() + 6) % 7;
  }

  function renderDayPager(dates, activeIndex) {
    if (!dom.dayPager) return;
    dom.dayPager.innerHTML = dates
      .map((date, index) => {
        const isActive = index === activeIndex;
        const isToday = dateKey(date) === dateKey(new Date());
        return `
          <button
            class="day-pager-button${isActive ? " is-active" : ""}${isToday ? " is-today" : ""}"
            type="button"
            data-day-index="${index}"
            aria-label="${DAY_NAMES[index]} ${date.getMonth() + 1}月${date.getDate()}日"
            aria-current="${isActive ? "true" : "false"}"
          >
            <span>${DAY_SHORT[index]}</span>
            <em>${date.getDate()}</em>
          </button>
        `;
      })
      .join("");
  }

  function updateDayPager(activeIndex) {
    if (!dom.dayPager) return;
    dom.dayPager.querySelectorAll("[data-day-index]").forEach((button) => {
      const isActive = Number(button.dataset.dayIndex) === activeIndex;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-current", String(isActive));
    });
  }

  function renderBoard({ preserveScroll = true } = {}) {
    const scrollLeft = dom.weekBoard.scrollLeft;
    const dates = getWeekDates(state.weekStart);
    const todayKey = dateKey(new Date());
    const editable = canEdit();
    const weekKey = dateKey(state.weekStart);

    if (!state.plan) {
      dom.weekBoard.innerHTML = "";
      if (dom.dayPager) dom.dayPager.innerHTML = "";
      return;
    }

    if (state.renderedWeekStart !== weekKey) {
      state.renderedWeekStart = weekKey;
      state.activeDayIndex = isCurrentWeek(state.weekStart) ? currentDayIndex() : 0;
    }
    const activeIndex = Math.max(0, Math.min(6, Number(state.activeDayIndex) || 0));
    state.activeDayIndex = activeIndex;

    dom.weekBoard.innerHTML = dates
      .map((date, index) => renderDayCard(date, index, todayKey, editable))
      .join("");
    renderDayPager(dates, activeIndex);

    if (isMobileBoard()) {
      requestAnimationFrame(() => {
        const width = dom.weekBoard.clientWidth;
        if (width) dom.weekBoard.scrollLeft = activeIndex * width;
        updateDayPager(activeIndex);
      });
    } else if (preserveScroll) {
      dom.weekBoard.scrollLeft = scrollLeft;
    }
  }

  function renderDayCard(date, index, todayKey, editable) {
    const key = dateKey(date);
    const isToday = key === todayKey;
    const total = getDayTotal(key);
    const itemCount = getDayItemCount(key);
    const target = getTarget();
    const isOver = total > target;
    const progress = Math.min(100, Math.round((total / target) * 100));
    const weekday = DAY_NAMES[index];
    const cook = state.plan?.cooks?.[key] || null;

    let status;
    if (!itemCount) {
      status = "尚未记录";
    } else if (total > target) {
      status = `超出 ${formatNumber(total - target)} kcal`;
    } else if (total === target) {
      status = "刚好达到目标";
    } else {
      status = `还可摄入 ${formatNumber(target - total)} kcal`;
    }

    const cookInner = cook
      ? `<span class="day-cook-avatar" aria-hidden="true">${escapeHtml(firstCharacter(cook.displayName))}</span>
         <span class="day-cook-name">${escapeHtml(cook.displayName)}掌勺</span>`
      : `<span class="day-cook-avatar is-empty" aria-hidden="true"><svg class="icon"><use href="#icon-chef"></use></svg></span>
         <span class="day-cook-name">${editable ? "今天谁做饭？" : "还没安排掌勺"}</span>`;
    const cookMarkup = editable
      ? `<button class="day-cook${cook ? " is-set" : " is-empty"}" type="button" data-cook-date="${key}" aria-label="${weekday}${cook ? `由${escapeHtml(cook.displayName)}掌勺，点击修改` : "还没有安排掌勺，点击指定"}">${cookInner}</button>`
      : `<div class="day-cook${cook ? " is-set" : " is-empty"} is-static">${cookInner}</div>`;

    const meals = MEALS.map((meal) => {
      const items = getMealItems(key, meal.key);
      const mealTotal = items.reduce((sum, item) => sum + item.calories, 0);
      const foodRows = items
        .map((item) => {
          const inner = `
            <span class="food-dot" aria-hidden="true"></span>
            <span class="food-name">${escapeHtml(item.name)}</span>
            <span class="food-kcal">${formatNumber(item.calories)}</span>
          `;
          if (!editable) {
            return `<li><div class="food-item is-static">${inner}</div></li>`;
          }
          return `
            <li>
              <button
                class="food-item"
                type="button"
                data-date="${key}"
                data-meal="${meal.key}"
                data-id="${escapeHtml(item.id)}"
                title="编辑「${escapeHtml(item.name)}」"
                aria-label="编辑${weekday}${meal.label}的${escapeHtml(item.name)}，${formatNumber(item.calories)} 千卡"
              >${inner}</button>
            </li>
          `;
        })
        .join("");

      return `
        <section class="meal" data-meal="${meal.key}" aria-label="${weekday}${meal.label}">
          <div class="meal-head">
            <span class="meal-badge" aria-hidden="true">${meal.short}</span>
            <span class="meal-name">${meal.label}</span>
            <span class="meal-total" aria-hidden="true">${mealTotal ? formatNumber(mealTotal) : ""}</span>
            ${
              editable && items.length
                ? `<button class="meal-favorite" type="button" data-favorite-date="${key}" data-favorite-meal="${meal.key}" aria-label="收藏${weekday}${meal.label}" title="收藏这一餐">
                     <svg class="icon" aria-hidden="true"><use href="#icon-star"></use></svg>
                   </button>`
                : ""
            }
            ${
              editable
                ? `<button class="meal-add" type="button" data-date="${key}" data-meal="${meal.key}" aria-label="为${weekday}${meal.label}添加食物" title="添加${meal.label}">
                     <svg class="icon" aria-hidden="true"><use href="#icon-plus"></use></svg>
                   </button>`
                : ""
            }
          </div>
          ${
            items.length
              ? `<ul class="food-list">${foodRows}</ul>`
              : editable
                ? `<button class="empty-meal" type="button" data-date="${key}" data-meal="${meal.key}" aria-label="为${weekday}${meal.label}添加第一种食物">
                     <svg class="icon" aria-hidden="true"><use href="#icon-plus"></use></svg> 还没有安排
                   </button>`
                : `<span class="empty-meal is-static">还没有安排</span>`
          }
        </section>
      `;
    }).join("");

    return `
      <article class="day-card${isToday ? " is-today" : ""}${isOver ? " is-over" : ""}" style="--index:${index}" data-day="${key}" aria-labelledby="day-title-${key}">
        <header class="day-head">
          <div>
            <h3 class="day-weekday" id="day-title-${key}">${weekday}</h3>
            <p class="day-date">${formatShortDate(date)}</p>
          </div>
          ${
            isToday
              ? '<span class="today-pill">今天</span>'
              : `<span class="day-index" aria-hidden="true">${pad(index + 1)}</span>`
          }
        </header>
        ${cookMarkup}
        <div class="day-meals">${meals}</div>
        <footer class="day-foot">
          <div class="day-total-row">
            <span class="day-total-label">日摄入</span>
            <span class="day-total">${formatNumber(total)}<span>kcal</span></span>
          </div>
          <div
            class="progress-track"
            role="progressbar"
            aria-label="${weekday}热量进度"
            aria-valuemin="0"
            aria-valuemax="${target}"
            aria-valuenow="${Math.min(total, target)}"
            aria-valuetext="${formatNumber(total)} / ${formatNumber(target)} 千卡"
          >
            <span class="progress-fill" style="width:${progress}%"></span>
          </div>
          <div class="day-foot-line">
            <p class="day-status">${status}</p>
            ${
              editable && itemCount
                ? `<button class="day-clear-button" type="button" data-clear-day="${key}">清空本日</button>`
                : ""
            }
          </div>
        </footer>
      </article>
    `;
  }

  async function refreshPlan({ silent = false, showLoader = false } = {}) {
    if (!state.kitchen) return;
    const sequence = ++state.planSequence;
    if (showLoader) {
      dom.boardLoading.hidden = false;
      dom.weekBoard.setAttribute("aria-busy", "true");
    }
    try {
      const plan = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/plan?weekStart=${encodeURIComponent(dateKey(state.weekStart))}`,
      );
      if (sequence !== state.planSequence) return;
      state.plan = plan;
      if (plan.dailyTarget) state.kitchen.dailyTarget = plan.dailyTarget;
      renderPlanner();
      renderChrome();
    } catch (error) {
      if (!silent) showToast(error.message);
      if (error.status === 404 || error.status === 403) await handleKitchenAccessLost();
    } finally {
      if (showLoader && sequence === state.planSequence) {
        dom.boardLoading.hidden = true;
        dom.weekBoard.removeAttribute("aria-busy");
      }
    }
  }

  async function refreshIngredients({ silent = false } = {}) {
    if (!state.kitchen) return;
    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/ingredients`,
      );
      state.ingredients = data.ingredients || [];
      renderIngredients();
    } catch (error) {
      if (!silent) showToast(error.message);
      if (error.status === 404 || error.status === 403) await handleKitchenAccessLost();
    }
  }

  async function changeWeek(offset) {
    state.weekStart = addDays(state.weekStart, offset * 7);
    renderHeaderDates();
    dom.boardLoading.hidden = false;
    dom.weekBoard.setAttribute("aria-busy", "true");
    await refreshPlan({ silent: false, showLoader: true });
  }

  async function goToCurrentWeek() {
    state.weekStart = startOfWeek(new Date());
    renderHeaderDates();
    dom.boardLoading.hidden = false;
    dom.weekBoard.setAttribute("aria-busy", "true");
    await refreshPlan({ silent: false, showLoader: true });
  }

  function applyPlanResponse(plan) {
    if (!plan) return;
    state.plan = plan;
    if (plan.dailyTarget) state.kitchen.dailyTarget = plan.dailyTarget;
    state.kitchen.isSample = false;
    state.kitchen.revision = plan.revision;
    renderPlanner();
    renderChrome();
  }

  /* =========================================================
     Ingredients module
     ========================================================= */

  function renderIngredients() {
    if (!state.kitchen) return;
    const canModify = canEdit();
    if (!canModify && state.ingredientBulkMode) {
      state.ingredientBulkMode = false;
      state.selectedIngredients.clear();
    }
    const bulk = state.ingredientBulkMode && canModify;
    const knownIngredientIds = new Set(state.ingredients.map((item) => item.id));
    for (const selectedId of state.selectedIngredients) {
      if (!knownIngredientIds.has(selectedId)) state.selectedIngredients.delete(selectedId);
    }
    dom.ingredientCount.textContent = `${state.ingredients.length} 种食材`;
    dom.ingredientWeekLabel.textContent = formatRange(
      getWeekDates(state.weekStart)[0],
      getWeekDates(state.weekStart)[6],
    );
    dom.addIngredientButton.hidden = !canModify || bulk;
    dom.bulkIngredientButton.hidden = !canModify || state.ingredients.length === 0 || bulk;
    dom.bulkIngredientButton.classList.toggle("is-active", bulk);
    dom.emptyAddIngredient.hidden = !canModify || bulk;

    const counts = { all: state.ingredients.length };
    Object.keys(CATEGORY_META).forEach((key) => {
      counts[key] = state.ingredients.filter((item) => item.category === key).length;
    });

    dom.categoryTabs.innerHTML = [
      `<button class="category-tab${state.ingredientCategory === "all" ? " is-active" : ""}" type="button" role="tab" aria-selected="${state.ingredientCategory === "all"}" data-ingredient-category="all">全部 <span>${counts.all}</span></button>`,
      ...Object.entries(CATEGORY_META).map(
        ([key, meta]) =>
          `<button class="category-tab${state.ingredientCategory === key ? " is-active" : ""}" type="button" role="tab" aria-selected="${state.ingredientCategory === key}" data-ingredient-category="${key}">${meta.label} <span>${counts[key]}</span></button>`,
      ),
    ].join("");

    const query = state.ingredientQuery.trim().toLowerCase();
    const categoryOrder = Object.keys(CATEGORY_META);
    const filtered = state.ingredients
      .filter((item) => {
        const categoryMatch =
          state.ingredientCategory === "all" || item.category === state.ingredientCategory;
        const queryMatch =
          !query ||
          item.name.toLowerCase().includes(query) ||
          item.unit.toLowerCase().includes(query);
        return categoryMatch && queryMatch;
      })
      .sort((left, right) => {
        const categoryDifference =
          categoryOrder.indexOf(left.category) - categoryOrder.indexOf(right.category);
        if (categoryDifference !== 0) return categoryDifference;
        return left.name.localeCompare(right.name, "zh-Hans-CN");
      });

    const visibleIds = filtered.map((item) => item.id);
    const allVisibleSelected =
      visibleIds.length > 0 && visibleIds.every((id) => state.selectedIngredients.has(id));

    dom.ingredientGrid.innerHTML = filtered
      .map((item) => {
        const meta = CATEGORY_META[item.category] || CATEGORY_META.other;
        const selected = state.selectedIngredients.has(item.id);
        return `
          <article class="ingredient-card${bulk ? " is-bulk-selectable" : ""}${selected ? " is-selected" : ""}" data-category="${item.category}" data-ingredient-card="${escapeHtml(item.id)}">
            ${
              bulk
                ? `<button class="ingredient-select-check" type="button" data-select-ingredient="${escapeHtml(item.id)}" aria-label="${selected ? "取消选择" : "选择"}${escapeHtml(item.name)}" aria-pressed="${selected}">
                     <svg class="icon" aria-hidden="true"><use href="#icon-check"></use></svg>
                   </button>`
                : ""
            }
            <div class="ingredient-card-head">
              <span class="ingredient-category">${escapeHtml(meta.label)}</span>
              ${
                canModify && !bulk
                  ? `<button class="ingredient-edit" type="button" data-edit-ingredient="${escapeHtml(item.id)}" aria-label="编辑${escapeHtml(item.name)}">
                       <svg class="icon" aria-hidden="true"><use href="#icon-pencil"></use></svg>
                     </button>`
                  : ""
              }
            </div>
            <h3 class="ingredient-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h3>
            <p class="ingredient-unit">每 ${escapeHtml(item.unit || "1 份")}</p>
            <div class="ingredient-bottom">
              <div class="ingredient-calories">
                <strong>${formatNumber(item.calories)}</strong>
                <span>kcal</span>
              </div>
              ${
                bulk
                  ? '<span class="ingredient-bulk-hint">点击卡片选择</span>'
                  : canModify
                    ? `<button class="ingredient-add" type="button" data-quick-add="${escapeHtml(item.id)}">
                         <svg class="icon" aria-hidden="true"><use href="#icon-plus"></use></svg>
                         加入食谱
                       </button>`
                    : '<span class="ingredient-readonly">仅观看</span>'
              }
            </div>
          </article>
        `;
      })
      .join("");

    dom.ingredientBulkBar.hidden = !bulk;
    if (bulk) {
      dom.selectedIngredientCount.textContent = `已选 ${state.selectedIngredients.size} 项`;
      dom.selectAllIngredients.textContent = allVisibleSelected ? "取消全选" : "全选当前";
      dom.deleteSelectedIngredients.disabled = state.selectedIngredients.size === 0;
    }

    const isEmpty = filtered.length === 0;
    dom.ingredientEmpty.hidden = !isEmpty;
    const heading = dom.ingredientEmpty.querySelector("h3");
    const copy = dom.ingredientEmpty.querySelector("p");
    if (isEmpty && state.ingredients.length === 0) {
      heading.textContent = "食材库还是空的";
      copy.textContent = "把常吃的食材和热量存进来，下次排餐就能一键填好。";
      dom.emptyAddIngredient.hidden = !canModify;
    } else if (isEmpty) {
      heading.textContent = "没有找到这种食材";
      copy.textContent = "换个关键词，或者切回「全部」分类看看。";
      dom.emptyAddIngredient.hidden = true;
    } else {
      dom.emptyAddIngredient.hidden = true;
    }
  }

  function updateIngredientBulkControls() {
    if (!state.ingredientBulkMode) return;
    const cards = [...dom.ingredientGrid.querySelectorAll("[data-ingredient-card]")];
    const visibleIds = cards.map((card) => card.dataset.ingredientCard);
    const allSelected =
      visibleIds.length > 0 && visibleIds.every((id) => state.selectedIngredients.has(id));
    dom.selectedIngredientCount.textContent = `已选 ${state.selectedIngredients.size} 项`;
    dom.selectAllIngredients.textContent = allSelected ? "取消全选" : "全选当前";
    dom.deleteSelectedIngredients.disabled = state.selectedIngredients.size === 0;
  }

  function toggleIngredientBulkSelection(id) {
    if (!state.ingredientBulkMode) return;
    if (state.selectedIngredients.has(id)) state.selectedIngredients.delete(id);
    else state.selectedIngredients.add(id);
    const card = dom.ingredientGrid.querySelector(`[data-ingredient-card="${id}"]`);
    if (card) {
      const selected = state.selectedIngredients.has(id);
      card.classList.toggle("is-selected", selected);
      const check = card.querySelector("[data-select-ingredient]");
      if (check) check.setAttribute("aria-pressed", String(selected));
    }
    updateIngredientBulkControls();
  }

  function toggleAllVisibleIngredients() {
    if (!state.ingredientBulkMode) return;
    const cards = [...dom.ingredientGrid.querySelectorAll("[data-ingredient-card]")];
    const visibleIds = cards.map((card) => card.dataset.ingredientCard);
    const allSelected =
      visibleIds.length > 0 && visibleIds.every((id) => state.selectedIngredients.has(id));
    visibleIds.forEach((id) => {
      if (allSelected) state.selectedIngredients.delete(id);
      else state.selectedIngredients.add(id);
    });
    cards.forEach((card) => {
      const selected = state.selectedIngredients.has(card.dataset.ingredientCard);
      card.classList.toggle("is-selected", selected);
      const check = card.querySelector("[data-select-ingredient]");
      if (check) check.setAttribute("aria-pressed", String(selected));
    });
    updateIngredientBulkControls();
  }

  function enterIngredientBulkMode() {
    if (!canEdit() || !state.ingredients.length) return;
    state.ingredientBulkMode = true;
    state.selectedIngredients.clear();
    renderIngredients();
    requestAnimationFrame(() => dom.ingredientBulkBar.scrollIntoView({ block: "nearest" }));
  }

  function exitIngredientBulkMode() {
    state.ingredientBulkMode = false;
    state.selectedIngredients.clear();
    renderIngredients();
  }

  function requestBulkDeleteIngredients() {
    if (!canEdit()) return;
    const ids = [...state.selectedIngredients];
    if (!ids.length) {
      showToast("先选择要删除的食材吧。");
      return;
    }
    askConfirm({
      title: `删除选中的 ${ids.length} 种食材？`,
      copy: "这些食材会从当前厨房的食材库中移除。已经加入食谱的食物不会被改动。",
      confirmLabel: `删除 ${ids.length} 项`,
      action: async () => {
        const data = await api(
          `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/ingredients/batch-delete`,
          { method: "POST", body: { ids } },
        );
        state.ingredients = data.ingredients;
        state.ingredientBulkMode = false;
        state.selectedIngredients.clear();
        renderIngredients();
        showToast(`已删除 ${data.deleted || ids.length} 种食材。`);
      },
    });
  }

  /* =========================================================
     Personal wellness
     ========================================================= */

  function formatSleepDuration(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) return "—";
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours && rest) return `${hours} 小时 ${rest} 分`;
    if (hours) return `${hours} 小时`;
    return `${rest} 分钟`;
  }

  function sleepMinutesFromInputs(bedtime, wakeTime) {
    if (!bedtime || !wakeTime) return null;
    const [bedHour, bedMinute] = bedtime.split(":").map(Number);
    const [wakeHour, wakeMinute] = wakeTime.split(":").map(Number);
    if ([bedHour, bedMinute, wakeHour, wakeMinute].some((part) => !Number.isFinite(part))) {
      return null;
    }
    const bed = bedHour * 60 + bedMinute;
    const wake = wakeHour * 60 + wakeMinute;
    return wake > bed ? wake - bed : wake + 1440 - bed;
  }

  function updateSleepDurationPreview() {
    const bed = dom.sleepBedtime.value;
    const wake = dom.sleepWake.value;
    if (!bed || !wake) {
      dom.sleepDuration.textContent = "—";
      return;
    }
    if (bed === wake) {
      dom.sleepDuration.textContent = "时间相同";
      return;
    }
    dom.sleepDuration.textContent = formatSleepDuration(sleepMinutesFromInputs(bed, wake));
  }

  function ensureWellnessState() {
    const weekStart = dateKey(startOfWeek(new Date()));
    if (!state.wellnessWeekStart) state.wellnessWeekStart = weekStart;
    if (!state.wellnessDate) state.wellnessDate = dateKey(new Date());
    return state.wellnessWeekStart;
  }

  function renderWellnessDays(dates) {
    const todayKey = dateKey(new Date());
    dom.wellnessDays.innerHTML = dates
      .map((date, index) => {
        const key = dateKey(date);
        const day = state.wellnessDays?.[key];
        const active = key === state.wellnessDate;
        return `
          <button
            class="wellness-day-button${active ? " is-active" : ""}${key === todayKey ? " is-today" : ""}${day?.sleep ? " has-sleep" : ""}${day?.exercise ? " has-exercise" : ""}"
            type="button"
            data-wellness-day="${key}"
            aria-pressed="${active}"
          >
            <span class="wellness-day-name">${DAY_SHORT[index]}</span>
            <span class="wellness-day-date">${date.getDate()}</span>
            <span class="wellness-day-marker" aria-hidden="true"></span>
          </button>
        `;
      })
      .join("");
  }

  function renderWellnessSummary(dates) {
    if (!state.wellnessDays) {
      dom.wellnessSummary.innerHTML = `<p class="wellness-summary-loading">正在读取本周记录…</p>`;
      return;
    }
    const todayKey = dateKey(new Date());
    dom.wellnessSummary.innerHTML = `
      <div class="wellness-summary-head" aria-hidden="true">
        <span>日期</span><span>睡眠</span><span>运动</span>
      </div>
      ${dates
        .map((date, index) => {
          const key = dateKey(date);
          const day = state.wellnessDays[key];
          const selected = key === state.wellnessDate;
          return `
            <button class="wellness-summary-row${selected ? " is-selected" : ""}" type="button" data-wellness-day="${key}">
              <span class="wellness-summary-date">${DAY_NAMES[index]} ${date.getMonth() + 1}/${date.getDate()}${key === todayKey ? " · 今天" : ""}</span>
              <span>${day?.sleep ? formatSleepDuration(day.sleep.durationMinutes) : '<span class="wellness-summary-empty">—</span>'}</span>
              <span>${day?.exercise ? `${formatNumber(day.exercise.calories)} kcal` : '<span class="wellness-summary-empty">—</span>'}</span>
            </button>
          `;
        })
        .join("")}
    `;
  }

  function renderWellness() {
    if (!state.user) return;
    const weekStart = ensureWellnessState();
    const dates = getWeekDates(parseDateKey(weekStart));
    if (!dates.some((date) => dateKey(date) === state.wellnessDate)) {
      state.wellnessDate = dateKey(dates[0]);
    }
    const start = dates[0];
    const end = dates[6];
    dom.wellnessRange.textContent = formatRange(start, end);
    renderWellnessDays(dates);
    renderWellnessSummary(dates);

    const day = state.wellnessDays?.[state.wellnessDate] || { sleep: null, exercise: null };
    dom.sleepBedtime.value = day.sleep?.bedtime || "";
    dom.sleepWake.value = day.sleep?.wakeTime || "";
    dom.exerciseCalories.value = day.exercise ? String(day.exercise.calories) : "";
    updateSleepDurationPreview();
    dom.sleepHint.textContent = day.sleep
      ? `已记录 ${day.sleep.bedtime} 入睡 · ${day.sleep.wakeTime} 起床。`
      : "只用于你自己的记录，不会分享给厨房成员。";
    dom.exerciseHint.textContent = day.exercise
      ? `已记录 ${formatNumber(day.exercise.calories)} kcal，可随时修改。`
      : "记录运动消耗，不改变食谱里的摄入热量。";
  }

  async function loadWellness({ force = false } = {}) {
    if (!state.user) return;
    const weekStart = ensureWellnessState();
    if (!force && state.wellnessDays && state.wellnessWeekStart === weekStart) {
      renderWellness();
      return;
    }
    state.wellnessWeekStart = weekStart;
    if (!getWeekDates(parseDateKey(weekStart)).some((date) => dateKey(date) === state.wellnessDate)) {
      state.wellnessDate = dateKey(new Date());
    }
    state.wellnessLoading = true;
    renderWellness();
    try {
      const data = await api(`/api/wellness?weekStart=${encodeURIComponent(weekStart)}`);
      if (state.wellnessWeekStart !== weekStart) return;
      state.wellnessDays = data.days || {};
      state.wellnessLoading = false;
      renderWellness();
    } catch (error) {
      state.wellnessLoading = false;
      state.wellnessDays = state.wellnessDays || {};
      renderWellness();
      showToast(error.message);
    }
  }

  async function saveWellnessSleep() {
    if (!state.user) return;
    const bedtime = dom.sleepBedtime.value;
    const wakeTime = dom.sleepWake.value;
    if (!bedtime || !wakeTime) {
      showToast("请填写预计入睡和起床时间。");
      return;
    }
    if (bedtime === wakeTime) {
      showToast("入睡和起床时间不能相同。");
      return;
    }
    dom.saveSleep.disabled = true;
    const original = dom.saveSleep.innerHTML;
    dom.saveSleep.textContent = "保存中…";
    try {
      const data = await api("/api/wellness/sleep", {
        method: "PUT",
        body: {
          date: state.wellnessDate,
          weekStart: state.wellnessWeekStart,
          bedtime,
          wakeTime,
        },
      });
      state.wellnessDays = data.days || {};
      renderWellness();
      showToast("睡眠计划已保存。");
    } catch (error) {
      showToast(error.message);
    } finally {
      dom.saveSleep.disabled = false;
      dom.saveSleep.innerHTML = original;
    }
  }

  async function saveWellnessExercise() {
    if (!state.user) return;
    const raw = dom.exerciseCalories.value.trim();
    const calories = Number(raw);
    if (!raw || !Number.isFinite(calories) || calories < 0 || calories > 5000) {
      showToast("请输入 0–5,000 kcal 之间的运动消耗。");
      return;
    }
    dom.saveExercise.disabled = true;
    const original = dom.saveExercise.innerHTML;
    dom.saveExercise.textContent = "保存中…";
    try {
      const data = await api("/api/wellness/exercise", {
        method: "PUT",
        body: {
          date: state.wellnessDate,
          weekStart: state.wellnessWeekStart,
          calories: Math.round(calories),
        },
      });
      state.wellnessDays = data.days || {};
      renderWellness();
      showToast("运动消耗已保存。");
    } catch (error) {
      showToast(error.message);
    } finally {
      dom.saveExercise.disabled = false;
      dom.saveExercise.innerHTML = original;
    }
  }

  /* =========================================================
     Table module: cooks, polls & grocery duty
     ========================================================= */

  function tableWeekStart() {
    return state.tableWeekStart || state.weekStart;
  }

  function getCookForDate(key) {
    const weekKey = dateKey(startOfWeek(parseDateKey(key)));
    if (state.table?.weekStart === weekKey && state.table.cooks) {
      return state.table.cooks[key] || null;
    }
    if (state.plan?.cooks && dateKey(state.weekStart) === weekKey) {
      return state.plan.cooks[key] || null;
    }
    return null;
  }

  async function loadTable({ silent = false } = {}) {
    if (!state.kitchen) return;
    if (!state.tableWeekStart) state.tableWeekStart = state.weekStart;
    const sequence = ++state.tableSequence;
    state.tableLoading = true;
    state.tableError = null;
    if (!silent) renderTable();

    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/table?weekStart=${encodeURIComponent(dateKey(tableWeekStart()))}`,
      );
      if (sequence !== state.tableSequence) return;
      state.table = data;
      if (Array.isArray(data.members)) state.members = data.members;
      if (Array.isArray(data.messages) && messagesChanged(data.messages)) {
        state.messages = data.messages;
        renderMessages();
      }
      if (state.plan && data.weekStart === dateKey(state.weekStart)) {
        state.plan.cooks = data.cooks;
      }
      renderTable();
    } catch (error) {
      if (sequence !== state.tableSequence) return;
      state.tableError = error.message;
      renderTable();
      if (!silent) showToast(error.message);
      if (error.status === 404 || error.status === 403) await handleKitchenAccessLost();
    } finally {
      if (sequence === state.tableSequence) {
        state.tableLoading = false;
        renderTable();
      }
    }
  }

  function renderTable() {
    if (!state.kitchen) return;
    const weekStart = tableWeekStart();
    const dates = getWeekDates(weekStart);
    dom.tableWeekLabel.textContent = formatRange(dates[0], dates[6]);
    dom.tableAddGrocery.hidden = !canEdit();

    const sameWeek = state.table?.weekStart === dateKey(weekStart);
    const planSameWeek = state.plan && dateKey(state.weekStart) === dateKey(weekStart);
    const cooks = sameWeek ? state.table.cooks : planSameWeek ? state.plan.cooks : {};
    renderCookRoster(dates, cooks);
    renderPolls(state.table?.polls || []);
    renderGroceries(sameWeek ? state.table.groceries : []);
  }

  function renderCookRoster(dates, cooks) {
    if (!dom.cookRoster) return;
    const editable = canEdit();
    const todayKey = dateKey(new Date());
    dom.cookRoster.innerHTML = dates
      .map((date, index) => {
        const key = dateKey(date);
        const cook = cooks?.[key] || null;
        const isToday = key === todayKey;
        const inner = `
          <span class="roster-day-top">
            <span>${DAY_NAMES[index]}</span>
            <em>${formatShortDate(date)}</em>
          </span>
          ${
            cook
              ? `<span class="roster-avatar" aria-hidden="true">${escapeHtml(firstCharacter(cook.displayName))}</span>
                 <strong>${escapeHtml(cook.displayName)}</strong>
                 <small class="roster-role">掌勺</small>`
              : `<span class="roster-avatar is-empty" aria-hidden="true"><svg class="icon"><use href="#icon-chef"></use></svg></span>
                 <strong class="is-empty">待安排</strong>
                 <small class="roster-role">${editable ? "点这里指定" : "还没人做饭"}</small>`
          }
        `;
        if (!editable) {
          return `<div class="roster-day${isToday ? " is-today" : ""}${cook ? " has-cook" : ""}">${inner}</div>`;
        }
        return `<button class="roster-day${isToday ? " is-today" : ""}${cook ? " has-cook" : ""}" type="button" data-cook-date="${key}" aria-label="${DAY_NAMES[index]}${cook ? `由${escapeHtml(cook.displayName)}掌勺，点击修改` : "还没有安排掌勺，点击指定"}">${inner}</button>`;
      })
      .join("");
  }

  function renderPolls(polls) {
    if (!dom.pollList) return;
    const list = Array.isArray(polls) ? polls : [];
    const openCount = list.filter((poll) => poll.status === "open").length;
    dom.pollCount.textContent = `${openCount} 个进行中`;

    if (!state.table && state.tableLoading) {
      dom.pollList.innerHTML = '<p class="table-loading">正在加载饭局安排…</p>';
      dom.pollEmpty.hidden = true;
      return;
    }
    if (!list.length) {
      dom.pollList.innerHTML = "";
      dom.pollEmpty.hidden = false;
      return;
    }
    dom.pollEmpty.hidden = true;
    dom.pollList.innerHTML = list
      .map((poll) => {
        const closed = poll.status !== "open";
        const canManage = state.kitchen.role === "owner" || poll.createdBy === state.user?.id;
        const options = poll.options
          .map((option) => {
            const percent = poll.totalVotes ? Math.round((option.count / poll.totalVotes) * 100) : 0;
            const mine = poll.myVoteOptionId === option.id;
            const voters = option.voters.map((voter) => voter.displayName).join("、");
            return `
              <button
                class="poll-option${mine ? " is-mine" : ""}${closed ? " is-closed" : ""}"
                type="button"
                data-poll-vote="${escapeHtml(poll.id)}"
                data-option-id="${escapeHtml(option.id)}"
                aria-pressed="${mine ? "true" : "false"}"
                ${closed ? "disabled" : ""}
              >
                <span class="poll-option-head">
                  <span class="poll-option-label">${escapeHtml(option.label)}</span>
                  <span class="poll-option-count">${option.count} 票${mine ? " · 已投" : ""}</span>
                </span>
                <span class="poll-option-track" aria-hidden="true"><span class="poll-option-fill" style="width:${percent}%"></span></span>
                ${voters ? `<span class="poll-option-voters">${escapeHtml(voters)}</span>` : '<span class="poll-option-voters is-empty">还没有人选</span>'}
              </button>
            `;
          })
          .join("");
        return `
          <article class="poll-card${closed ? " is-closed" : ""}">
            <header class="poll-card-head">
              <div class="poll-card-title">
                <span class="poll-status${closed ? " is-closed" : ""}">${closed ? "已结束" : "进行中"}</span>
                <h3>${escapeHtml(poll.title)}</h3>
                ${poll.note ? `<p>${escapeHtml(poll.note)}</p>` : ""}
              </div>
              ${
                canManage
                  ? `<div class="poll-actions">
                       ${
                         closed
                           ? `<button class="poll-action" type="button" data-poll-reopen="${escapeHtml(poll.id)}">重新开启</button>`
                           : `<button class="poll-action" type="button" data-poll-close="${escapeHtml(poll.id)}">结束投票</button>`
                       }
                       <button class="poll-delete" type="button" data-poll-delete="${escapeHtml(poll.id)}" aria-label="删除投票「${escapeHtml(poll.title)}」">
                         <svg class="icon" aria-hidden="true"><use href="#icon-trash"></use></svg>
                       </button>
                     </div>`
                  : ""
              }
            </header>
            <div class="poll-options">${options}</div>
            <footer class="poll-foot">
              <span>共 ${poll.totalVotes} 票 · ${escapeHtml(poll.creatorName)} 发起</span>
              <time datetime="${escapeHtml(poll.createdAt)}">${escapeHtml(formatMessageTime(poll.createdAt))}</time>
            </footer>
          </article>
        `;
      })
      .join("");
  }

  function renderGroceries(groceries) {
    if (!dom.groceryList) return;
    const list = Array.isArray(groceries) ? groceries : [];
    dom.groceryCount.textContent = `${list.length} 项`;
    if (!state.table && state.tableLoading) {
      dom.groceryList.innerHTML = '<p class="table-loading">正在加载本周安排…</p>';
      dom.groceryEmpty.hidden = true;
      return;
    }
    if (!list.length) {
      dom.groceryList.innerHTML = "";
      dom.groceryEmpty.hidden = false;
      return;
    }
    dom.groceryEmpty.hidden = true;
    dom.groceryList.innerHTML = list
      .map((duty) => {
        const canToggle = canEdit() || duty.userId === state.user?.id;
        const dayLabel = duty.dayIndex === null ? "本周" : DAY_NAMES[duty.dayIndex] || "本周";
        return `
          <div class="grocery-row${duty.done ? " is-done" : ""}">
            ${
              canToggle
                ? `<button class="grocery-check" type="button" data-grocery-done="${escapeHtml(duty.id)}" data-done="${duty.done ? "1" : "0"}" aria-pressed="${duty.done ? "true" : "false"}" aria-label="${duty.done ? "把买菜安排标记为未完成" : "把买菜安排标记为已完成"}">
                     ${duty.done ? '<svg class="icon" aria-hidden="true"><use href="#icon-check"></use></svg>' : ""}
                   </button>`
                : `<span class="grocery-check is-static" aria-hidden="true">${duty.done ? '<svg class="icon"><use href="#icon-check"></use></svg>' : ""}</span>`
            }
            <span class="grocery-avatar" aria-hidden="true">${escapeHtml(firstCharacter(duty.userName))}</span>
            <div class="grocery-copy">
              <strong>${escapeHtml(duty.userName)}<span class="grocery-day">${dayLabel}</span></strong>
              <span>${escapeHtml(duty.note || "负责本周采购")}</span>
            </div>
            ${
              canEdit()
                ? `<button class="grocery-delete" type="button" data-grocery-delete="${escapeHtml(duty.id)}" aria-label="删除${escapeHtml(duty.userName)}的买菜安排">
                     <svg class="icon" aria-hidden="true"><use href="#icon-trash"></use></svg>
                   </button>`
                : ""
            }
          </div>
        `;
      })
      .join("");
  }

  async function changeTableWeek(offset) {
    const base = state.tableWeekStart || state.weekStart;
    state.tableWeekStart = addDays(base, offset * 7);
    state.table = null;
    renderTable();
    await loadTable();
  }

  function openCookModal(date) {
    if (!state.kitchen || !canEdit()) return;
    const dateValue = parseDateKey(date);
    if (!dateValue) return;
    state.cookDate = date;
    const weekday = DAY_NAMES[getWeekdayIndex(dateValue)];
    const cook = getCookForDate(date);
    dom.cookModalTitle.textContent = `${weekday}谁做饭？`;
    dom.cookModalCopy.textContent = `${formatShortDate(dateValue)} · 选一位厨房成员来掌勺，安排会同步给所有人。`;
    dom.cookChoiceList.innerHTML = state.members
      .map((member) => {
        const checked = cook?.userId === member.id;
        const isSelf = member.id === state.user?.id;
        return `
          <label class="cook-choice">
            <input type="radio" name="cookChoice" value="${escapeHtml(member.id)}"${checked ? " checked" : ""}>
            <span class="cook-choice-avatar" aria-hidden="true">${escapeHtml(firstCharacter(member.displayName))}</span>
            <span class="cook-choice-copy">
              <strong>${escapeHtml(member.displayName)}${isSelf ? "（你）" : ""}</strong>
              <small>${roleLabel(member.role)} · @${escapeHtml(member.username)}</small>
            </span>
            <span class="cook-choice-check" aria-hidden="true"><svg class="icon"><use href="#icon-check"></use></svg></span>
          </label>
        `;
      })
      .join("");
    dom.cookClear.hidden = !cook;
    dom.cookError.hidden = true;
    openModal(dom.cookModal, dom.cookChoiceList.querySelector("input:checked"));
  }

  function applyCookUpdate(weekStart, cooks) {
    if (state.table && state.table.weekStart === weekStart) {
      state.table.cooks = cooks;
    }
    if (dateKey(state.weekStart) === weekStart && state.plan) {
      state.plan.cooks = cooks;
    }
    renderPlanner();
    renderTable();
  }

  async function saveCook() {
    if (!state.kitchen || !state.cookDate) return;
    const selected = dom.cookChoiceList.querySelector('input[name="cookChoice"]:checked');
    if (!selected) {
      setFormError(null, dom.cookError, "先选一位掌勺的人吧。");
      return;
    }
    dom.cookSave.disabled = true;
    const original = dom.cookSave.textContent;
    dom.cookSave.textContent = "保存中…";
    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/cooks/${encodeURIComponent(state.cookDate)}`,
        { method: "PUT", body: { userId: selected.value } },
      );
      applyCookUpdate(data.weekStart, data.cooks);
      closeModal();
      showToast("掌勺的人已经安排好了。");
    } catch (error) {
      setFormError(null, dom.cookError, error.message);
    } finally {
      dom.cookSave.disabled = false;
      dom.cookSave.textContent = original;
    }
  }

  async function clearCook() {
    if (!state.kitchen || !state.cookDate) return;
    dom.cookClear.disabled = true;
    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/cooks/${encodeURIComponent(state.cookDate)}`,
        { method: "DELETE" },
      );
      applyCookUpdate(data.weekStart, data.cooks);
      closeModal();
      showToast("已清除这一天的掌勺安排。");
    } catch (error) {
      showToast(error.message);
    } finally {
      dom.cookClear.disabled = false;
    }
  }

  function openPollModal() {
    if (!state.kitchen) return;
    dom.pollForm.reset();
    dom.pollTitle.value = "周末吃什么？";
    dom.pollOptions.value = "火锅\n烤肉\n寿司\n在家随便做点";
    dom.pollError.hidden = true;
    openModal(dom.pollModal, dom.pollTitle);
  }

  async function createPoll(event) {
    event.preventDefault();
    if (!state.kitchen) return;
    const title = dom.pollTitle.value.trim();
    const note = dom.pollNote.value.trim();
    const options = [...new Set(
      dom.pollOptions.value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    )];
    if (!title) {
      setFormError(dom.pollTitle, dom.pollError, "给投票起个标题吧。");
      return;
    }
    if (options.length < 2) {
      setFormError(dom.pollOptions, dom.pollError, "至少写两个不同的选项，每行一个。");
      return;
    }
    if (options.length > 6) {
      setFormError(dom.pollOptions, dom.pollError, "最多只能有六个选项。");
      return;
    }
    dom.pollSubmit.disabled = true;
    const original = dom.pollSubmit.textContent;
    dom.pollSubmit.textContent = "发起中…";
    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/polls`,
        { method: "POST", body: { title, note, options } },
      );
      if (state.table) state.table.polls = data.polls || [];
      renderTable();
      closeModal();
      showToast("投票已发起，等大家来选。");
    } catch (error) {
      setFormError(null, dom.pollError, error.message);
    } finally {
      dom.pollSubmit.disabled = false;
      dom.pollSubmit.textContent = original;
    }
  }

  async function votePoll(pollId, optionId) {
    if (!state.kitchen || state.pollVoting) return;
    state.pollVoting = true;
    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/polls/${encodeURIComponent(pollId)}/vote`,
        { method: "POST", body: { optionId } },
      );
      if (state.table) state.table.polls = data.polls || [];
      renderTable();
      showToast("投票已记录。");
    } catch (error) {
      showToast(error.message);
    } finally {
      state.pollVoting = false;
    }
  }

  async function setPollStatus(pollId, action) {
    if (!state.kitchen) return;
    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/polls/${encodeURIComponent(pollId)}/${action}`,
        { method: "POST" },
      );
      if (state.table) state.table.polls = data.polls || [];
      renderTable();
      showToast(action === "close" ? "投票已结束。" : "投票已重新开启。");
    } catch (error) {
      showToast(error.message);
    }
  }

  async function deletePoll(pollId) {
    if (!state.kitchen) return;
    const data = await api(
      `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/polls/${encodeURIComponent(pollId)}`,
      { method: "DELETE" },
    );
    if (state.table) state.table.polls = data.polls || [];
    renderTable();
    showToast("投票已删除。");
  }

  function openGroceryModal() {
    if (!state.kitchen || !canEdit()) return;
    const dates = getWeekDates(tableWeekStart());
    dom.groceryMember.innerHTML = state.members
      .map(
        (member) =>
          `<option value="${escapeHtml(member.id)}"${member.id === state.user?.id ? " selected" : ""}>${escapeHtml(member.displayName)}${member.id === state.user?.id ? "（你）" : ""}</option>`,
      )
      .join("");
    dom.groceryDay.innerHTML =
      '<option value="">不指定</option>' +
      dates
        .map(
          (date, index) =>
            `<option value="${index}">${DAY_NAMES[index]} ${formatShortDate(date)}</option>`,
        )
        .join("");
    dom.groceryNote.value = "";
    dom.groceryError.hidden = true;
    openModal(dom.groceryModal, dom.groceryMember);
  }

  async function saveGrocery(event) {
    event.preventDefault();
    if (!state.kitchen) return;
    const userId = dom.groceryMember.value;
    if (!userId) {
      setFormError(dom.groceryMember, dom.groceryError, "先选一位负责买菜的成员。");
      return;
    }
    const dayValue = dom.groceryDay.value;
    dom.grocerySubmit.disabled = true;
    const original = dom.grocerySubmit.textContent;
    dom.grocerySubmit.textContent = "保存中…";
    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/groceries`,
        {
          method: "POST",
          body: {
            weekStart: dateKey(tableWeekStart()),
            userId,
            dayIndex: dayValue === "" ? null : Number(dayValue),
            note: dom.groceryNote.value.trim(),
          },
        },
      );
      if (state.table) state.table.groceries = data.groceries || [];
      renderTable();
      closeModal();
      showToast("买菜安排已经记下。");
    } catch (error) {
      setFormError(null, dom.groceryError, error.message);
    } finally {
      dom.grocerySubmit.disabled = false;
      dom.grocerySubmit.textContent = original;
    }
  }

  async function toggleGroceryDone(groceryId, done) {
    if (!state.kitchen) return;
    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/groceries/${encodeURIComponent(groceryId)}`,
        { method: "PATCH", body: { done: !done } },
      );
      if (state.table) state.table.groceries = data.groceries || [];
      renderTable();
    } catch (error) {
      showToast(error.message);
    }
  }

  async function deleteGrocery(groceryId) {
    if (!state.kitchen) return;
    const data = await api(
      `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/groceries/${encodeURIComponent(groceryId)}`,
      { method: "DELETE" },
    );
    if (state.table) state.table.groceries = data.groceries || [];
    renderTable();
    showToast("买菜安排已删除。");
  }

  /* =========================================================
     Recipe tools: week copy, templates & favorites
     ========================================================= */

  async function copyLastWeek() {
    if (!state.kitchen || !canEdit()) return;
    const sourceWeekStart = addDays(state.weekStart, -7);
    const targetWeekStart = state.weekStart;
    const dates = getWeekDates(sourceWeekStart);
    const itemCount = getWeekTotals().reduce((total, day) => total + day.count, 0);
    askConfirm({
      title: "复制上周食谱到本周？",
      copy: `会把 ${formatRange(dates[0], dates[6])} 的安排，按相同的星期追加到这一周。${
        itemCount ? `这一周已有 ${itemCount} 道食物，不会被覆盖。` : "这一周还是空的，复制过来刚刚好。"
      }`,
      confirmLabel: "复制过来",
      action: async () => {
        const data = await api(
          `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/plan/copy`,
          {
            method: "POST",
            body: {
              sourceWeekStart: dateKey(sourceWeekStart),
              targetWeekStart: dateKey(targetWeekStart),
              mode: "merge",
            },
          },
        );
        applyPlanResponse(data.plan);
        showToast(`已复制 ${data.copied} 道食物到这一周。`);
      },
    });
  }

  function openRecipeTools(tab = "templates") {
    if (!state.kitchen) return;
    switchRecipeTab(tab);
    const week = getISOWeekInfo(state.weekStart);
    dom.templateNameInput.value = `第 ${week.week} 周食谱`;
    dom.templateSaveHint.textContent = `把 ${formatRange(
      getWeekDates(state.weekStart)[0],
      getWeekDates(state.weekStart)[6],
    )} 的安排存成模板，之后可以一键套用到任意一周。`;
    openModal(dom.recipeToolsModal, dom.recipeTabTemplates);
    loadRecipeTools();
  }

  async function loadRecipeTools() {
    if (!state.kitchen) return;
    renderRecipeTools();
    try {
      const [templatesData, favoritesData] = await Promise.all([
        api(`/api/kitchens/${encodeURIComponent(state.kitchen.id)}/templates`),
        api(`/api/kitchens/${encodeURIComponent(state.kitchen.id)}/favorites`),
      ]);
      state.templates = templatesData.templates || [];
      state.favorites = favoritesData.favorites || [];
      state.recipeToolsLoaded = true;
      renderRecipeTools();
    } catch (error) {
      showToast(error.message);
    }
  }

  function switchRecipeTab(tab) {
    state.recipeTab = tab === "favorites" ? "favorites" : "templates";
    const isTemplates = state.recipeTab === "templates";
    dom.recipeTabTemplates.classList.toggle("is-active", isTemplates);
    dom.recipeTabFavorites.classList.toggle("is-active", !isTemplates);
    dom.recipeTabTemplates.setAttribute("aria-selected", String(isTemplates));
    dom.recipeTabFavorites.setAttribute("aria-selected", String(!isTemplates));
    dom.recipePanelTemplates.hidden = !isTemplates;
    dom.recipePanelFavorites.hidden = isTemplates;
  }

  function renderRecipeTools() {
    if (!dom.templateList) return;
    const templates = state.templates || [];
    const favorites = state.favorites || [];
    const loading = !state.recipeToolsLoaded;

    if (loading && !templates.length) {
      dom.templateList.innerHTML = '<p class="table-loading">正在加载模板…</p>';
    } else if (!templates.length) {
      dom.templateList.innerHTML = "";
    } else {
      dom.templateList.innerHTML = templates
        .map((template) => {
          const canDelete =
            state.kitchen.role === "owner" || template.creatorId === state.user?.id;
          return `
            <div class="template-item" data-template-id="${escapeHtml(template.id)}">
              <span class="template-mark" aria-hidden="true"><svg class="icon"><use href="#icon-bookmark"></use></svg></span>
              <div class="template-copy">
                <strong>${escapeHtml(template.name)}</strong>
                <span>${template.itemCount} 道食物 · ${template.dayCount} 天 · ${formatNumber(template.totalCalories)} kcal · ${escapeHtml(template.creatorName)} 保存</span>
              </div>
              <div class="template-actions">
                <button class="mini-button" type="button" data-apply-template="${escapeHtml(template.id)}">套用</button>
                ${
                  canDelete
                    ? `<button class="mini-icon-button" type="button" data-delete-template="${escapeHtml(template.id)}" data-template-name="${escapeHtml(template.name)}" aria-label="删除模板「${escapeHtml(template.name)}」">
                         <svg class="icon" aria-hidden="true"><use href="#icon-trash"></use></svg>
                       </button>`
                    : ""
                }
              </div>
            </div>
          `;
        })
        .join("");
    }
    dom.templateEmpty.hidden = loading || templates.length > 0;

    if (loading && !favorites.length) {
      dom.favoriteList.innerHTML = '<p class="table-loading">正在加载收藏…</p>';
    } else if (!favorites.length) {
      dom.favoriteList.innerHTML = "";
    } else {
      dom.favoriteList.innerHTML = favorites
        .map((favorite) => {
          const canDelete =
            state.kitchen.role === "owner" || favorite.creatorId === state.user?.id;
          const meal = MEALS.find((item) => item.key === favorite.meal);
          const itemsLabel = favorite.items.map((item) => item.name).join("、");
          return `
            <div class="favorite-item" data-favorite-id="${escapeHtml(favorite.id)}">
              <span class="favorite-meal-badge" aria-hidden="true">${meal?.short || "餐"}</span>
              <div class="favorite-copy">
                <strong>${escapeHtml(favorite.name)}</strong>
                <span>${escapeHtml(itemsLabel)} · ${formatNumber(favorite.totalCalories)} kcal</span>
              </div>
              <div class="favorite-actions">
                <button class="mini-button" type="button" data-apply-favorite="${escapeHtml(favorite.id)}">加入</button>
                ${
                  canDelete
                    ? `<button class="mini-icon-button" type="button" data-delete-favorite="${escapeHtml(favorite.id)}" data-favorite-name="${escapeHtml(favorite.name)}" aria-label="删除收藏「${escapeHtml(favorite.name)}」">
                         <svg class="icon" aria-hidden="true"><use href="#icon-trash"></use></svg>
                       </button>`
                    : ""
                }
              </div>
            </div>
          `;
        })
        .join("");
    }
    dom.favoriteEmpty.hidden = loading || favorites.length > 0;
  }

  async function saveWeekTemplate() {
    if (!state.kitchen || !canEdit()) return;
    const name = dom.templateNameInput.value.trim() || `第 ${getISOWeekInfo(state.weekStart).week} 周食谱`;
    dom.saveWeekTemplate.disabled = true;
    const original = dom.saveWeekTemplate.textContent;
    dom.saveWeekTemplate.textContent = "保存中…";
    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/templates`,
        { method: "POST", body: { name, weekStart: dateKey(state.weekStart) } },
      );
      state.templates = data.templates || [];
      state.recipeToolsLoaded = true;
      renderRecipeTools();
      showToast("本周已保存为模板。");
    } catch (error) {
      showToast(error.message);
    } finally {
      dom.saveWeekTemplate.disabled = false;
      dom.saveWeekTemplate.textContent = original;
    }
  }

  async function deleteTemplate(templateId) {
    if (!state.kitchen) return;
    const data = await api(
      `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/templates/${encodeURIComponent(templateId)}`,
      { method: "DELETE" },
    );
    state.templates = data.templates || [];
    renderRecipeTools();
    showToast("模板已删除。");
  }

  function openTemplateApply(templateId) {
    const template = state.templates.find((item) => item.id === templateId);
    if (!template) return;
    state.pendingTemplate = template;
    dom.templateApplySummary.innerHTML = `
      <span class="template-mark" aria-hidden="true"><svg class="icon"><use href="#icon-bookmark"></use></svg></span>
      <div>
        <strong>${escapeHtml(template.name)}</strong>
        <span>${template.itemCount} 道食物 · ${template.dayCount} 天 · ${formatNumber(template.totalCalories)} kcal</span>
      </div>
    `;
    dom.templateApplyError.hidden = true;
    const replace = dom.templateApplyModal.querySelector('input[name="templateMode"][value="replace"]');
    if (replace) replace.checked = true;
    openModal(dom.templateApplyModal, dom.templateApplyConfirm);
  }

  async function confirmTemplateApply() {
    if (!state.kitchen || !state.pendingTemplate) return;
    const selected = dom.templateApplyModal.querySelector('input[name="templateMode"]:checked');
    const mode = selected?.value === "merge" ? "merge" : "replace";
    dom.templateApplyConfirm.disabled = true;
    const original = dom.templateApplyConfirm.textContent;
    dom.templateApplyConfirm.textContent = "套用中…";
    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/templates/${encodeURIComponent(state.pendingTemplate.id)}/apply`,
        { method: "POST", body: { weekStart: dateKey(state.weekStart), mode } },
      );
      applyPlanResponse(data.plan);
      closeModal();
      showToast(`已套用模板，加入 ${data.applied} 道食物。`);
    } catch (error) {
      setFormError(null, dom.templateApplyError, error.message);
    } finally {
      dom.templateApplyConfirm.disabled = false;
      dom.templateApplyConfirm.textContent = original;
    }
  }

  function openFavoriteModal(date, mealKey) {
    if (!state.kitchen || !canEdit()) return;
    const dateValue = parseDateKey(date);
    const meal = MEALS.find((item) => item.key === mealKey);
    const items = getMealItems(date, mealKey);
    if (!dateValue || !meal || !items.length) return;
    state.favoriteSource = { date, meal: mealKey, items };
    const defaultName =
      items.length === 1 ? items[0].name : `${items[0].name} 套餐`;
    dom.favoriteModalCopy.textContent = `${formatDayLong(date)} · ${meal.label}，共 ${items.length} 道食物。存进收藏后，下次可以直接加进任意一天。`;
    dom.favoriteName.value = defaultName;
    dom.favoritePreview.innerHTML = `
      ${items
        .map(
          (item) =>
            `<span class="favorite-preview-row"><span>${escapeHtml(item.name)}</span><em>${formatNumber(item.calories)} kcal</em></span>`,
        )
        .join("")}
      <span class="favorite-preview-total">合计 ${formatNumber(items.reduce((total, item) => total + item.calories, 0))} kcal</span>
    `;
    dom.favoriteError.hidden = true;
    openModal(dom.favoriteModal, dom.favoriteName);
  }

  async function saveFavorite() {
    if (!state.kitchen || !state.favoriteSource) return;
    const name = dom.favoriteName.value.trim();
    if (!name) {
      setFormError(dom.favoriteName, dom.favoriteError, "给它起个名字吧。");
      return;
    }
    dom.favoriteSave.disabled = true;
    const original = dom.favoriteSave.textContent;
    dom.favoriteSave.textContent = "收藏中…";
    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/favorites`,
        {
          method: "POST",
          body: {
            date: state.favoriteSource.date,
            meal: state.favoriteSource.meal,
            name,
          },
        },
      );
      state.favorites = data.favorites || [];
      state.recipeToolsLoaded = true;
      renderRecipeTools();
      closeModal();
      showToast("这一餐已经收藏好了。");
    } catch (error) {
      setFormError(null, dom.favoriteError, error.message);
    } finally {
      dom.favoriteSave.disabled = false;
      dom.favoriteSave.textContent = original;
    }
  }

  function openFavoriteApply(favoriteId) {
    const favorite = state.favorites.find((item) => item.id === favoriteId);
    if (!favorite) return;
    state.pendingFavorite = favorite;
    const dates = getWeekDates(state.weekStart);
    const todayKey = dateKey(new Date());
    dom.favoriteApplyDay.innerHTML = dates
      .map((date, index) => {
        const key = dateKey(date);
        return `<option value="${key}"${key === todayKey ? " selected" : ""}>${DAY_NAMES[index]} ${formatShortDate(date)}</option>`;
      })
      .join("");
    dom.favoriteApplyMeal.value = favorite.meal;
    dom.favoriteApplyPreview.classList.add("is-inline");
    dom.favoriteApplyPreview.innerHTML = `
      <span class="favorite-meal-badge" aria-hidden="true">${MEALS.find((item) => item.key === favorite.meal)?.short || "餐"}</span>
      <div>
        <strong>${escapeHtml(favorite.name)}</strong>
        <span>${escapeHtml(favorite.items.map((item) => item.name).join("、"))} · ${formatNumber(favorite.totalCalories)} kcal</span>
      </div>
    `;
    dom.favoriteApplyError.hidden = true;
    openModal(dom.favoriteApplyModal, dom.favoriteApplySave);
  }

  async function confirmFavoriteApply() {
    if (!state.kitchen || !state.pendingFavorite) return;
    dom.favoriteApplySave.disabled = true;
    const original = dom.favoriteApplySave.textContent;
    dom.favoriteApplySave.textContent = "加入中…";
    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/favorites/${encodeURIComponent(state.pendingFavorite.id)}/apply`,
        {
          method: "POST",
          body: {
            weekStart: dateKey(state.weekStart),
            date: dom.favoriteApplyDay.value,
            meal: dom.favoriteApplyMeal.value,
          },
        },
      );
      applyPlanResponse(data.plan);
      closeModal();
      showToast(`已把 ${data.added} 道食物加入食谱。`);
    } catch (error) {
      setFormError(null, dom.favoriteApplyError, error.message);
    } finally {
      dom.favoriteApplySave.disabled = false;
      dom.favoriteApplySave.textContent = original;
    }
  }

  /* =========================================================
     Kitchen page
     ========================================================= */

  function renderKitchen() {
    if (!state.kitchen) return;
    const kitchen = state.kitchen;
    const owner = kitchen.role === "owner";

    dom.currentKitchenName.textContent = kitchen.name;
    dom.kitchenBigAvatar.textContent = firstCharacter(kitchen.name);
    dom.currentKitchenRole.textContent = roleLabel(kitchen.role);
    dom.currentKitchenRole.dataset.role = kitchen.role;
    dom.currentKitchenMeta.textContent = `${kitchen.memberCount} 位成员 · 创建于 ${formatCreatedAt(kitchen.createdAt)}`;
    dom.kitchenOwnerName.textContent = kitchen.ownerName;
    dom.kitchenMemberCount.textContent = `${kitchen.memberCount} 人`;
    dom.kitchenRoleLabel.textContent = roleLabel(kitchen.role);
    dom.kitchenTargetLabel.textContent = `${formatNumber(kitchen.dailyTarget)} kcal`;
    dom.renameKitchenButton.hidden = !owner;
    dom.leaveKitchenButton.hidden = owner;
    dom.memberCountLabel.textContent = String(state.members.length);
    dom.kitchenListCount.textContent = `${state.kitchens.length} 间厨房`;
    dom.inviteOwnerRole.textContent = roleLabel(kitchen.role);

    const weekTotals = getWeekTotals();
    const recordedDays = weekTotals.filter((day) => day.count > 0).length;
    const weeklyCalories = weekTotals.reduce((total, day) => total + day.total, 0);
    dom.kitchenWeekDays.textContent = String(recordedDays);
    dom.kitchenWeekCalories.textContent = formatNumber(weeklyCalories);
    const visibleMembers = state.members.slice(0, 4);
    dom.kitchenMemberAvatars.innerHTML =
      visibleMembers
        .map(
          (member) =>
            `<span class="stack-avatar" title="${escapeHtml(member.displayName)}">${escapeHtml(firstCharacter(member.displayName))}</span>`,
        )
        .join("") +
      (state.members.length > visibleMembers.length
        ? `<span class="stack-more">+${state.members.length - visibleMembers.length}</span>`
        : "");

    dom.inviteCard.classList.toggle("is-readonly", !owner);
    const inviteHeading = dom.inviteCard.querySelector("h3");
    const inviteCopy = dom.inviteCard.querySelector(".invite-copy");
    const roleOptions = dom.inviteCard.querySelector(".invite-role-options");
    if (owner) {
      inviteHeading.textContent = "邀请朋友来厨房";
      inviteCopy.textContent = "给他们一个身份：一起添菜，或只是看看这周吃什么。";
      roleOptions.hidden = false;
      dom.createInviteButton.hidden = false;
      dom.inviteOwnerNote.hidden = true;
    } else {
      inviteHeading.textContent = "邀请由主人发起";
      inviteCopy.textContent = "这间厨房的邀请和管理由主人负责。你可以安心查看，或请主人把你升级为共建者。";
      roleOptions.hidden = true;
      dom.createInviteButton.hidden = true;
      dom.inviteResult.hidden = true;
      dom.inviteOwnerNote.hidden = false;
    }

    if (owner && state.generatedInviteLink) {
      dom.inviteResult.hidden = false;
      dom.inviteLink.value = state.generatedInviteLink;
      dom.inviteHint.textContent = `身份：${ROLE_INVITE_LABELS[state.generatedInviteRole] || "观看者"} · 7 天内有效，可邀请多位朋友。`;
    } else if (owner) {
      dom.inviteResult.hidden = true;
    }

    renderActiveInvites(owner);
    renderMemberList(owner);
    renderKitchenList();
  }

  function messagesChanged(next) {
    const current = state.messages || [];
    if (!Array.isArray(next) || current.length !== next.length) return true;
    return next.some(
      (message, index) =>
        message.id !== current[index].id ||
        message.content !== current[index].content ||
        message.authorName !== current[index].authorName,
    );
  }

  function renderMessages() {
    if (!state.kitchen) return;
    const messages = state.messages || [];
    dom.messageCountLabel.textContent = `${messages.length} 条留言`;
    if (!messages.length) {
      dom.messageList.innerHTML =
        '<p class="message-empty">还没有留言，给厨房里的朋友说句话吧。</p>';
      return;
    }
    dom.messageList.innerHTML = messages
      .map((message) => {
        const canDelete =
          state.kitchen.role === "owner" || message.authorId === state.user?.id;
        return `
          <div class="message-item" data-message-id="${escapeHtml(message.id)}">
            <span class="message-avatar" aria-hidden="true">${escapeHtml(firstCharacter(message.authorName))}</span>
            <div class="message-main">
              <div class="message-head">
                <strong class="message-author">${escapeHtml(message.authorName)}</strong>
                <time class="message-time" datetime="${escapeHtml(message.createdAt)}">${escapeHtml(formatMessageTime(message.createdAt))}</time>
              </div>
              <p class="message-content">${escapeHtml(message.content)}</p>
            </div>
            ${
              canDelete
                ? `<button class="message-delete" type="button" data-delete-message="${escapeHtml(message.id)}" aria-label="删除${escapeHtml(message.authorName)}的留言">
                     <svg class="icon" aria-hidden="true"><use href="#icon-trash"></use></svg>
                   </button>`
                : ""
            }
          </div>
        `;
      })
      .join("");
  }

  function updateMessageLength() {
    dom.messageLength.textContent = `${dom.messageInput.value.length} / 500`;
  }

  async function postMessage(event) {
    event.preventDefault();
    if (!state.kitchen || !state.user) return;
    const content = dom.messageInput.value.trim();
    if (!content) {
      showToast("写点内容再张贴吧。");
      return;
    }
    if (content.length > 500) {
      showToast("留言最多 500 个字。");
      return;
    }
    dom.messageSubmit.disabled = true;
    const original = dom.messageSubmit.innerHTML;
    dom.messageSubmit.textContent = "张贴中…";
    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/messages`,
        { method: "POST", body: { content } },
      );
      state.messages = data.messages || [];
      dom.messageInput.value = "";
      updateMessageLength();
      renderMessages();
      dom.messageList.scrollTop = 0;
      showToast("留言已张贴。");
    } catch (error) {
      showToast(error.message);
    } finally {
      dom.messageSubmit.disabled = false;
      dom.messageSubmit.innerHTML = original;
    }
  }

  async function deleteMessage(messageId) {
    if (!state.kitchen) return;
    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/messages/${encodeURIComponent(messageId)}`,
        { method: "DELETE" },
      );
      state.messages = data.messages || [];
      renderMessages();
      showToast("留言已删除。");
    } catch (error) {
      showToast(error.message);
    }
  }

  function renderActiveInvites(owner) {
    if (!owner || !state.invites.length) {
      dom.activeInvites.innerHTML = "";
      return;
    }

    dom.activeInvites.innerHTML =
      '<p class="active-invites-label">待使用的邀请</p>' +
      state.invites
      .map(
        (invite) => `
          <div class="active-invite" data-invite-id="${escapeHtml(invite.id)}">
            <div class="active-invite-copy">
              <strong>${ROLE_INVITE_LABELS[invite.role] || "观看者"}</strong>
              <span>${formatExpiry(invite.expiresAt)}</span>
            </div>
            <div class="active-invite-actions">
              <button type="button" data-copy-invite="${escapeHtml(invite.code)}">复制</button>
              <button type="button" data-revoke-invite="${escapeHtml(invite.id)}">撤回</button>
            </div>
          </div>
        `,
      )
      .join("");
  }

  function renderMemberList(owner) {
    dom.memberList.innerHTML = state.members
      .map((member) => {
        const isMemberOwner = member.role === "owner";
        const isSelf = member.id === state.user?.id;
        const controls =
          owner && !isMemberOwner
            ? `<div class="member-actions">
                 <select class="member-role-select" data-member-role="${escapeHtml(member.id)}" aria-label="修改${escapeHtml(member.displayName)}的身份">
                   <option value="editor"${member.role === "editor" ? " selected" : ""}>共建者</option>
                   <option value="viewer"${member.role === "viewer" ? " selected" : ""}>观看者</option>
                 </select>
                 <button class="member-remove" type="button" data-remove-member="${escapeHtml(member.id)}" data-member-name="${escapeHtml(member.displayName)}" aria-label="移除${escapeHtml(member.displayName)}">
                   <svg class="icon" aria-hidden="true"><use href="#icon-trash"></use></svg>
                 </button>
               </div>`
            : `<span class="role-badge member-role-static" data-role="${member.role}">${roleLabel(member.role)}${isSelf ? " · 你" : ""}</span>`;

        return `
          <div class="member-row">
            <span class="member-avatar">${escapeHtml(firstCharacter(member.displayName))}</span>
            <div class="member-copy">
              <strong>${escapeHtml(member.displayName)}${isSelf ? "（你）" : ""}</strong>
              <span>@${escapeHtml(member.username)}</span>
            </div>
            ${controls}
          </div>
        `;
      })
      .join("");
  }

  function renderKitchenList() {
    dom.kitchenList.innerHTML = state.kitchens
      .map((kitchen) => {
        const isCurrent = kitchen.id === state.activeKitchenId;
        return `
          <article class="kitchen-card${isCurrent ? " is-current" : ""}">
            ${isCurrent ? '<span class="current-kitchen-mark" aria-label="当前厨房"><svg class="icon" aria-hidden="true"><use href="#icon-check"></use></svg></span>' : ""}
            <div class="kitchen-card-head">
              <span class="kitchen-card-avatar">${escapeHtml(firstCharacter(kitchen.name))}</span>
              <div class="kitchen-card-copy">
                <strong>${escapeHtml(kitchen.name)}</strong>
                <span>${escapeHtml(kitchen.ownerName)} 的厨房 · ${kitchen.memberCount} 人</span>
              </div>
            </div>
            <div class="kitchen-card-foot">
              <span class="kitchen-card-role">${roleLabel(kitchen.role)}</span>
              ${
                isCurrent
                  ? '<span class="kitchen-card-role">当前所在</span>'
                  : `<button class="kitchen-card-enter" type="button" data-switch-kitchen="${escapeHtml(kitchen.id)}">进入厨房 <svg class="icon" aria-hidden="true"><use href="#icon-arrow-right"></use></svg></button>`
              }
            </div>
          </article>
        `;
      })
      .join("") +
      `
        <button class="kitchen-card-new" type="button" data-new-kitchen>
          <svg class="icon" aria-hidden="true"><use href="#icon-plus"></use></svg>
          <span>新建一间厨房</span>
        </button>
      `;
  }

  /* =========================================================
     View routing
     ========================================================= */

  function setView(view, { updateHash = true } = {}) {
    if (!state.user) return;
    if (!["planner", "ingredients", "table", "wellness", "kitchen"].includes(view)) view = "planner";
    if (!state.kitchen) view = "kitchen";
    if (view !== "ingredients" && state.ingredientBulkMode) {
      state.ingredientBulkMode = false;
      state.selectedIngredients.clear();
    }
    state.view = view;

    dom.plannerView.hidden = view !== "planner";
    dom.ingredientsView.hidden = view !== "ingredients";
    dom.tableView.hidden = view !== "table";
    dom.wellnessView.hidden = view !== "wellness";
    dom.kitchenView.hidden = view !== "kitchen";
    selectNav(view);

    if (view === "planner") {
      renderPlanner();
    } else if (view === "ingredients") {
      renderIngredients();
    } else if (view === "table") {
      if (!state.tableWeekStart) state.tableWeekStart = state.weekStart;
      renderTable();
      renderMessages();
      loadTable();
    } else if (view === "wellness") {
      renderWellness();
      loadWellness();
    } else if (view === "kitchen") {
      renderKitchen();
    }

    if (updateHash && location.hash !== `#/${view}`) {
      location.hash = `#/${view}`;
    }

    if (state.kitchen) {
      const names = { planner: "一周食谱", ingredients: "食材库", table: "饭局", wellness: "健康", kitchen: "厨房" };
      document.title = `${names[view]} · ${state.kitchen.name} | 凑狗厨房`;
    }

    const jumpToPlanner = state.pendingPlannerJump && view === "planner" && isMobileBoard();
    state.pendingPlannerJump = false;

    if (jumpToPlanner) {
      requestAnimationFrame(() => {
        document.querySelector("#planner")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } else {
      // Switching app sections should always start at the top, especially on mobile.
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }
  }

  function navigate(view) {
    if (!state.user) return;
    if (view === "planner" && isMobileBoard()) state.pendingPlannerJump = true;
    if (state.view === view && location.hash === `#/${view}`) {
      setView(view, { updateHash: false });
      return;
    }
    if (location.hash !== `#/${view}`) {
      location.hash = `#/${view}`;
    } else {
      setView(view, { updateHash: false });
    }
    if (view === "kitchen" && state.kitchen) {
      refreshKitchenDetail();
    }
  }

  /* =========================================================
     Modals & focus
     ========================================================= */

  function getFocusableElements(container) {
    return Array.from(
      container.querySelectorAll(
        'a[href], button:not([disabled]):not([hidden]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.offsetParent !== null);
  }

  function openModal(modal, preferredFocus) {
    if (activeModal && activeModal !== modal) {
      closeModal({ restoreFocus: false });
    }
    const pending = modalTimers.get(modal);
    if (pending) {
      clearTimeout(pending);
      modalTimers.delete(modal);
    }

    modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    activeModal = modal;
    modal.hidden = false;
    document.body.classList.add("modal-open");

    requestAnimationFrame(() => {
      if (activeModal !== modal) return;
      modal.classList.add("is-open");
      const target =
        preferredFocus ||
        modal.querySelector("#foodName, #targetInput, #ingredientName, #newKitchenName, .button-primary, button");
      if (target) target.focus({ preventScroll: true });
      else modal.focus({ preventScroll: true });
    });
  }

  function closeModal({ restoreFocus = true } = {}) {
    const modal = activeModal;
    if (!modal) return;
    activeModal = null;
    modal.classList.remove("is-open");
    document.body.classList.remove("modal-open");
    if (modal === dom.confirmModal) state.confirmAction = null;

    const previous = modalTimers.get(modal);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      modal.hidden = true;
      modalTimers.delete(modal);
    }, 230);
    modalTimers.set(modal, timer);

    if (restoreFocus && modalReturnFocus && document.contains(modalReturnFocus)) {
      const target = modalReturnFocus;
      requestAnimationFrame(() => {
        if (!activeModal) target.focus({ preventScroll: true });
      });
    }
    modalReturnFocus = null;
  }

  function closeAllPopovers() {
    dom.kitchenMenu.hidden = true;
    dom.userMenu.hidden = true;
    dom.kitchenSwitch.setAttribute("aria-expanded", "false");
    dom.userMenuButton.setAttribute("aria-expanded", "false");
  }

  function trapModalFocus(event) {
    if (!activeModal || event.key !== "Tab") return;
    const focusable = getFocusableElements(activeModal);
    if (!focusable.length) {
      event.preventDefault();
      activeModal.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === activeModal)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function setFormError(input, errorElement, message) {
    errorElement.textContent = message;
    errorElement.hidden = false;
    if (input) {
      input.setAttribute("aria-invalid", "true");
      input.focus();
    }
  }

  function clearFormError(input, errorElement) {
    errorElement.hidden = true;
    errorElement.textContent = "";
    if (input) input.removeAttribute("aria-invalid");
  }

  function askConfirm({ title, copy, confirmLabel = "确认", action }) {
    clearTimeout(toastTimer);
    clearTimeout(toastHideTimer);
    dom.toast.classList.remove("is-visible");
    dom.toast.hidden = true;
    state.confirmAction = action;
    dom.confirmTitle.textContent = title;
    dom.confirmCopy.textContent = copy;
    dom.confirmActionButton.textContent = confirmLabel;
    dom.confirmActionButton.disabled = false;
    openModal(dom.confirmModal);
    requestAnimationFrame(() => dom.confirmActionButton.focus({ preventScroll: true }));
  }

  /* =========================================================
     Food modal
     ========================================================= */

  function populatePresetSelect() {
    const noIngredients = state.ingredients.length === 0;
    state.presetQuery = "";
    state.presetCategory = "all";
    state.presetPanelOpen = false;
    dom.presetPickerButton.disabled = noIngredients;
    dom.presetPickerButton.classList.remove("has-value");
    dom.presetPickerButton.setAttribute("aria-expanded", "false");
    dom.presetTriggerLabel.textContent = noIngredients
      ? "食材库暂时没有预设"
      : "选择一种预设食材…";
    dom.presetTriggerMeta.textContent = noIngredients
      ? "先去食材库添加吧"
      : "按分类浏览，点一下自动填入";
    dom.presetPanel.hidden = true;
    dom.presetSearch.value = "";
    dom.presetHint.textContent = noIngredients
      ? "食材库还没有预设，先去添加，下次就能一键填入。"
      : "选好预设后，名称和热量会自动填上。";
  }

  function renderPresetPanel() {
    const query = state.presetQuery.trim().toLowerCase();
    const counts = {};
    state.ingredients.forEach((item) => {
      counts[item.category] = (counts[item.category] || 0) + 1;
    });
    const categories = Object.entries(CATEGORY_META).filter(([key]) => counts[key]);
    dom.presetCategoryChips.innerHTML = [
      `<button class="preset-chip${state.presetCategory === "all" ? " is-active" : ""}" type="button" data-preset-category="all">全部 <span>${state.ingredients.length}</span></button>`,
      ...categories.map(
        ([key, meta]) =>
          `<button class="preset-chip${state.presetCategory === key ? " is-active" : ""}" type="button" data-preset-category="${key}">${meta.label} <span>${counts[key]}</span></button>`,
      ),
    ].join("");

    const filtered = state.ingredients
      .filter((item) => {
        const categoryMatch =
          state.presetCategory === "all" || item.category === state.presetCategory;
        const queryMatch =
          !query ||
          item.name.toLowerCase().includes(query) ||
          item.unit.toLowerCase().includes(query);
        return categoryMatch && queryMatch;
      })
      .sort((left, right) => {
        const order = Object.keys(CATEGORY_META);
        const diff = order.indexOf(left.category) - order.indexOf(right.category);
        return diff !== 0 ? diff : left.name.localeCompare(right.name, "zh-Hans-CN");
      });

    if (!filtered.length) {
      dom.presetList.innerHTML = "";
      dom.presetEmpty.hidden = false;
      return;
    }
    dom.presetEmpty.hidden = true;

    const optionHtml = (item) => {
      const meta = CATEGORY_META[item.category] || CATEGORY_META.other;
      return `
        <button class="preset-option" type="button" data-preset-id="${escapeHtml(item.id)}">
          <span class="preset-option-main">
            <strong>${escapeHtml(item.name)}</strong>
            <small>${escapeHtml(meta.label)} · ${formatNumber(item.calories)} kcal · 每 ${escapeHtml(item.unit || "1 份")}</small>
          </span>
          <span class="preset-option-add" aria-hidden="true"><svg class="icon"><use href="#icon-plus"></use></svg></span>
        </button>
      `;
    };

    if (state.presetCategory === "all" && !query) {
      dom.presetList.innerHTML = categories
        .map(([key, meta]) => {
          const items = filtered.filter((item) => item.category === key);
          return items.length
            ? `<p class="preset-group-title">${meta.label}</p>${items.map(optionHtml).join("")}`
            : "";
        })
        .join("");
    } else {
      dom.presetList.innerHTML = filtered.map(optionHtml).join("");
    }
  }

  function openPresetPanel() {
    if (dom.presetPickerButton.disabled) return;
    state.presetPanelOpen = true;
    dom.presetPanel.hidden = false;
    dom.presetPickerButton.setAttribute("aria-expanded", "true");
    renderPresetPanel();
    if (!window.matchMedia("(max-width: 880px)").matches) {
      requestAnimationFrame(() => dom.presetSearch.focus({ preventScroll: true }));
    }
  }

  function closePresetPanel({ focus = false } = {}) {
    state.presetPanelOpen = false;
    dom.presetPanel.hidden = true;
    dom.presetPickerButton.setAttribute("aria-expanded", "false");
    if (focus) dom.presetPickerButton.focus({ preventScroll: true });
  }

  function togglePresetPanel() {
    if (state.presetPanelOpen) closePresetPanel({ focus: true });
    else openPresetPanel();
  }

  function applyPresetIngredient(ingredient) {
    if (!ingredient) return;
    const meta = CATEGORY_META[ingredient.category] || CATEGORY_META.other;
    dom.foodName.value = ingredient.name;
    dom.foodKcal.value = String(ingredient.calories);
    dom.presetTriggerLabel.textContent = ingredient.name;
    dom.presetTriggerMeta.textContent = `${meta.label} · ${formatNumber(ingredient.calories)} kcal · 每 ${ingredient.unit || "1 份"}`;
    dom.presetPickerButton.classList.add("has-value");
    clearFormError(dom.foodName, dom.foodError);
    closePresetPanel();
    dom.foodName.focus({ preventScroll: true });
  }

  function updateFoodKicker() {
    if (!editContext) return;
    const selected = dom.foodForm.querySelector('input[name="meal"]:checked');
    const meal = MEALS.find((item) => item.key === (selected ? selected.value : editContext.meal));
    dom.foodModalKicker.textContent = `${formatDayLong(editContext.dateKey)} · ${meal ? meal.label : "早餐"}`;
  }

  function openFoodModal(key, mealKey, itemId = null) {
    if (!canEdit()) return;
    const item = itemId
      ? getMealItems(key, mealKey).find((food) => food.id === itemId) || null
      : null;

    if (itemId && !item) {
      showToast("没有找到这条食物记录，请刷新后再试。");
      return;
    }

    editContext = { dateKey: key, meal: mealKey, id: item ? item.id : null };
    dom.foodForm.reset();
    clearFormError(dom.foodName, dom.foodError);
    dom.foodKcal.removeAttribute("aria-invalid");

    const radio = dom.foodForm.querySelector(`input[name="meal"][value="${mealKey}"]`);
    if (radio) radio.checked = true;
    dom.foodName.value = item ? item.name : "";
    dom.foodKcal.value = item ? String(item.calories) : "";
    dom.foodModalTitle.textContent = item ? "编辑食物" : "添加食物";
    dom.foodSubmitButton.textContent = "保存";
    dom.deleteFood.hidden = !item;
    populatePresetSelect();
    updateFoodKicker();

    openModal(dom.foodModal);
    requestAnimationFrame(() => {
      dom.foodName.focus({ preventScroll: true });
      if (item) dom.foodName.select();
    });
  }

  async function saveFood(event) {
    event.preventDefault();
    if (!editContext || !state.kitchen) return;

    const name = dom.foodName.value.replace(/\s+/g, " ").trim();
    const rawCalories = dom.foodKcal.value.trim();
    const calories = Number(rawCalories);
    const selected = dom.foodForm.querySelector('input[name="meal"]:checked');
    const mealKey = selected ? selected.value : editContext.meal;

    if (!name) {
      setFormError(dom.foodName, dom.foodError, "给这份食物写个名字吧。");
      return;
    }
    if (!rawCalories || !Number.isFinite(calories)) {
      setFormError(dom.foodKcal, dom.foodError, "请填写一个有效的热量数字（千卡）。");
      return;
    }
    if (calories < 0 || calories > FOOD_MAX) {
      setFormError(dom.foodKcal, dom.foodError, `每份热量需要在 0–${formatNumber(FOOD_MAX)} kcal 之间。`);
      return;
    }

    const editingId = editContext.id;
    const dayKey = editContext.dateKey;
    const kitchenId = state.kitchen.id;
    dom.foodSubmitButton.disabled = true;
    dom.foodSubmitButton.textContent = "保存中…";

    try {
      const data = await api(
        editingId
          ? `/api/kitchens/${encodeURIComponent(kitchenId)}/plan/items/${encodeURIComponent(editingId)}`
          : `/api/kitchens/${encodeURIComponent(kitchenId)}/plan/items`,
        {
          method: editingId ? "PATCH" : "POST",
          body: {
            weekStart: dateKey(state.weekStart),
            date: dayKey,
            meal: mealKey,
            name,
            calories: Math.round(calories),
          },
        },
      );

      const savedItem = data.item;
      applyPlanResponse(data.plan);
      closeModal({ restoreFocus: false });
      const weekday = formatDayLong(dayKey);
      const mealLabel = MEALS.find((meal) => meal.key === mealKey)?.label || "这一餐";
      showToast(
        editingId
          ? `已更新「${savedItem.name}」`
          : `已把「${savedItem.name}」放进${weekday}${mealLabel}`,
      );

      setTimeout(() => {
        const replacement = Array.from(dom.weekBoard.querySelectorAll(".food-item")).find(
          (element) =>
            element.dataset.date === dayKey &&
            element.dataset.meal === mealKey &&
            element.dataset.id === savedItem.id,
        );
        if (replacement) replacement.focus({ preventScroll: true });
      }, 250);
    } catch (error) {
      showToast(error.message);
    } finally {
      dom.foodSubmitButton.disabled = false;
      dom.foodSubmitButton.textContent = "保存";
    }
  }

  async function deleteFood() {
    if (!editContext || !editContext.id || !state.kitchen) return;
    const { dateKey: dayKey, meal: mealKey, id } = editContext;
    dom.deleteFood.disabled = true;

    try {
      await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/plan/items/${encodeURIComponent(id)}?weekStart=${encodeURIComponent(dateKey(state.weekStart))}`,
        { method: "DELETE" },
      ).then((data) => applyPlanResponse(data.plan));

      closeModal({ restoreFocus: false });
      showToast("已删除这份食物。");
      setTimeout(() => {
        const addButton = Array.from(dom.weekBoard.querySelectorAll(".meal-add")).find(
          (element) => element.dataset.date === dayKey && element.dataset.meal === mealKey,
        );
        if (addButton) addButton.focus({ preventScroll: true });
      }, 250);
    } catch (error) {
      showToast(error.message);
    } finally {
      dom.deleteFood.disabled = false;
    }
  }

  /* =========================================================
     Account settings
     ========================================================= */

  function openProfileModal() {
    if (!state.user) return;
    closeAllPopovers();
    dom.profileForm.reset();
    dom.passwordForm.reset();
    dom.profileError.hidden = true;
    dom.profileError.textContent = "";
    dom.passwordError.hidden = true;
    dom.passwordError.textContent = "";
    dom.profileDisplayName.removeAttribute("aria-invalid");
    dom.currentPassword.removeAttribute("aria-invalid");
    dom.newPassword.removeAttribute("aria-invalid");
    dom.confirmPassword.removeAttribute("aria-invalid");
    dom.profileDisplayName.value = state.user.displayName;
    dom.profileAvatar.textContent = firstCharacter(state.user.displayName);
    dom.profileNamePreview.textContent = state.user.displayName;
    dom.profileUsernamePreview.textContent = `@${state.user.username}`;
    openModal(dom.profileModal);
    requestAnimationFrame(() => dom.profileDisplayName.select());
  }

  async function saveProfile(event) {
    event.preventDefault();
    if (!state.user) return;
    const displayName = dom.profileDisplayName.value.replace(/\s+/g, " ").trim();
    if (!displayName) {
      setFormError(dom.profileDisplayName, dom.profileError, "昵称不能为空。");
      return;
    }

    dom.profileSubmit.disabled = true;
    dom.profileSubmit.textContent = "保存中…";
    try {
      const data = await api("/api/auth/profile", {
        method: "PATCH",
        body: { displayName },
      });
      state.user = data.user;
      state.kitchens = data.kitchens || state.kitchens;
      if (state.kitchen) {
        if (state.kitchen.ownerId === state.user.id) {
          state.kitchen.ownerName = state.user.displayName;
        }
        state.members = state.members.map((member) =>
          member.id === state.user.id
            ? { ...member, displayName: state.user.displayName }
            : member,
        );
      }
      renderChrome();
      renderPlanner();
      renderIngredients();
      renderKitchen();
      closeModal();
      showToast("昵称已更新。");
    } catch (error) {
      setFormError(dom.profileDisplayName, dom.profileError, error.message);
    } finally {
      dom.profileSubmit.disabled = false;
      dom.profileSubmit.textContent = "保存昵称";
    }
  }

  async function savePassword(event) {
    event.preventDefault();
    if (!state.user) return;
    const currentPassword = dom.currentPassword.value;
    const newPassword = dom.newPassword.value;
    const confirmation = dom.confirmPassword.value;
    dom.passwordError.hidden = true;

    if (!currentPassword) {
      setFormError(dom.currentPassword, dom.passwordError, "请输入当前密码。");
      return;
    }
    if (newPassword.length < 8) {
      setFormError(dom.newPassword, dom.passwordError, "新密码至少需要 8 位。");
      return;
    }
    if (newPassword !== confirmation) {
      setFormError(dom.confirmPassword, dom.passwordError, "两次输入的新密码不一致。");
      return;
    }

    dom.passwordSubmit.disabled = true;
    dom.passwordSubmit.textContent = "更新中…";
    try {
      const data = await api("/api/auth/password", {
        method: "POST",
        body: { currentPassword, newPassword },
      });
      dom.passwordForm.reset();
      closeModal();
      const revoked = Number(data.revokedSessions || 0);
      showToast(
        revoked > 0
          ? `密码已更新，其他 ${revoked} 个登录会话已退出。`
          : "密码已更新。",
      );
    } catch (error) {
      const input = error.message.includes("当前密码") ? dom.currentPassword : dom.newPassword;
      setFormError(input, dom.passwordError, error.message);
    } finally {
      dom.passwordSubmit.disabled = false;
      dom.passwordSubmit.textContent = "更新密码";
    }
  }

  /* =========================================================
     Target modal
     ========================================================= */

  function updateTargetPresetState() {
    const value = Number(dom.targetInput.value);
    dom.targetModal.querySelectorAll("[data-target]").forEach((button) => {
      const isActive = Number(button.dataset.target) === value;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
  }

  function openTargetModal() {
    if (!canEdit()) {
      showToast("只有共建者和主人可以修改每日目标。");
      return;
    }
    dom.targetInput.value = String(getTarget());
    clearFormError(dom.targetInput, dom.targetError);
    updateTargetPresetState();
    openModal(dom.targetModal);
    requestAnimationFrame(() => dom.targetInput.select());
  }

  async function saveTarget(event) {
    event.preventDefault();
    if (!state.kitchen) return;
    const value = Number(dom.targetInput.value);
    if (!Number.isFinite(value) || value < TARGET_MIN || value > TARGET_MAX) {
      setFormError(
        dom.targetInput,
        dom.targetError,
        `每日目标需要在 ${formatNumber(TARGET_MIN)}–${formatNumber(TARGET_MAX)} kcal 之间。`,
      );
      return;
    }

    try {
      const detail = await api(`/api/kitchens/${encodeURIComponent(state.kitchen.id)}`, {
        method: "PATCH",
        body: { dailyTarget: Math.round(value) },
      });
      state.kitchen = detail.kitchen;
      state.members = detail.members;
      state.invites = detail.invites || [];
      closeModal();
      renderPlanner();
      renderKitchen();
      renderChrome();
      showToast(`每日目标已设为 ${formatNumber(detail.kitchen.dailyTarget)} kcal`);
    } catch (error) {
      showToast(error.message);
    }
  }

  /* =========================================================
     Clear week / sample
     ========================================================= */

  function openClearWeek() {
    if (!canEdit()) return;
    renderHeaderDates();
    openModal(dom.clearModal);
    requestAnimationFrame(() => dom.clearModal.querySelector(".button-danger").focus({ preventScroll: true }));
  }

  async function clearWeek({ skipConfirm = false, silent = false } = {}) {
    if (!canEdit() || !state.kitchen) return;
    if (!skipConfirm) {
      openClearWeek();
      return;
    }

    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/plan?weekStart=${encodeURIComponent(dateKey(state.weekStart))}`,
        { method: "DELETE" },
      );
      applyPlanResponse(data.plan);
      closeModal({ restoreFocus: false });
      if (!silent) showToast("本周已清空，重新开始吧。");
      setTimeout(() => dom.clearWeek.focus({ preventScroll: true }), 250);
    } catch (error) {
      showToast(error.message);
    }
  }

  function requestClearDay(date) {
    if (!canEdit() || !state.kitchen) return;
    const count = getDayItemCount(date);
    if (!count) {
      showToast("这一天还没有安排食物。");
      return;
    }
    askConfirm({
      title: `清空${formatDayLong(date)}的食谱？`,
      copy: `${formatDayLong(date)}有 ${count} 道食物。清空后，这一天的热量记录也会一起移除，其他日期不受影响。`,
      confirmLabel: "清空本日",
      action: async () => {
        const data = await api(
          `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/plan/day?date=${encodeURIComponent(date)}&weekStart=${encodeURIComponent(dateKey(state.weekStart))}`,
          { method: "DELETE" },
        );
        applyPlanResponse(data.plan);
        showToast(`${formatDayLong(date)}的食谱已清空。`);
      },
    });
  }

  function dismissSample() {
    if (!state.kitchen) return;
    dismissSampleFor(state.kitchen.id);
    dom.demoBanner.hidden = true;
    showToast("示例食谱已保留，随时可以修改。");
  }

  async function startBlankWeek() {
    if (!canEdit()) return;
    dom.demoBanner.hidden = true;
    await clearWeek({ skipConfirm: true, silent: true });
    showToast("已从一张白纸开始，慢慢安排。");
  }

  /* =========================================================
     Ingredient modal & actions
     ========================================================= */

  function syncIngredientCategoryPicker(category) {
    const validCategory = CATEGORY_META[category] ? category : "staple";
    dom.ingredientCategory.value = validCategory;
    dom.ingredientCategoryPicker.querySelectorAll("[data-category-choice]").forEach((button) => {
      const active = button.dataset.categoryChoice === validCategory;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-checked", String(active));
    });
  }

  function openIngredientModal(ingredientId = null) {
    if (!canEdit()) return;
    const ingredient = ingredientId
      ? state.ingredients.find((item) => item.id === ingredientId) || null
      : null;
    if (ingredientId && !ingredient) {
      showToast("食材不存在，请刷新后再试。");
      return;
    }

    ingredientEditId = ingredient ? ingredient.id : null;
    dom.ingredientForm.reset();
    clearFormError(dom.ingredientName, dom.ingredientError);
    dom.ingredientName.value = ingredient ? ingredient.name : "";
    dom.ingredientCategory.value = ingredient ? ingredient.category : "staple";
    syncIngredientCategoryPicker(dom.ingredientCategory.value);
    dom.ingredientUnit.value = ingredient ? ingredient.unit : "";
    dom.ingredientCalories.value = ingredient ? String(ingredient.calories) : "";
    dom.ingredientModalTitle.textContent = ingredient ? "编辑食材" : "新建食材";
    dom.ingredientSubmitButton.textContent = ingredient ? "保存修改" : "保存食材";
    dom.deleteIngredient.hidden = !ingredient;

    openModal(dom.ingredientModal);
    requestAnimationFrame(() => dom.ingredientName.focus({ preventScroll: true }));
  }

  async function saveIngredient(event) {
    event.preventDefault();
    if (!state.kitchen) return;
    const name = dom.ingredientName.value.replace(/\s+/g, " ").trim();
    const unit = dom.ingredientUnit.value.replace(/\s+/g, " ").trim();
    const category = dom.ingredientCategory.value;
    const rawCalories = dom.ingredientCalories.value.trim();
    const calories = Number(rawCalories);

    if (!name) {
      setFormError(dom.ingredientName, dom.ingredientError, "给食材写个名字吧。");
      return;
    }
    if (!rawCalories || !Number.isFinite(calories) || calories < 0 || calories > FOOD_MAX) {
      setFormError(
        dom.ingredientCalories,
        dom.ingredientError,
        `每份热量需要在 0–${formatNumber(FOOD_MAX)} kcal 之间。`,
      );
      return;
    }

    dom.ingredientSubmitButton.disabled = true;
    dom.ingredientSubmitButton.textContent = "保存中…";
    try {
      const data = await api(
        ingredientEditId
          ? `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/ingredients/${encodeURIComponent(ingredientEditId)}`
          : `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/ingredients`,
        {
          method: ingredientEditId ? "PATCH" : "POST",
          body: {
            name,
            category,
            unit: unit || "1 份",
            calories: Math.round(calories),
          },
        },
      );
      state.ingredients = data.ingredients || [];
      closeModal();
      renderIngredients();
      showToast(ingredientEditId ? `已更新「${name}」` : `已把「${name}」放进食材库`);
    } catch (error) {
      showToast(error.message);
    } finally {
      dom.ingredientSubmitButton.disabled = false;
      dom.ingredientSubmitButton.textContent = ingredientEditId ? "保存修改" : "保存食材";
    }
  }

  function deleteCurrentIngredient() {
    if (!ingredientEditId || !state.kitchen) return;
    const ingredient = state.ingredients.find((item) => item.id === ingredientEditId);
    if (!ingredient) return;
    const targetId = ingredient.id;
    askConfirm({
      title: "从食材库删除？",
      copy: `「${ingredient.name}」会从当前厨房的预设中移除，已经加入食谱的食物不受影响。`,
      confirmLabel: "删除食材",
      action: async () => {
        const data = await api(
          `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/ingredients/${encodeURIComponent(targetId)}`,
          { method: "DELETE" },
        );
        state.ingredients = data.ingredients || [];
        ingredientEditId = null;
        renderIngredients();
        showToast(`已从食材库删除「${ingredient.name}」`);
      },
    });
  }

  function openQuickAdd(ingredientId) {
    if (!canEdit()) return;
    const ingredient = state.ingredients.find((item) => item.id === ingredientId);
    if (!ingredient) return;
    state.quickIngredient = ingredient;
    const dates = getWeekDates(state.weekStart);
    dom.quickAddDay.innerHTML = dates
      .map(
        (date, index) =>
          `<option value="${dateKey(date)}">${DAY_NAMES[index]} · ${formatShortDate(date)}</option>`,
      )
      .join("");
    dom.quickAddForm.querySelector('input[name="quickMeal"][value="breakfast"]').checked = true;
    dom.quickAddTitle.textContent = "加入本周食谱";
    dom.quickAddName.textContent = ingredient.name;
    dom.quickAddCategory.textContent = categoryLabel(ingredient.category);
    dom.quickAddMeta.textContent = `${formatNumber(ingredient.calories)} kcal · ${ingredient.unit}`;
    clearFormError(null, dom.quickAddError);
    dom.quickAddError.hidden = true;
    openModal(dom.quickAddModal);
    requestAnimationFrame(() => dom.quickAddDay.focus({ preventScroll: true }));
  }

  async function saveQuickAdd(event) {
    event.preventDefault();
    if (!state.quickIngredient || !state.kitchen) return;
    const ingredient = state.quickIngredient;
    const date = dom.quickAddDay.value;
    const meal = dom.quickAddForm.querySelector('input[name="quickMeal"]:checked')?.value || "breakfast";

    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/plan/items`,
        {
          method: "POST",
          body: {
            weekStart: dateKey(state.weekStart),
            date,
            meal,
            name: ingredient.name,
            calories: ingredient.calories,
          },
        },
      );
      applyPlanResponse(data.plan);
      closeModal();
      showToast(
        `已把「${ingredient.name}」放进${formatDayLong(date)}${MEALS.find((m) => m.key === meal)?.label || ""}`,
      );
    } catch (error) {
      setFormError(null, dom.quickAddError, error.message);
    }
  }

  /* =========================================================
     Kitchen actions
     ========================================================= */

  function openCreateKitchen() {
    dom.createKitchenForm.reset();
    clearFormError(dom.newKitchenName, dom.createKitchenError);
    openModal(dom.createKitchenModal);
    requestAnimationFrame(() => dom.newKitchenName.focus({ preventScroll: true }));
  }

  async function createKitchen(event) {
    event.preventDefault();
    const name = dom.newKitchenName.value.trim();
    if (!name) {
      setFormError(dom.newKitchenName, dom.createKitchenError, "给厨房起个名字吧。");
      return;
    }

    try {
      const data = await api("/api/kitchens", { method: "POST", body: { name } });
      state.kitchens = data.kitchens;
      closeModal();
      renderChrome();
      await switchKitchen(data.kitchen.id, { targetView: "kitchen" });
      showToast(`「${data.kitchen.name}」建好了`);
    } catch (error) {
      setFormError(dom.newKitchenName, dom.createKitchenError, error.message);
    }
  }

  function openJoinKitchen() {
    dom.joinKitchenForm.reset();
    clearFormError(dom.joinCodeInput, dom.joinKitchenError);
    openModal(dom.joinKitchenModal);
    requestAnimationFrame(() => dom.joinCodeInput.focus({ preventScroll: true }));
  }

  async function joinKitchen(event) {
    event.preventDefault();
    const code = extractInviteCode(dom.joinCodeInput.value);
    if (!code) {
      setFormError(dom.joinCodeInput, dom.joinKitchenError, "请粘贴邀请链接或邀请码。");
      return;
    }

    try {
      const data = await api(`/api/invites/${encodeURIComponent(code)}/accept`, {
        method: "POST",
        body: {},
      });
      state.kitchens = data.kitchens || state.kitchens;
      closeModal();
      renderChrome();
      await switchKitchen(data.kitchenId, { targetView: "kitchen" });
      showToast(data.joined ? `已加入「${data.kitchenName}」` : `已切换到「${data.kitchenName}」`);
    } catch (error) {
      setFormError(dom.joinCodeInput, dom.joinKitchenError, error.message);
    }
  }

  function openRenameKitchen() {
    if (!state.kitchen || !isOwner()) return;
    dom.renameKitchenInput.value = state.kitchen.name;
    clearFormError(dom.renameKitchenInput, dom.renameKitchenError);
    openModal(dom.renameKitchenModal);
    requestAnimationFrame(() => dom.renameKitchenInput.select());
  }

  async function renameKitchen(event) {
    event.preventDefault();
    if (!state.kitchen) return;
    const name = dom.renameKitchenInput.value.trim();
    if (!name) {
      setFormError(dom.renameKitchenInput, dom.renameKitchenError, "厨房名字不能为空。");
      return;
    }
    try {
      const detail = await api(`/api/kitchens/${encodeURIComponent(state.kitchen.id)}`, {
        method: "PATCH",
        body: { name },
      });
      state.kitchen = detail.kitchen;
      state.members = detail.members;
      state.invites = detail.invites || [];
      closeModal();
      renderChrome();
      renderKitchen();
      showToast("厨房名字已更新。");
    } catch (error) {
      setFormError(dom.renameKitchenInput, dom.renameKitchenError, error.message);
    }
  }

  async function createInvite() {
    if (!state.kitchen || !isOwner()) return;
    const role =
      dom.inviteCard.querySelector('input[name="inviteRole"]:checked')?.value || "viewer";
    const button = dom.createInviteButton;
    button.disabled = true;
    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/invites`,
        { method: "POST", body: { role } },
      );
      state.generatedInviteLink = `${location.origin}/join/${data.invite.code}`;
      state.generatedInviteRole = data.invite.role;
      state.invites = data.invites || state.invites;
      renderKitchen();
      dom.inviteResult.hidden = false;
      dom.inviteLink.value = state.generatedInviteLink;
      showToast("邀请链接已生成，可以发给朋友了。");
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function copyText(text, successMessage = "已复制") {
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMessage);
      return;
    } catch (error) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
        showToast(successMessage);
      } catch (copyError) {
        showToast("复制失败，请手动选中链接复制。");
      }
      textarea.remove();
    }
  }

  async function revokeInvite(inviteId) {
    if (!state.kitchen) return;
    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/invites/${encodeURIComponent(inviteId)}`,
        { method: "DELETE" },
      );
      state.invites = data.invites || [];
      if (state.generatedInviteLink) {
        const activeCodes = new Set(state.invites.map((invite) => invite.code));
        const generatedCode = state.generatedInviteLink.split("/").pop();
        if (!activeCodes.has(generatedCode)) {
          state.generatedInviteLink = null;
          dom.inviteResult.hidden = true;
        }
      }
      renderKitchen();
      showToast("邀请链接已撤回。");
    } catch (error) {
      showToast(error.message);
    }
  }

  async function updateMemberRole(memberId, role) {
    if (!state.kitchen) return;
    try {
      const data = await api(
        `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/members/${encodeURIComponent(memberId)}`,
        { method: "PATCH", body: { role } },
      );
      state.members = data.members;
      renderKitchen();
      showToast(`成员身份已改为「${roleLabel(role)}」`);
    } catch (error) {
      showToast(error.message);
      await refreshKitchenDetail();
    }
  }

  function removeMember(memberId, memberName) {
    if (!state.kitchen) return;
    askConfirm({
      title: "把朋友请出厨房？",
      copy: `「${memberName}」将不能再查看或编辑这间厨房。之后可以重新邀请。`,
      confirmLabel: "移除成员",
      action: async () => {
        const data = await api(
          `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/members/${encodeURIComponent(memberId)}`,
          { method: "DELETE" },
        );
        state.members = data.members;
        renderKitchen();
        showToast(`已移除「${memberName}」`);
      },
    });
  }

  function leaveKitchen() {
    if (!state.kitchen || isOwner()) return;
    const kitchen = state.kitchen;
    askConfirm({
      title: "退出这间厨房？",
      copy: `退出后你将无法再查看「${kitchen.name}」的食谱和食材库。需要的话，请主人重新邀请你。`,
      confirmLabel: "退出厨房",
      action: async () => {
        const data = await api(
          `/api/kitchens/${encodeURIComponent(kitchen.id)}/leave`,
          { method: "POST", body: {} },
        );
        state.kitchens = data.kitchens || [];
        disconnectStream();
        state.kitchen = null;
        state.plan = null;
        state.ingredients = [];
        state.members = [];
        state.invites = [];
        renderChrome();
        const fallback = state.kitchens[0];
        if (fallback) {
          await switchKitchen(fallback.id, { targetView: "kitchen" });
        } else {
          showAuth();
        }
        showToast(`已退出「${kitchen.name}」`);
      },
    });
  }

  /* =========================================================
     Popovers
     ========================================================= */

  function toggleKitchenMenu() {
    const willOpen = dom.kitchenMenu.hidden;
    closeAllPopovers();
    if (willOpen) {
      dom.kitchenMenu.hidden = false;
      dom.kitchenSwitch.setAttribute("aria-expanded", "true");
    }
  }

  function toggleUserMenu() {
    const willOpen = dom.userMenu.hidden;
    closeAllPopovers();
    if (willOpen) {
      dom.userMenu.hidden = false;
      dom.userMenuButton.setAttribute("aria-expanded", "true");
    }
  }

  /* =========================================================
     Bootstrap
     ========================================================= */

  async function bootstrap() {
    const inviteCode = getInviteCodeFromLocation();
    if (inviteCode) {
      await loadInvitePreview(inviteCode);
    }

    try {
      const runtime = await api("/api/runtime", { allowUnauthorized: true });
      state.realtime = runtime.realtime !== false;
    } catch (error) {
      state.realtime = false;
    }

    let me = null;
    try {
      me = await api("/api/auth/me", { allowUnauthorized: true });
    } catch (error) {
      hideBoot();
      showAuth();
      if (error.status !== 401) showAuthError(error.message);
      return;
    }

    if (!me) {
      hideBoot();
      showAuth();
      return;
    }

    state.user = me.user;
    state.kitchens = me.kitchens;

    let inviteResult = null;
    if (state.pendingInviteCode) {
      inviteResult = await acceptPendingInvite();
    }

    const preferredId =
      inviteResult?.kitchenId ||
      getActiveKitchenStored() ||
      state.kitchens[0]?.id ||
      null;

    const loaded = await enterAppWithKitchen(preferredId);
    if (!loaded) {
      hideBoot();
      showAuth();
      showAuthError("厨房加载失败，请稍后重试。");
      return;
    }

    hideBoot();
    if (inviteResult?.kitchenId) {
      showToast(
        inviteResult.joined
          ? `已加入「${inviteResult.kitchenName}」`
          : `已切换到「${inviteResult.kitchenName}」`,
      );
    } else if (inviteResult?.error) {
      showToast(inviteResult.error);
    }
  }

  /* =========================================================
     DOM cache & event binding
     ========================================================= */

  function cacheDom() {
    const id = (value) => document.getElementById(value);

    dom.bootScreen = id("bootScreen");
    dom.protocolView = id("protocolView");
    dom.authView = id("authView");
    dom.appView = id("appView");

    dom.authInviteBanner = id("authInviteBanner");
    dom.authInviteTitle = id("authInviteTitle");
    dom.authInviteText = id("authInviteText");
    dom.authKicker = id("authKicker");
    dom.authTitle = id("authTitle");
    dom.authSub = id("authSub");
    dom.authTabLogin = id("authTabLogin");
    dom.authTabRegister = id("authTabRegister");
    dom.displayNameField = id("displayNameField");
    dom.authDisplayName = id("authDisplayName");
    dom.authUsername = id("authUsername");
    dom.authPassword = id("authPassword");
    dom.passwordToggle = id("passwordToggle");
    dom.authError = id("authError");
    dom.authForm = id("authForm");
    dom.authSubmit = id("authSubmit");
    dom.authSubmitLabel = id("authSubmitLabel");

    dom.kitchenSwitch = id("kitchenSwitch");
    dom.kitchenAvatar = id("kitchenAvatar");
    dom.kitchenSwitchName = id("kitchenSwitchName");
    dom.kitchenSwitchRole = id("kitchenSwitchRole");
    dom.kitchenMenu = id("kitchenMenu");
    dom.kitchenMenuList = id("kitchenMenuList");
    dom.openKitchenManager = id("openKitchenManager");
    dom.syncStatus = id("syncStatus");
    dom.userMenuButton = id("userMenuButton");
    dom.userMenu = id("userMenu");
    dom.userInitial = id("userInitial");
    dom.userMenuInitial = id("userMenuInitial");
    dom.userMenuName = id("userMenuName");
    dom.userMenuUsername = id("userMenuUsername");
    dom.profileButton = id("profileButton");
    dom.adminLink = id("adminLink");
    dom.logoutButton = id("logoutButton");

    dom.profileModal = id("profileModal");
    dom.profileForm = id("profileForm");
    dom.profileDisplayName = id("profileDisplayName");
    dom.profileError = id("profileError");
    dom.profileSubmit = id("profileSubmit");
    dom.profileAvatar = id("profileAvatar");
    dom.profileNamePreview = id("profileNamePreview");
    dom.profileUsernamePreview = id("profileUsernamePreview");
    dom.passwordForm = id("passwordForm");
    dom.currentPassword = id("currentPassword");
    dom.newPassword = id("newPassword");
    dom.confirmPassword = id("confirmPassword");
    dom.passwordError = id("passwordError");
    dom.passwordSubmit = id("passwordSubmit");
    dom.mainNav = id("mainNav");
    dom.mobileTabbar = id("mobileTabbar");

    dom.plannerView = id("plannerView");
    dom.ingredientsView = id("ingredientsView");
    dom.tableView = id("tableView");
    dom.kitchenView = id("kitchenView");
    dom.wellnessView = id("wellnessView");
    dom.wellnessRange = id("wellnessRange");
    dom.wellnessDays = id("wellnessDays");
    dom.sleepBedtime = id("sleepBedtime");
    dom.sleepWake = id("sleepWake");
    dom.sleepDuration = id("sleepDuration");
    dom.saveSleep = id("saveSleep");
    dom.sleepHint = id("sleepHint");
    dom.exerciseCalories = id("exerciseCalories");
    dom.exerciseQuick = id("exerciseQuick");
    dom.saveExercise = id("saveExercise");
    dom.exerciseHint = id("exerciseHint");
    dom.wellnessSummary = id("wellnessSummary");

    dom.heroWeekNo = id("heroWeekNo");
    dom.heroRange = id("heroRange");
    dom.heroYear = id("heroYear");
    dom.heroRoleBadge = id("heroRoleBadge");
    dom.targetButton = id("targetButton");
    dom.targetCurrent = id("targetCurrent");
    dom.weekTotal = id("weekTotal");
    dom.weekCompare = id("weekCompare");
    dom.weekChart = id("weekChart");
    dom.recordedDays = id("recordedDays");
    dom.overDays = id("overDays");
    dom.boardRange = id("boardRange");
    dom.boardWeekNo = id("boardWeekNo");
    dom.todayButton = id("todayButton");
    dom.prevWeek = id("prevWeek");
    dom.nextWeek = id("nextWeek");
    dom.printButton = id("printButton");
    dom.readonlyBanner = id("readonlyBanner");
    dom.plannerSub = id("plannerSub");
    dom.readonlyManage = id("readonlyManage");
    dom.plannerTools = id("plannerTools");
    dom.copyLastWeek = id("copyLastWeek");
    dom.openRecipeTools = id("openRecipeTools");
    dom.demoBanner = id("demoBanner");
    dom.startBlank = id("startBlank");
    dom.dismissDemo = id("dismissDemo");
    dom.weekBoard = id("weekBoard");
    dom.dayPager = id("dayPager");
    dom.boardLoading = id("boardLoading");
    dom.clearWeek = id("clearWeek");
    dom.footerYear = id("footerYear");

    dom.ingredientCount = id("ingredientCount");
    dom.addIngredientButton = id("addIngredientButton");
    dom.bulkIngredientButton = id("bulkIngredientButton");
    dom.ingredientBulkBar = id("ingredientBulkBar");
    dom.selectedIngredientCount = id("selectedIngredientCount");
    dom.selectAllIngredients = id("selectAllIngredients");
    dom.deleteSelectedIngredients = id("deleteSelectedIngredients");
    dom.cancelIngredientBulk = id("cancelIngredientBulk");
    dom.categoryTabs = id("categoryTabs");
    dom.ingredientSearch = id("ingredientSearch");
    dom.ingredientWeekLabel = id("ingredientWeekLabel");
    dom.ingredientRoleNote = id("ingredientRoleNote");
    dom.ingredientGrid = id("ingredientGrid");
    dom.ingredientEmpty = id("ingredientEmpty");
    dom.emptyAddIngredient = id("emptyAddIngredient");

    dom.currentKitchenName = id("currentKitchenName");
    dom.currentKitchenRole = id("currentKitchenRole");
    dom.currentKitchenMeta = id("currentKitchenMeta");
    dom.kitchenBigAvatar = id("kitchenBigAvatar");
    dom.renameKitchenButton = id("renameKitchenButton");
    dom.leaveKitchenButton = id("leaveKitchenButton");
    dom.kitchenOwnerName = id("kitchenOwnerName");
    dom.kitchenMemberCount = id("kitchenMemberCount");
    dom.kitchenRoleLabel = id("kitchenRoleLabel");
    dom.kitchenTargetLabel = id("kitchenTargetLabel");
    dom.kitchenWeekDays = id("kitchenWeekDays");
    dom.kitchenWeekCalories = id("kitchenWeekCalories");
    dom.kitchenMemberAvatars = id("kitchenMemberAvatars");
    dom.kitchenGoPlanner = id("kitchenGoPlanner");
    dom.inviteCard = id("inviteCard");
    dom.inviteResult = id("inviteResult");
    dom.inviteLink = id("inviteLink");
    dom.inviteHint = id("inviteHint");
    dom.inviteOwnerNote = id("inviteOwnerNote");
    dom.inviteOwnerRole = id("inviteOwnerRole");
    dom.createInviteButton = id("createInviteButton");
    dom.copyInviteButton = id("copyInviteButton");
    dom.activeInvites = id("activeInvites");
    dom.memberCountLabel = id("memberCountLabel");
    dom.memberList = id("memberList");
    dom.kitchenListCount = id("kitchenListCount");
    dom.messageForm = id("messageForm");
    dom.messageInput = id("messageInput");
    dom.messageLength = id("messageLength");
    dom.messageSubmit = id("messageSubmit");
    dom.messageCountLabel = id("messageCountLabel");
    dom.messageList = id("messageList");
    dom.tableStartPoll = id("tableStartPoll");
    dom.tableAddGrocery = id("tableAddGrocery");
    dom.tableWeekLabel = id("tableWeekLabel");
    dom.tablePrevWeek = id("tablePrevWeek");
    dom.tableNextWeek = id("tableNextWeek");
    dom.cookRoster = id("cookRoster");
    dom.pollCount = id("pollCount");
    dom.pollList = id("pollList");
    dom.pollEmpty = id("pollEmpty");
    dom.pollEmptyAction = id("pollEmptyAction");
    dom.groceryCount = id("groceryCount");
    dom.groceryList = id("groceryList");
    dom.groceryEmpty = id("groceryEmpty");
    dom.groceryEmptyAction = id("groceryEmptyAction");
    dom.kitchenList = id("kitchenList");
    dom.createKitchenButton = id("createKitchenButton");
    dom.joinKitchenButton = id("joinKitchenButton");

    dom.foodModal = id("foodModal");
    dom.foodForm = id("foodForm");
    dom.foodModalKicker = id("foodModalKicker");
    dom.foodModalTitle = id("foodModalTitle");
    dom.presetField = id("presetField");
    dom.presetPickerButton = id("presetPickerButton");
    dom.presetTriggerLabel = id("presetTriggerLabel");
    dom.presetTriggerMeta = id("presetTriggerMeta");
    dom.presetPanel = id("presetPanel");
    dom.presetSearch = id("presetSearch");
    dom.presetCategoryChips = id("presetCategoryChips");
    dom.presetList = id("presetList");
    dom.presetEmpty = id("presetEmpty");
    dom.closePresetPanel = id("closePresetPanel");
    dom.presetHint = id("presetHint");
    dom.manageIngredientsFromModal = id("manageIngredientsFromModal");
    dom.foodName = id("foodName");
    dom.foodKcal = id("foodKcal");
    dom.foodError = id("foodError");
    dom.deleteFood = id("deleteFood");
    dom.foodSubmitButton = id("foodSubmitButton");

    dom.targetModal = id("targetModal");
    dom.targetForm = id("targetForm");
    dom.targetInput = id("targetInput");
    dom.targetError = id("targetError");

    dom.clearModal = id("clearModal");
    dom.clearModalKicker = id("clearModalKicker");
    dom.clearModalTitle = id("clearModalTitle");
    dom.clearModalCopy = id("clearModalCopy");
    dom.confirmClear = id("confirmClear");

    dom.ingredientModal = id("ingredientModal");
    dom.ingredientForm = id("ingredientForm");
    dom.ingredientModalTitle = id("ingredientModalTitle");
    dom.ingredientName = id("ingredientName");
    dom.ingredientCategory = id("ingredientCategory");
    dom.ingredientCategoryPicker = id("ingredientCategoryPicker");
    dom.ingredientUnit = id("ingredientUnit");
    dom.ingredientCalories = id("ingredientCalories");
    dom.ingredientError = id("ingredientError");
    dom.deleteIngredient = id("deleteIngredient");
    dom.ingredientSubmitButton = id("ingredientSubmitButton");

    dom.quickAddModal = id("quickAddModal");
    dom.quickAddForm = id("quickAddForm");
    dom.quickAddTitle = id("quickAddTitle");
    dom.quickAddCategory = id("quickAddCategory");
    dom.quickAddName = id("quickAddName");
    dom.quickAddMeta = id("quickAddMeta");
    dom.quickAddDay = id("quickAddDay");
    dom.quickAddError = id("quickAddError");

    dom.createKitchenModal = id("createKitchenModal");
    dom.createKitchenForm = id("createKitchenForm");
    dom.newKitchenName = id("newKitchenName");
    dom.createKitchenError = id("createKitchenError");

    dom.joinKitchenModal = id("joinKitchenModal");
    dom.joinKitchenForm = id("joinKitchenForm");
    dom.joinCodeInput = id("joinCodeInput");
    dom.joinKitchenError = id("joinKitchenError");

    dom.renameKitchenModal = id("renameKitchenModal");
    dom.renameKitchenForm = id("renameKitchenForm");
    dom.renameKitchenInput = id("renameKitchenInput");
    dom.renameKitchenError = id("renameKitchenError");

    dom.cookModal = id("cookModal");
    dom.cookModalTitle = id("cookModalTitle");
    dom.cookModalCopy = id("cookModalCopy");
    dom.cookChoiceList = id("cookChoiceList");
    dom.cookError = id("cookError");
    dom.cookSave = id("cookSave");
    dom.cookClear = id("cookClear");
    dom.cookClaim = id("cookClaim");

    dom.recipeToolsModal = id("recipeToolsModal");
    dom.recipeTabTemplates = id("recipeTabTemplates");
    dom.recipeTabFavorites = id("recipeTabFavorites");
    dom.recipePanelTemplates = id("recipePanelTemplates");
    dom.recipePanelFavorites = id("recipePanelFavorites");
    dom.templateNameInput = id("templateNameInput");
    dom.templateSaveHint = id("templateSaveHint");
    dom.saveWeekTemplate = id("saveWeekTemplate");
    dom.templateList = id("templateList");
    dom.templateEmpty = id("templateEmpty");
    dom.favoriteList = id("favoriteList");
    dom.favoriteEmpty = id("favoriteEmpty");

    dom.favoriteModal = id("favoriteModal");
    dom.favoriteModalCopy = id("favoriteModalCopy");
    dom.favoritePreview = id("favoritePreview");
    dom.favoriteName = id("favoriteName");
    dom.favoriteError = id("favoriteError");
    dom.favoriteSave = id("favoriteSave");

    dom.favoriteApplyModal = id("favoriteApplyModal");
    dom.favoriteApplyPreview = id("favoriteApplyPreview");
    dom.favoriteApplyDay = id("favoriteApplyDay");
    dom.favoriteApplyMeal = id("favoriteApplyMeal");
    dom.favoriteApplyError = id("favoriteApplyError");
    dom.favoriteApplySave = id("favoriteApplySave");

    dom.templateApplyModal = id("templateApplyModal");
    dom.templateApplySummary = id("templateApplySummary");
    dom.templateApplyError = id("templateApplyError");
    dom.templateApplyConfirm = id("templateApplyConfirm");

    dom.pollModal = id("pollModal");
    dom.pollForm = id("pollForm");
    dom.pollTitle = id("pollTitle");
    dom.pollNote = id("pollNote");
    dom.pollOptions = id("pollOptions");
    dom.pollError = id("pollError");
    dom.pollSubmit = id("pollSubmit");

    dom.groceryModal = id("groceryModal");
    dom.groceryForm = id("groceryForm");
    dom.groceryMember = id("groceryMember");
    dom.groceryDay = id("groceryDay");
    dom.groceryNote = id("groceryNote");
    dom.groceryError = id("groceryError");
    dom.grocerySubmit = id("grocerySubmit");

    dom.confirmModal = id("confirmModal");
    dom.confirmTitle = id("confirmTitle");
    dom.confirmCopy = id("confirmCopy");
    dom.confirmActionButton = id("confirmActionButton");

    dom.toast = id("toast");
    dom.toastText = id("toastText");
  }

  function bindEvents() {
    document.querySelectorAll("[data-auth-mode]").forEach((button) => {
      button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
    });
    dom.authForm.addEventListener("submit", handleAuthSubmit);
    dom.authUsername.addEventListener("input", hideAuthError);
    dom.authPassword.addEventListener("input", hideAuthError);
    dom.authDisplayName.addEventListener("input", hideAuthError);
    dom.passwordToggle.addEventListener("click", () => {
      const showing = dom.authPassword.type === "text";
      dom.authPassword.type = showing ? "password" : "text";
      dom.passwordToggle.setAttribute("aria-label", showing ? "显示密码" : "隐藏密码");
      dom.passwordToggle.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#icon-${showing ? "eye" : "eye-off"}"></use></svg>`;
    });

    document.querySelectorAll("[data-view]").forEach((button) => {
      button.addEventListener("click", () => navigate(button.dataset.view));
    });

    dom.kitchenSwitch.addEventListener("click", toggleKitchenMenu);
    dom.userMenuButton.addEventListener("click", toggleUserMenu);
    dom.kitchenMenuList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-kitchen-id]");
      if (!button) return;
      switchKitchen(button.dataset.kitchenId);
    });
    dom.openKitchenManager.addEventListener("click", () => {
      closeAllPopovers();
      navigate("kitchen");
    });
    dom.profileButton.addEventListener("click", openProfileModal);
    dom.logoutButton.addEventListener("click", logout);
    dom.profileForm.addEventListener("submit", saveProfile);
    dom.passwordForm.addEventListener("submit", savePassword);
    dom.profileDisplayName.addEventListener("input", () => {
      clearFormError(dom.profileDisplayName, dom.profileError);
      dom.profileAvatar.textContent = firstCharacter(dom.profileDisplayName.value || state.user?.displayName);
      const preview = dom.profileDisplayName.value.trim();
      if (preview) dom.profileNamePreview.textContent = preview;
    });
    dom.currentPassword.addEventListener("input", () => clearFormError(dom.currentPassword, dom.passwordError));
    dom.newPassword.addEventListener("input", () => clearFormError(dom.newPassword, dom.passwordError));
    dom.confirmPassword.addEventListener("input", () => clearFormError(dom.confirmPassword, dom.passwordError));

    dom.prevWeek.addEventListener("click", () => changeWeek(-1));
    dom.nextWeek.addEventListener("click", () => changeWeek(1));
    dom.todayButton.addEventListener("click", goToCurrentWeek);
    dom.printButton.addEventListener("click", () => window.print());
    dom.targetButton.addEventListener("click", openTargetModal);
    dom.clearWeek.addEventListener("click", openClearWeek);
    dom.confirmClear.addEventListener("click", () => clearWeek({ skipConfirm: true }));
    dom.dismissDemo.addEventListener("click", dismissSample);
    dom.startBlank.addEventListener("click", startBlankWeek);
    dom.readonlyManage.addEventListener("click", () => navigate("kitchen"));
    dom.copyLastWeek.addEventListener("click", copyLastWeek);
    dom.openRecipeTools.addEventListener("click", () => openRecipeTools("templates"));

    dom.tableStartPoll.addEventListener("click", openPollModal);
    dom.pollEmptyAction.addEventListener("click", openPollModal);
    dom.tableAddGrocery.addEventListener("click", openGroceryModal);
    dom.groceryEmptyAction.addEventListener("click", openGroceryModal);
    dom.tablePrevWeek.addEventListener("click", () => changeTableWeek(-1));
    dom.tableNextWeek.addEventListener("click", () => changeTableWeek(1));
    dom.cookRoster.addEventListener("click", (event) => {
      const button = event.target.closest("[data-cook-date]");
      if (button) openCookModal(button.dataset.cookDate);
    });
    dom.pollList.addEventListener("click", (event) => {
      const voteButton = event.target.closest("[data-poll-vote]");
      if (voteButton && !voteButton.disabled) {
        votePoll(voteButton.dataset.pollVote, voteButton.dataset.optionId);
        return;
      }
      const closeButton = event.target.closest("[data-poll-close]");
      if (closeButton) {
        setPollStatus(closeButton.dataset.pollClose, "close");
        return;
      }
      const reopenButton = event.target.closest("[data-poll-reopen]");
      if (reopenButton) {
        setPollStatus(reopenButton.dataset.pollReopen, "reopen");
        return;
      }
      const deleteButton = event.target.closest("[data-poll-delete]");
      if (deleteButton) {
        askConfirm({
          title: "删除这个投票？",
          copy: "投票和已经投出的选择都会一起消失，其他成员也将看不到。",
          confirmLabel: "删除投票",
          action: () => deletePoll(deleteButton.dataset.pollDelete),
        });
      }
    });
    dom.groceryList.addEventListener("click", (event) => {
      const doneButton = event.target.closest("[data-grocery-done]");
      if (doneButton) {
        toggleGroceryDone(doneButton.dataset.groceryDone, doneButton.dataset.done === "1");
        return;
      }
      const deleteButton = event.target.closest("[data-grocery-delete]");
      if (deleteButton) {
        askConfirm({
          title: "删除这项买菜安排？",
          copy: "删除后，厨房成员将不再看到这项采购记录。",
          confirmLabel: "删除安排",
          action: () => deleteGrocery(deleteButton.dataset.groceryDelete),
        });
      }
    });

    dom.recipeTabTemplates.addEventListener("click", () => switchRecipeTab("templates"));
    dom.recipeTabFavorites.addEventListener("click", () => switchRecipeTab("favorites"));
    dom.saveWeekTemplate.addEventListener("click", saveWeekTemplate);
    dom.templateList.addEventListener("click", (event) => {
      const applyButton = event.target.closest("[data-apply-template]");
      if (applyButton) {
        openTemplateApply(applyButton.dataset.applyTemplate);
        return;
      }
      const deleteButton = event.target.closest("[data-delete-template]");
      if (deleteButton) {
        askConfirm({
          title: "删除这个模板？",
          copy: `「${deleteButton.dataset.templateName}」会从厨房模板里移除，已经套用过的食谱不受影响。`,
          confirmLabel: "删除模板",
          action: () => deleteTemplate(deleteButton.dataset.deleteTemplate),
        });
      }
    });
    dom.favoriteList.addEventListener("click", (event) => {
      const applyButton = event.target.closest("[data-apply-favorite]");
      if (applyButton) {
        openFavoriteApply(applyButton.dataset.applyFavorite);
        return;
      }
      const deleteButton = event.target.closest("[data-delete-favorite]");
      if (deleteButton) {
        askConfirm({
          title: "删除这个收藏？",
          copy: `「${deleteButton.dataset.favoriteName}」会从厨房收藏里移除。`,
          confirmLabel: "删除收藏",
          action: async () => {
            if (!state.kitchen) return;
            const data = await api(
              `/api/kitchens/${encodeURIComponent(state.kitchen.id)}/favorites/${encodeURIComponent(deleteButton.dataset.deleteFavorite)}`,
              { method: "DELETE" },
            );
            state.favorites = data.favorites || [];
            renderRecipeTools();
            showToast("收藏已删除。");
          },
        });
      }
    });

    dom.cookSave.addEventListener("click", saveCook);
    dom.cookClear.addEventListener("click", clearCook);
    dom.cookClaim.addEventListener("click", () => {
      const input = dom.cookChoiceList.querySelector(`input[name="cookChoice"][value="${state.user?.id}"]`);
      if (input) {
        input.checked = true;
        input.focus({ preventScroll: true });
      }
    });
    dom.cookChoiceList.addEventListener("change", () => {
      dom.cookError.hidden = true;
    });

    dom.favoriteSave.addEventListener("click", saveFavorite);
    dom.favoriteApplySave.addEventListener("click", confirmFavoriteApply);
    dom.templateApplyConfirm.addEventListener("click", confirmTemplateApply);
    dom.templateNameInput.addEventListener("input", () => {
      dom.saveWeekTemplate.disabled = false;
    });
    dom.pollForm.addEventListener("submit", createPoll);
    dom.pollTitle.addEventListener("input", () => {
      dom.pollError.hidden = true;
    });
    dom.pollOptions.addEventListener("input", () => {
      dom.pollError.hidden = true;
    });
    dom.pollNote.addEventListener("input", () => {
      dom.pollError.hidden = true;
    });
    dom.groceryForm.addEventListener("submit", saveGrocery);

    dom.weekBoard.addEventListener("click", (event) => {
      const cookButton = event.target.closest("[data-cook-date]");
      if (cookButton) {
        if (canEdit()) openCookModal(cookButton.dataset.cookDate);
        return;
      }
      if (!canEdit()) return;
      const favoriteButton = event.target.closest("[data-favorite-date]");
      if (favoriteButton) {
        openFavoriteModal(favoriteButton.dataset.favoriteDate, favoriteButton.dataset.favoriteMeal);
        return;
      }
      const clearDayButton = event.target.closest("[data-clear-day]");
      if (clearDayButton) {
        requestClearDay(clearDayButton.dataset.clearDay);
        return;
      }
      const addButton = event.target.closest(".meal-add, .empty-meal");
      if (addButton) {
        openFoodModal(addButton.dataset.date, addButton.dataset.meal);
        return;
      }
      const foodButton = event.target.closest(".food-item");
      if (foodButton && !foodButton.classList.contains("is-static")) {
        openFoodModal(foodButton.dataset.date, foodButton.dataset.meal, foodButton.dataset.id);
      }
    });

    dom.dayPager.addEventListener("click", (event) => {
      const button = event.target.closest("[data-day-index]");
      if (!button) return;
      const index = Number(button.dataset.dayIndex);
      if (!Number.isInteger(index)) return;
      state.activeDayIndex = index;
      updateDayPager(index);
      const width = dom.weekBoard.clientWidth;
      dom.weekBoard.scrollTo({ left: index * width, behavior: "auto" });
    });

    let boardScrollFrame = 0;
    dom.weekBoard.addEventListener("scroll", () => {
      if (!isMobileBoard()) return;
      cancelAnimationFrame(boardScrollFrame);
      boardScrollFrame = requestAnimationFrame(() => {
        const width = dom.weekBoard.clientWidth;
        if (!width) return;
        const index = Math.max(0, Math.min(6, Math.round(dom.weekBoard.scrollLeft / width)));
        if (index !== state.activeDayIndex) {
          state.activeDayIndex = index;
          updateDayPager(index);
        }
      });
    }, { passive: true });

    let boardResizeTimer = 0;
    window.addEventListener("resize", () => {
      if (!isMobileBoard()) return;
      clearTimeout(boardResizeTimer);
      boardResizeTimer = setTimeout(() => {
        const width = dom.weekBoard.clientWidth;
        if (width) dom.weekBoard.scrollLeft = state.activeDayIndex * width;
      }, 120);
    });

    dom.bulkIngredientButton.addEventListener("click", () => {
      if (state.ingredientBulkMode) exitIngredientBulkMode();
      else enterIngredientBulkMode();
    });
    dom.cancelIngredientBulk.addEventListener("click", exitIngredientBulkMode);
    dom.selectAllIngredients.addEventListener("click", toggleAllVisibleIngredients);
    dom.deleteSelectedIngredients.addEventListener("click", requestBulkDeleteIngredients);

    dom.wellnessDays.addEventListener("click", (event) => {
      const button = event.target.closest("[data-wellness-day]");
      if (!button) return;
      state.wellnessDate = button.dataset.wellnessDay;
      renderWellness();
    });
    dom.wellnessSummary.addEventListener("click", (event) => {
      const button = event.target.closest("[data-wellness-day]");
      if (!button) return;
      state.wellnessDate = button.dataset.wellnessDay;
      renderWellness();
    });
    dom.sleepBedtime.addEventListener("input", updateSleepDurationPreview);
    dom.sleepWake.addEventListener("input", updateSleepDurationPreview);
    dom.saveSleep.addEventListener("click", saveWellnessSleep);
    dom.saveExercise.addEventListener("click", saveWellnessExercise);
    dom.exerciseQuick.addEventListener("click", (event) => {
      const button = event.target.closest("[data-exercise-quick]");
      if (!button) return;
      const current = Number(dom.exerciseCalories.value) || 0;
      dom.exerciseCalories.value = String(Math.min(5000, current + Number(button.dataset.exerciseQuick)));
    });

    dom.addIngredientButton.addEventListener("click", () => openIngredientModal());
    dom.emptyAddIngredient.addEventListener("click", () => openIngredientModal());
    dom.ingredientSearch.addEventListener("input", () => {
      state.ingredientQuery = dom.ingredientSearch.value;
      renderIngredients();
    });
    dom.categoryTabs.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-ingredient-category]");
      if (!tab) return;
      state.ingredientCategory = tab.dataset.ingredientCategory;
      renderIngredients();
    });
    dom.ingredientGrid.addEventListener("click", (event) => {
      if (state.ingredientBulkMode) {
        const card = event.target.closest("[data-ingredient-card]");
        if (card) toggleIngredientBulkSelection(card.dataset.ingredientCard);
        return;
      }
      const editButton = event.target.closest("[data-edit-ingredient]");
      if (editButton) {
        openIngredientModal(editButton.dataset.editIngredient);
        return;
      }
      const quickButton = event.target.closest("[data-quick-add]");
      if (quickButton) {
        openQuickAdd(quickButton.dataset.quickAdd);
      }
    });

    dom.messageForm.addEventListener("submit", postMessage);
    dom.messageInput.addEventListener("input", updateMessageLength);
    dom.messageList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-delete-message]");
      if (!button) return;
      askConfirm({
        title: "删除这条留言？",
        copy: "删除后，厨房里的其他成员也将看不到这条留言。",
        confirmLabel: "删除留言",
        action: () => deleteMessage(button.dataset.deleteMessage),
      });
    });

    dom.createKitchenButton.addEventListener("click", openCreateKitchen);
    dom.joinKitchenButton.addEventListener("click", openJoinKitchen);
    dom.renameKitchenButton.addEventListener("click", openRenameKitchen);
    dom.leaveKitchenButton.addEventListener("click", leaveKitchen);
    dom.kitchenGoPlanner.addEventListener("click", () => navigate("planner"));
    dom.createInviteButton.addEventListener("click", createInvite);
    dom.copyInviteButton.addEventListener("click", () => {
      if (dom.inviteLink.value) copyText(dom.inviteLink.value, "邀请链接已复制");
    });
    dom.inviteLink.addEventListener("click", () => dom.inviteLink.select());
    dom.kitchenList.addEventListener("click", (event) => {
      const switchButton = event.target.closest("[data-switch-kitchen]");
      if (switchButton) {
        switchKitchen(switchButton.dataset.switchKitchen, { targetView: "kitchen" });
        return;
      }
      if (event.target.closest("[data-new-kitchen]")) openCreateKitchen();
    });
    dom.activeInvites.addEventListener("click", (event) => {
      const copyButton = event.target.closest("[data-copy-invite]");
      if (copyButton) {
        copyText(`${location.origin}/join/${copyButton.dataset.copyInvite}`, "邀请链接已复制");
        return;
      }
      const revokeButton = event.target.closest("[data-revoke-invite]");
      if (revokeButton) revokeInvite(revokeButton.dataset.revokeInvite);
    });
    dom.memberList.addEventListener("click", (event) => {
      const removeButton = event.target.closest("[data-remove-member]");
      if (removeButton) {
        removeMember(removeButton.dataset.removeMember, removeButton.dataset.memberName);
      }
    });
    dom.memberList.addEventListener("change", (event) => {
      const select = event.target.closest("[data-member-role]");
      if (select) updateMemberRole(select.dataset.memberRole, select.value);
    });

    dom.foodForm.addEventListener("submit", saveFood);
    dom.deleteFood.addEventListener("click", deleteFood);
    dom.foodForm.addEventListener("input", (event) => {
      if (event.target === dom.foodName) clearFormError(dom.foodName, dom.foodError);
      if (event.target === dom.foodKcal) clearFormError(dom.foodKcal, dom.foodError);
    });
    dom.foodForm.addEventListener("change", (event) => {
      if (event.target.name === "meal") updateFoodKicker();
    });
    dom.presetPickerButton.addEventListener("click", togglePresetPanel);
    dom.closePresetPanel.addEventListener("click", () => closePresetPanel({ focus: true }));
    dom.presetSearch.addEventListener("input", () => {
      state.presetQuery = dom.presetSearch.value;
      renderPresetPanel();
    });
    dom.presetSearch.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      dom.presetList.querySelector(".preset-option")?.click();
    });
    dom.presetCategoryChips.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-preset-category]");
      if (!chip) return;
      state.presetCategory = chip.dataset.presetCategory;
      renderPresetPanel();
    });
    dom.presetList.addEventListener("click", (event) => {
      const option = event.target.closest("[data-preset-id]");
      if (!option) return;
      applyPresetIngredient(state.ingredients.find((item) => item.id === option.dataset.presetId));
    });
    dom.manageIngredientsFromModal.addEventListener("click", () => {
      closeModal();
      navigate("ingredients");
    });

    dom.targetForm.addEventListener("submit", saveTarget);
    dom.targetInput.addEventListener("input", () => {
      clearFormError(dom.targetInput, dom.targetError);
      updateTargetPresetState();
    });
    dom.targetModal.querySelectorAll("[data-target]").forEach((button) => {
      button.addEventListener("click", () => {
        dom.targetInput.value = button.dataset.target;
        updateTargetPresetState();
        clearFormError(dom.targetInput, dom.targetError);
        dom.targetInput.focus({ preventScroll: true });
      });
    });

    dom.ingredientCategoryPicker.addEventListener("click", (event) => {
      const choice = event.target.closest("[data-category-choice]");
      if (!choice) return;
      syncIngredientCategoryPicker(choice.dataset.categoryChoice);
    });
    dom.ingredientCategoryPicker.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      const buttons = [...dom.ingredientCategoryPicker.querySelectorAll("[data-category-choice]")];
      const currentIndex = buttons.indexOf(document.activeElement);
      if (currentIndex === -1) return;
      event.preventDefault();
      const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
      const next = buttons[(currentIndex + direction + buttons.length) % buttons.length];
      next.focus();
      syncIngredientCategoryPicker(next.dataset.categoryChoice);
    });

    dom.ingredientForm.addEventListener("submit", saveIngredient);
    dom.deleteIngredient.addEventListener("click", deleteCurrentIngredient);
    dom.ingredientForm.addEventListener("input", (event) => {
      if (event.target === dom.ingredientName || event.target === dom.ingredientCalories) {
        clearFormError(event.target, dom.ingredientError);
      }
    });

    dom.quickAddForm.addEventListener("submit", saveQuickAdd);

    dom.createKitchenForm.addEventListener("submit", createKitchen);
    dom.joinKitchenForm.addEventListener("submit", joinKitchen);
    dom.renameKitchenForm.addEventListener("submit", renameKitchen);
    dom.newKitchenName.addEventListener("input", () => clearFormError(dom.newKitchenName, dom.createKitchenError));
    dom.joinCodeInput.addEventListener("input", () => clearFormError(dom.joinCodeInput, dom.joinKitchenError));
    dom.renameKitchenInput.addEventListener("input", () => clearFormError(dom.renameKitchenInput, dom.renameKitchenError));

    dom.confirmActionButton.addEventListener("click", async () => {
      if (!state.confirmAction) return;
      const action = state.confirmAction;
      dom.confirmActionButton.disabled = true;
      const originalLabel = dom.confirmActionButton.textContent;
      dom.confirmActionButton.textContent = "处理中…";
      try {
        await action();
        closeModal();
      } catch (error) {
        showToast(error.message);
      } finally {
        dom.confirmActionButton.disabled = false;
        dom.confirmActionButton.textContent = originalLabel;
      }
    });

    document.querySelectorAll(
      "[data-close-food], [data-close-target], [data-close-profile], [data-close-clear], [data-close-ingredient], [data-close-quick], [data-close-create-kitchen], [data-close-join-kitchen], [data-close-rename-kitchen], [data-close-cook], [data-close-recipe-tools], [data-close-favorite], [data-close-favorite-apply], [data-close-template-apply], [data-close-poll], [data-close-grocery], [data-close-confirm]",
    ).forEach((element) => {
      element.addEventListener("click", () => closeModal());
    });

    document.addEventListener("keydown", (event) => {
      if (activeModal) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeModal();
          return;
        }
        trapModalFocus(event);
        return;
      }
      if (event.key === "Escape") closeAllPopovers();
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".kitchen-switch-wrap")) {
        if (!dom.kitchenMenu.hidden) {
          dom.kitchenMenu.hidden = true;
          dom.kitchenSwitch.setAttribute("aria-expanded", "false");
        }
      }
      if (!event.target.closest(".user-wrap")) {
        if (!dom.userMenu.hidden) {
          dom.userMenu.hidden = true;
          dom.userMenuButton.setAttribute("aria-expanded", "false");
        }
      }
    });

    window.addEventListener("hashchange", () => {
      if (!state.user || !state.kitchen) return;
      if (location.hash === "#/messages") {
        history.replaceState(null, "", `${location.pathname}#/table`);
      }
      setView(viewFromHash(), { updateHash: false });
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden || !state.user || !state.kitchen) return;
      refreshPlan({ silent: true });
      refreshKitchenDetail({ render: false });
    });
  }

  function init() {
    cacheDom();
    bindEvents();

    if (location.protocol === "file:") {
      dom.bootScreen.hidden = true;
      dom.authView.hidden = true;
      dom.appView.hidden = true;
      dom.protocolView.hidden = false;
      document.body.classList.add("protocol-mode");
      document.title = "请启动本地服务 · 凑狗厨房";
      return;
    }

    setAuthMode("login");
    renderAuthInviteBanner();
    bootstrap();
  }

  init();
})();
