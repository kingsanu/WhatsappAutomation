import { createBrowserPool } from "./browser-pool.js";
import sessionHandler from "./sessions.js";
import Queue from "bull";

const messageQueue = new Queue("messages", process.env.REDIS_URL);

let cluster;
const initializeCluster = async () => {
  cluster = await createBrowserPool();
  return cluster;
};

messageQueue.process(10, async (job) => {
  try {
    if (!cluster) await initializeCluster();

    const { sessionId, number, message } = job.data;
    const client = await cluster.execute(async ({ page }) => {
      const sessionData = await sessionHandler.get(sessionId);
      return new Client({
        authStrategy: new LocalAuth({ clientId: sessionId }),
        puppeteer: { page },
        session: sessionData,
      });
    });

    await client.sendMessage(number, message);
    await sessionHandler.store(sessionId, client.session);
  } catch (error) {
    console.error(`Message failed: ${error.message}`);
    throw error;
  }
});

export default messageQueue;
