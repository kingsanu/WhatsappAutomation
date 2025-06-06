// Load environment variables from .env file
require("dotenv").config();

// setup global const
const sessionFolderPath = process.env.SESSIONS_PATH || "./sessions";
const enableLocalCallbackExample =
  (process.env.ENABLE_LOCAL_CALLBACK_EXAMPLE || "").toLowerCase() === "true";
const globalApiKey = process.env.API_KEY;
const baseWebhookURL = process.env.BASE_WEBHOOK_URL;
const maxAttachmentSize = parseInt(process.env.MAX_ATTACHMENT_SIZE) || 10000000;
const setMessagesAsSeen =
  (process.env.SET_MESSAGES_AS_SEEN || "").toLowerCase() === "true";
const disabledCallbacks = process.env.DISABLED_CALLBACKS
  ? process.env.DISABLED_CALLBACKS.split("|")
  : [];
const enableSwaggerEndpoint =
  (process.env.ENABLE_SWAGGER_ENDPOINT || "").toLowerCase() === "true";
const webVersion = process.env.WEB_VERSION;
const webVersionCacheType = process.env.WEB_VERSION_CACHE_TYPE || "none";
const rateLimitMax = process.env.RATE_LIMIT_MAX || 1000;
const rateLimitWindowMs = process.env.RATE_LIMIT_WINDOW_MS || 1000;
const recoverSessions =
  (process.env.RECOVER_SESSIONS || "").toLowerCase() === "true";

// Session health monitoring configuration
const sessionHealthCheckInterval =
  parseInt(process.env.SESSION_HEALTH_CHECK_INTERVAL) || 30000; // 30 seconds
const maxSessionRetries = parseInt(process.env.MAX_SESSION_RETRIES) || 3;
const sessionRetryDelay = parseInt(process.env.SESSION_RETRY_DELAY) || 5000; // 5 seconds
const sessionTimeout = parseInt(process.env.SESSION_TIMEOUT) || 300000; // 5 minutes
const maxConcurrentSessions =
  parseInt(process.env.MAX_CONCURRENT_SESSIONS) || 10;
const enableSessionPersistence =
  (process.env.ENABLE_SESSION_PERSISTENCE || "true").toLowerCase() === "true";
const sessionMetadataPath =
  process.env.SESSION_METADATA_PATH || "./sessions/metadata";

module.exports = {
  sessionFolderPath,
  enableLocalCallbackExample,
  globalApiKey,
  baseWebhookURL,
  maxAttachmentSize,
  setMessagesAsSeen,
  disabledCallbacks,
  enableSwaggerEndpoint,
  webVersion,
  webVersionCacheType,
  rateLimitMax,
  rateLimitWindowMs,
  recoverSessions,
  sessionHealthCheckInterval,
  maxSessionRetries,
  sessionRetryDelay,
  sessionTimeout,
  maxConcurrentSessions,
  enableSessionPersistence,
  sessionMetadataPath,
};
