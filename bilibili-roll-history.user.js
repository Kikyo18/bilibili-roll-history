// ==UserScript==
// @name        bilibili-roll-history
// @namespace   Violentmonkey Scripts
// @match       https://www.bilibili.com/
// @match       https://www.bilibili.com/?*
// @match       https://www.bilibili.com/index.html
// @match       https://www.bilibili.com/index.html?*
// @run-at      document-start
// @inject-into page
// @sandbox     raw
// @grant       none
// @version     2.0.3
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
  let backButton = null;
  let nextButton = null;
  let boundRollButton = null;
  let statusMessage = "";

  installFetchInterceptor();
  installControlsWhenReady();

  function installFetchInterceptor() {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch !== "function") {
      return;
    }

    window.fetch = function bilibiliRollHistoryFetch(...argumentsList) {
      const requestType = getRecommendationRequestType(...argumentsList);
      if (requestType === null) {
        return Reflect.apply(nativeFetch, window, argumentsList);
      }
      return handleRecommendation(nativeFetch, argumentsList, requestType);
    };
  }

  async function handleRecommendation(nativeFetch, argumentsList, requestType) {
    pendingOperationCount += 1;
    updateButtonStatus();
    try {
      const suppliedSignal = argumentsList[1]?.signal;
      const signal = suppliedSignal !== undefined
        ? suppliedSignal
        : argumentsList[0] instanceof Request ? argumentsList[0].signal : undefined;
      signal?.throwIfAborted();
      // 只有换一换能领取回放目标，初始化或顶部刷新不能误用它。
      const replayIndex = requestType === "3" ? consumeReplayTarget() : null;
      if (replayIndex !== null) {
        const snapshot = feedHistory[replayIndex];
        if (snapshot) {
          const response = createReplayResponse(snapshot);
          feedHistoryIndex = replayIndex;
          statusMessage = "";
          return response;
        }
      }

      const response = await Reflect.apply(nativeFetch, window, argumentsList);
      if (!response.ok || !isJsonResponse(response)) {
        throw new Error("推荐接口未返回有效数据");
      }
      let responseClone;
      try {
        responseClone = response.clone();
      } catch {
        // 无法复制不代表页面无法读取；放行原响应，但不能保留旧索引。
        clearHistory();
        return response;
      }
      // 先验证正文再交给页面，错误数据不会被页面转换成空推荐列表。
      const result = await createSnapshot(responseClone);
      signal?.throwIfAborted();
      if (result.status === "failed") {
        const error = new Error("推荐加载失败，请重试");
        error.code = result.code;
        throw error;
      }
      if (result.status === "success") {
        recordSnapshot(result.snapshot);
      } else {
        clearHistory();
      }
      statusMessage = "";
      return response;
    } catch (error) {
      consumeReplayTarget();
      statusMessage = feedHistory.length > 0
        ? "推荐加载失败，已保留历史，可重试换一换"
        : "推荐加载失败，请重试或刷新页面";
      throw error;
    } finally {
      finishOperation();
    }
  }

  function getRecommendationRequestType(input, options) {
    try {
      const requestUrl =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : String(input);
      const url = new URL(requestUrl, window.location.href);
      const method = options?.method ??
        (input instanceof Request ? input.method : "GET");
      const requestType = url.searchParams.get("fresh_type");
      // 同一接口的 4 表示向下追加，不能记录成顶部换页或截断前进历史。
      return (
        url.protocol === "https:" &&
        url.hostname === recommendationApiHostname &&
        url.pathname === recommendationApiPath &&
        String(method).toUpperCase() === "GET" &&
        ["0", "3", "5"].includes(requestType)
      ) ? requestType : null;
    } catch {
      return null;
    }
  }

  function finishOperation() {
    const deadline = Date.now() + replayTimeoutMilliseconds;
    const finishWhenRendered = () => {
      // fetch 返回不等于 Vue 已完成换页；这段时间仍禁止连续回放。
      if (getFeedData()?.loading && Date.now() < deadline) {
        window.setTimeout(finishWhenRendered, 50);
      } else {
        pendingOperationCount -= 1;
        updateButtonStatus();
      }
    };
    window.setTimeout(finishWhenRendered, 0);
  }

  function isJsonResponse(response) {
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.toLowerCase().includes("application/json");
  }

  async function createSnapshot(response) {
    try {
      const body = await readSnapshotBody(response);
      if (body === null) {
        return { status: "too-large" };
      }

      const payload = JSON.parse(new TextDecoder().decode(body));
      const pageKey = createPageKey(payload);
      if (!pageKey) {
        return { status: "failed", code: payload?.code };
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

  async function readSnapshotBody(response) {
    const reader = response.body?.getReader();
    if (!reader) {
      return new ArrayBuffer(0);
    }
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        length += value.byteLength;
        if (length > maxSnapshotBytes) {
          // 克隆分支取消可能等待页面读取原响应，不能在这里 await。
          void reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body.buffer;
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

    const recommendation = getFeedData()?.recommend;
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

  function getFeedData() {
    const data = window.__pinia?.feed?.data;
    return data?.__v_isRef ? data.value : data;
  }

  function createPageKey(payload) {
    const items = payload?.data?.item;
    if (
      payload?.code !== 0 ||
      !Array.isArray(items) ||
      items.length === 0 ||
      items.some((item) => !item || typeof item !== "object" || Array.isArray(item))
    ) {
      return null;
    }

    try {
      return JSON.stringify(items.map((item) => {
        const identifiers = item.goto === "ad"
          ? [
              item.business_info?.src_id,
              item.business_info?.creative_id,
              item.business_info?.archive?.aid,
              item.bvid, item.id, item.cid, item.uri, item.title,
            ]
          : [item.bvid, item.id, item.cid, item.uri, item.title];
        const identifier = identifiers.find((value) =>
          (typeof value === "string" && value.trim() !== "") ||
          (typeof value === "number" && Number.isFinite(value) && value > 0));
        // 未知卡片比较内容，不能退化为固定位置；数组编码避免分隔符碰撞。
        return [
          item.goto ?? "unknown",
          identifier === undefined ? item : String(identifier),
        ];
      }));
    } catch {
      return null;
    }
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
      statusMessage = "页面未响应历史切换，请重试或刷新页面";
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
    let scheduled = false;
    const observer = new MutationObserver(() => {
      const controlsConnected = boundRollButton?.isConnected &&
        backButton?.isConnected && nextButton?.isConnected &&
        backButton.parentElement === boundRollButton.parentElement &&
        nextButton.parentElement === boundRollButton.parentElement;
      if (scheduled || controlsConnected) {
        return;
      }
      // 已连接时只检查引用；失联后按帧合并重装，避免每次变更扫描整页。
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        installControls();
      });
    });
    observer.observe(document, { childList: true, subtree: true });
    installControls();
  }

  function installControls() {
    const rollButton = document.querySelector(".roll-btn");
    if (!(rollButton?.parentElement instanceof HTMLElement)) {
      return false;
    }

    injectStyle();
    captureInitialSnapshot();
    if (boundRollButton !== rollButton) {
      boundRollButton?.removeEventListener("click", captureInitialSnapshot, true);
      // Pinia 可能晚于控件就绪；每次换页前补采，历史非空时立即返回。
      rollButton.addEventListener("click", captureInitialSnapshot, true);
      boundRollButton = rollButton;
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

    if (
      backButton.parentElement !== rollButton.parentElement ||
      nextButton.parentElement !== rollButton.parentElement
    ) {
      rollButton.parentElement.append(backButton, nextButton);
    }
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
    // 原生 disabled 已阻止点击；保留命中测试才能显示禁用指针和提示。
    style.textContent = `
      .feed-roll-btn .roll-btn,
      .feed-roll-back-btn,
      .feed-roll-next-btn {
        cursor: pointer;
      }
      .feed-roll-btn .roll-btn *,
      .feed-roll-back-btn *,
      .feed-roll-next-btn * {
        cursor: inherit;
      }
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
      }
      .feed-roll-btn .roll-btn:disabled,
      .feed-roll-back-btn:disabled,
      .feed-roll-next-btn:disabled {
        cursor: not-allowed;
        pointer-events: auto;
      }
    `;
    (document.head ?? document.documentElement).append(style);
  }

  function updateButtonStatus() {
    if (!backButton || !nextButton) {
      return;
    }

    const isBusy = pendingOperationCount > 0 || replayTargetIndex !== null;
    const hint = statusMessage || (feedHistory.length === 0 && !getFeedData()
      ? "尚未读取首页数据，请确认脚本运行在页面环境" : "");
    backButton.title = hint || "返回上一组推荐";
    nextButton.title = hint || "前往下一组推荐";
    backButton.disabled = isBusy || feedHistoryIndex <= 0;
    nextButton.disabled =
      isBusy ||
      feedHistoryIndex < 0 ||
      feedHistoryIndex >= feedHistory.length - 1;
  }
})();
