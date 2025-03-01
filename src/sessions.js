import pg from "pg";
import redis from "redis";

const { Pool } = pg;

const pgPool = new Pool({ connectionString: process.env.POSTGRES_URL });
const redisClient = redis.createClient({ url: process.env.REDIS_URL });

export default {
  store: async (sessionId, data) => {
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
  },

  get: async (sessionId) => {
    const cached = await redisClient.get(sessionId);
    return (
      cached ||
      pgPool
        .query("SELECT data FROM sessions WHERE session_id = $1", [sessionId])
        .then((res) => res.rows[0]?.data)
    );
  },
};
