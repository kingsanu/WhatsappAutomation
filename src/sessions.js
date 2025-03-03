import pg from "pg";
import { createClient } from "redis";

const { Pool } = pg;

// Redis connection
const redisClient = createClient({
  url: process.env.REDIS_URL,
});

// Connect to Redis with retries
const connectRedis = async () => {
  try {
    await redisClient.connect();
    console.log("Connected to Redis");
  } catch (err) {
    console.error("Redis connection failed:", err);
    setTimeout(connectRedis, 5000); // Retry every 5s
  }
};

// Initialize connection
connectRedis();

// PostgreSQL pool
const pgPool = new Pool({
  connectionString: process.env.POSTGRES_URL,
});

export default {
  store: async (sessionId, data) => {
    try {
      await redisClient.setEx(
        sessionId,
        process.env.SESSION_TIMEOUT,
        JSON.stringify(data)
      );
      await pgPool.query(
        `
        INSERT INTO sessions (session_id, data)
        VALUES ($1, $2)
        ON CONFLICT (session_id) DO UPDATE
        SET data = $2, updated_at = NOW()
      `,
        [sessionId, data]
      );
    } catch (err) {
      console.error("Session store error:", err);
    }
  },

  get: async (sessionId) => {
    try {
      const cached = await redisClient.get(sessionId);
      return (
        cached ||
        pgPool
          .query("SELECT data FROM sessions WHERE session_id = $1", [sessionId])
          .then((res) => res.rows[0]?.data)
      );
    } catch (err) {
      console.error("Session get error:", err);
      return null;
    }
  },
};
