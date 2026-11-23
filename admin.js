(() => {
  "use strict";

  const CLIENT_ID = getClientId();
  const numberFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
  const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const MEAL_LABELS = {
    breakfast: "早餐",
    lunch: "午餐",
    dinner: "晚餐",
    snack: "加餐",
  };

  const SECTION_TITLES = {
    overview: "数据概览",
    users: "用户管理",
    kitchens: "厨房管理",
    invites: "邀请管理",
    sessions: "登录会话",
  };

  const state = {
    user: null,
    section: "overview",
    overview: null,
    users: [],
    kitchens: [],
    invites: [],
    sessions: [],
    confirmAction: null,
    refreshSequence: 0,
  };

  const dom = {};
  let activeModal = null;
  let modalReturnFocus = null;
  let toastTimer = null;
  let toastHideTimer = null;
  let hiddenTimer = null;
  const modalTimers = new WeakMap();

  function getClientId() {
    try {
      let id = sessionStorage.getItem("cougou.admin.clientId");
      if (!id) {
        id = `admin_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
        sessionStorage.setItem("cougou.admin.clientId", id);
      }
      return id;
    } catch (error) {
      return `admin_${Date.now().toString(36)}`;
    }
  }

  function number(value) {
    return numberFormatter.format(Number(value || 0));
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => {
      const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
      return map[character];
    });
  }

  function formatDateTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return dateTimeFormatter.format(date).replace(/\//g, "/");
  }

  function shortDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  function firstCharacter(value) {
    return Array.from(String(value || "管").trim())[0] || "管";
  }

  function inviteRoleLabel(role) {
    return role === "editor" ? "一起编辑" : "只能观看";
  }

  function inviteStatus(invite) {
    if (invite.revoked) return { key: "revoked", label: "已撤回" };
    if (new Date(invite.expiresAt).getTime() <= Date.now()) return { key: "expired", label: "已过期" };
    return { key: "active", label: "有效" };
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
      throw new Error("无法连接服务器，请确认服务仍在运行。");
    }

    let data = null;
    if ((response.headers.get("content-type") || "").includes("application/json")) {
      try {
        data = await response.json();
      } catch (error) {
        data = null;
      }
    }

    if (response.status === 401 && !allowUnauthorized) {
      showLogin();
    }
    if (response.status === 403) {
      showDenied(state.user);
    }

    if (!response.ok) {
      const error = new Error(data?.error || `请求失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  /* =========================================================
     Screens
     ========================================================= */

  function hideBoot() {
    dom.boot.hidden = true;
    clearTimeout(hiddenTimer);
  }

  function hideAll() {
    dom.boot.hidden = true;
    dom.login.hidden = true;
    dom.denied.hidden = true;
    dom.app.hidden = true;
  }

  function showLogin() {
    hideAll();
    dom.login.hidden = false;
    dom.adminLoginError.hidden = true;
    dom.adminPassword.value = "";
    requestAnimationFrame(() => dom.adminUsername.focus({ preventScroll: true }));
  }

  function showDenied(user) {
    hideAll();
    dom.deniedUserName.textContent = user ? `${user.displayName}（@${user.username}）` : "当前账号";
    dom.denied.hidden = false;
  }

  function showConsole() {
    hideAll();
    dom.app.hidden = false;
    const name = state.user?.displayName || "管理员";
    dom.sidebarName.textContent = name;
    dom.sidebarAvatar.textContent = firstCharacter(name);
    dom.adminAvatar.textContent = firstCharacter(name);
    switchSection(state.section, { scroll: false });
  }

  async function bootstrap() {
    let me = null;
    try {
      me = await api("/api/auth/me", { allowUnauthorized: true });
    } catch (error) {
      hideBoot();
      showLogin();
      return;
    }
    if (!me) {
      hideBoot();
      showLogin();
      return;
    }
    if (!me.user.isAdmin) {
      hideBoot();
      showDenied(me.user);
      return;
    }
    state.user = me.user;
    showConsole();
    hideBoot();
    await loadAll();
  }

  async function handleLogin(event) {
    event.preventDefault();
    hideLoginError();
    const username = dom.adminUsername.value.trim();
    const password = dom.adminPassword.value;
    if (!username || !password) {
      showLoginError("请输入用户名和密码。");
      return;
    }

    dom.adminLoginSubmit.disabled = true;
    dom.adminLoginSubmit.textContent = "正在验证…";
    try {
      const data = await api("/api/auth/login", {
        method: "POST",
        body: { username, password },
        allowUnauthorized: true,
      });
      if (!data.user.isAdmin) {
        state.user = data.user;
        showDenied(data.user);
        return;
      }
      state.user = data.user;
      showConsole();
      await loadAll();
    } catch (error) {
      showLoginError(error.message);
    } finally {
      dom.adminLoginSubmit.disabled = false;
      dom.adminLoginSubmit.textContent = "进入后台";
    }
  }

  async function logout() {
    try {
      await api("/api/auth/logout", {
        method: "POST",
        body: {},
        allowUnauthorized: true,
      });
    } catch (error) {
      // Show the login screen even if the request failed.
    }
    state.user = null;
    showLogin();
  }

  function showLoginError(message) {
    dom.adminLoginError.textContent = message;
    dom.adminLoginError.hidden = false;
  }

  function hideLoginError() {
    dom.adminLoginError.hidden = true;
    dom.adminLoginError.textContent = "";
  }

  /* =========================================================
     Data
     ========================================================= */

  async function loadAll() {
    const sequence = ++state.refreshSequence;
    dom.adminRefresh.disabled = true;
    dom.adminRefresh.classList.add("is-loading");
    try {
      const [overview, users, kitchens, invites, sessions] = await Promise.all([
        api("/api/admin/overview"),
        api("/api/admin/users"),
        api("/api/admin/kitchens"),
        api("/api/admin/invites"),
        api("/api/admin/sessions"),
      ]);
      if (sequence !== state.refreshSequence) return;
      state.overview = overview;
      state.users = users.users || [];
      state.kitchens = kitchens.kitchens || [];
      state.invites = invites.invites || [];
      state.sessions = sessions.sessions || [];
      renderAll();
      const now = new Date();
      dom.adminUpdated.textContent = `上次刷新 ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    } catch (error) {
      if (error.status !== 401 && error.status !== 403) {
        showToast(error.message);
      }
    } finally {
      dom.adminRefresh.disabled = false;
      dom.adminRefresh.classList.remove("is-loading");
    }
  }

  function renderAll() {
    renderStats();
    renderRecentLists();
    renderUsers();
    renderKitchens();
    renderInvites();
    renderSessions();
  }

  function renderStats() {
    const stats = state.overview?.stats || {};
    dom.statUsers.textContent = number(stats.users);
    dom.statAdmins.textContent = number(stats.admins);
    dom.statKitchens.textContent = number(stats.kitchens);
    dom.statIngredients.textContent = number(stats.ingredients);
    dom.statPlanItems.textContent = number(stats.planItems);
    dom.statInvites.textContent = number(stats.activeInvites);
    dom.statSessions.textContent = number(stats.activeSessions);
  }

  function renderRecentLists() {
    const users = state.overview?.recentUsers || [];
    dom.recentUsers.innerHTML = users.length
      ? users
          .map(
            (user) => `
              <div class="admin-compact-row">
                <span class="admin-compact-avatar">${escapeHtml(firstCharacter(user.displayName))}</span>
                <div class="admin-compact-copy">
                  <strong>${escapeHtml(user.displayName)}${user.isAdmin ? " · 管理员" : ""}</strong>
                  <span>@${escapeHtml(user.username)} · ${number(user.kitchenCount)} 间厨房</span>
                </div>
                <span class="admin-compact-meta">${escapeHtml(shortDate(user.createdAt))}</span>
              </div>
            `,
          )
          .join("")
      : '<div class="admin-empty">还没有用户。</div>';

    const kitchens = state.overview?.recentKitchens || [];
    dom.recentKitchens.innerHTML = kitchens.length
      ? kitchens
          .map(
            (kitchen) => `
              <div class="admin-compact-row">
                <span class="admin-compact-avatar">${escapeHtml(firstCharacter(kitchen.name))}</span>
                <div class="admin-compact-copy">
                  <strong>${escapeHtml(kitchen.name)}</strong>
                  <span>${escapeHtml(kitchen.ownerName)} · ${number(kitchen.memberCount)} 人 · ${number(kitchen.planItemCount)} 条食谱</span>
                </div>
                <span class="admin-compact-meta">${escapeHtml(shortDate(kitchen.updatedAt))}</span>
              </div>
            `,
          )
          .join("")
      : '<div class="admin-empty">还没有厨房。</div>';
  }

  function renderUsers() {
    const query = dom.userSearch.value.trim().toLowerCase();
    const filtered = state.users.filter(
      (user) =>
        !query ||
        user.username.toLowerCase().includes(query) ||
        user.displayName.toLowerCase().includes(query),
    );
    dom.userCount.textContent = `${filtered.length} 位用户`;
    dom.userEmpty.hidden = filtered.length > 0;

    dom.userRows.innerHTML = filtered
      .map((user) => {
        const isSelf = user.id === state.user?.id;
        const actions = isSelf
          ? '<span class="admin-badge is-muted">当前账号</span>'
          : `
              <div class="admin-row-actions">
                <button class="admin-row-button" type="button" data-toggle-admin="${escapeHtml(user.id)}" data-next-admin="${user.isAdmin ? "false" : "true"}">
                  ${user.isAdmin ? "取消管理员" : "设为管理员"}
                </button>
                <button class="admin-row-button is-danger" type="button" data-delete-user="${escapeHtml(user.id)}">删除</button>
              </div>
            `;

        return `
          <tr>
            <td>
              <div class="admin-user-cell">
                <span class="admin-row-avatar">${escapeHtml(firstCharacter(user.displayName))}</span>
                <div class="admin-user-copy">
                  <strong>${escapeHtml(user.displayName)}${isSelf ? "（你）" : ""}</strong>
                  <span>@${escapeHtml(user.username)}</span>
                </div>
              </div>
            </td>
            <td>${user.isAdmin ? '<span class="admin-badge is-admin">管理员</span>' : '<span class="admin-badge">普通用户</span>'}</td>
            <td>${number(user.kitchenCount)} 间 <span class="admin-cell-muted">/ 拥有 ${number(user.ownedKitchenCount)}</span></td>
            <td>${number(user.activeSessions)} 个</td>
            <td class="admin-cell-muted">${escapeHtml(shortDate(user.createdAt))}</td>
            <td>${actions}</td>
          </tr>
        `;
      })
      .join("");
  }

  function renderKitchens() {
    const query = dom.kitchenSearch.value.trim().toLowerCase();
    const filtered = state.kitchens.filter(
      (kitchen) =>
        !query ||
        kitchen.name.toLowerCase().includes(query) ||
        kitchen.ownerName.toLowerCase().includes(query),
    );
    dom.kitchenCount.textContent = `${filtered.length} 间厨房`;
    dom.kitchenEmpty.hidden = filtered.length > 0;

    dom.kitchenRows.innerHTML = filtered
      .map(
        (kitchen) => `
          <tr>
            <td>
              <div class="admin-kitchen-title">
                <strong>${escapeHtml(kitchen.name)}</strong>
                <span>${escapeHtml(kitchen.id)}</span>
              </div>
            </td>
            <td>${escapeHtml(kitchen.ownerName)}</td>
            <td>${number(kitchen.memberCount)} 人</td>
            <td>${number(kitchen.ingredientCount)} / ${number(kitchen.planItemCount)}</td>
            <td>${number(kitchen.dailyTarget)} kcal</td>
            <td class="admin-cell-muted">${escapeHtml(shortDate(kitchen.updatedAt))}</td>
            <td>
              <div class="admin-row-actions">
                <button class="admin-row-button" type="button" data-view-kitchen="${escapeHtml(kitchen.id)}">查看</button>
                <button class="admin-row-button is-danger" type="button" data-delete-kitchen="${escapeHtml(kitchen.id)}">删除</button>
              </div>
            </td>
          </tr>
        `,
      )
      .join("");
  }

  function renderInvites() {
    dom.inviteCount.textContent = `${state.invites.length} 条邀请`;
    dom.inviteEmpty.hidden = state.invites.length > 0;

    dom.inviteRows.innerHTML = state.invites
      .map((invite) => {
        const status = inviteStatus(invite);
        const badgeClass =
          status.key === "active"
            ? "is-active"
            : status.key === "revoked"
              ? "is-danger"
              : "is-muted";
        return `
          <tr>
            <td><div class="admin-kitchen-title"><strong>${escapeHtml(invite.kitchenName)}</strong><span>${escapeHtml(invite.kitchenId)}</span></div></td>
            <td>${escapeHtml(inviteRoleLabel(invite.role))}</td>
            <td>${escapeHtml(invite.creatorName)}</td>
            <td class="admin-cell-muted">${escapeHtml(formatDateTime(invite.expiresAt))}</td>
            <td><span class="admin-badge ${badgeClass}">${status.label}</span></td>
            <td>
              <div class="admin-row-actions">
                ${
                  status.key === "active"
                    ? `<button class="admin-row-button is-danger" type="button" data-revoke-invite="${escapeHtml(invite.id)}">撤回</button>`
                    : '<span class="admin-badge is-muted">不可操作</span>'
                }
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function renderSessions() {
    dom.sessionCount.textContent = `${state.sessions.length} 个活跃会话`;
    dom.sessionEmpty.hidden = state.sessions.length > 0;

    dom.sessionRows.innerHTML = state.sessions
      .map(
        (session) => `
          <tr>
            <td>
              <div class="admin-user-cell">
                <span class="admin-row-avatar">${escapeHtml(firstCharacter(session.displayName))}</span>
                <div class="admin-user-copy">
                  <strong>${escapeHtml(session.displayName)}</strong>
                  <span>@${escapeHtml(session.username)}</span>
                </div>
              </div>
            </td>
            <td class="admin-cell-muted">${escapeHtml(formatDateTime(session.createdAt))}</td>
            <td class="admin-cell-muted">${escapeHtml(formatDateTime(session.expiresAt))}</td>
            <td>
              <div class="admin-row-actions">
                <button class="admin-row-button is-danger" type="button" data-revoke-session="${escapeHtml(session.id)}">撤销</button>
              </div>
            </td>
          </tr>
        `,
      )
      .join("");
  }

  /* =========================================================
     Actions
     ========================================================= */

  function askConfirm({ title, copy, label = "确认", action }) {
    state.confirmAction = action;
    dom.confirmTitle.textContent = title;
    dom.confirmCopy.textContent = copy;
    dom.confirmButton.textContent = label;
    dom.confirmButton.disabled = false;
    openModal(dom.confirmModal);
    requestAnimationFrame(() => dom.confirmButton.focus({ preventScroll: true }));
  }

  async function executeConfirm() {
    if (!state.confirmAction) return;
    const action = state.confirmAction;
    dom.confirmButton.disabled = true;
    const originalLabel = dom.confirmButton.textContent;
    dom.confirmButton.textContent = "处理中…";
    try {
      await action();
      closeModal();
    } catch (error) {
      showToast(error.message);
    } finally {
      dom.confirmButton.disabled = false;
      dom.confirmButton.textContent = originalLabel;
    }
  }

  function toggleAdmin(user, nextIsAdmin) {
    askConfirm({
      title: nextIsAdmin ? "授予管理员权限？" : "取消管理员权限？",
      copy: nextIsAdmin
        ? `「${user.displayName}」将可以进入管理后台，查看和管理全站数据。`
        : `「${user.displayName}」将失去管理后台访问权限。`,
      label: nextIsAdmin ? "设为管理员" : "取消管理员",
      action: async () => {
        await api(`/api/admin/users/${encodeURIComponent(user.id)}`, {
          method: "PATCH",
          body: { isAdmin: nextIsAdmin },
        });
        showToast(nextIsAdmin ? "已授予管理员权限。" : "已取消管理员权限。");
        await loadAll();
      },
    });
  }

  function deleteUser(user) {
    askConfirm({
      title: "删除这个用户？",
      copy: `将永久删除「${user.displayName}」（@${user.username}）。TA 拥有的厨房、食谱、食材、会员关系和登录会话都会被级联删除，操作不可撤销。`,
      label: "删除用户",
      action: async () => {
        await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
        showToast(`已删除用户「${user.displayName}」。`);
        await loadAll();
      },
    });
  }

  function deleteKitchen(kitchen) {
    askConfirm({
      title: "删除这间厨房？",
      copy: `将永久删除「${kitchen.name}」及其全部食谱、食材预设、成员关系和邀请。这个操作不可撤销。`,
      label: "删除厨房",
      action: async () => {
        await api(`/api/admin/kitchens/${encodeURIComponent(kitchen.id)}`, { method: "DELETE" });
        showToast(`已删除厨房「${kitchen.name}」。`);
        await loadAll();
      },
    });
  }

  function revokeInvite(invite) {
    askConfirm({
      title: "撤回这条邀请？",
      copy: `撤回后，这个邀请链接将不能再加入「${invite.kitchenName}」。已经加入的成员不受影响。`,
      label: "撤回邀请",
      action: async () => {
        await api(`/api/admin/invites/${encodeURIComponent(invite.id)}`, { method: "DELETE" });
        showToast("邀请已撤回。");
        await loadAll();
      },
    });
  }

  function revokeSession(session) {
    askConfirm({
      title: "撤销这个登录会话？",
      copy: `「${session.displayName}」的这个会话会立即失效，需要重新登录。`,
      label: "撤销会话",
      action: async () => {
        await api(`/api/admin/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
        showToast("登录会话已撤销。");
        await loadAll();
      },
    });
  }

  async function openKitchenDetail(kitchen) {
    dom.kitchenDetailTitle.textContent = kitchen.name;
    dom.kitchenDetailBody.innerHTML = '<div class="admin-empty">正在读取厨房数据…</div>';
    openModal(dom.kitchenDetailModal);
    try {
      const detail = await api(`/api/admin/kitchens/${encodeURIComponent(kitchen.id)}`);
      if (!activeModal) return;
      renderKitchenDetail(detail);
    } catch (error) {
      if (activeModal === dom.kitchenDetailModal) {
        dom.kitchenDetailBody.innerHTML = `<div class="admin-empty">${escapeHtml(error.message)}</div>`;
      }
    }
  }

  function renderKitchenDetail(detail) {
    const kitchen = detail.kitchen;
    const ingredients = detail.ingredients || [];
    const members = detail.members || [];
    const planItems = detail.planItems || [];
    const recentItems = planItems.slice(0, 16);

    dom.kitchenDetailTitle.textContent = kitchen.name;
    dom.kitchenDetailBody.innerHTML = `
      <div class="admin-detail-summary">
        <div><span>主人</span><strong>${escapeHtml(kitchen.ownerName)}</strong></div>
        <div><span>成员</span><strong>${number(kitchen.memberCount)} 人</strong></div>
        <div><span>食材预设</span><strong>${number(ingredients.length)} 种</strong></div>
        <div><span>食谱记录</span><strong>${number(detail.totals.items)} 条</strong></div>
        <div><span>每日目标</span><strong>${number(kitchen.dailyTarget)} kcal</strong></div>
        <div><span>累计热量</span><strong>${number(detail.totals.calories)} kcal</strong></div>
        <div><span>创建时间</span><strong>${escapeHtml(formatDateTime(kitchen.createdAt))}</strong></div>
        <div><span>最近更新</span><strong>${escapeHtml(formatDateTime(kitchen.updatedAt))}</strong></div>
      </div>

      <div class="admin-detail-section">
        <h3>厨房成员</h3>
        <div class="admin-detail-list">
          ${
            members.length
              ? members
                  .map(
                    (member) => `
                      <div class="admin-detail-row">
                        <span>${escapeHtml(member.displayName)} · @${escapeHtml(member.username)}</span>
                        <span>${escapeHtml(member.role === "owner" ? "主人" : member.role === "editor" ? "共建者" : "观看者")}</span>
                      </div>
                    `,
                  )
                  .join("")
              : '<div class="admin-empty">还没有成员。</div>'
          }
        </div>
      </div>

      <div class="admin-detail-section">
        <h3>食材预设</h3>
        <div class="admin-detail-list">
          ${
            ingredients.length
              ? ingredients
                  .map(
                    (ingredient) => `
                      <div class="admin-detail-row">
                        <span>${escapeHtml(ingredient.name)} · ${escapeHtml(ingredient.unit)}</span>
                        <span>${number(ingredient.calories)} kcal</span>
                      </div>
                    `,
                  )
                  .join("")
              : '<div class="admin-empty">食材库为空。</div>'
          }
        </div>
      </div>

      <div class="admin-detail-section">
        <h3>最近的食谱记录</h3>
        <div class="admin-detail-list">
          ${
            recentItems.length
              ? recentItems
                  .map(
                    (item) => `
                      <div class="admin-detail-row">
                        <span>${escapeHtml(item.date)} · ${escapeHtml(MEAL_LABELS[item.meal] || item.meal)} · ${escapeHtml(item.name)}</span>
                        <span>${number(item.calories)} kcal</span>
                      </div>
                    `,
                  )
                  .join("")
              : '<div class="admin-empty">还没有食谱记录。</div>'
          }
        </div>
      </div>
    `;
  }

  /* =========================================================
     Section switching
     ========================================================= */

  function switchSection(section, { scroll = true } = {}) {
    if (!SECTION_TITLES[section]) section = "overview";
    state.section = section;
    document.querySelectorAll("[data-admin-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.adminPanel !== section;
    });
    document.querySelectorAll("#adminNav [data-admin-section]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.adminSection === section);
      if (button.dataset.adminSection === section) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    dom.adminHeading.textContent = SECTION_TITLES[section];
    if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* =========================================================
     Modals & toast
     ========================================================= */

  function getFocusable(container) {
    return Array.from(
      container.querySelectorAll(
        'a[href], button:not([disabled]):not([hidden]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.offsetParent !== null);
  }

  function openModal(modal) {
    if (activeModal && activeModal !== modal) closeModal({ restoreFocus: false });
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
      const focusTarget = modal.querySelector(".button-danger, button, [tabindex]:not([tabindex='-1'])");
      if (focusTarget) focusTarget.focus({ preventScroll: true });
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

  function trapFocus(event) {
    if (!activeModal || event.key !== "Tab") return;
    const focusable = getFocusable(activeModal);
    if (!focusable.length) return;
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

  function showToast(message) {
    clearTimeout(toastTimer);
    clearTimeout(toastHideTimer);
    dom.toastText.textContent = message;
    dom.toast.hidden = false;
    requestAnimationFrame(() => dom.toast.classList.add("is-visible"));
    toastTimer = setTimeout(() => {
      dom.toast.classList.remove("is-visible");
      toastHideTimer = setTimeout(() => {
        dom.toast.hidden = true;
      }, 240);
    }, 2800);
  }

  /* =========================================================
     Events and init
     ========================================================= */

  function cacheDom() {
    const id = (value) => document.getElementById(value);
    dom.boot = id("adminBoot");
    dom.login = id("adminLogin");
    dom.denied = id("adminDenied");
    dom.app = id("adminApp");
    dom.adminLoginForm = id("adminLoginForm");
    dom.adminUsername = id("adminUsername");
    dom.adminPassword = id("adminPassword");
    dom.adminLoginError = id("adminLoginError");
    dom.adminLoginSubmit = id("adminLoginSubmit");
    dom.deniedUserName = id("deniedUserName");
    dom.deniedLogout = id("deniedLogout");
    dom.adminLogout = id("adminLogout");
    dom.adminNav = id("adminNav");
    dom.adminHeading = id("adminHeading");
    dom.adminRefresh = id("adminRefresh");
    dom.adminUpdated = id("adminUpdated");
    dom.sidebarName = id("sidebarName");
    dom.sidebarAvatar = id("sidebarAvatar");
    dom.adminAvatar = id("sidebarAvatar");
    dom.statUsers = id("statUsers");
    dom.statAdmins = id("statAdmins");
    dom.statKitchens = id("statKitchens");
    dom.statIngredients = id("statIngredients");
    dom.statPlanItems = id("statPlanItems");
    dom.statInvites = id("statInvites");
    dom.statSessions = id("statSessions");
    dom.recentUsers = id("recentUsers");
    dom.recentKitchens = id("recentKitchens");
    dom.userSearch = id("userSearch");
    dom.userCount = id("userCount");
    dom.userRows = id("userRows");
    dom.userEmpty = id("userEmpty");
    dom.kitchenSearch = id("kitchenSearch");
    dom.kitchenCount = id("kitchenCount");
    dom.kitchenRows = id("kitchenRows");
    dom.kitchenEmpty = id("kitchenEmpty");
    dom.inviteCount = id("inviteCount");
    dom.inviteRows = id("inviteRows");
    dom.inviteEmpty = id("inviteEmpty");
    dom.sessionCount = id("sessionCount");
    dom.sessionRows = id("sessionRows");
    dom.sessionEmpty = id("sessionEmpty");
    dom.confirmModal = id("adminConfirmModal");
    dom.confirmTitle = id("adminConfirmTitle");
    dom.confirmCopy = id("adminConfirmCopy");
    dom.confirmButton = id("adminConfirmButton");
    dom.kitchenDetailModal = id("kitchenDetailModal");
    dom.kitchenDetailTitle = id("kitchenDetailTitle");
    dom.kitchenDetailBody = id("kitchenDetailBody");
    dom.toast = id("adminToast");
    dom.toastText = id("adminToastText");
  }

  function bindEvents() {
    dom.adminLoginForm.addEventListener("submit", handleLogin);
    dom.adminUsername.addEventListener("input", hideLoginError);
    dom.adminPassword.addEventListener("input", hideLoginError);
    dom.adminLogout.addEventListener("click", logout);
    dom.deniedLogout.addEventListener("click", logout);
    dom.adminRefresh.addEventListener("click", loadAll);

    document.querySelectorAll("[data-admin-section]").forEach((button) => {
      button.addEventListener("click", () => switchSection(button.dataset.adminSection));
    });

    dom.userSearch.addEventListener("input", renderUsers);
    dom.kitchenSearch.addEventListener("input", renderKitchens);

    dom.userRows.addEventListener("click", (event) => {
      const toggle = event.target.closest("[data-toggle-admin]");
      if (toggle) {
        const user = state.users.find((item) => item.id === toggle.dataset.toggleAdmin);
        if (user) toggleAdmin(user, toggle.dataset.nextAdmin === "true");
        return;
      }
      const remove = event.target.closest("[data-delete-user]");
      if (remove) {
        const user = state.users.find((item) => item.id === remove.dataset.deleteUser);
        if (user) deleteUser(user);
      }
    });

    dom.kitchenRows.addEventListener("click", (event) => {
      const view = event.target.closest("[data-view-kitchen]");
      if (view) {
        const kitchen = state.kitchens.find((item) => item.id === view.dataset.viewKitchen);
        if (kitchen) openKitchenDetail(kitchen);
        return;
      }
      const remove = event.target.closest("[data-delete-kitchen]");
      if (remove) {
        const kitchen = state.kitchens.find((item) => item.id === remove.dataset.deleteKitchen);
        if (kitchen) deleteKitchen(kitchen);
      }
    });

    dom.inviteRows.addEventListener("click", (event) => {
      const revoke = event.target.closest("[data-revoke-invite]");
      if (revoke) {
        const invite = state.invites.find((item) => item.id === revoke.dataset.revokeInvite);
        if (invite) revokeInvite(invite);
      }
    });

    dom.sessionRows.addEventListener("click", (event) => {
      const revoke = event.target.closest("[data-revoke-session]");
      if (revoke) {
        const session = state.sessions.find((item) => item.id === revoke.dataset.revokeSession);
        if (session) revokeSession(session);
      }
    });

    dom.confirmButton.addEventListener("click", executeConfirm);

    document.querySelectorAll("[data-close-admin-confirm], [data-close-kitchen-detail]").forEach((element) => {
      element.addEventListener("click", () => closeModal());
    });

    document.addEventListener("keydown", (event) => {
      if (!activeModal) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
        return;
      }
      trapFocus(event);
    });
  }

  function init() {
    cacheDom();
    bindEvents();
    bootstrap();
  }

  init();
})();
