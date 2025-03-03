export const browsers = {
  chrome: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
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
