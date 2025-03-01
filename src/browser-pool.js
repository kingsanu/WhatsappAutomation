import puppeteerCluster from "puppeteer-cluster";
import { browsers as config } from "./config.js";
const { Cluster } = puppeteerCluster;

export const createBrowserPool = async () => {
  try {
    const cluster = await Cluster.launch({
      concurrency: Cluster.CONCURRENCY_BROWSER,
      maxConcurrency: parseInt(process.env.MAX_BROWSERS) || 5,
      puppeteerOptions: config.browsers[process.env.BROWSER_TYPE || "chrome"],
      workerCreationDelay: 5000,
      retryLimit: 2,
      timeout: 30000,
    });

    console.log(
      "Browser pool initialized with",
      process.env.MAX_BROWSERS,
      "instances"
    );
    return cluster;
  } catch (error) {
    console.error("Failed to create browser pool:", error);
    throw error;
  }
};
