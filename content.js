(function () {
  "use strict";

  const VIDEO_SELECTOR = "ytd-playlist-video-renderer";
  const ACTIONS_CLASS = "wlqa-actions";
  const HIDE_MENU_CLASS = "wlqa-hide-menu";
  const COPY_ICON =
    "M3.9 12a5 5 0 0 1 5-5h4v2h-4a3 3 0 0 0 0 6h4v2h-4a5 5 0 0 1-5-5Zm5.1 1h6v-2h-6v2Zm2-6h4a5 5 0 0 1 0 10h-4v-2h4a3 3 0 0 0 0-6h-4V7Z";
  const REMOVE_ICON =
    "M9 3h6l1 2h4v2H4V5h4l1-2Zm1 6h2v9h-2V9Zm4 0h2v9h-2V9ZM7 9h2v10h6v-1h2v3H7V9Z";

  let route = "";
  let refreshQueued = false;
  let removing = false;

  function isWatchLater() {
    return location.pathname === "/playlist" && new URLSearchParams(location.search).get("list") === "WL";
  }

  function videoIdFor(row) {
    const link = row.querySelector('a[href*="/watch?"][href*="v="]');
    if (!link) return "";

    try {
      return new URL(link.href, location.href).searchParams.get("v") || "";
    } catch {
      return "";
    }
  }

  function menuButtonFor(row) {
    return row.querySelector(
      "ytd-menu-renderer yt-icon-button button, ytd-menu-renderer button#button, ytd-menu-renderer button[aria-label]"
    );
  }

  function menuHostFor(button) {
    return button.closest("ytd-menu-renderer") || button.closest("#menu") || button;
  }

  function icon(pathData) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    path.setAttribute("d", pathData);
    svg.append(path);
    return svg;
  }

  function menuItems() {
    return Array.from(
      document.querySelectorAll(
        "ytd-menu-service-item-renderer, ytd-menu-navigation-item-renderer, tp-yt-paper-item"
      )
    );
  }

  function removeItem(row) {
    const setVideoId = row.data && row.data.setVideoId;
    return menuItems().find((item) => {
      if (!item.getClientRects().length) return false;
      const endpoint = item.data && item.data.serviceEndpoint && item.data.serviceEndpoint.playlistEditEndpoint;
      return setVideoId && endpoint && endpoint.playlistId === "WL" &&
        Array.isArray(endpoint.actions) && endpoint.actions.some((action) =>
          action.action === "ACTION_REMOVE_VIDEO" && action.setVideoId === setVideoId
        );
    });
  }

  function waitForRemoveItem(row, deadline, done) {
    const item = removeItem(row);
    if (item || performance.now() >= deadline) {
      done(item);
      return;
    }
    setTimeout(() => waitForRemoveItem(row, deadline, done), 100);
  }

  function waitUntilGone(row, deadline, done) {
    if (!row.isConnected || performance.now() >= deadline) {
      done(!row.isConnected);
      return;
    }
    setTimeout(() => waitUntilGone(row, deadline, done), 100);
  }

  function mark(button, text, state = "ok") {
    const oldTitle = button.title;
    const oldLabel = button.getAttribute("aria-label");
    button.title = text;
    button.setAttribute("aria-label", text);
    button.dataset.wlqaState = state;
    button.disabled = true;
    setTimeout(() => {
      button.title = oldTitle;
      if (oldLabel) button.setAttribute("aria-label", oldLabel);
      delete button.dataset.wlqaState;
      button.disabled = false;
    }, 900);
  }

  async function writeText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
  }

  async function copyLink(row, button) {
    const id = videoIdFor(row);
    if (!id) {
      mark(button, "Нет ID", "error");
      return;
    }

    await writeText(`https://youtu.be/${id}`);
    mark(button, "Скопировано");
  }

  async function removeViaYouTube(row, button) {
    if (removing) return;
    const menuButton = menuButtonFor(row);
    if (!menuButton) {
      mark(button, "Нет меню", "error");
      return;
    }

    removing = true;
    document.documentElement.classList.add(HIDE_MENU_CLASS);
    button.disabled = true;
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      menuButton.click();
      const item = await new Promise((done) => waitForRemoveItem(row, performance.now() + 1500, done));
      if (!item) {
        mark(button, "Не найдено", "error");
        return;
      }
      // Let YouTube run its own command with the correct row context.
      item.click();
      const gone = await new Promise((done) => waitUntilGone(row, performance.now() + 2500, done));
      mark(button, gone ? "Удалено" : "Не удалено", gone ? "ok" : "error");
      if (gone) setTimeout(refresh, 50);
    } catch {
      mark(button, "Ошибка", "error");
    } finally {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.documentElement.classList.remove(HIDE_MENU_CLASS);
      button.disabled = false;
      removing = false;
    }
  }

  function addActions(row) {
    if (row.querySelector(`.${ACTIONS_CLASS}`)) return;

    const menuButton = menuButtonFor(row);
    const id = videoIdFor(row);
    if (!menuButton || !id) return;

    const actions = document.createElement("div");
    actions.className = ACTIONS_CLASS;

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "wlqa-button";
    copy.append(icon(COPY_ICON));
    copy.title = "Скопировать ссылку";
    copy.setAttribute("aria-label", "Скопировать ссылку");
    copy.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      copyLink(row, copy).catch(() => mark(copy, "Ошибка", "error"));
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "wlqa-button";
    remove.append(icon(REMOVE_ICON));
    remove.title = "Удалить из Watch Later";
    remove.setAttribute("aria-label", "Удалить из Watch Later");
    remove.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await removeViaYouTube(row, remove);
      } catch {
        mark(remove, "Ошибка", "error");
      }
    });

    actions.append(copy, remove);
    menuHostFor(menuButton).before(actions);
  }

  function refresh() {
    const nextRoute = `${location.pathname}?${location.search}`;
    if (route !== nextRoute) {
      route = nextRoute;
      document.documentElement.classList.remove(HIDE_MENU_CLASS);
    }

    if (!isWatchLater()) return;
    document.querySelectorAll(VIDEO_SELECTOR).forEach(addActions);
  }

  function scheduleRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    setTimeout(() => {
      refreshQueued = false;
      refresh();
    }, 50);
  }

  refresh();
  new MutationObserver(scheduleRefresh).observe(document.documentElement, { childList: true, subtree: true });
})();
