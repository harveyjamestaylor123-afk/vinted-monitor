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
    item.condition ? `✨ ${escapeHtml(item.condition)}` : "",
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

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id =
    raw.id ||
    raw.item_id ||
    raw.itemId;

  if (!id) return null;

  const brandName =
    raw.brand_title ||
    raw.brand_name ||
    raw.brand?.title ||
    raw.brand?.name ||
    "";

  const title =
    raw.title ||
    raw.name ||
    raw.description ||
    `Vinted item ${id}`;

  const price =
    raw.price?.amount
      ? `£${raw.price.amount}`
      : raw.price_numeric
      ? `£${raw.price_numeric}`
      : typeof raw.price === "string"
      ? raw.price
      : "";

  const image =
    raw.photo?.url ||
    raw.photo?.full_size_url ||
    raw.photos?.[0]?.url ||
    raw.photos?.[0]?.full_size_url ||
    raw.image?.url ||
    "";

  const size =
    raw.size_title ||
    raw.size ||
    raw.size?.title ||
    "";

  const condition =
    raw.status ||
    raw.condition ||
    raw.status_title ||
    "";

  const url =
    raw.url ||
    `https://www.vinted.co.uk/items/${id}`;

  const combined =
    `${brandName} ${title}`.toLowerCase();

  if (!combined.match(/drake['’]?s/)) {
    return null;
  }

  return {
    id: String(id),
    title: String(title),
    price: String(price || ""),
    image: String(image || ""),
    size: String(size || ""),
    condition: String(condition || ""),
    url: String(url)
  };
}

async function extractListings(page) {
  return await page.evaluate(() => {
    const out = new Map();

    function add(item) {
      if (!item || !item.id) return;
      out.set(String(item.id), item);
    }

    function normalize(raw) {
      if (!raw || typeof raw !== "object") return null;

      const id =
        raw.id ||
        raw.item_id ||
        raw.itemId;

      if (!id) return null;

      const brandName =
        raw.brand_title ||
        raw.brand_name ||
        raw.brand?.title ||
        raw.brand?.name ||
        "";

      const title =
        raw.title ||
        raw.name ||
        raw.description ||
        `Vinted item ${id}`;

      const price =
        raw.price?.amount
          ? `£${raw.price.amount}`
          : raw.price_numeric
          ? `£${raw.price_numeric}`
          : typeof raw.price === "string"
          ? raw.price
          : "";

      const image =
        raw.photo?.url ||
        raw.photo?.full_size_url ||
        raw.photos?.[0]?.url ||
        raw.photos?.[0]?.full_size_url ||
        raw.image?.url ||
        "";

      const size =
        raw.size_title ||
        raw.size?.title ||
        raw.size ||
        "";

      const condition =
        raw.status ||
        raw.condition ||
        raw.status_title ||
        "";

      const url =
        raw.url ||
        `https://www.vinted.co.uk/items/${id}`;

      const combined =
        `${brandName} ${title}`.toLowerCase();

      if (!/drake['’]?s/.test(combined)) {
        return null;
      }

      return {
        id: String(id),
        title: String(title),
        price: String(price || ""),
        image: String(image || ""),
        size: String(size || ""),
        condition: String(condition || ""),
        url: String(url)
      };
    }

    function walk(value, depth = 0) {
      if (depth > 8 || value == null) return;

      if (Array.isArray(value)) {
        for (const x of value) {
          walk(x, depth + 1);
        }
        return;
      }

      if (typeof value === "object") {
        const candidate = normalize(value);
        if (candidate) add(candidate);

        for (const v of Object.values(value)) {
          walk(v, depth + 1);
        }
      }
    }

    // 1) Inspect embedded JSON/state scripts
    for (const script of document.querySelectorAll("script")) {
      const text = script.textContent || "";

      if (
        !text.includes("Drake") &&
        !text.includes("drake") &&
        !text.includes("/items/")
      ) {
        continue;
      }

      try {
        const parsed = JSON.parse(text);
        walk(parsed);
      } catch {
        // Not pure JSON, ignore.
      }
    }

    // 2) Inspect global Next/SSR state if present
    try {
      if (window.__NEXT_DATA__) {
        walk(window.__NEXT_DATA__);
      }
    } catch {}

    // 3) Fall back to visible links/cards
    for (const link of document.querySelectorAll('a[href*="/items/"]')) {
      try {
        const url = new URL(link.href, location.origin);
        const match = url.pathname.match(/\/items\/(\d+)/);
        if (!match) continue;

        const id = match[1];

        const card =
          link.closest(
            '[data-testid*="item"], article, li, [class*="feed-grid"]'
          ) ||
          link.parentElement?.parentElement ||
          link;

        const rawText =
          card?.innerText ||
          link.innerText ||
          "";

        const text =
          rawText.replace(/\s+/g, " ").trim();

        if (!/\bdrake['’]?s\b/i.test(text)) {
          continue;
        }

        const lines =
          rawText
            .split("\n")
            .map(x => x.trim())
            .filter(Boolean);

        let price = "";
        let size = "";
        let condition = "";

        for (const line of lines) {
          if (!price && /£\s?\d/.test(line)) {
            price = line;
          }

          if (
            !size &&
            /^(XXS|XS|S|M|L|XL|XXL|XXXL|\d{1,2}(\.\d)?|UK\s?\d+)/i.test(line)
          ) {
            size = line;
          }

          if (
            !condition &&
            /(new with tags|new without tags|very good|good|satisfactory)/i.test(line)
          ) {
            condition = line;
          }
        }

        add({
          id,
          title:
            link.getAttribute("title") ||
            link.querySelector("img")?.alt ||
            lines[0] ||
            `Vinted item ${id}`,
          price,
          size,
          condition,
          image:
            card?.querySelector("img")?.src ||
            link.querySelector("img")?.src ||
            "",
          url: url.href
        });
      } catch {}
    }

    return [...out.values()];
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
          waitUntil: "networkidle",
          timeout: 60000
        }
      );

      await page.waitForTimeout(2000);

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
