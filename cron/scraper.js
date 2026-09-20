const puppeteer = require("puppeteer");

const MAX_TABS    = 3;
const MAX_RETRIES = 5;
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
// Cookie overlay — display:none everything cookie-related, no waiting
// ─────────────────────────────────────────────────────────────────────────────
async function hideCookieOverlay(page) {
    try {
        await page.evaluate(() => {
            const kill = (el) => {
                if (!el) return;
                el.style.display       = "none";
                el.style.visibility    = "hidden";
                el.style.pointerEvents = "none";
            };
            [
                ".cookie-overlay",
                "#cookie-overlay",
                "[class*='cookie-banner']",
                "[id*='cookie-banner']",
                "[class*='cookie-consent']",
                "[id*='cookie-consent']",
                "[class*='gdpr']",
                "[id*='gdpr']",
            ].forEach((sel) => document.querySelectorAll(sel).forEach(kill));
        });
    } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug dump — logs full product-level HTML when something goes wrong.
// Call BEFORE closing the tab so the page is still alive.
// ─────────────────────────────────────────────────────────────────────────────
async function dumpDebugHtml(page, productId, context) {
    try {
        const html = await page.evaluate(() => {
            const detailInfo = document.querySelector(".detail-info");
            const priceBlock = document.querySelector(".price-block");
            return {
                detailInfo : detailInfo ? detailInfo.outerHTML : "[.detail-info not found]",
                priceBlock : priceBlock ? priceBlock.outerHTML : "[.price-block not found]",
            };
        });
        console.error(`\n🔍  [Product ${productId}] ── DEBUG HTML DUMP (${context}) ──`);
        console.error(`     .detail-info → ${html.detailInfo}`);
        console.error(`     .price-block → ${html.priceBlock}`);
        console.error(`     ─────────────────────────────────────────────────────\n`);
    } catch (e) {
        console.error(`🔍  [Product ${productId}] HTML dump failed (page already closed?): ${e.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Price parser — handles every format the site throws at us:
//
//  Format                         Example raw text           → Result
//  ────────────────────────────── ─────────────────────────  ────────
//  Normal comma-thousands         ₹21,626                    → 21626
//  Space-thousands                ₹12 449                    → 12449
//  Full-width unicode digits      ₹４２,１４４                → 42144
//  Indian lakh format             ₹1,26,960                  → 126960
//  Trailing paise (Indian sep)    Rs. 50,707.00              → 50707
//  EU/glitchy (dot before comma)  ₹50.707,00                 → 50  ← site bug
//  Char-split with ZWS            ₹​1​3​,​1​8​4 (k2 div) → 13184
// ─────────────────────────────────────────────────────────────────────────────
function parsePrice(rawText) {
    if (!rawText) return null;

    // 1. NFKC normalization: full-width digits (１２３) → ASCII (123)
    //    + strip zero-width / non-breaking / soft-hyphen chars
    //    This is essential for the k2 "char-split" div: each character span
    //    has a trailing U+200B (zero-width space) that must be removed first.
    let text = rawText
        .normalize("NFKC")
        .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "")   // strip ZWS and relatives
        .replace(/\u00A0/g, " ")                         // NBSP → regular space
        .trim();

    // 2. Strip currency symbols/prefixes (₹, Rs., Rs, INR — any case)
    text = text.replace(/(?:Rs\.?\s*|₹\s*|INR\s*)/gi, "").trim();

    if (!text) return null;

    // 3. Detect EU/glitchy format: dot appears BEFORE the first comma
    //    e.g. "50.707,00" — site bug, grab only digits before the dot (→ 50)
    //    Normal Indian format: commas/spaces are thousands separators
    const firstDot   = text.indexOf(".");
    const firstComma = text.indexOf(",");

    let integerStr;
    if (firstDot !== -1 && firstComma !== -1 && firstDot < firstComma) {
        // EU/glitchy: take only the digits strictly before the first dot
        integerStr = text.slice(0, firstDot).replace(/[^0-9]/g, "");
    } else {
        integerStr = text
            .replace(/[, ]/g, "")     // strip thousands separators (commas + spaces)
            .replace(/\.\d*$/, "")    // drop decimal paise (.00, .50, etc.)
            .replace(/[^0-9]/g, "");  // safety-strip anything non-digit remaining
    }

    if (!integerStr) return null;
    const val = parseInt(integerStr, 10);
    return isNaN(val) ? null : val;
}

// ─────────────────────────────────────────────────────────────────────────────
// Price extractor — reads the final selling price from a price-success block.
//
// ══ THE SITE RENDERS THE PRICE ELEMENT IN TWO DIFFERENT WAYS ══════════════
//
//  ① SPAN variant  (pages with pw-a7 suffix):
//       <span class="RANDOM pv-a7" style="...">₹21,626</span>
//     textContent gives the price string directly.
//
//  ② DIV + char-split variant  (pages with pw-k2 suffix):
//       <div class="RANDOM pv-k2" style="...">
//         <span>₹​</span><span>1​</span><span>3​</span><span>,​</span>...
//       </div>
//     Each character is in its own <span>; U+200B (zero-width space) trails
//     each character.  textContent on the div concatenates all child text
//     nodes, giving e.g. "₹​1​3​,​1​8​4".  parsePrice strips the U+200B chars.
//
//  SELECTOR PHILOSOPHY (stable, not class-suffix-dependent):
//    ✅  [class*="pv-"]                — matches BOTH <span> AND <div> variants
//    ❌  span[class*="pv-"]            — BUG: misses the DIV form entirely!
//    ✅  .price-block.price-success    — stable state class
//    ✅  .price-main                   — stable container
//    ❌  [class*="pv-k2"] / [class*="pv-a7"]  — never hardcode the suffix
//
//  WHY textContent OVER innerText:
//    In headless Chrome, innerText depends on CSS layout being fully computed;
//    textContent always works and correctly concatenates all descendant text.
// ─────────────────────────────────────────────────────────────────────────────
async function extractPrice(page, productId) {
    const result = await page.evaluate(() => {
        // Anchor to the success block so we never accidentally read a stale span
        const successBlock = document.querySelector(".price-block.price-success");
        if (!successBlock) {
            return {
                raw          : null,
                pvFound      : false,
                pvTag        : null,
                pvClass      : null,
                priceMainHtml: "[.price-block.price-success not in DOM]",
            };
        }

        const priceMain     = successBlock.querySelector(".price-main");
        const priceMainHtml = priceMain ? priceMain.outerHTML
                                        : "[.price-main not found inside success block]";

        if (!priceMain) {
            return { raw: null, pvFound: false, pvTag: null, pvClass: null, priceMainHtml };
        }

        // ── THE FIX: [class*="pv-"] not span[class*="pv-"] ─────────────────────
        // Matches both the <span> (pw-a7) and <div> (pw-k2) price element variants.
        // "pv-" prefix never appears in any other class inside .price-main, so
        // this selector is unique and safe.
        const pvEl = priceMain.querySelector('[class*="pv-"]');

        if (!pvEl) {
            return { raw: null, pvFound: false, pvTag: null, pvClass: null, priceMainHtml };
        }

        // textContent works for both:
        //   • direct-text span  → returns the price string as-is
        //   • char-split div    → concatenates all child <span> text nodes
        //     (zero-width chars are stripped later by parsePrice)
        const raw = (pvEl.textContent || "").trim() || null;

        return {
            raw,
            pvFound      : true,
            pvTag        : pvEl.tagName.toLowerCase(),   // "span" or "div"
            pvClass      : pvEl.className,
            priceMainHtml: null,                         // only populated on failure
        };
    });

    // ── Logging ──────────────────────────────────────────────────────────────
    console.log(`🔤  [Product ${productId}] Price extraction:`);
    if (result.pvFound) {
        console.log(`     Element found : true  <${result.pvTag} class="${result.pvClass}">`);
        console.log(`     Raw text      : "${result.raw}"`);
    } else {
        console.log(`     Element found : false`);
        console.log(`     Raw text      : "null"`);
    }

    if (!result.pvFound || !result.raw) {
        console.error(`⚠️   [Product ${productId}] pv element not found or empty. price-main HTML:`);
        console.error(`     ${result.priceMainHtml}`);
        return null;
    }

    const price = parsePrice(result.raw);

    if (price === null) {
        console.warn(`⚠️   [Product ${productId}] parsePrice could not extract a number from "${result.raw}"`);
    } else {
        console.log(`💰  [Product ${productId}] Parsed price → ₹${price}`);
    }

    return price;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page state reader — single evaluate for the checkpoint loop.
// Reads all relevant DOM signals in one round-trip to minimise latency.
//
// States returned:
//   "success"      — .price-block.price-success present (price is extractable)
//   "loading"      — spinner or aria-busy="true", not yet success/error
//   "error"        — .price-block.price-error; hasTryAgain says whether btn exists
//   "reveal-active"— Reveal Price button is in the DOM and enabled (click missed)
//   "unknown"      — none of the above (transitional)
//   "no-block"     — .price-block not in DOM at all
//
// isUpdating flag (set when state === "success"):
//   True when price-success is present but an "Updating…" inline text span is
//   visible — the price value has been set but the site is still refining it.
//   We still extract the current pv value (samples 10 & 15 confirm this is valid).
// ─────────────────────────────────────────────────────────────────────────────
async function readPageState(page) {
    return page.evaluate(() => {
        const block = document.querySelector(".price-block");
        if (!block) return { type: "no-block", classes: "", hasTryAgain: false, isUpdating: false };

        const classes    = block.className;
        const ariaBusy   = block.getAttribute("aria-busy");
        const hasSpinner = !!block.querySelector(".spinner");

        // Stable semantic state classes (ignore the dynamic pw-* suffix entirely)
        const hasSuccess = block.classList.contains("price-success");
        const hasError   = block.classList.contains("price-error");

        // Loading = spinner present OR aria-busy="true", and not yet success/error
        const isLoading  = !hasSuccess && !hasError && (ariaBusy === "true" || hasSpinner);

        // "Updating…" sub-state: price-success is set but the site is still
        // refining the value (pv element opacity ~0.45, "Updating…" span visible).
        // The pv value is still valid to read — we extract it and return it.
        let isUpdating = false;
        if (hasSuccess) {
            const spans = block.querySelectorAll("span");
            for (const s of spans) {
                // "Updating…" span has no class and no aria-hidden — it is visible
                if (/Updating/i.test(s.textContent) && !s.getAttribute("aria-hidden")) {
                    isUpdating = true;
                    break;
                }
            }
        }

        // "Try again" button inside the error block
        const tryAgainBtn = hasError ? block.querySelector("button.btn-primary") : null;
        const hasTryAgain = !!tryAgainBtn;

        // Reveal button — identified by aria-label (stable), not by class
        const revealBtn    = document.querySelector('button[aria-label="Reveal price"]');
        const revealActive = !!(revealBtn && !revealBtn.disabled);

        return {
            type: hasSuccess    ? "success"
                : hasError      ? "error"
                : isLoading     ? "loading"
                : revealActive  ? "reveal-active"
                :                 "unknown",
            classes,
            hasTryAgain,
            revealActive,
            isUpdating,
        };
    });
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

    // ── Fast-path: price already in success state (cached / SSR) ─────────────
    {
        const alreadySuccess = await page.evaluate(
            () => !!document.querySelector(".price-block.price-success")
        );
        if (alreadySuccess) {
            console.log(`⚡  [Product ${productId}] price-block already in success state — skipping hover+click`);
            const price = await extractPrice(page, productId);
            if (price !== null) {
                console.log(`🎯  [Product ${productId}] Price on fast-path → ₹${price}`);
                return { product_id: productId, price, timestamp: new Date().toISOString() };
            }
            console.warn(`⚠️   [Product ${productId}] Fast-path: success block present but price parse failed — continuing normally`);
        }
    }

    // ── Wait for .price-substatus (the hover-trigger text element) ───────────
    console.log(`🔎  [Product ${productId}] Waiting for .price-substatus to be visible...`);
    try {
        await page.waitForSelector(".price-substatus", { visible: true, timeout: 10000 });
    } catch (_) {
        throw new Error("'.price-substatus' never appeared — page likely failed to load properly");
    }
    console.log(`✅  [Product ${productId}] .price-substatus is visible`);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 1 — Hover loop: activate the Reveal Price button
    //
    // The Reveal Price button starts disabled.  Hovering over .price-substatus
    // triggers the site's JS to enable it.  We hover → wait 500ms → check.
    // On each miss we re-suppress the cookie overlay and try again (up to 8×).
    // ─────────────────────────────────────────────────────────────────────────
    const MAX_HOVER_ATTEMPTS = 8;
    let buttonActivated = false;

    console.log(`🖱️   [Product ${productId}] PHASE 1 — Hover loop (max ${MAX_HOVER_ATTEMPTS} attempts)...`);

    for (let ha = 1; ha <= MAX_HOVER_ATTEMPTS; ha++) {
        console.log(`     [Product ${productId}] Hover attempt ${ha}/${MAX_HOVER_ATTEMPTS} — suppressing cookie first...`);
        await hideCookieOverlay(page);

        const substatusEl = await page.$(".price-substatus");
        if (!substatusEl) {
            // Element gone — the block already transitioned to loading/success
            console.log(`❓  [Product ${productId}] .price-substatus disappeared — block may have transitioned already`);
            break;
        }

        const box = await substatusEl.boundingBox();
        if (!box) {
            console.log(`⚠️   [Product ${productId}] Bounding box unavailable — retrying in 300ms...`);
            await sleep(300);
            continue;
        }

        const cx = box.x + box.width  / 2;
        const cy = box.y + box.height / 2;
        console.log(`     [Product ${productId}] Moving mouse → (${Math.round(cx)}, ${Math.round(cy)})...`);
        await page.mouse.move(cx, cy, { steps: 10 });

        console.log(`     [Product ${productId}] Hovering — waiting 500ms for button to activate...`);
        await sleep(500);

        // Check button state using aria-label (stable), not class
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

    // ── Between-phase check: did price succeed during the hover phase? ────────
    {
        const successAfterHover = await page.evaluate(
            () => !!document.querySelector(".price-block.price-success")
        );
        if (successAfterHover) {
            console.log(`⚡  [Product ${productId}] price-success appeared during hover phase — extracting now!`);
            const price = await extractPrice(page, productId);
            if (price !== null) {
                console.log(`🎯  [Product ${productId}] Price extracted → ₹${price}`);
                return { product_id: productId, price, timestamp: new Date().toISOString() };
            }
            console.warn(`⚠️   [Product ${productId}] price-success during hover but parse failed — continuing to Phase 2`);
        }
    }

    if (!buttonActivated) {
        throw new Error(`Reveal button could not be activated after ${MAX_HOVER_ATTEMPTS} hover attempts`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2 — Click → checkpoint state machine
    //
    // Button is confirmed active.  Click it, wait 3s, then loop over
    // checkpoints reading the page state each round:
    //
    //   ① .price-block.price-success  → extract price → DONE ✅
    //      • "Updating…" sub-state: price IS readable — extract and return it
    //        (samples 10 & 15 confirm the interim value is the expected result)
    //   ② Loading (spinner / aria-busy)→ wait 3s → next checkpoint
    //   ③ .price-block.price-error    → click "Try again" → wait 3s
    //   ④ Reveal button still active  → click missed, re-click → wait 3s
    //   ⑤ None of the above          → wait 3s → next checkpoint
    //
    // All state detection uses stable semantic classes / attributes only.
    // ─────────────────────────────────────────────────────────────────────────
    const MAX_CLICK_ROUNDS = 15;

    console.log(`\n🖱️   [Product ${productId}] PHASE 2 — Initial click on Reveal Price button...`);
    await page.click('button[aria-label="Reveal price"]');
    console.log(`✅  [Product ${productId}] Reveal clicked! Waiting 3s before first checkpoint...`);
    await sleep(3000);

    console.log(`\n🔁  [Product ${productId}] Entering checkpoint loop (max ${MAX_CLICK_ROUNDS} rounds)...`);

    for (let round = 1; round <= MAX_CLICK_ROUNDS; round++) {
        console.log(`\n📍  [Product ${productId}] ── Checkpoint ${round}/${MAX_CLICK_ROUNDS} ──`);

        const state = await readPageState(page);

        const updatingTag = state.isUpdating ? " (Updating…)" : "";
        console.log(`📋  [Product ${productId}] State → "${state.type}"${updatingTag}  (classes: "${state.classes}")`);

        // ─── ① SUCCESS ───────────────────────────────────────────────────────
        if (state.type === "success") {
            if (state.isUpdating) {
                console.log(`⏳  [Product ${productId}] CP-1 — price-success + Updating… (price refining, extracting current value)`);
            } else {
                console.log(`🎉  [Product ${productId}] ✅ CP-1 — price-success! Extracting price...`);
            }

            const price = await extractPrice(page, productId);
            if (price !== null) {
                console.log(`🎯  [Product ${productId}] Price extracted → ₹${price}`);
                return { product_id: productId, price, timestamp: new Date().toISOString() };
            }

            // Success block present but pv element not readable — wait and retry once
            console.warn(`⚠️   [Product ${productId}] price-success present but pv element returned no price — waiting 2s and retrying once...`);
            await sleep(2000);
            const retryPrice = await extractPrice(page, productId);
            if (retryPrice !== null) {
                console.log(`🎯  [Product ${productId}] Price on retry → ₹${retryPrice}`);
                return { product_id: productId, price: retryPrice, timestamp: new Date().toISOString() };
            }

            throw new Error("price-success state reached but pv element returned no parseable price");
        }

        // ─── ② LOADING (spinner / aria-busy) ────────────────────────────────
        if (state.type === "loading") {
            console.log(`⏳  [Product ${productId}] CP-2 — Loading state (spinner/aria-busy). Waiting 3s...`);
            await sleep(3000);
            continue;
        }

        // ─── ③ ERROR — click "Try again" ─────────────────────────────────────
        if (state.type === "error") {
            if (state.hasTryAgain) {
                console.log(`🔄  [Product ${productId}] CP-3 — Error state! Clicking "Try again"...`);
                try {
                    await page.click(".price-block.price-error button.btn-primary");
                    console.log(`✅  [Product ${productId}] "Try again" clicked — waiting 3s...`);
                } catch (e) {
                    console.warn(`⚠️   [Product ${productId}] "Try again" click threw: ${e.message} — waiting anyway...`);
                }
            } else {
                console.warn(`⚠️   [Product ${productId}] CP-3 — Error state but no "Try again" button found — waiting 3s...`);
            }
            await sleep(3000);
            continue;
        }

        // ─── ④ REVEAL BUTTON STILL ACTIVE (click didn't register) ────────────
        if (state.type === "reveal-active") {
            console.log(`🖱️   [Product ${productId}] CP-4 — Reveal button still active (click missed?). Re-clicking...`);
            try {
                await page.click('button[aria-label="Reveal price"]');
                console.log(`✅  [Product ${productId}] Re-clicked Reveal — waiting 3s...`);
            } catch (e) {
                console.warn(`⚠️   [Product ${productId}] Re-click threw: ${e.message} — waiting anyway...`);
            }
            await sleep(3000);
            continue;
        }

        // ─── ⑤ UNKNOWN / TRANSITIONAL — just wait ────────────────────────────
        console.log(`❓  [Product ${productId}] CP-5 — Unknown/transitional state ("${state.type}"). Waiting 3s...`);
        await sleep(3000);
    }

    throw new Error(`Price never reached success state after ${MAX_CLICK_ROUNDS} checkpoint rounds (≈${MAX_CLICK_ROUNDS * 3}s total)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-product wrapper — opens a fresh tab per attempt, retries up to MAX_RETRIES
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
            console.log(`\n✨  [Product ${productId}] SUCCESS — price: ₹${data.price} | scraped at ${data.timestamp}`);
            return data;

        } catch (error) {
            console.warn(`\n⚠️   [Product ${productId}] Attempt ${attempt}/${MAX_RETRIES} FAILED`);
            console.warn(`     Reason: ${error.message}`);
            lastError = error;

            // Dump full product HTML BEFORE closing the tab — crucial for debugging
            await dumpDebugHtml(page, productId, `attempt ${attempt} failure`);

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
        product_id : productId,
        price      : null,
        timestamp  : new Date().toISOString(),
        error      : lastError ? lastError.message : "Scrape failed",
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
        headless: true,
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
