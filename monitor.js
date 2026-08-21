import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  CHECK_INTERVAL_SECONDS = "10",
  VINTED_SEARCH_URL =
    "https://www.vinted.co.uk/catalog?search_text=drakes&brand_ids[]=389025&page=1",
  DATA_DIR = "/data"
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("Missing Telegram variables.");
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const seenFile = path.join(DATA_DIR, "seen_vinted.json");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadSeen() {
  try {
    return new Set(
      JSON.parse(fs.readFileSync(seenFile, "utf8"))
    );
  } catch {
    return new Set();
  }
}

function saveSeen(seen) {
  fs.writeFileSync(
    seenFile,
    JSON.stringify([...seen], null, 2)
  );
}

function escapeHtml(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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

async function sendListing(item) {
  const caption = [
    "🚨 <b>NEW VINTED LISTING</b>",
    "",
    `<b>${escapeHtml(item.title || "New listing")}</b>`,
    item.price ? `💷 ${escapeHtml(item.price)}` : "",
    item.size ? `📏 ${escapeHtml(item.size)}` : "",
    `🏷 Drake's`,
    "",
    `<a href="${item.url}">OPEN ON VINTED</a>`
  ]
    .filter(Boolean)
    .join("\n");

  if (item.image) {
    try {
      await telegramRequest("sendPhoto", {
        chat_id: TELEGRAM_CHAT_ID,
        photo: item.image,
        caption,
        parse_mode: "HTML"
      });

      return;
    } catch (error) {
      console.log(
        "Photo send failed, falling back to text:",
        error.message
      );
    }
  }

  await telegramRequest("sendMessage", {
    chat_id: TELEGRAM_CHAT_ID,
    text: caption,
    parse_mode: "HTML",
    disable_web_page_preview: false
  });
}

async function extractListings(page) {
  return await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    const links = [
      ...document.querySelectorAll('a[href*="/items/"]')
    ];

    for (const link of links) {
      try {
        const url = new URL(
          link.href,
          location.origin
        );

        const match = url.pathname.match(
          /\/items\/(\d+)/
        );

        if (!match) continue;

        const id = match[1];

        if (seen.has(id)) continue;

        const card =
          link.closest(
            '[data-testid*="item"], article, li'
          ) ||
          link.parentElement?.parentElement ||
          link;

        const rawText =
          card?.innerText ||
          link.innerText ||
          "";

        const text = rawText
          .replace(/\s+/g, " ")
          .trim();

        /*
         * Strict Drake's filter.
         * Ignore recommendations/adverts/unrelated items
         * unless the card text explicitly contains Drake's.
         */
        if (!/\bdrake['’]?s\b/i.test(text)) {
          continue;
        }

        const image =
          card?.querySelector("img")?.src ||
          link.querySelector("img")?.src ||
          "";

        const lines = rawText
          .split("\n")
          .map(x => x.trim())
          .filter(Boolean);

        let price = "";
        let size = "";

        for (const line of lines) {
          if (
            !price &&
            /£\s?\d|GBP/i.test(line)
          ) {
            price = line;
          }

          if (
            !size &&
            /^(XXS|XS|S|M|L|XL|XXL|XXXL|\d{1,2}(\.\d)?|UK\s?\d+)/i.test(line)
          ) {
            size = line;
          }
        }

        const title =
          link.getAttribute("title") ||
          link.querySelector("img")?.alt ||
          lines[0] ||
          `Vinted item ${id}`;

        seen.add(id);

        results.push({
          id,
          url: url.href,
          title,
          price,
          size,
          image
        });

      } catch {
        // Ignore malformed links/cards.
      }
    }

    return results;
  });
}

async function main() {
  const seen = loadSeen();

  console.log(
    `Loaded ${seen.size} previously seen Vinted item(s).`
  );

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage"
    ]
  });

  const context = await browser.newContext({
    locale: "en-GB",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150 Safari/537.36"
  });

  const page = await context.newPage();

  let baselineDone = seen.size > 0;
  let consecutiveErrors = 0;

  console.log("✅ Vinted monitor started.");
  console.log(
    `Checking every ${CHECK_INTERVAL_SECONDS} seconds.`
  );

  while (true) {
    try {
      await page.goto(
        VINTED_SEARCH_URL,
        {
          waitUntil: "domcontentloaded",
          timeout: 45000
        }
      );

      await page.waitForTimeout(2500);

      const listings =
        await extractListings(page);

      console.log(
        `Found ${listings.length} Drake's listing(s).`
      );

      if (
        listings.length > 0 &&
        !baselineDone
      ) {
        for (const listing of listings) {
          seen.add(listing.id);
        }

        saveSeen(seen);
        baselineDone = true;

        console.log(
          `✅ Baseline saved with ${seen.size} existing Drake's listing(s).`
        );
      }

      else if (baselineDone) {
        const newListings =
          listings.filter(
            item => !seen.has(item.id)
          );

        if (newListings.length > 0) {
          console.log(
            `🚨 ${newListings.length} NEW Drake's listing(s)!`
          );

          for (
            const item of [...newListings].reverse()
          ) {
            try {
              await sendListing(item);

              seen.add(item.id);
              saveSeen(seen);

              console.log(
                `✅ Alert sent for Vinted item ${item.id}.`
              );

            } catch (error) {
              console.error(
                `Telegram failed for ${item.id}:`,
                error.message
              );
            }
          }

        } else {
          console.log(
            "No new Drake's listings."
          );
        }
      }

      consecutiveErrors = 0;

    } catch (error) {
      consecutiveErrors++;

      console.error(
        "Vinted check failed:",
        error.message
      );
    }

    const delay =
      consecutiveErrors >= 3
        ? 60000
        : Number(
            CHECK_INTERVAL_SECONDS
          ) * 1000;

    await sleep(delay);
  }
}

main().catch(error => {
  console.error(
    "Fatal Vinted monitor error:",
    error
  );

  process.exit(1);
});
