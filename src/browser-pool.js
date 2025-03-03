import puppeteerCluster from "puppeteer-cluster";
import { browsers as config } from "./config.js";
const { Cluster } = puppeteerCluster;

export const createBrowserPool = async () => {
  try {
    // Get browser configuration
    const browserType = process.env.BROWSER_TYPE || "chrome";
    const browserConfig = {
      ...config.browsers[browserType],
      // Ensure Chrome path is properly set
      executablePath:
        process.env.CHROME_PATH || config.browsers[browserType].executablePath,
    };

    // Validate configuration
    if (!browserConfig.executablePath) {
      throw new Error(`Chrome executable path not found for ${browserType}`);
    }

    const cluster = await Cluster.launch({
      concurrency: Cluster.CONCURRENCY_BROWSER,
      maxConcurrency: parseInt(process.env.MAX_BROWSERS) || 5,
      puppeteerOptions: {
        ...config.browsers.chrome,
        headless: "new",
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        // Use new headless mode
        args: [
          ...browserConfig.args,
          "--disable-features=site-per-process", // Important for WhatsApp Web
          "--disable-web-security", // Handle CORS if needed
          "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ],
      },
      workerCreationDelay: 5000,
      retryLimit: 3, // Increased retry attempts
      timeout: 60000, // Longer timeout for WhatsApp initialization
      monitor: process.env.NODE_ENV === "development", // Enable monitoring in dev
    });

    // Cluster event handlers
    cluster.on("taskerror", (err, data) => {
      console.error(`Task error in browser instance: ${err.message}`);
    });

    console.log(
      `Browser pool initialized with ${
        process.env.MAX_BROWSERS || 5
      } ${browserType} instances`
    );
    return cluster;
  } catch (error) {
    console.error("Failed to create browser pool:", error.message);
    throw new Error(`Browser pool initialization failed: ${error.message}`);
  }
};
