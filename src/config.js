export const browsers = {
  chrome: {
    executablePath: process.env.CHROME_PATH || "/usr/bin/chromium-browser",
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
  firefox: {
    product: "firefox",
    args: ["-headless"],
  },
};
