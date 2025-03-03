export const browsers = {
  chrome: {
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome-stable",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--single-process",
      "--headless=new",
      "--disable-gpu",
      "--remote-debugging-port=9222",
    ],
  },
};

// For CommonJS compatibility
export default { browsers };
