import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  VINTED_COOKIE = "",
  CHECK_INTERVAL_SECONDS = "10",
  DATA_DIR = "/data"
} = process.env;

const SEARCH_URL =
  "https://www.vinted.co.uk/catalog?search_text=drakes&brand_ids[]=389025&page=1&order=newest_first";

/*
 * Only monitor the newest visible cards.
 */
const MONITOR_TOP_N = 30;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ Missing Telegram variables.");
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const SEEN_FILE = path.join(
  DATA_DIR,
  "vinted_visible_newest_seen.json"
);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadSeen() {
  try {
    return new Set(
      JSON.parse(
        fs.readFileSync(SEEN_FILE, "utf8")
      )
    );
  } catch {
    return new Set();
  }
}

function saveSeen(seen) {
  fs.writeFileSync(
    SEEN_FILE,
    JSON.stringify([...seen], null, 2)
  );
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function parseCookieString(cookieString) {
  if (!cookieString) {
    return [];
  }

  return cookieString
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const index = part.indexOf("=");

      if (index === -1) {
        return null;
      }

      const name =
        part.slice(0, index).trim();

      const value =
        part.slice(index + 1).trim();

      if (!name) {
        return null;
      }

      return {
        name,
        value,
        domain: ".vinted.co.uk",
        path: "/"
      };
    })
    .filter(Boolean);
}

async function telegramRequest(method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(
      `Telegram ${data.error_code}: ${data.description}`
    );
  }
}

async function sendTelegram(item) {
  const caption = [
    "🚨 <b>NEW DRAKE'S LISTING</b>",
    "",
    `<b>${escapeHtml(item.title)}</b>`,
    "",
    item.details
      ? escapeHtml(item.details)
      : "",
    item.price
      ? `💷 <b>${escapeHtml(item.price)}</b>`
      : "",
    "",
    `<a href="${item.url}">OPEN ON VINTED</a>`
  ]
    .filter(Boolean)
    .join("\n");

  if (item.image) {
    try {
      await telegramRequest(
        "sendPhoto",
        {
          chat_id: TELEGRAM_CHAT_ID,
          photo: item.image,
          caption,
          parse_mode: "HTML"
        }
      );

      return;
    } catch (error) {
      console.log(
        "Photo failed, using text:",
        error.message
      );
    }
  }

  await telegramRequest(
    "sendMessage",
    {
      chat_id: TELEGRAM_CHAT_ID,
      text: caption,
      parse_mode: "HTML",
      disable_web_page_preview: false
    }
  );
}

async function extractNewestVisibleItems(page) {
  return await page.evaluate(
    topN => {
      const output = [];
      const usedIds = new Set();

      const links = Array.from(
        document.querySelectorAll(
          'a[href*="/items/"]'
        )
      );

      for (const link of links) {
        try {
          const url =
            new URL(
              link.href,
              location.origin
            );

          const match =
            url.pathname.match(
              /\/items\/(\d+)/
            );

          if (!match) {
            continue;
          }

          const id = match[1];

          if (usedIds.has(id)) {
            continue;
          }

          /*
           * Find a sensible surrounding product card.
           */
          let card = link;

          for (let i = 0; i < 7; i++) {
            if (!card.parentElement) {
              break;
            }

            card = card.parentElement;

            const text =
              card.innerText || "";

            const hasImage =
              Boolean(
                card.querySelector("img")
              );

            const hasPrice =
              /£\s?\d/.test(text);

            if (hasImage && hasPrice) {
              break;
            }
          }

          if (!card) {
            continue;
          }

          const style =
            window.getComputedStyle(card);

          const rect =
            card.getBoundingClientRect();

          /*
           * Reject invisible/hidden DOM cards.
           */
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity) === 0 ||
            rect.width < 40 ||
            rect.height < 40
          ) {
            continue;
          }

          /*
           * Only use cards that are actually laid out
           * near the rendered search results.
           */
          if (
            rect.bottom < 0 ||
            rect.top > document.documentElement.scrollHeight
          ) {
            continue;
          }

          const rawText =
            card.innerText || "";

          const lines =
            rawText
              .split("\n")
              .map(x => x.trim())
              .filter(Boolean);

          /*
           * Make sure it's actually one of the
           * Drake's cards shown on this page.
           */
          const combined =
            lines.join(" ");

          if (
            !/\bdrake['’]?s\b/i.test(
              combined
            )
          ) {
            continue;
          }

          const img =
            card.querySelector("img");

          const image =
            img?.currentSrc ||
            img?.src ||
            "";

          const imageAlt =
            img?.alt ||
            "";

          let title =
            link.getAttribute("title") ||
            imageAlt ||
            "";

          if (!title) {
            title =
              url.pathname
                .replace(
                  `/items/${id}-`,
                  ""
                )
                .replaceAll("-", " ");
          }

          title =
            String(title)
              .replace(/\s+/g, " ")
              .trim();

          let price = "";

          for (const line of lines) {
            if (/^£\s?\d/.test(line)) {
              price = line;
              break;
            }
          }

          const details =
            lines
              .filter(line => {
                if (
                  line === price ||
                  /^£\s?\d/.test(line)
                ) {
                  return false;
                }

                return true;
              })
              .slice(0, 3)
              .join(" · ");

          output.push({
            id,
            title,
            details,
            price,
            image,
            url: url.href,
            top: rect.top + window.scrollY,
            left: rect.left
          });

          usedIds.add(id);

        } catch {
          // Ignore malformed DOM entries.
        }
      }

      /*
       * Critical:
       * sort by actual displayed position.
       *
       * Top row first, then left → right.
       */
      output.sort(
        (a, b) => {
          const rowDifference =
            a.top - b.top;

          if (
            Math.abs(rowDifference) > 20
          ) {
            return rowDifference;
          }

          return a.left - b.left;
        }
      );

      return output.slice(
        0,
        topN
      );
    },
    MONITOR_TOP_N
  );
}

