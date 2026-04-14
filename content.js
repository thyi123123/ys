(function () {
  const RELOAD_INTERVAL_MS = 5 * 60 * 1000;
  const SEARCH_INTERVAL_MS = 1500;
  const MAX_SEARCH_ATTEMPTS = 20;
  const TARGET_TOP_MARGIN_PX = 24;

  function getTodayTokens() {
    const now = new Date();
    const day = now.getDate();
    const month = now.getMonth() + 1;
    const paddedDay = String(day).padStart(2, "0");
    const paddedMonth = String(month).padStart(2, "0");

    return [
      `${day}.${month}`,
      `${day}.${paddedMonth}`,
      `${paddedDay}.${month}`,
      `${paddedDay}.${paddedMonth}`,
    ];
  }

  function wildcardToRegex(pattern) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i");
  }

  function matchesSite(currentUrl, sitePattern) {
    if (!sitePattern) return false;
    return wildcardToRegex(sitePattern).test(currentUrl);
  }

  function updateDebugStatus(status) {
    chrome.storage.local.set({
      debugStatus: {
        ...status,
        checkedAt: new Date().toISOString(),
      },
    });
  }

  function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function isVisibleElement(el) {
    if (!el || el === document.body || el === document.documentElement) {
      return false;
    }

    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getBestRangeRect(range) {
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width || rect.height);
    if (rects.length > 0) {
      rects.sort((a, b) => a.top - b.top || a.left - b.left);
      return rects[0];
    }

    const rect = range.getBoundingClientRect();
    if (rect.width || rect.height) {
      return rect;
    }

    return null;
  }

  function findTodayMatch() {
    const tokens = getTodayTokens();
    const tokenRegexes = tokens.map((token) => new RegExp(`(^|[^0-9])${escapeRegex(token)}([^0-9]|$)`));
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    let bestMatch = null;

    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!isVisibleElement(parent)) {
        continue;
      }

      const rawText = node.nodeValue || "";
      if (!rawText.trim()) {
        continue;
      }

      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (!rawText.includes(token) || !tokenRegexes[index].test(rawText)) {
          continue;
        }

        const startIndex = rawText.indexOf(token);
        if (startIndex === -1) {
          continue;
        }

        const range = document.createRange();
        range.setStart(node, startIndex);
        range.setEnd(node, startIndex + token.length);
        const rect = getBestRangeRect(range);

        if (!rect) {
          continue;
        }

        const score = Math.max(rawText.trim().length, 1);
        if (!bestMatch || score < bestMatch.score) {
          bestMatch = {
            token,
            rect,
            score,
            parent,
            parentText: (parent.innerText || parent.textContent || "").trim().slice(0, 120),
          };
        }
      }
    }

    return bestMatch;
  }

  function tryScrollToToday() {
    const match = findTodayMatch();

    if (!match) {
      updateDebugStatus({
        state: "date_not_found",
        url: window.location.href,
        token: getTodayTokens()[0],
      });
      return false;
    }

    if (match.parent) {
      match.parent.scrollIntoView({
        block: "start",
        inline: "nearest",
        behavior: "auto",
      });
    }

    const targetTop = Math.max(window.scrollY + match.rect.top - TARGET_TOP_MARGIN_PX, 0);
    window.scrollTo({
      top: targetTop,
      behavior: "auto",
    });

    setTimeout(() => {
      const secondMatch = findTodayMatch();
      if (!secondMatch) {
        return;
      }

      const secondTop = Math.max(window.scrollY + secondMatch.rect.top - TARGET_TOP_MARGIN_PX, 0);
      window.scrollTo({
        top: secondTop,
        behavior: "auto",
      });
    }, 250);

    updateDebugStatus({
      state: "found",
      url: window.location.href,
      token: match.token,
      matchedText: match.parentText,
    });

    return true;
  }

  function startFinding() {
    let attempts = 0;
    let intervalId = null;

    const trySearch = () => {
      attempts += 1;

      if (tryScrollToToday() || attempts >= MAX_SEARCH_ATTEMPTS) {
        if (intervalId) {
          clearInterval(intervalId);
        }
      }
    };

    trySearch();
    intervalId = setInterval(trySearch, SEARCH_INTERVAL_MS);
  }

  function initialize() {
    updateDebugStatus({
      state: "initialized",
      url: window.location.href,
    });

    startFinding();

    setInterval(() => {
      location.reload();
    }, RELOAD_INTERVAL_MS);
  }

  chrome.storage.local.get(["enabled", "licensed", "sitePattern"], ({ enabled, licensed, sitePattern }) => {
    if (!enabled || !licensed || !matchesSite(window.location.href, sitePattern)) {
      updateDebugStatus({
        state: "site_mismatch_or_disabled",
        url: window.location.href,
        enabled,
        licensed,
        sitePattern,
      });
      return;
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initialize, { once: true });
      return;
    }

    initialize();
  });
})();
