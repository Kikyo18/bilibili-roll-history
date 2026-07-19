// ==UserScript==
// @name        bilibili-roll-history
// @namespace   Violentmonkey Scripts
// @match       https://www.bilibili.com/
// @run-at      document-start
// @inject-into page
// @grant       none
// @version     2.0.1
// @author      mesimpler
// @description 为 B 站首页添加“换一换”历史回溯功能。
// @license     MIT
// @homepageURL https://github.com/Kikyo18/bilibili-roll-history
// @supportURL  https://github.com/Kikyo18/bilibili-roll-history/issues
// @downloadURL https://raw.githubusercontent.com/Kikyo18/bilibili-roll-history/main/bilibili-roll-history.user.js
// @updateURL   https://raw.githubusercontent.com/Kikyo18/bilibili-roll-history/main/bilibili-roll-history.user.js
// ==/UserScript==

(() => {
  "use strict";

  const recommendationApiHostname = "api.bilibili.com";
  const recommendationApiPath =
    "/x/web-interface/wbi/index/top/feed/rcmd";
  const recommendationApiUrl =
    `https://${recommendationApiHostname}${recommendationApiPath}`;
  const maxHistoryPages = 10;
  const maxSnapshotBytes = 512 * 1024;
  const maxHistoryBytes = 2 * 1024 * 1024;
  const replayTimeoutMilliseconds = 3000;

  const feedHistory = [];
  let feedHistoryBytes = 0;
  let feedHistoryIndex = -1;
  let replayTargetIndex = null;
  let replayTimeoutId = null;
  let pendingOperationCount = 0;
  let snapshotQueue = Promise.resolve();
  let backButton = null;
  let nextButton = null;

  installFetchInterceptor();
  installControlsWhenReady();

  function installFetchInterceptor() {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch !== "function") {
      return;
    }

    window.fetch = async function bilibiliRollHistoryFetch(...argumentsList) {
      if (!isRecommendationRequest(argumentsList[0])) {
        return Reflect.apply(nativeFetch, window, argumentsList);
      }

      const replayIndex = consumeReplayTarget();
      if (replayIndex !== null) {
        const snapshot = feedHistory[replayIndex];
        if (snapshot) {
          const response = createReplayResponse(snapshot);
          feedHistoryIndex = replayIndex;
          updateButtonStatus();
          return response;
        }
      }

      pendingOperationCount += 1;
      updateButtonStatus();
      try {
        const response = await Reflect.apply(nativeFetch, window, argumentsList);
        queueSnapshot(response);
        return response;
      } finally {
        pendingOperationCount -= 1;
        updateButtonStatus();
      }
    };
  }

  function isRecommendationRequest(input) {
    try {
      const requestUrl =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : String(input);
      const url = new URL(requestUrl, window.location.href);
      return (
        url.hostname === recommendationApiHostname &&
        url.pathname === recommendationApiPath
      );
    } catch {
      return false;
    }
  }

  function queueSnapshot(response) {
    if (!response.ok || !isJsonResponse(response)) {
      return;
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > maxSnapshotBytes
    ) {
      clearHistory();
      return;
    }

    let responseClone;
    try {
      responseClone = response.clone();
    } catch {
      return;
    }

    pendingOperationCount += 1;
    updateButtonStatus();
    snapshotQueue = snapshotQueue
      .catch(() => undefined)
      .then(() => createSnapshot(responseClone))
      .then((result) => {
        if (result.status === "success") {
          recordSnapshot(result.snapshot);
        } else if (result.status === "too-large") {
          // 当前页面无法安全缓存时清空旧索引，避免按钮回放到错误页面。
          clearHistory();
        }
      })
      .finally(() => {
        pendingOperationCount -= 1;
        updateButtonStatus();
      });
  }

  function isJsonResponse(response) {
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.toLowerCase().includes("application/json");
  }

  async function createSnapshot(response) {
    try {
      const body = await response.arrayBuffer();
      if (body.byteLength > maxSnapshotBytes) {
        return { status: "too-large" };
      }

      const pageKey = createPageKeyFromBody(body);
      if (!pageKey) {
        return { status: "failed" };
      }

      return {
        status: "success",
        snapshot: {
          body,
          headers: Array.from(response.headers.entries()).filter(
            ([headerName]) =>
              !["content-encoding", "content-length", "transfer-encoding"].includes(
                headerName.toLowerCase(),
              ),
          ),
          redirected: response.redirected,
          status: response.status,
          statusText: response.statusText,
          type: response.type,
          url: response.url,
          pageKey,
        },
      };
    } catch {
      return { status: "failed" };
    }
  }

  function recordSnapshot(snapshot) {
    if (feedHistory[feedHistoryIndex]?.pageKey === snapshot.pageKey) {
      return;
    }

    if (feedHistoryIndex < feedHistory.length - 1) {
      const removedSnapshots = feedHistory.splice(feedHistoryIndex + 1);
      for (const removedSnapshot of removedSnapshots) {
        feedHistoryBytes -= removedSnapshot.body.byteLength;
      }
    }

    feedHistory.push(snapshot);
    feedHistoryBytes += snapshot.body.byteLength;

    // 同时限制页数和精确字节数，避免推荐数据随使用时长无限增长。
    while (
      feedHistory.length > maxHistoryPages ||
      feedHistoryBytes > maxHistoryBytes
    ) {
      const removedSnapshot = feedHistory.shift();
      feedHistoryBytes -= removedSnapshot.body.byteLength;
    }

    feedHistoryIndex = feedHistory.length - 1;
    updateButtonStatus();
  }

  function captureInitialSnapshot() {
    if (feedHistory.length > 0) {
      return true;
    }

    const recommendation = window.__pinia?.feed?.data?.recommend;
    const payload = {
      code: 0,
      message: "0",
      ttl: 1,
      data: recommendation,
    };
    const pageKey = createPageKey(payload);
    if (!pageKey) {
      return false;
    }

    let body;
    try {
      // 立即复制 Pinia 数据，历史中不保留任何 Vue 响应式对象。
      body = new TextEncoder().encode(JSON.stringify(payload)).buffer;
    } catch {
      return false;
    }
    if (body.byteLength === 0 || body.byteLength > maxSnapshotBytes) {
      return false;
    }

    recordSnapshot({
      body,
      headers: [["content-type", "application/json"]],
      redirected: false,
      status: 200,
      statusText: "OK",
      type: "cors",
      url: recommendationApiUrl,
      pageKey,
    });
    return true;
  }

  function createPageKeyFromBody(body) {
    try {
      const payload = JSON.parse(new TextDecoder().decode(body));
      if (payload?.code !== 0) {
        return null;
      }
      return createPageKey(payload);
    } catch {
      return null;
    }
  }

  function createPageKey(payload) {
    const items = payload?.data?.item;
    if (!Array.isArray(items) || items.length === 0) {
      return null;
    }

    return items
      .map((item, index) => {
        if (!item || typeof item !== "object") {
          return `unknown:${index}`;
        }
        const identifier =
          item.bvid ?? item.id ?? item.cid ?? item.uri ?? item.title ?? index;
        return `${item.goto ?? "unknown"}:${String(identifier)}`;
      })
      .join("\u001f");
  }

  function createReplayResponse(snapshot) {
    const response = new Response(snapshot.body.slice(0), {
      headers: snapshot.headers,
      status: snapshot.status,
      statusText: snapshot.statusText,
    });

    // 大多数调用方只读取 json()；补齐只读元数据可保持 fetch Response 语义。
    try {
      Object.defineProperties(response, {
        redirected: { configurable: true, value: snapshot.redirected },
        type: { configurable: true, value: snapshot.type },
        url: { configurable: true, value: snapshot.url },
      });
    } catch {
      // 浏览器若不允许覆盖只读元数据，响应正文仍可正常回放。
    }

    return response;
  }

  function requestReplay(targetIndex) {
    if (
      pendingOperationCount > 0 ||
      replayTargetIndex !== null ||
      targetIndex < 0 ||
      targetIndex >= feedHistory.length
    ) {
      return;
    }

    const rollButton = document.querySelector(".roll-btn");
    if (!(rollButton instanceof HTMLElement)) {
      return;
    }

    replayTargetIndex = targetIndex;
    replayTimeoutId = window.setTimeout(() => {
      replayTargetIndex = null;
      replayTimeoutId = null;
      updateButtonStatus();
    }, replayTimeoutMilliseconds);
    updateButtonStatus();
    rollButton.click();
  }

  function consumeReplayTarget() {
    if (replayTargetIndex === null) {
      return null;
    }

    const targetIndex = replayTargetIndex;
    replayTargetIndex = null;
    if (replayTimeoutId !== null) {
      window.clearTimeout(replayTimeoutId);
      replayTimeoutId = null;
    }
    return targetIndex;
  }

  function clearHistory() {
    feedHistory.length = 0;
    feedHistoryBytes = 0;
    feedHistoryIndex = -1;
    replayTargetIndex = null;
    if (replayTimeoutId !== null) {
      window.clearTimeout(replayTimeoutId);
      replayTimeoutId = null;
    }
    updateButtonStatus();
  }

  function installControlsWhenReady() {
    if (installControls()) {
      return;
    }

    const observer = new MutationObserver(() => {
      if (installControls()) {
        // 控件安装后不再观察整页，避免常驻 DOM 监听开销。
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  }

  function installControls() {
    const rollButton = document.querySelector(".roll-btn");
    if (!(rollButton?.parentElement instanceof HTMLElement)) {
      return false;
    }

    injectStyle();
    if (!captureInitialSnapshot()) {
      // 控件可能早于 Pinia 首屏数据就绪；首次换页前再做一次同步采集。
      rollButton.addEventListener("click", captureInitialSnapshot, {
        capture: true,
        once: true,
      });
    }
    if (!backButton || !nextButton) {
      backButton = createHistoryButton(
        "feed-roll-back-btn",
        "feed-roll-back-btn",
        "返回上一组推荐",
        "M5.82843 6.99955L8.36396 9.53509L6.94975 10.9493L2 5.99955L6.94975 1.0498L8.36396 2.46402L5.82843 4.99955H13C17.4183 4.99955 21 8.58127 21 12.9996C21 17.4178 17.4183 20.9996 13 20.9996H4V18.9996H13C16.3137 18.9996 19 16.3133 19 12.9996C19 9.68584 16.3137 6.99955 13 6.99955H5.82843Z",
      );
      nextButton = createHistoryButton(
        "feed-roll-next-btn",
        "feed-roll-next-btn",
        "前往下一组推荐",
        "M18.1716 6.99955H11C7.68629 6.99955 5 9.68584 5 12.9996C5 16.3133 7.68629 18.9996 11 18.9996H20V20.9996H11C6.58172 20.9996 3 17.4178 3 12.9996C3 8.58127 6.58172 4.99955 11 4.99955H18.1716L15.636 2.46402L17.0503 1.0498L22 5.99955L17.0503 10.9493L15.636 9.53509L18.1716 6.99955Z",
      );
      backButton.addEventListener("click", () => {
        requestReplay(feedHistoryIndex - 1);
      });
      nextButton.addEventListener("click", () => {
        requestReplay(feedHistoryIndex + 1);
      });
    }

    rollButton.parentElement.append(backButton, nextButton);
    updateButtonStatus();
    return true;
  }

  function createHistoryButton(id, className, label, iconPath) {
    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.className = `primary-btn ${className}`;
    button.title = label;
    button.setAttribute("aria-label", label);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", iconPath);
    svg.append(path);
    button.append(svg);
    return button;
  }

  function injectStyle() {
    if (document.querySelector("#feed-roll-history-style")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "feed-roll-history-style";
    style.textContent = `
      .feed-roll-back-btn,
      .feed-roll-next-btn {
        flex-direction: column;
        margin-left: 0 !important;
        height: 40px !important;
        width: 40px;
        padding: 11px;
        margin-top: 6px;
      }
      .feed-roll-back-btn svg,
      .feed-roll-next-btn svg {
        margin-right: 0;
        margin-bottom: 0;
      }
      .feed-roll-back-btn:disabled,
      .feed-roll-next-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        pointer-events: none;
      }
    `;
    (document.head ?? document.documentElement).append(style);
  }

  function updateButtonStatus() {
    if (!backButton || !nextButton) {
      return;
    }

    const isBusy = pendingOperationCount > 0 || replayTargetIndex !== null;
    backButton.disabled = isBusy || feedHistoryIndex <= 0;
    nextButton.disabled =
      isBusy ||
      feedHistoryIndex < 0 ||
      feedHistoryIndex >= feedHistory.length - 1;
  }
})();