async function loadNewestPage(page) {
  const url =
    new URL(SEARCH_URL);

  /*
   * Fresh timestamp to avoid stale results.
   */
  url.searchParams.set(
    "time",
    String(
      Math.floor(Date.now() / 1000)
    )
  );

  await page.goto(
    url.toString(),
    {
      waitUntil: "domcontentloaded",
      timeout: 60000
    }
  );

  try {
    await page.waitForSelector(
      'a[href*="/items/"]',
      {
        timeout: 15000
      }
    );
  } catch {
    throw new Error(
      "No Vinted listing cards appeared."
    );
  }

  /*
   * Ensure we're at the actual top of newest-first.
   */
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });

  await page.waitForTimeout(
    1500
  );

  return await extractNewestVisibleItems(
    page
  );
}

async function main() {
  const seen = loadSeen();

  console.log(
    `Loaded ${seen.size} previously seen item(s).`
  );

  console.log(
    "🚀 Starting visible newest-first Drake's monitor."
  );

  console.log(
    `Watching top ${MONITOR_TOP_N} visible listings.`
  );

  console.log(
    `Checking every ${CHECK_INTERVAL_SECONDS} seconds.`
  );

  const browser =
    await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

  const context =
    await browser.newContext({
      locale: "en-GB",
      timezoneId: "Europe/London",

      viewport: {
        width: 1440,
        height: 1200
      },

      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/140.0.0.0 Safari/537.36"
    });

  if (VINTED_COOKIE) {
    const cookies =
      parseCookieString(
        VINTED_COOKIE
      );

    if (cookies.length > 0) {
      await context.addCookies(
        cookies
      );

      console.log(
        `✅ Loaded ${cookies.length} Vinted session cookie(s).`
      );
    }
  }

  let page =
    await context.newPage();

  let baselineDone =
    seen.size > 0;

  let errors = 0;

  while (true) {
    const started =
      Date.now();

    try {
      console.log(
        "🔄 Loading newest-first page..."
      );

      const items =
        await loadNewestPage(
          page
        );

      console.log(
        `✅ Monitoring ${items.length} top visible listing(s).`
      );

      console.log(
        "TOP 10 VISIBLE:"
      );

      for (
        const item of items.slice(0, 10)
      ) {
        console.log(
          `${item.id} | ${item.title} | ${item.price}`
        );
      }

      if (
        items.length === 0
      ) {
        throw new Error(
          "No visible Drake's cards extracted."
        );
      }

      /*
       * First successful run becomes baseline.
       */
      if (!baselineDone) {
        for (const item of items) {
          seen.add(
            String(item.id)
          );
        }

        saveSeen(seen);

        baselineDone = true;

        console.log(
          `✅ Baseline created with ${seen.size} visible listings.`
        );
      }

      else {
        const newItems =
          items.filter(
            item =>
              !seen.has(
                String(item.id)
              )
          );

        /*
         * Only newly appearing TOP listings qualify.
         */
        if (
          newItems.length > 6
        ) {
          console.error(
            `🛑 SAFETY LOCK: ${newItems.length} unseen top listings.`
          );

          console.error(
            "Telegram alerts suppressed."
          );
        }

        else if (
          newItems.length === 0
        ) {
          console.log(
            "No new top Drake's listings."
          );
        }

        else {
          console.log(
            `🚨 ${newItems.length} NEW TOP LISTING(S)!`
          );

          /*
           * Because items are already in visible
           * newest-first order, send newest first.
           */
          for (const item of newItems) {
            try {
              console.log(
                `🚨 NEW TOP ITEM: ${item.id} | ${item.title}`
              );

              await sendTelegram(
                item
              );

              seen.add(
                String(item.id)
              );

              saveSeen(seen);

              console.log(
                `✅ Telegram sent for ${item.id}`
              );

              await sleep(300);

            } catch (error) {
              console.error(
                `Telegram failed for ${item.id}:`,
                error.message
              );
            }
          }
        }

        /*
         * Remember every currently visible top item,
         * even if it wasn't alerted due to safety.
         *
         * This prevents old cards moving around the
         * page from later becoming fake "new" alerts.
         */
        for (const item of items) {
          seen.add(
            String(item.id)
          );
        }

        saveSeen(seen);
      }

      errors = 0;

    } catch (error) {
      errors++;

      console.error(
        "❌ Check failed:",
        error.message
      );

      if (errors >= 3) {
        try {
          await page.close();
        } catch {}

        page =
          await context.newPage();

        errors = 0;

        console.log(
          "♻️ Fresh Vinted page created."
        );
      }
    }

    const elapsed =
      Date.now() - started;

    const target =
      Number(
        CHECK_INTERVAL_SECONDS
      ) * 1000;

    await sleep(
      Math.max(
        1000,
        target - elapsed
      )
    );
  }
}

main().catch(error => {
  console.error(
    "❌ Fatal monitor error:",
    error
  );

  process.exit(1);
});
