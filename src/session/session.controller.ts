import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  HttpException,
  HttpStatus,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { WhatsAppService } from '../services/whatsapp.service';

@Controller('session')
export class SessionController {
  constructor(private readonly whatsappService: WhatsAppService) {}

  @Get('qr/:username/image')
  async getQRCode(@Param('username') username: string, @Res() res: Response) {
    try {
      // First check if session is already connected
      const status = await this.whatsappService.getSessionStatus(username);
      
      if (status.connected) {
        return res.status(200).json({
          success: true,
          message: 'Session already connected. No QR code needed.',
          connected: true,
          data: {
            user: status.user,
            connectionStatus: status.connectionStatus
          }
        });
      }

      let qrCode;
      
      try {
        qrCode = await this.whatsappService.getQRCode(username);
      } catch (error) {
        // If QR code doesn't exist, create a new session
        try {
          qrCode = await this.whatsappService.createSession(username);
        } catch (sessionError) {
          if (sessionError.message.includes('Session already exists and is connected')) {
            // If session exists and is connected, return JSON response
            return res.status(200).json({
              success: true,
              message: 'Session already connected. No QR code needed.',
              connected: true
            });
          }
          throw sessionError;
        }
      }

      // Convert data URL to buffer and send as image
      const base64Data = qrCode.replace(/^data:image\/png;base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');

      res.set({
        'Content-Type': 'image/png',
        'Content-Length': imageBuffer.length.toString(),
      });

      res.send(imageBuffer);
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Failed to generate QR code',
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('terminate/:username')
  async terminateSession(@Param('username') username: string) {
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
          error: 'Failed to terminate session',
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('status/:username')
  async getSessionStatus(@Param('username') username: string) {
    try {
      const status = await this.whatsappService.getSessionStatus(username);
      return {
        success: true,
        data: status,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Failed to get session status',
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('clear/:username')
  async clearSession(@Param('username') username: string) {
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
          error: 'Failed to clear session',
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
