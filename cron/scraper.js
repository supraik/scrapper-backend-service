const puppeteer = require("puppeteer");

const MAX_TABS    = 3;
const MAX_RETRIES = 2;
const BASE_URL    = "https://demo.inelabteamdev.com/product/";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Resource blocking — kill images / fonts / media to save RAM & CPU
// ─────────────────────────────────────────────────────────────────────────────
async function configureResourceBlocking(page) {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
        if (["image", "font", "media"].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cookie overlay — just display:none it, no fancy waiting
// ─────────────────────────────────────────────────────────────────────────────
async function hideCookieOverlay(page) {
    try {
        await page.evaluate(() => {
            const el = document.querySelector(".cookie-overlay");
            if (el) el.style.display = "none";
        });
    } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Price parser — handles every format the site throws at us:
//
//  Format                      Example raw text          → Result
//  ─────────────────────────── ─────────────────────     ────────
//  Normal comma-thousands      ₹21,626                   → 21626
//  Space-thousands             ₹12 449                   → 12449
//  Full-width unicode digits   ₹４２,１４４               → 42144
//  Indian lakh format          ₹1,26,960                 → 126960
//  Trailing paise              Rs. 50,707.00             → 50707
//  EU/glitchy (dot < comma)    ₹50.707,00                → 50  ← site bug, expected
//  With deal/prefix text       (stripped by caller)
// ─────────────────────────────────────────────────────────────────────────────
function parsePrice(rawText) {
    if (!rawText) return null;

    // 1. NFKC normalization: full-width digits (１２３) → ASCII (123)
    //    + strip zero-width / non-breaking / soft-hyphen chars
    let text = rawText
        .normalize("NFKC")
        .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "")
        .replace(/\u00A0/g, " ")
        .trim();

    // 2. Strip currency symbols and prefixes (₹, Rs., Rs, INR — any case)
    text = text.replace(/(?:Rs\.?\s*|₹\s*|INR\s*)/gi, "").trim();

    if (!text) return null;

    // 3. Detect whether this is European/glitchy format (dot appears before comma)
    //    e.g. "50.707,00" — site is outputting bad data in EU notation.
    //    In that case just take the digits before the first dot (→ 50).
    //    Otherwise treat commas + spaces as Indian thousands separators.
    const firstDot   = text.indexOf(".");
    const firstComma = text.indexOf(",");

    let integerStr;

    if (firstDot !== -1 && firstComma !== -1 && firstDot < firstComma) {
        // EU / glitchy: dot is thousands separator here — grab only what's before it
        integerStr = text.slice(0, firstDot).replace(/[^0-9]/g, "");
    } else {
        // Indian / standard: commas and spaces are thousands separators;
        // a trailing ".xx" is decimal paise → drop it
        integerStr = text
            .replace(/[, ]/g, "")    // remove thousands separators
            .replace(/\.\d*$/, "")   // strip decimal portion
            .replace(/[^0-9]/g, ""); // safety-strip any remaining non-digits
    }

    if (!integerStr) return null;
    const val = parseInt(integerStr, 10);
    return isNaN(val) ? null : val;
}

// ─────────────────────────────────────────────────────────────────────────────
// Price extractor — reads the pv-a7 span from a price-success block.
// Call only once .price-block.price-success is confirmed to be in the DOM.
// ─────────────────────────────────────────────────────────────────────────────
async function extractPrice(page, productId) {
    const raw = await page.evaluate(() => {
        // The real price is always in the span carrying the "pv-a7" class.
        // The random prefix class (ve6llzt, v4sf02u …) changes per product,
        // so we use a substring attribute selector on className.
        const span = document.querySelector(".price-main [class*='pv-a7']");
        if (!span) return null;
        // innerText respects CSS visibility; textContent as fallback
        return (span.innerText || span.textContent || "").trim();
    });

    console.log(`🔤  [Product ${productId}] Raw price text from DOM → "${raw}"`);

    if (!raw) {
        console.warn(`⚠️   [Product ${productId}] pv-a7 span returned empty text`);
        return null;
    }

    const price = parsePrice(raw);

    if (price === null) {
        console.warn(`⚠️   [Product ${productId}] parsePrice could not extract a number from "${raw}"`);
    }

    return price;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main scrape function for one product page
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeProductPage(page, productId) {
    const url = `${BASE_URL}${productId}`;

    console.log(`\n${"─".repeat(60)}`);
    console.log(`🛒  [Product ${productId}] Starting scrape`);
    console.log(`🌐  [Product ${productId}] Navigating → ${url}`);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    console.log(`✅  [Product ${productId}] DOM loaded — waiting 5s for cookie popup to appear (if any)...`);

    await sleep(5000);

    console.log(`🍪  [Product ${productId}] 5s elapsed — killing cookie overlay now...`);
    await hideCookieOverlay(page);
    console.log(`✔️   [Product ${productId}] Cookie overlay handled`);

    // ── Fast-path: price might already be in success state ───────────────────
    {
        const alreadySuccess = await page.evaluate(
            () => !!document.querySelector(".price-block.price-success")
        );
        if (alreadySuccess) {
            console.log(`⚡  [Product ${productId}] price-block already in success state — skipping hover+click`);
            const price = await extractPrice(page, productId);
            if (price !== null) {
                console.log(`🎯  [Product ${productId}] Price extracted → ${price}`);
                return { product_id: productId, price, timestamp: new Date().toISOString() };
            }
            console.warn(`⚠️   [Product ${productId}] Fast-path found success block but parse failed — continuing normally`);
        }
    }

    // ── Wait for the substatus paragraph ──────────────────────────────────────
    console.log(`🔎  [Product ${productId}] Waiting for .price-substatus to be visible...`);
    try {
        await page.waitForSelector(".price-substatus", { visible: true, timeout: 10000 });
    } catch (_) {
        throw new Error("'.price-substatus' never appeared — page likely failed to load properly");
    }
    console.log(`✅  [Product ${productId}] .price-substatus is visible`);

    // ── PHASE 1: Hover loop — activate the Reveal button ─────────────────────
    //
    // We hover over the substatus paragraph, wait 500ms, then check if the
    // Reveal button flipped from disabled → enabled.
    // If still disabled: suppress cookie overlay and try again (up to 8 times).
    // ─────────────────────────────────────────────────────────────────────────
    const MAX_HOVER_ATTEMPTS = 8;
    let buttonActivated = false;

    console.log(`🖱️   [Product ${productId}] Starting hover loop (max ${MAX_HOVER_ATTEMPTS} attempts)...`);

    for (let ha = 1; ha <= MAX_HOVER_ATTEMPTS; ha++) {
        console.log(`     [Product ${productId}] Hover attempt ${ha}/${MAX_HOVER_ATTEMPTS} — suppressing cookie first...`);
        await hideCookieOverlay(page);

        const substatusEl = await page.$(".price-substatus");
        if (!substatusEl) {
            // Substatus is gone — price may have loaded during our wait
            console.log(`❓  [Product ${productId}] .price-substatus disappeared — checking if price loaded...`);
            break;
        }

        const box = await substatusEl.boundingBox();
        if (!box) {
            console.log(`⚠️   [Product ${productId}] Could not get bounding box — retrying in 300ms...`);
            await sleep(300);
            continue;
        }

        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        console.log(`     [Product ${productId}] Moving mouse → (${Math.round(cx)}, ${Math.round(cy)})...`);
        await page.mouse.move(cx, cy, { steps: 10 });

        console.log(`     [Product ${productId}] Hovering — waiting 500ms for button to activate...`);
        await sleep(500);

        const btnState = await page.evaluate(() => {
            const btn = document.querySelector('button[aria-label="Reveal price"]');
            if (!btn) return "missing";
            return btn.disabled ? "disabled" : "active";
        });

        if (btnState === "active") {
            console.log(`🟢  [Product ${productId}] Reveal button is ACTIVE after hover attempt ${ha}!`);
            buttonActivated = true;
            break;
        } else if (btnState === "missing") {
            console.log(`❓  [Product ${productId}] Reveal button not in DOM — price may have loaded on its own`);
            break;
        } else {
            console.log(`🔴  [Product ${productId}] Button still disabled after attempt ${ha} — will try again...`);
        }
    }

    // ── Between-phase check: did price load during hover? ────────────────────
    {
        const successDuringHover = await page.evaluate(
            () => !!document.querySelector(".price-block.price-success")
        );
        if (successDuringHover) {
            console.log(`⚡  [Product ${productId}] price-success appeared during hover phase — extracting now!`);
            const price = await extractPrice(page, productId);
            if (price !== null) {
                console.log(`🎯  [Product ${productId}] Price extracted → ${price}`);
                return { product_id: productId, price, timestamp: new Date().toISOString() };
            }
        }
    }

    if (!buttonActivated) {
        throw new Error(`Reveal button could not be activated after ${MAX_HOVER_ATTEMPTS} hover attempts`);
    }

    // ── PHASE 2: Post-click checkpoint state machine ─────────────────────────
    //
    // Now that Phase 1 has confirmed the Reveal button is active, we:
    //   1. Fire the initial click on the Reveal button.
    //   2. Enter a checkpoint loop that reads the current DOM state each round
    //      and decides what to do next:
    //
    //   ┌──────────────────────────────────────────────────────────────────┐
    //   │  CLICK Reveal Price (initial — button is guaranteed active here) │
    //   └────────────────────────────┬─────────────────────────────────────┘
    //                                │  wait 3 s
    //                                ▼
    //   ┌──────────────────────────────────────────────────────────────────┐
    //   │  CHECKPOINT — read .price-block state                            │
    //   │                                                                  │
    //   │  ① price-success?         → extract & DONE ✅                   │
    //   │  ② loading?  (spinner /   → wait 3 s → next checkpoint          │
    //   │     aria-busy / no error)                                        │
    //   │  ③ price-error?           → click "Try again" btn               │
    //   │                              wait 3 s → next checkpoint          │
    //   │  ④ Reveal btn still       → click it again                      │
    //   │     active? (click missed)   wait 3 s → next checkpoint          │
    //   │  ⑤ none of the above     → wait 3 s → next checkpoint           │
    //   └──────────────────────────────────────────────────────────────────┘
    //
    // ─────────────────────────────────────────────────────────────────────────
    const MAX_CLICK_ROUNDS = 15;

    // ── Initial click — button is active, confirmed by Phase 1 ──────────────
    console.log(`\n🖱️   [Product ${productId}] PHASE 2 — Initial click on Reveal Price button...`);
    await page.click('button[aria-label="Reveal price"]');
    console.log(`✅  [Product ${productId}] Reveal clicked! Waiting 3s before first checkpoint...`);
    await sleep(3000);

    // ── Checkpoint loop ──────────────────────────────────────────────────────
    console.log(`\n🔁  [Product ${productId}] Entering checkpoint loop (max ${MAX_CLICK_ROUNDS} rounds)...`);

    for (let round = 1; round <= MAX_CLICK_ROUNDS; round++) {

        console.log(`\n📍  [Product ${productId}] ── Checkpoint ${round}/${MAX_CLICK_ROUNDS} ──`);

        // Read every relevant signal from the DOM in a single evaluate call
        const state = await page.evaluate(() => {
            const block     = document.querySelector(".price-block");
            if (!block) return { type: "no-block", className: "" };

            const cls        = block.className;
            const ariaBusy   = block.getAttribute("aria-busy");
            const hasSpinner = !!block.querySelector(".spinner");
            const hasSuccess = cls.includes("price-success");
            const hasError   = cls.includes("price-error");
            // Loading = not success, not error, but spinner present OR aria-busy="true"
            const isLoading  = !hasSuccess && !hasError && (ariaBusy === "true" || hasSpinner);

            const tryAgainBtn = block.querySelector("button.btn-primary");
            const hasTryAgain = !!tryAgainBtn;

            const revealBtn   = document.querySelector('button[aria-label="Reveal price"]');
            const revealActive = revealBtn && !revealBtn.disabled;

            return {
                type: hasSuccess   ? "success"
                    : hasError     ? "error"
                    : isLoading    ? "loading"
                    : revealActive ? "reveal-active"
                    :                "unknown",
                className:    cls,
                hasTryAgain,
                revealActive: !!revealActive,
            };
        });

        console.log(`📋  [Product ${productId}] State → "${state.type}"  (classes: "${state.className}")`);

        // ─── ① SUCCESS ─────────────────────────────────────────────────────
        if (state.type === "success") {
            console.log(`🎉  [Product ${productId}] ✅ CP-1 — price-success! Extracting price...`);
            const price = await extractPrice(page, productId);
            if (price !== null) {
                console.log(`🎯  [Product ${productId}] Price extracted → ${price}`);
                return { product_id: productId, price, timestamp: new Date().toISOString() };
            }
            // Edge case: success block rendered but span text not painted yet
            console.warn(`⚠️   [Product ${productId}] price-success present but span empty — waiting 1.5 s then retrying...`);
            await sleep(1500);
            const retryPrice = await extractPrice(page, productId);
            if (retryPrice !== null) {
                console.log(`🎯  [Product ${productId}] Price on retry → ${retryPrice}`);
                return { product_id: productId, price: retryPrice, timestamp: new Date().toISOString() };
            }
            throw new Error("price-success state reached but pv-a7 span returned no parseable number");
        }

        // ─── ② LOADING ─────────────────────────────────────────────────────
        if (state.type === "loading") {
            console.log(`⏳  [Product ${productId}] ✅ CP-2 — Loading state (spinner / aria-busy). Waiting 3 s...`);
            await sleep(3000);
            continue;
        }

        // ─── ③ ERROR / FAILED — click "Try again" ──────────────────────────
        if (state.type === "error") {
            if (state.hasTryAgain) {
                console.log(`🔄  [Product ${productId}] ✅ CP-3 — Error state! Clicking "Try again"...`);
                try {
                    await page.click(".price-block.price-error button.btn-primary");
                    console.log(`✅  [Product ${productId}] "Try again" clicked — waiting 3 s...`);
                } catch (e) {
                    console.warn(`⚠️   [Product ${productId}] Click on "Try again" threw: ${e.message} — waiting anyway...`);
                }
            } else {
                console.warn(`⚠️   [Product ${productId}] Error state but no "Try again" button found — waiting 3 s...`);
            }
            await sleep(3000);
            continue;
        }

        // ─── ④ REVEAL BUTTON STILL ACTIVE (click didn't register) ──────────
        if (state.type === "reveal-active") {
            console.log(`🖱️   [Product ${productId}] ✅ CP-4 — Reveal button still active (click missed?). Re-clicking...`);
            try {
                await page.click('button[aria-label="Reveal price"]');
                console.log(`✅  [Product ${productId}] Re-clicked Reveal — waiting 3 s...`);
            } catch (e) {
                console.warn(`⚠️   [Product ${productId}] Re-click threw: ${e.message} — waiting anyway...`);
            }
            await sleep(3000);
            continue;
        }

        // ─── ⑤ UNKNOWN / TRANSITIONAL — just wait ──────────────────────────
        console.log(`❓  [Product ${productId}] ✅ CP-5 — Unknown/transitional state. Waiting 3 s...`);
        await sleep(3000);
    }

    throw new Error(`Price never reached success state after ${MAX_CLICK_ROUNDS} checkpoint rounds (≈${MAX_CLICK_ROUNDS * 3}s total)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-product wrapper with retry logic
// ─────────────────────────────────────────────────────────────────────────────
async function processProductWithRetry(browser, productId) {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        console.log(`\n🚀  [Product ${productId}] Opening new browser tab — attempt ${attempt}/${MAX_RETRIES}`);
        const page = await browser.newPage();

        try {
            await configureResourceBlocking(page);
            console.log(`🚫  [Product ${productId}] Resource blocking active — images / fonts / media will be aborted`);

            const data = await scrapeProductPage(page, productId);

            await page.close();
            console.log(`📄  [Product ${productId}] Tab closed cleanly`);
            console.log(`\n✨  [Product ${productId}] SUCCESS — price: ${data.price} | scraped at ${data.timestamp}`);
            return data;

        } catch (error) {
            console.warn(`\n⚠️   [Product ${productId}] Attempt ${attempt}/${MAX_RETRIES} FAILED`);
            console.warn(`     Reason: ${error.message}`);
            lastError = error;

            await page.close().catch(() => {});
            console.warn(`📄  [Product ${productId}] Tab closed after failure`);

            if (attempt < MAX_RETRIES) {
                console.warn(`⏳  [Product ${productId}] Waiting 1s before retry ${attempt + 1}...`);
                await sleep(1000);
            }
        }
    }

    console.error(`\n❌  [Product ${productId}] All ${MAX_RETRIES} attempts exhausted — recording as failed`);
    console.error(`     Last error: ${lastError ? lastError.message : "unknown"}`);

    return {
        product_id: productId,
        price:      null,
        timestamp:  new Date().toISOString(),
        error:      lastError ? lastError.message : "Scrape failed",
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main pipeline — batches products MAX_TABS at a time in parallel
// ─────────────────────────────────────────────────────────────────────────────
async function runScraperPipeline(productIds) {
    if (!productIds || productIds.length === 0) {
        console.warn("⚠️  No product IDs provided — pipeline exiting early");
        return [];
    }

    const totalBatches = Math.ceil(productIds.length / MAX_TABS);

    console.log(`\n${"═".repeat(60)}`);
    console.log(`🏁  SCRAPER PIPELINE STARTING`);
    console.log(`     Total products  : ${productIds.length}`);
    console.log(`     Parallel tabs   : ${MAX_TABS}`);
    console.log(`     Total batches   : ${totalBatches}`);
    console.log(`     Max retries     : ${MAX_RETRIES} per product`);
    console.log(`${"═".repeat(60)}`);

    console.log(`\n🌍  Launching Chromium browser...`);
    const browser = await puppeteer.launch({
        headless: false,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-component-extensions-with-background-pages",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-translate",
            "--no-first-run",
            "--no-default-browser-check",
            "--single-process",
            "--js-flags=--max-old-space-size=128",
        ],
    });
    console.log(`✅  Browser launched successfully\n`);

    const results = [];

    try {
        for (let i = 0; i < productIds.length; i += MAX_TABS) {
            const batch       = productIds.slice(i, i + MAX_TABS);
            const batchNumber = Math.floor(i / MAX_TABS) + 1;

            console.log(`\n${"═".repeat(60)}`);
            console.log(`📦  BATCH ${batchNumber}/${totalBatches} — Products: [${batch.join(", ")}]`);
            console.log(`     Firing ${batch.length} parallel tab(s)...`);
            console.log(`${"═".repeat(60)}`);

            const batchResults = await Promise.all(
                batch.map((id) => processProductWithRetry(browser, id))
            );

            const succeeded = batchResults.filter((r) => r.price !== null).length;
            const failed    = batchResults.length - succeeded;
            console.log(`\n📊  Batch ${batchNumber}/${totalBatches} complete — ✅ ${succeeded} succeeded  ❌ ${failed} failed`);

            results.push(...batchResults);
        }
    } finally {
        await browser.close();
        console.log(`\n🔒  Browser closed — memory freed`);
    }

    const totalSucceeded = results.filter((r) => r.price !== null).length;
    const totalFailed    = results.length - totalSucceeded;

    console.log(`\n${"═".repeat(60)}`);
    console.log(`🏆  PIPELINE COMPLETE`);
    console.log(`     Products scraped : ${results.length}`);
    console.log(`     ✅ Succeeded     : ${totalSucceeded}`);
    console.log(`     ❌ Failed        : ${totalFailed}`);
    console.log(`${"═".repeat(60)}\n`);

    return results;
}

module.exports = { runScraperPipeline };