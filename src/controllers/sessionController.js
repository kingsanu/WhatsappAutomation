const qr = require("qr-image");
const {
  setupSession,
  deleteSession,
  reloadSession,
  validateSession,
  flushSessions,
  sessions,
  getSessionStats: getSessionStatsFromSessions,
  getAllSessionsMetadata,
  recoverSession: recoverSessionFromSessions,
} = require("../sessions");
const { sendErrorResponse, waitForNestedObject } = require("../utils");

/**
 * Starts a session for the given session ID.
 *
 * @function
 * @async
 * @param {Object} req - The HTTP request object.
 * @param {Object} res - The HTTP response object.
 * @param {string} req.params.sessionId - The session ID to start.
 * @returns {Promise<void>}
 * @throws {Error} If there was an error starting the session.
 */
const startSession = async (req, res) => {
  // #swagger.summary = 'Start new session'
  // #swagger.description = 'Starts a session for the given session ID.'
  try {
    const sessionId = req.params.sessionId;
    const setupSessionReturn = await setupSession(sessionId);
    if (!setupSessionReturn.success) {
      /* #swagger.responses[422] = {
        description: "Unprocessable Entity.",
        content: {
          "application/json": {
            schema: { "$ref": "#/definitions/ErrorResponse" }
          }
        }
      }
      */
      sendErrorResponse(res, 422, setupSessionReturn.message);
      return;
    }
    /* #swagger.responses[200] = {
      description: "Status of the initiated session.",
      content: {
        "application/json": {
          schema: { "$ref": "#/definitions/StartSessionResponse" }
        }
      }
    }
    */
    // wait until the client is created
    waitForNestedObject(setupSessionReturn.client, "pupPage")
      .then(res.json({ success: true, message: setupSessionReturn.message }))
      .catch((err) => {
        sendErrorResponse(res, 500, err.message);
      });
  } catch (error) {
    /* #swagger.responses[500] = {
      description: "Server Failure.",
      content: {
        "application/json": {
          schema: { "$ref": "#/definitions/ErrorResponse" }
        }
      }
    }
    */
    console.log("startSession ERROR", error);
    sendErrorResponse(res, 500, error.message);
  }
};

/**
 * Status of the session with the given session ID.
 *
 * @function
 * @async
 * @param {Object} req - The HTTP request object.
 * @param {Object} res - The HTTP response object.
 * @param {string} req.params.sessionId - The session ID to start.
 * @returns {Promise<void>}
 * @throws {Error} If there was an error getting status of the session.
 */
const statusSession = async (req, res) => {
  // #swagger.summary = 'Get session status'
  // #swagger.description = 'Status of the session with the given session ID.'
  try {
    const sessionId = req.params.sessionId;
    const sessionData = await validateSession(sessionId);
    /* #swagger.responses[200] = {
      description: "Status of the session.",
      content: {
        "application/json": {
          schema: { "$ref": "#/definitions/StatusSessionResponse" }
        }
      }
    }
    */
    res.json(sessionData);
  } catch (error) {
    console.log("statusSession ERROR", error);
    /* #swagger.responses[500] = {
      description: "Server Failure.",
      content: {
        "application/json": {
          schema: { "$ref": "#/definitions/ErrorResponse" }
        }
      }
    }
    */
    sendErrorResponse(res, 500, error.message);
  }
};

/**
 * QR code of the session with the given session ID.
 *
 * @function
 * @async
 * @param {Object} req - The HTTP request object.
 * @param {Object} res - The HTTP response object.
 * @param {string} req.params.sessionId - The session ID to start.
 * @returns {Promise<void>}
 * @throws {Error} If there was an error getting status of the session.
 */
