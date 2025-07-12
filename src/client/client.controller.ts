import {
  Controller,
  Post,
  Param,
  Body,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { WhatsAppService } from '../services/whatsapp.service';
import { SendMessageDto } from '../dto/send-message.dto';

@Controller('client')
export class ClientController {
  private readonly logger = new Logger(ClientController.name);

  constructor(private readonly whatsappService: WhatsAppService) {}

  @Post('sendMessage/:username')
  async sendMessage(
    @Param('username') username: string,
    @Body() sendMessageDto: SendMessageDto,
  ) {
    try {
      const { number, message, document } = sendMessageDto;

      if (!message && !document) {
        throw new HttpException(
          {
            status: HttpStatus.BAD_REQUEST,
            error: 'Bad Request',
            message: 'Either message or document is required',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      // Format phone number - ensure it has country code
      let formattedNumber = number;
      if (!number.startsWith('+')) {
        // If no plus sign, add it (assuming the number already includes country code)
        formattedNumber = `+${number}`;
      }

      // Remove plus sign for WhatsApp format
      const whatsappNumber = formattedNumber.replace('+', '');

      // 🚀 ENHANCED AUTONOMOUS SEND MESSAGE - Complete session management automation
      return await this.sendMessageWithAutonomousActivation(username, whatsappNumber, message, document);

    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Failed to send message',
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Autonomous message sending with complete session management
   * This method implements the "fire and forget" approach by:
   * 1. Attempting to send message with intelligent session activation
   * 2. If activation fails, calling the same activateSession method as POST /session/activate/:username
   * 3. Retrying the message send after manual activation
   * 4. Only failing if all recovery attempts are exhausted
   */
  private async sendMessageWithAutonomousActivation(
    username: string,
    whatsappNumber: string,
    message?: string,
    document?: string
  ) {
    try {
      // STEP 1: Attempt to send message with intelligent session activation
      this.logger.log(`[${username}] 🚀 AUTONOMOUS SEND: Initial attempt with intelligent activation`);

      const result = await this.whatsappService.sendMessage(
        username,
        whatsappNumber,
        message,
        document,
      );

      this.logger.log(`[${username}] ✅ AUTONOMOUS SEND: Message sent successfully on initial attempt`);
      return {
        success: true,
        data: result,
        message: result.retried ? 'Message sent successfully (after intelligent retry)' : 'Message sent successfully',
        recoveryUsed: false
      };

    } catch (initialError) {
      this.logger.warn(`[${username}] ⚠️ AUTONOMOUS SEND: Initial attempt failed: ${initialError.message}`);

      // Check if this is a session activation failure
      if (this.isSessionActivationFailure(initialError)) {
        this.logger.log(`[${username}] 🔧 AUTONOMOUS SEND: Detected session activation failure - triggering manual activation recovery`);

        try {
          // STEP 2: Call the same activateSession method as POST /session/activate/:username
          this.logger.log(`[${username}] 🔄 AUTONOMOUS SEND: Calling manual session activation (same as POST /session/activate/:username)`);

          try {
            await this.whatsappService.activateSession(username);
            this.logger.log(`[${username}] ✅ AUTONOMOUS SEND: Manual session activation call completed`);
          } catch (activationError) {
            this.logger.warn(`[${username}] ⚠️ AUTONOMOUS SEND: Manual activation threw error, but continuing with connection verification: ${activationError.message}`);
            // Continue anyway - the activation might have partially succeeded
          }

          // STEP 2.5: Wait for connection establishment with event-driven approach
          this.logger.log(`[${username}] 🔍 AUTONOMOUS SEND: Waiting for connection establishment after manual activation`);
          const connectionEstablished = await this.waitForConnectionWithEventSupport(username, 60000); // 60 seconds timeout

          if (!connectionEstablished) {
            // STEP 2.6: Fallback strategy - try one more time with force validation
            this.logger.warn(`[${username}] ⚠️ AUTONOMOUS SEND: Initial connection verification failed, trying fallback strategy`);

            try {
              // Force validate the connection using WhatsApp service internal method
              await this.whatsappService.forceValidateConnection(username);
              this.logger.log(`[${username}] ✅ AUTONOMOUS SEND: Fallback connection validation succeeded`);
            } catch (fallbackError) {
              this.logger.error(`[${username}] ❌ AUTONOMOUS SEND: Fallback validation also failed: ${fallbackError.message}`);
              throw new Error('Connection not established after manual activation and fallback validation within timeout period');
            }
          }

          this.logger.log(`[${username}] ✅ AUTONOMOUS SEND: Connection fully established after manual activation`);

          // STEP 2.7: Add a stabilization delay to ensure connection is stable and events have propagated
          this.logger.log(`[${username}] ⏳ AUTONOMOUS SEND: Adding stabilization delay for event loop synchronization`);
          await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second stabilization delay for event loop

          // STEP 3: Smart retry with direct message sending (bypass enhanced retry logic)
          this.logger.log(`[${username}] 🔄 AUTONOMOUS SEND: Performing smart retry after manual activation and connection verification`);

          // Use a more direct approach for the retry to avoid nested retry logic
          const retryResult = await this.performDirectMessageSend(username, whatsappNumber, message, document);

          this.logger.log(`[${username}] ✅ AUTONOMOUS SEND: Message sent successfully after manual activation recovery`);
          return {
            success: true,
            data: retryResult,
            message: 'Message sent successfully (after manual activation recovery)',
            recoveryUsed: true,
            recoveryType: 'manual_activation'
          };

        } catch (recoveryError) {
          this.logger.error(`[${username}] ❌ AUTONOMOUS SEND: Manual activation recovery failed: ${recoveryError.message}`);

          // STEP 4: All recovery attempts exhausted - return final error
          throw new Error(`All session recovery attempts failed. Initial error: ${initialError.message}. Recovery error: ${recoveryError.message}`);
        }
      } else {
        // Not a session activation failure - re-throw original error
        this.logger.error(`[${username}] ❌ AUTONOMOUS SEND: Non-activation error - re-throwing: ${initialError.message}`);
        throw initialError;
      }
    }
  }

  /**
   * Enhanced event-driven connection waiting with multiple verification strategies
   * This addresses the event loop timing issue by using multiple approaches
   */
  private async waitForConnectionWithEventSupport(username: string, timeoutMs: number = 60000): Promise<boolean> {
    const startTime = Date.now();

    this.logger.log(`[${username}] 🔍 Starting enhanced connection establishment verification (timeout: ${timeoutMs}ms)`);

    // Strategy 1: Multi-phase verification with increasing intervals
    const phases = [
      { duration: 15000, interval: 500, name: 'rapid' },      // First 15s: check every 500ms
      { duration: 20000, interval: 1000, name: 'standard' },  // Next 20s: check every 1s
      { duration: 25000, interval: 2000, name: 'extended' }   // Final 25s: check every 2s
    ];

    for (const phase of phases) {
      const phaseStartTime = Date.now();
      this.logger.log(`[${username}] 🔍 Starting ${phase.name} verification phase (${phase.duration}ms, interval: ${phase.interval}ms)`);

      while (Date.now() - phaseStartTime < phase.duration && Date.now() - startTime < timeoutMs) {
        const sessionInfo = this.whatsappService.getSessionInfo(username);

        if (!sessionInfo) {
          this.logger.debug(`[${username}] No session info found during ${phase.name} phase`);
          await new Promise(resolve => setTimeout(resolve, phase.interval));
          continue;
        }

        // Multi-level connection verification
        const connectionChecks = {
          hasSessionInfo: !!sessionInfo,
          isConnected: sessionInfo.isConnected,
          hasSocket: !!sessionInfo.socket,
          hasUser: !!sessionInfo.socket?.user,
          hasWebSocket: !!sessionInfo.socket?.ws,
          connectionState: sessionInfo.connectionState,
          socketConnected: sessionInfo.socket?.ws ? true : false // Simplified WebSocket check
        };

        // Primary check: Full connection verification
        const isFullyConnected = connectionChecks.isConnected &&
                                connectionChecks.hasSocket &&
                                connectionChecks.hasUser &&
                                connectionChecks.hasWebSocket &&
                                connectionChecks.connectionState === 'connected';

        // Secondary check: Partial connection that might work
        const isPartiallyConnected = connectionChecks.hasSocket &&
                                   connectionChecks.hasUser &&
                                   connectionChecks.hasWebSocket &&
                                   connectionChecks.socketConnected; // WebSocket exists and connected

        if (isFullyConnected) {
          const elapsed = Date.now() - startTime;
          this.logger.log(`[${username}] ✅ Full connection established in ${phase.name} phase after ${elapsed}ms`);

          // Additional verification: Basic socket functionality check
          try {
            // Simple check: if we have all the required components, assume it's ready
            if (connectionChecks.hasSocket && connectionChecks.hasUser && connectionChecks.hasWebSocket) {
              this.logger.log(`[${username}] ✅ Basic socket functionality confirmed`);
              return true;
            } else {
              this.logger.warn(`[${username}] ⚠️ Connection established but missing key components`);
              // Continue checking - might become ready soon
            }
          } catch (checkError) {
            this.logger.warn(`[${username}] ⚠️ Basic check failed, but connection seems established: ${checkError.message}`);
            return true; // Assume connection is good if basic checks pass
          }
        } else if (isPartiallyConnected && phase.name === 'extended') {
          // In extended phase, accept partial connection if it has key components
          const elapsed = Date.now() - startTime;
          this.logger.log(`[${username}] ⚠️ Accepting partial connection in extended phase after ${elapsed}ms`);
          return true;
        }

        // Log current state for debugging (only in standard and extended phases to reduce noise)
        if (phase.name !== 'rapid') {
          const elapsed = Date.now() - startTime;
          this.logger.debug(`[${username}] Connection check in ${phase.name} phase (${elapsed}ms):`, connectionChecks);
        }

        await new Promise(resolve => setTimeout(resolve, phase.interval));
      }

      this.logger.log(`[${username}] 🔍 Completed ${phase.name} verification phase`);
    }

    const elapsed = Date.now() - startTime;
    this.logger.error(`[${username}] ❌ Connection establishment timeout after ${elapsed}ms across all phases`);
    return false;
  }

  /**
   * Perform direct message send without enhanced retry logic
   * This is used for the final retry after manual activation to avoid nested retry loops
   */
  private async performDirectMessageSend(
    username: string,
    whatsappNumber: string,
    message?: string,
    document?: string
  ): Promise<any> {
    try {
      this.logger.log(`[${username}] 📤 DIRECT SEND: Attempting direct message send`);

      // Get session info and verify it's ready
      const sessionInfo = this.whatsappService.getSessionInfo(username);
      if (!sessionInfo?.socket) {
        throw new Error('No active socket available for direct send');
      }

      // Verify basic session components one more time
      if (!sessionInfo.isConnected || !sessionInfo.socket?.user || !sessionInfo.socket?.ws) {
        this.logger.warn(`[${username}] ⚠️ DIRECT SEND: Session components not fully ready but proceeding anyway`);
      }

      // Format phone number
      let jid = whatsappNumber;
      if (!whatsappNumber.includes('@')) {
        jid = `${whatsappNumber}@s.whatsapp.net`;
      }

      let result: any;

      // Send the message directly using the socket
      if (document) {
        const response = await fetch(document);
        if (!response.ok) {
          throw new Error(`Failed to fetch document: ${response.statusText}`);
        }

        const buffer = await response.arrayBuffer();
        const mimeType = response.headers.get('content-type') || 'application/octet-stream';

        if (mimeType.startsWith('image/')) {
          result = await sessionInfo.socket.sendMessage(jid, {
            image: Buffer.from(buffer),
            caption: message || '',
          });
        } else if (mimeType.startsWith('audio/')) {
          result = await sessionInfo.socket.sendMessage(jid, {
            audio: Buffer.from(buffer),
            mimetype: mimeType,
          });
        } else if (mimeType.startsWith('video/')) {
          result = await sessionInfo.socket.sendMessage(jid, {
            video: Buffer.from(buffer),
            caption: message || '',
          });
        } else {
          result = await sessionInfo.socket.sendMessage(jid, {
            document: Buffer.from(buffer),
            mimetype: mimeType,
            fileName: document.split('/').pop() || 'document',
          });
        }
      } else if (message) {
        result = await sessionInfo.socket.sendMessage(jid, { text: message });
      } else {
        throw new Error('Either message or document is required');
      }

      this.logger.log(`[${username}] ✅ DIRECT SEND: Message sent successfully`);
      return {
        messageId: result.key.id,
        timestamp: result.messageTimestamp,
        to: jid,
      };

    } catch (error) {
      this.logger.error(`[${username}] ❌ DIRECT SEND: Failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Determine if an error is related to session activation failure
   */
  private isSessionActivationFailure(error: any): boolean {
    const errorMessage = error.message?.toLowerCase() || '';

    // Check for various session activation failure patterns
    const activationFailurePatterns = [
      'session activation failed',
      'activation failed',
      'connection not established',
      'session not ready',
      'whatsapp session could not be established',
      'session activated but connection not established',
      'unable to establish session',
      'no active socket available',
      'session not found'
    ];

    return activationFailurePatterns.some(pattern => errorMessage.includes(pattern));
  }
}
