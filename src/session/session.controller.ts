import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  HttpException,
  HttpStatus,
  Res,
  Logger,
  Body,
  Put,
} from "@nestjs/common";
import { Response } from "express";
import { WhatsAppService } from "../services/whatsapp.service";
import { SessionHealthService } from "../services/session-health.service";
import { SessionPolicyService } from "../services/session-policy.service";
import { SessionBackupService } from "../services/session-backup.service";
import { PersistentAuthStateService } from "../services/persistent-auth-state.service";
import { PersistencePolicy } from "../schemas/auth-state.schema";

@Controller("session")
export class SessionController {
  private readonly logger = new Logger(SessionController.name);

  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly sessionHealthService: SessionHealthService,
    private readonly sessionPolicyService: SessionPolicyService,
    private readonly sessionBackupService: SessionBackupService,
    private readonly persistentAuthStateService: PersistentAuthStateService
  ) {}

  @Get("qr/:username/image")
  async getQRCode(@Param("username") username: string, @Res() res: Response) {
    try {
      // First check if session is already connected
      const status = await this.whatsappService.getSessionStatus(username);

      if (status.connected) {
        return res.status(200).json({
          success: true,
          message: "Session already connected. No QR code needed.",
          connected: true,
          data: {
            user: status.user,
            connectionStatus: status.connectionStatus,
          },
        });
      }

      // Session persistence: Do not clear sessions based on age
      // Sessions should persist indefinitely unless manually removed
      const sessionInfo = this.whatsappService.getSessionInfo(username);
      if (sessionInfo) {
        this.logger.log(
          `Existing session found for ${username}, preserving for persistence`
        );
      }

      let qrCode: string;

      try {
        qrCode = await this.whatsappService.getQRCode(username);
      } catch (error) {
        // If QR code doesn't exist, create a new session
        try {
          qrCode = await this.whatsappService.createSession(username);
        } catch (sessionError) {
          if (
            sessionError.message.includes(
              "Session already exists and is connected"
            )
          ) {
            // If session exists and is connected, return JSON response
            return res.status(200).json({
              success: true,
              message: "Session already connected. No QR code needed.",
              connected: true,
            });
          }
          throw sessionError;
        }
      }

      // Convert data URL to buffer and send as image
      const base64Data = qrCode.replace(/^data:image\/png;base64,/, "");
      const imageBuffer = Buffer.from(base64Data, "base64");

      res.set({
        "Content-Type": "image/png",
        "Content-Length": imageBuffer.length.toString(),
      });

      res.send(imageBuffer);
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to generate QR code",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Delete("terminate/:username")
  async terminateSession(@Param("username") username: string) {
    try {
      await this.whatsappService.terminateSession(username);
      return {
        success: true,
        message: `Session terminated for user ${username}`,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to terminate session",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get("status/:username")
  async getSessionStatus(@Param("username") username: string) {
    try {
      // Enhanced status check - behaves like sendMessage by actually trying to activate
      // This gives you the real connection status, not just stored data
      const status =
        await this.whatsappService.getActiveSessionStatus(username);
      return {
        success: true,
        data: status,
        message: status.connected
          ? "Session is active and ready for messaging"
          : status.realConnectionStatus === "requires_qr"
            ? "Session requires QR code scan"
            : "Session could not be activated",
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to get session status",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Delete("clear/:username")
  async clearSession(@Param("username") username: string) {
    try {
      const sessionInfo = this.whatsappService.getSessionInfo(username);
      if (sessionInfo) {
        await this.whatsappService.clearUserSession(username);
        return {
          success: true,
          message: `Session cleared for user ${username} (auth state preserved)`,
        };
      } else {
        return {
          success: true,
          message: `No active session found for user ${username}`,
        };
      }
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to clear session",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get("start/:username")
  async startSession(@Param("username") username: string) {
    // Optionally kick off session activation in background
    this.whatsappService.activateSession(username).catch(() => {});
    return {
      success: true,
      message: `Session start requested for user ${username}`,
    };
  }

  @Get("validate/:username")
  async validateConnection(@Param("username") username: string) {
    try {
      const result =
        await this.whatsappService.forceValidateConnection(username);
      return {
        success: true,
        data: result,
        message: `Connection validation completed for user ${username}`,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to validate connection",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Delete("clear-all")
  async clearAllSessions() {
    try {
      await this.whatsappService.clearAllSessions();
      return {
        success: true,
        message: "All sessions cleared successfully",
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to clear sessions",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Delete("clear-conflicts")
  async clearConflictedSessions() {
    try {
      await this.whatsappService.clearConflictedSessions();
      return {
        success: true,
        message: "Conflicted sessions cleared successfully",
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to clear conflicted sessions",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Put("persistence/:username")
  async setSessionPersistence(
    @Param("username") username: string,
    @Body() body: { policy?: PersistencePolicy; autoReconnect?: boolean }
  ) {
    try {
      const { policy = PersistencePolicy.PERMANENT, autoReconnect = true } =
        body;

      await this.whatsappService.setSessionPersistence(
        username,
        policy,
        autoReconnect
      );

      return {
        success: true,
        message: `Session persistence policy set to ${policy} for user ${username}`,
        data: {
          policy,
          autoReconnect,
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to set session persistence",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post("migrate-to-permanent")
  async migrateAllSessionsToPermanent() {
    try {
      await this.whatsappService.migrateAllSessionsToPermanent();
      return {
        success: true,
        message: "All sessions migrated to permanent persistence successfully",
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to migrate sessions",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get("detailed/:username")
  async getDetailedSessionInfo(@Param("username") username: string) {
    try {
      const sessionInfo =
        await this.whatsappService.getDetailedSessionInfo(username);
      return {
        success: true,
        data: sessionInfo,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to get detailed session info",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get("system-stats")
  async getSystemStats() {
    try {
      const stats = await this.whatsappService.getSystemStats();
      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to get system stats",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get("health/system")
  async getSystemHealth() {
    try {
      const health = await this.sessionHealthService.getCurrentSystemHealth();
      return {
        success: true,
        data: health,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to get system health",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get("health/:username")
  async getUserHealth(@Param("username") username: string) {
    try {
      const health = await this.sessionHealthService.getUserHealth(username);
      return {
        success: true,
        data: health,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to get user health",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get("policies")
  async getPolicyRules() {
    try {
      const rules = this.sessionPolicyService.getPolicyRules();
      const stats = this.sessionPolicyService.getPolicyStats();
      return {
        success: true,
        data: {
          rules,
          stats,
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to get policy rules",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Put("policies/:ruleId/enable")
  async enablePolicyRule(@Param("ruleId") ruleId: string) {
    try {
      const success = this.sessionPolicyService.enableRule(ruleId);
      if (!success) {
        throw new HttpException(
          {
            status: HttpStatus.NOT_FOUND,
            error: "Policy rule not found",
            message: `Rule with ID ${ruleId} not found`,
          },
          HttpStatus.NOT_FOUND
        );
      }
      return {
        success: true,
        message: `Policy rule ${ruleId} enabled successfully`,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to enable policy rule",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Put("policies/:ruleId/disable")
  async disablePolicyRule(@Param("ruleId") ruleId: string) {
    try {
      const success = this.sessionPolicyService.disableRule(ruleId);
      if (!success) {
        throw new HttpException(
          {
            status: HttpStatus.NOT_FOUND,
            error: "Policy rule not found",
            message: `Rule with ID ${ruleId} not found`,
          },
          HttpStatus.NOT_FOUND
        );
      }
      return {
        success: true,
        message: `Policy rule ${ruleId} disabled successfully`,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to disable policy rule",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post("policies/execute")
  async executePolicies() {
    try {
      await this.sessionPolicyService.forceExecutePolicies();
      return {
        success: true,
        message: "Session policies executed successfully",
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to execute policies",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get("backups")
  async getBackupHistory() {
    try {
      const history = this.sessionBackupService.getBackupHistory();
      const stats = this.sessionBackupService.getBackupStats();
      return {
        success: true,
        data: {
          history,
          stats,
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to get backup history",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post("backups/create")
  async createBackup(@Body() body: { type?: "full" | "incremental" } = {}) {
    try {
      const { type = "full" } = body;
      const backup = await this.sessionBackupService.forceBackup();
      return {
        success: true,
        message: `${type} backup created successfully`,
        data: backup,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to create backup",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get("backups/:backupId")
  async getBackupInfo(@Param("backupId") backupId: string) {
    try {
      const info = await this.sessionBackupService.getBackupInfo(backupId);
      return {
        success: true,
        data: info,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to get backup info",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post("backups/:backupId/restore")
  async restoreFromBackup(
    @Param("backupId") backupId: string,
    @Body()
    body: {
      overwriteExisting?: boolean;
      onlyMissingSessions?: boolean;
      dryRun?: boolean;
    } = {}
  ) {
    try {
      const result = await this.sessionBackupService.restoreFromBackup(
        backupId,
        body
      );
      return {
        success: true,
        message: `Backup restore ${body.dryRun ? "simulation" : "operation"} completed`,
        data: result,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to restore from backup",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get("conflicts")
  async getConflictedSessions() {
    try {
      const conflicts = await this.whatsappService.getConflictedSessions();
      return {
        success: true,
        data: conflicts,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to get conflicted sessions",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post("conflicts/:username/resolve")
  async resolveSessionConflict(@Param("username") username: string) {
    try {
      const result =
        await this.whatsappService.resolveSessionConflict(username);
      return {
        success: true,
        message: `Session conflict resolved for ${username}`,
        data: result,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to resolve session conflict",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post("conflicts/:username/force-takeover")
  async forceSessionTakeover(
    @Param("username") username: string,
    @Body() body: { completeReset?: boolean } = {}
  ) {
    try {
      const { completeReset = false } = body;
      const result = await this.whatsappService.forceSessionTakeover(
        username,
        completeReset
      );
      return {
        success: true,
        message: `Session takeover completed for ${username}`,
        data: result,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to force session takeover",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Delete("conflicts/:username")
  async clearSessionConflict(@Param("username") username: string) {
    try {
      await this.whatsappService.clearSessionConflict(username);
      return {
        success: true,
        message: `Session conflict cleared for ${username}`,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to clear session conflict",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post("activate/:username")
  async activateExistingSession(@Param("username") username: string) {
    try {
      await this.whatsappService.activateSession(username);
      return {
        success: true,
        message: `Session activated for ${username} using existing auth data`,
        data: {
          username,
          message:
            "Session activated using stored credentials - no QR scan required",
          authPreserved: true,
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to activate session",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get("auth-status/:username")
  async getAuthStatus(@Param("username") username: string) {
    try {
      const hasAuth = await this.whatsappService.hasValidAuthState(username);
      const sessionInfo = this.whatsappService.getSessionInfo(username);

      return {
        success: true,
        data: {
          username,
          hasValidAuth: hasAuth,
          isActive: !!sessionInfo,
          isConnected: sessionInfo?.isConnected || false,
          canActivateWithoutQR: hasAuth,
          lastActivity: sessionInfo?.lastUsed,
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to get auth status",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get("serialization/stats")
  async getSerializationStats() {
    try {
      const stats =
        await this.persistentAuthStateService.getSerializationStats();
      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to get serialization stats",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get("serialization/metrics/:username")
  async getSerializationMetrics(@Param("username") username: string) {
    try {
      const metrics =
        this.persistentAuthStateService.getSerializationMetrics(username);
      return {
        success: true,
        data: metrics || { message: "No metrics available for this user" },
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to get serialization metrics",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get("serialization/validate/:username")
  async validateSerializationIntegrity(@Param("username") username: string) {
    try {
      const validation =
        await this.persistentAuthStateService.validateSerializationIntegrity(
          username
        );
      return {
        success: true,
        data: validation,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to validate serialization integrity",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post("serialization/force-save/:username")
  async forceSerializationSave(@Param("username") username: string) {
    try {
      await this.persistentAuthStateService.forceSave(username);
      return {
        success: true,
        message: `Serialization force saved for ${username}`,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: "Failed to force save serialization",
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}
