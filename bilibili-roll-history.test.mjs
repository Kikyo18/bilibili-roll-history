import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const chromePath = [
  process.env.BROWSER_BIN,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].find((candidate) => candidate && existsSync(candidate));
const userscriptPath = new URL("./bilibili-roll-history.user.js", import.meta.url);
const userscriptUrl = userscriptPath.href;

test("脚本在页面脚本执行前接管推荐请求，且不依赖外部运行库", () => {
  const source = readFileSync(userscriptPath, "utf8");

  assert.match(source, /@run-at\s+document-start/);
  assert.match(source, /@inject-into\s+page/);
  assert.match(source, /@grant\s+none/);
  assert.doesNotMatch(source, /@require\b/);
});

test("回溯由 B 站原生重新渲染，稍后再看可用且不产生额外网络请求", () => {
  assert.ok(chromePath, "未找到 Chrome；可通过 BROWSER_BIN 指定浏览器路径");

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "bilibili-roll-history-"));
  const fixturePath = join(temporaryDirectory, "fixture.html");

  try {
    writeFileSync(fixturePath, createFixtureHtml(userscriptUrl), "utf8");

    const result = spawnSync(
      chromePath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--allow-file-access-from-files",
        "--virtual-time-budget=2500",
        "--dump-dom",
        pathToFileURL(fixturePath).href,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, `Chrome 执行失败：${result.stderr}`);
    assert.match(
      result.stdout,
      /data-test-result="PASS"/,
      `原生回溯验证失败：${readResultDetail(result.stdout)}`,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

function createFixtureHtml(scriptUrl) {
  const responses = ["第二页", "新分支页"];

  return `<!doctype html>
<html lang="zh-CN">
  <body data-test-result="PENDING">
    <main class="recommended-container_floor-aside">
      <div class="feed-card"></div>
    </main>
    <div class="roll-controls"><button class="roll-btn">换一换</button></div>

    <script>
      const apiUrl = "https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd";
      const responseNames = ${JSON.stringify(responses)};
      const componentStates = new Set();
      window.networkRequestCount = 0;
      window.watchLaterClicks = [];

      window.fetch = async () => {
        const responseName = responseNames[window.networkRequestCount];
        window.networkRequestCount += 1;
        return new Response(
          JSON.stringify({
            code: 0,
            data: { item: [{ id: responseName, title: responseName }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      // B 站冷启动会把完整首屏推荐保存在 Pinia 初始化状态中。
      window.__pinia = {
        feed: {
          data: {
            recommend: {
              item: [{ id: "第一页", title: "第一页" }],
            },
          },
        },
      };

      function destroyMountedComponents() {
        for (const state of componentStates) {
          state.alive = false;
        }
        componentStates.clear();
      }

      function renderFeed(title) {
        // 真实 Vue 卸载会让旧监听器闭包失效；仅保存旧 DOM 节点无法恢复组件。
        destroyMountedComponents();
        const card = document.querySelector(".feed-card");
        card.innerHTML = \`<article data-card-title="\${title}">
          <div class="bili-watch-later--wrap">
            <button class="bili-watch-later" style="display: none">添加至稍后再看</button>
          </div>
        </article>\`;

        const state = { alive: true, title };
        componentStates.add(state);
        const wrapper = card.querySelector(".bili-watch-later--wrap");
        const action = card.querySelector(".bili-watch-later");
        wrapper.addEventListener("mouseenter", () => {
          if (state.alive) action.style.display = "block";
        });
        action.addEventListener("click", () => {
          if (state.alive) window.watchLaterClicks.push(state.title);
        });
      }

      async function loadRecommendation() {
        const response = await window.fetch(apiUrl);
        const payload = await response.json();
        renderFeed(payload.data.item[0].title);
      }

      document.querySelector(".roll-btn").addEventListener("click", loadRecommendation);
      window.loadRecommendation = loadRecommendation;
      // 模拟真实冷启动：首屏已由站点渲染，没有经过推荐 fetch。
      renderFeed("第一页");
    </script>
    <script src="${scriptUrl}"></script>
    <script>
      const waitForTurn = () => new Promise((resolve) => setTimeout(resolve, 30));

      (async () => {
        try {
          await waitForTurn();

          const originalAction = document.querySelector(".bili-watch-later");
          document.querySelector(".bili-watch-later--wrap").dispatchEvent(
            new MouseEvent("mouseenter", { bubbles: true }),
          );
          originalAction.click();
          const baselineWorks =
            originalAction.style.display === "block" &&
            window.watchLaterClicks.includes("第一页");

          document.querySelector(".roll-btn").click();
          await waitForTurn();
          const secondPageWorks =
            document.querySelector("[data-card-title]").dataset.cardTitle === "第二页";

          document.querySelector("#feed-roll-back-btn").click();
          await waitForTurn();
          const restoredAction = document.querySelector(".bili-watch-later");
          document.querySelector(".bili-watch-later--wrap").dispatchEvent(
            new MouseEvent("mouseenter", { bubbles: true }),
          );
          restoredAction.click();
          const backWorks =
            document.querySelector("[data-card-title]").dataset.cardTitle === "第一页" &&
            restoredAction !== originalAction &&
            restoredAction.style.display === "block" &&
            window.watchLaterClicks.filter((title) => title === "第一页").length === 2;

          document.querySelector("#feed-roll-next-btn").click();
          await waitForTurn();
          const nextWorks =
            document.querySelector("[data-card-title]").dataset.cardTitle === "第二页";
          const replayUsesNoNetwork = window.networkRequestCount === 1;

          document.querySelector("#feed-roll-back-btn").click();
          await waitForTurn();
          document.querySelector(".roll-btn").click();
          await waitForTurn();
          const branchWorks =
            document.querySelector("[data-card-title]").dataset.cardTitle === "新分支页" &&
            document.querySelector("#feed-roll-next-btn").disabled &&
            window.networkRequestCount === 2;

          const details = {
            baselineWorks,
            secondPageWorks,
            backWorks,
            nextWorks,
            replayUsesNoNetwork,
            branchWorks,
          };
          document.body.dataset.testResult = Object.values(details).every(Boolean)
            ? "PASS"
            : "FAIL";
          document.body.dataset.testDetail = JSON.stringify(details);
        } catch (error) {
          document.body.dataset.testResult = "FAIL";
          document.body.dataset.testDetail = error.stack || error.message;
        }
      })();
    </script>
  </body>
</html>`;
}

function readResultDetail(html) {
  return html.match(/data-test-detail="([^"]*)"/)?.[1] ?? "未生成结果";
}
