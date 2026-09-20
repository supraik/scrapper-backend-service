const cron = require("node-cron");
const { getProductIdsToFetch, saveProductData } = require("./db_interactions");
const { runScraperPipeline } = require("./scraper");

async function executeScheduledTask() {
    console.log(`\n⏰ [${new Date().toISOString()}] Starting hourly price scrape task...`);

    try {
        const productIds = await getProductIdsToFetch();
        console.log(`Found ${productIds.length} product IDs to process.`);

        const scrapedData = await runScraperPipeline(productIds);

        await saveProductData(scrapedData);

        console.log(`✅ Hourly scrape completed successfully.\n`);
    } catch (error) {
        console.error("❌ Error running hourly scrape task:", error);
    }
}

function startCron() {
    // Initial execution on boot
    executeScheduledTask();

    // Schedule cron job to run every 1 hour
    cron.schedule("0 * * * *", () => {
        executeScheduledTask();
    });

    console.log("🚀 Cron service initialized. Running every 1 hour.");
}

module.exports = { startCron };