import "dotenv/config";
import express from "express";
import messageQueue from "./message-queue.js";
import { createSession } from "./session-manager.js";
import sessionHandler from "./sessions.js";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("WhatsApp Automation API is running!");
});

app.post("/create-session", async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const { qrCode, sessionId } = await createSession(userId);

    res.json({
      status: "success",
      qrCode,
      sessionId,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/send", async (req, res) => {
  try {
    const { sessionId, number, message } = req.body;

    if (!sessionId || !number || !message) {
      return res.status(400).json({
        error: "sessionId, number, and message are required",
      });
    }

    const job = await messageQueue.add(
      { sessionId, number, message },
      {
        attempts: 3,
        backoff: 60000,
      }
    );

    res.json({
      status: "queued",
      jobId: job.id,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/session-status/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionData = await sessionHandler.get(sessionId);

    if (!sessionData) {
      return res.status(404).json({ error: "Session not found" });
    }

    res.json({
      sessionId,
      status: sessionData ? "active" : "inactive",
      lastActive: sessionData?.lastActive,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    activeSessions: messageQueue.cluster?.getActiveCount() || 0,
  });
});

app.use((err, req, res, next) => {
  console.error("API Error:", err.stack);
  res.status(500).json({ error: "Internal server error" });
});

const startServer = async () => {
  try {
    await messageQueue.isReady();
    app.listen(process.env.PORT || 3000, () => {
      console.log(`Server running on port ${process.env.PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
