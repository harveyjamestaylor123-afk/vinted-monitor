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

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ Missing Telegram variables.");
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const SEEN_FILE = path.join(
  DATA_DIR,
  "vinted_visible_seen.json"
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
  if (!cookieString) return [];

  return cookieString
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const index = part.indexOf("=");

      if (index === -1) return null;

      const name =
        part.slice(0, index).trim();

      const value =
        part.slice(index + 1).trim();

      if (!name) return null;

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
        "Photo failed, sending text:",
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

async function extractVisibleItems(page) {
  return await page.evaluate(() => {
    const results = [];
    const usedIds = new Set();

    const links =
      Array.from(
        document.querySelectorAll(
          'a[href*="/items/"]'
        )
      );

    for (const link of links) {
      try {
        const url =
          new URL(
            link.href,
            window.location.origin
          );

        const match =
          url.pathname.match(
            /\/items\/(\d+)/
          );

        if (!match) continue;

        const id = match[1];

        if (usedIds.has(id)) {
          continue;
        }

        /*
         * Find the surrounding Vinted product card.
         */
        let card = link;

        for (let i = 0; i < 6; i++) {
          if (!card.parentElement) break;

          card = card.parentElement;

          const text =
            card.innerText || "";

          const hasPrice =
            /£\s?\d/.test(text);

          const hasImage =
            Boolean(
              card.querySelector("img")
            );

          if (hasPrice && hasImage) {
            break;
          }
        }

        const rawText =
          card?.innerText ||
          link.innerText ||
          "";

        const lines =
          rawText
            .split("\n")
            .map(x => x.trim())
            .filter(Boolean);

        /*
         * Require Drake's to be visible on the card.
         * This is a final defensive check.
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

        const image =
          card?.querySelector("img")?.src ||
          link.querySelector("img")?.src ||
          "";

        const imageAlt =
          card?.querySelector("img")?.alt ||
          "";

        let price = "";

        for (const line of lines) {
          if (
            /^£\s?\d/.test(line) ||
            /£\d/.test(line)
          ) {
            price = line;
            break;
          }
        }

        /*
         * Vinted card text normally includes:
         *
         * Drake's
         * size · condition
         * £price
         *
         * The image alt/title often contains
         * the actual listing title.
         */
        let title =
          link.getAttribute("title") ||
          imageAlt ||
          "";

        if (!title) {
          /*
           * Fall back to URL slug.
           */
          const slug =
            url.pathname
              .replace(
                `/items/${id}-`,
                ""
              )
              .replaceAll("-", " ");

          title =
            slug ||
            `Drake's item ${id}`;
        }

        /*
         * Clean Vinted image alt text when it
         * contains extra wording.
         */
        title =
          String(title)
            .replace(/\s+/g, " ")
            .trim();

        const details =
          lines
            .filter(line => {
              if (line === price) return false;

              if (
                /^£\s?\d/.test(line)
              ) {
                return false;
              }

              return true;
            })
            .slice(0, 3)
            .join(" · ");

        usedIds.add(id);

        results.push({
          id,
          title,
          details,
          price,
          image,
          url: url.href
        });

      } catch {
        // Ignore malformed cards.
      }
    }

    return results;
  });
}

async function loadNewestPage(page) {
  /*
   * Change the existing Vinted time parameter
   * each visit to discourage cached results.
   */
  const url =
    new URL(SEARCH_URL);

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

  /*
   * Wait for actual item links rather than an
   * arbitrary network request.
   */
  try {
    await page.waitForSelector(
      'a[href*="/items/"]',
      {
        timeout: 15000
      }
    );
  } catch {
    throw new Error(
      "No Vinted item cards appeared on the page."
    );
  }

  /*
   * Give React a little time to finish rendering.
   */
  await page.waitForTimeout(1200);

  return await extractVisibleItems(page);
}

async function main() {
  const seen = loadSeen();

  console.log(
    `Loaded ${seen.size} previously seen item(s).`
  );

  console.log(
    "🚀 Starting ACTUAL Vinted page monitor."
  );

  console.log(
    "🇬🇧 Drake's — Newest first"
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

  /*
   * If you added your UK Vinted cookie in
   * Railway, apply it to the real browser.
   */
  if (VINTED_COOKIE) {
    try {
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

    } catch (error) {
      console.log(
        "Cookie warning:",
        error.message
      );
    }
  }

  const page =
    await context.newPage();

  let baselineDone =
    seen.size > 0;

  let errors = 0;

  while (true) {
    const started =
      Date.now();

    try {
      console.log(
        "🔄 Loading Drake's newest-first page..."
      );

      const items =
        await loadNewestPage(
          page
        );

      console.log(
        `✅ Page contains ${items.length} Drake's item(s).`
      );

      /*
       * This is the crucial diagnostic.
       *
       * Compare these to the first products
       * shown on your own Vinted page.
       */
      console.log(
        "TOP VISIBLE ITEMS:"
      );

      for (
        const item of items.slice(0, 8)
      ) {
        console.log(
          `${item.id} | ${item.title} | ${item.price}`
        );
      }

      if (items.length === 0) {
        throw new Error(
          "Page loaded but no Drake's cards were extracted."
        );
      }

      /*
       * Establish baseline on first successful run.
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
          `✅ Baseline created with ${seen.size} current item(s).`
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
         * Protect against another accidental flood.
         */
        if (newItems.length > 8) {
          console.error(
            `🛑 SAFETY LOCK: ${newItems.length} unseen items appeared.`
          );

          console.error(
            "Telegram alerts suppressed."
          );
        }

        else if (
          newItems.length === 0
        ) {
          console.log(
            "No new Drake's listings."
          );
        }

        else {
          console.log(
            `🚨 ${newItems.length} NEW LISTING(S)!`
          );

          for (
            const item of
              [...newItems].reverse()
          ) {
            try {
              console.log(
                `🚨 NEW: ${item.id} | ${item.title}`
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
      }

      errors = 0;

    } catch (error) {
      errors++;

      console.error(
        "❌ Check failed:",
        error.message
      );

      if (errors >= 3) {
        console.log(
          "♻️ Creating fresh Vinted page..."
        );

        try {
          await page.close();
        } catch {}

        page =
          await context.newPage();

        errors = 0;
      }
    }

    const elapsed =
      Date.now() -
      started;

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