const sessionQrCode = async (req, res) => {
  // #swagger.summary = 'Get session QR code'
  // #swagger.description = 'QR code of the session with the given session ID.'
  try {
    const sessionId = req.params.sessionId;
    let session = sessions.get(sessionId);

    // If session doesn't exist, create it
    if (!session) {
      const setupSessionReturn = await setupSession(sessionId);
      if (!setupSessionReturn.success) {
        return sendErrorResponse(res, 422, setupSessionReturn.message);
      }
      session = setupSessionReturn.client;
    }

    // Check session state first
    const validation = await validateSession(sessionId);
    if (validation.success && validation.state === "CONNECTED") {
      return res.json({
        success: false,
        message: "Session is already authenticated. QR code not needed.",
        state: "CONNECTED",
      });
    }

    // Wait for QR code with timeout
    const maxWaitTime = 60000; // 1 minute
    const startTime = Date.now();
    const checkInterval = 1000; // Check every second

    while (Date.now() - startTime < maxWaitTime) {
      if (session.qr) {
        return res.json({
          success: true,
          qr: session.qr,
          message: "QR code ready for scanning",
        });
      }

      // Check if session became ready (authenticated)
      try {
        const currentState = await session.getState();
        if (currentState === "CONNECTED") {
          return res.json({
            success: false,
            message: "Session authenticated while waiting for QR",
            state: "CONNECTED",
          });
        }
      } catch (error) {
        // Session might not be ready yet, continue waiting
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    // Timeout reached
    return res.json({
      success: false,
      message: "QR code generation timeout. Try restarting the session.",
      suggestion: `Try calling /session/restart/${sessionId} and then request QR again`,
    });
  } catch (error) {
    console.log("sessionQrCode ERROR", error);
    sendErrorResponse(res, 500, error.message);
  }
};

/**
 * QR code as image of the session with the given session ID.
 *
 * @function
 * @async
 * @param {Object} req - The HTTP request object.
 * @param {Object} res - The HTTP response object.
 * @param {string} req.params.sessionId - The session ID to start.
 * @returns {Promise<void>}
 * @throws {Error} If there was an error getting status of the session.
 */
const sessionQrCodeImage = async (req, res) => {
  // #swagger.summary = 'Get session QR code as image'
  // #swagger.description = 'QR code as image of the session with the given session ID.'
  try {
    const sessionId = req.params.sessionId;
    let session = sessions.get(sessionId);

    // If session doesn't exist, create it
    if (!session) {
      const setupSessionReturn = await setupSession(sessionId);
      if (!setupSessionReturn.success) {
        return sendErrorResponse(res, 422, setupSessionReturn.message);
      }
      session = setupSessionReturn.client;
    }

    // Check session state first
    const validation = await validateSession(sessionId);
    if (validation.success && validation.state === "CONNECTED") {
      return res.json({
        success: false,
        message: "Session is already authenticated. QR code not needed.",
        state: "CONNECTED",
      });
    }

    // Wait for QR code with timeout
    const maxWaitTime = 120000; // 2 minutes for image endpoint
    const startTime = Date.now();
    const checkInterval = 1000; // Check every second

    while (Date.now() - startTime < maxWaitTime) {
      if (session.qr) {
        try {
          const qrImage = qr.image(session.qr, { size: 10 });
          res.writeHead(200, {
            "Content-Type": "image/png",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            Pragma: "no-cache",
            Expires: "0",
          });
          return qrImage.pipe(res);
        } catch (qrError) {
          console.log("QR image generation error:", qrError);
          return res.json({
            success: false,
            message: "Failed to generate QR image",
            qr: session.qr, // Return raw QR for manual processing
          });
        }
      }

      // Check if session became ready (authenticated)
      try {
        const currentState = await session.getState();
        if (currentState === "CONNECTED") {
          return res.json({
            success: false,
            message: "Session authenticated while waiting for QR",
            state: "CONNECTED",
          });
        }
      } catch (error) {
        // Session might not be ready yet, continue waiting
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    // Timeout reached - provide helpful response
    return res.json({
      success: false,
      message: "QR code generation timeout. Session may need restart.",
      suggestion: `Try calling /session/restart/${sessionId} and then request QR again`,
      troubleshooting: {
        step1: "Check if WhatsApp Web is accessible",
        step2: "Verify browser/Chrome is working properly",
        step3: "Try restarting the session",
        step4: "Check server logs for initialization errors",
      },
    });
  } catch (error) {
    console.log("sessionQrCodeImage ERROR", error);
    sendErrorResponse(res, 500, error.message);
  }
};

/**
 * Restarts the session with the given session ID.
 *
 * @function
 * @async
 * @param {Object} req - The HTTP request object.
 * @param {Object} res - The HTTP response object.
 * @param {string} req.params.sessionId - The session ID to terminate.
 * @returns {Promise<void>}
 * @throws {Error} If there was an error terminating the session.
 */
const restartSession = async (req, res) => {
  // #swagger.summary = 'Restart session'
  // #swagger.description = 'Restarts the session with the given session ID.'
  try {
    const sessionId = req.params.sessionId;
    const validation = await validateSession(sessionId);
    if (validation.message === "session_not_found") {
      return res.json(validation);
    }
    await reloadSession(sessionId);
    /* #swagger.responses[200] = {
      description: "Sessions restarted.",
      content: {
        "application/json": {
          schema: { "$ref": "#/definitions/RestartSessionResponse" }
        }
      }
    }
    */
    res.json({ success: true, message: "Restarted successfully" });
  } catch (error) {
    /* #swagger.responses[500] = {
      description: "Server Failure.",
      content: {
        "application/json": {
          schema: { "$ref": "#/definitions/ErrorResponse" }
        }
      }
    }
    */
    console.log("restartSession ERROR", error);
    sendErrorResponse(res, 500, error.message);
  }
};

/**
 * Terminates the session with the given session ID.
 *
 * @function
 * @async
 * @param {Object} req - The HTTP request object.
 * @param {Object} res - The HTTP response object.
 * @param {string} req.params.sessionId - The session ID to terminate.
 * @returns {Promise<void>}
 * @throws {Error} If there was an error terminating the session.
 */
const terminateSession = async (req, res) => {
  // #swagger.summary = 'Terminate session'
  // #swagger.description = 'Terminates the session with the given session ID.'
  try {
    const sessionId = req.params.sessionId;
    const validation = await validateSession(sessionId);
    if (validation.message === "session_not_found") {
      return res.json(validation);
    }
    await deleteSession(sessionId, validation);
    /* #swagger.responses[200] = {
      description: "Sessions terminated.",
      content: {
        "application/json": {
          schema: { "$ref": "#/definitions/TerminateSessionResponse" }
        }
      }
    }
    */
    res.json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    /* #swagger.responses[500] = {
      description: "Server Failure.",
      content: {
        "application/json": {
          schema: { "$ref": "#/definitions/ErrorResponse" }
        }
      }
    }
    */
    console.log("terminateSession ERROR", error);
    sendErrorResponse(res, 500, error.message);
  }
};

/**
 * Terminates all inactive sessions.
 *
 * @function
 * @async
 * @param {Object} req - The HTTP request object.
 * @param {Object} res - The HTTP response object.
 * @returns {Promise<void>}
 * @throws {Error} If there was an error terminating the sessions.
 */
const terminateInactiveSessions = async (req, res) => {
  // #swagger.summary = 'Terminate inactive sessions'
  // #swagger.description = 'Terminates all inactive sessions.'
  try {
    await flushSessions(true);
    /* #swagger.responses[200] = {
      description: "Sessions terminated.",
      content: {
        "application/json": {
          schema: { "$ref": "#/definitions/TerminateSessionsResponse" }
        }
      }
    }
    */
    res.json({ success: true, message: "Flush completed successfully" });
  } catch (error) {
    /* #swagger.responses[500] = {
      description: "Server Failure.",
      content: {
        "application/json": {
          schema: { "$ref": "#/definitions/ErrorResponse" }
        }
      }
    }
    */
    console.log("terminateInactiveSessions ERROR", error);
    sendErrorResponse(res, 500, error.message);
  }
};

/**
 * Terminates all sessions.
 *
 * @function
 * @async
 * @param {Object} req - The HTTP request object.
 * @param {Object} res - The HTTP response object.
 * @returns {Promise<void>}
 * @throws {Error} If there was an error terminating the sessions.
 */
const terminateAllSessions = async (req, res) => {
  // #swagger.summary = 'Terminate all sessions'
  // #swagger.description = 'Terminates all sessions.'
  try {
    await flushSessions(false);
    /* #swagger.responses[200] = {
      description: "Sessions terminated.",
      content: {
        "application/json": {
          schema: { "$ref": "#/definitions/TerminateSessionsResponse" }
        }
      }
    }
    */
    res.json({ success: true, message: "Flush completed successfully" });
  } catch (error) {
    /* #swagger.responses[500] = {
      description: "Server Failure.",
      content: {
        "application/json": {
          schema: { "$ref": "#/definitions/ErrorResponse" }
        }
      }
    }
    */
    console.log("terminateAllSessions ERROR", error);
    sendErrorResponse(res, 500, error.message);
  }
};

/**
 * Get session statistics and health information
 */
const getSessionStats = async (req, res) => {
  try {
    const stats = await getSessionStatsFromSessions();
    res.json({ success: true, stats });
  } catch (error) {
    console.log("getSessionStats ERROR", error);
    sendErrorResponse(res, 500, error.message);
  }
};

/**
 * Get all sessions metadata
 */
const getAllSessions = async (req, res) => {
  try {
    const sessionsData = await getAllSessionsMetadata();
    res.json({ success: true, sessions: sessionsData });
  } catch (error) {
    console.log("getAllSessions ERROR", error);
    sendErrorResponse(res, 500, error.message);
  }
};

/**
 * Manually recover a specific session
 */
const recoverSessionEndpoint = async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const result = await recoverSessionFromSessions(sessionId);

    if (result) {
      res.json({ success: true, message: "Session recovery initiated" });
    } else {
      res.json({
        success: false,
        message: "Failed to initiate session recovery",
      });
    }
  } catch (error) {
    console.log("recoverSession ERROR", error);
    sendErrorResponse(res, 500, error.message);
  }
};

/**
 * Force QR code regeneration for a session
 */
const forceQrRegeneration = async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const session = sessions.get(sessionId);

    if (!session) {
      return sendErrorResponse(res, 404, "Session not found");
    }

    // Check if session is already connected
    const validation = await validateSession(sessionId);
    if (validation.success && validation.state === "CONNECTED") {
      return res.json({
        success: false,
        message:
          "Session is already authenticated. QR regeneration not needed.",
        state: "CONNECTED",
      });
    }

    try {
      // Clear existing QR
      session.qr = null;

      // Force a new QR by restarting the authentication process
      await session.destroy();
      sessions.delete(sessionId);

      // Create new session
      const setupResult = await setupSession(sessionId);
      if (!setupResult.success) {
        return sendErrorResponse(res, 500, setupResult.message);
      }

      res.json({
        success: true,
        message:
          "QR regeneration initiated. Please wait and request QR code again.",
        suggestion: `Wait 5-10 seconds, then call /session/qr/${sessionId} to get the new QR code`,
      });
    } catch (error) {
      console.log("Force QR regeneration error:", error);
      sendErrorResponse(res, 500, "Failed to regenerate QR code");
    }
  } catch (error) {
    console.log("forceQrRegeneration ERROR", error);
    sendErrorResponse(res, 500, error.message);
  }
};

module.exports = {
  startSession,
  statusSession,
  sessionQrCode,
  sessionQrCodeImage,
  restartSession,
  terminateSession,
  terminateInactiveSessions,
  terminateAllSessions,
  getSessionStats,
  getAllSessions,
  recoverSessionEndpoint,
  forceQrRegeneration,
};
