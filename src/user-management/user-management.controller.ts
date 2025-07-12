import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { WhatsAppService } from '../services/whatsapp.service';
import { SendMessageDto } from '../dto/send-message.dto';
import { PersistencePolicy } from '../schemas/auth-state.schema';

interface UserListQuery {
  status?: 'connected' | 'disconnected' | 'all';
  limit?: number;
  offset?: number;
  search?: string;
}

interface SetPersistenceDto {
  policy?: PersistencePolicy;
  autoReconnect?: boolean;
  // Legacy support
  isPersistent?: boolean;
}

@Controller('users')
export class UserManagementController {
  constructor(private readonly whatsappService: WhatsAppService) {}

  /**
   * Get all registered users with their session status and details
   */
  @Get()
  async getAllUsers(@Query() query: UserListQuery) {
    try {
      const { status = 'all', limit = 50, offset = 0, search } = query;
      
      const users = await this.whatsappService.getAllUsers({
        status,
        limit: Math.min(limit, 100), // Cap at 100 for performance
        offset,
        search
      });

      return {
        success: true,
        data: users,
        message: `Retrieved ${users.length} users`,
        pagination: {
          limit,
          offset,
          total: users.length
        }
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Failed to retrieve users',
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get detailed information about a specific user
   */
  @Get(':userId/details')
  async getUserDetails(@Param('userId') userId: string) {
    try {
      const userDetails = await this.whatsappService.getDetailedSessionInfo(userId);
      
      if (!userDetails.exists) {
        throw new HttpException(
          {
            status: HttpStatus.NOT_FOUND,
            error: 'User not found',
            message: `User ${userId} does not exist`,
          },
          HttpStatus.NOT_FOUND,
        );
      }

      return {
        success: true,
        data: userDetails,
        message: `Retrieved details for user ${userId}`,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Failed to retrieve user details',
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get session status for a specific user
   */
  @Get(':userId/status')
  async getUserStatus(@Param('userId') userId: string) {
    try {
      const status = await this.whatsappService.getSessionStatus(userId);
      
      return {
        success: true,
        data: status,
        message: `Retrieved status for user ${userId}`,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Failed to retrieve user status',
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Send a message to a specific phone number using a user's session
   */
  @Post(':userId/send-message')
  async sendMessage(
    @Param('userId') userId: string,
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

      // 🚀 INTELLIGENT SEND MESSAGE - Session status check removed
      // The sendMessage service now handles automatic session activation
      // No need to manually check session status here

      // Format phone number - ensure it has country code
      let formattedNumber = number;
      if (!number.startsWith('+')) {
        formattedNumber = `+${number}`;
      }
      
      // Remove plus sign for WhatsApp format
      const whatsappNumber = formattedNumber.replace('+', '');

      const result = await this.whatsappService.sendMessage(
        userId,
        whatsappNumber,
        message,
        document,
      );

      return {
        success: true,
        data: result,
        message: `Message sent successfully from user ${userId}`,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      
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
   * Set session persistence settings for a user
   */
  @Post(':userId/persistence')
  async setSessionPersistence(
    @Param('userId') userId: string,
    @Body() persistenceDto: SetPersistenceDto,
  ) {
    try {
      const { policy, isPersistent, autoReconnect = true } = persistenceDto;

      // Determine persistence policy
      let persistencePolicy: PersistencePolicy;
      if (policy) {
        persistencePolicy = policy;
      } else if (isPersistent !== undefined) {
        // Legacy support: convert boolean to policy
        persistencePolicy = isPersistent ? PersistencePolicy.PERMANENT : PersistencePolicy.TEMPORARY;
      } else {
        persistencePolicy = PersistencePolicy.PERMANENT; // Default
      }

      await this.whatsappService.setSessionPersistence(userId, persistencePolicy, autoReconnect);
      
      return {
        success: true,
        message: `Session persistence updated for user ${userId}`,
        data: {
          userId,
          isPersistent,
          autoReconnect
        }
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Failed to update session persistence',
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Force disconnect a user's session
   */
  @Delete(':userId/disconnect')
  async disconnectUser(@Param('userId') userId: string) {
    try {
      await this.whatsappService.clearUserSession(userId);
      
      return {
        success: true,
        message: `User ${userId} session disconnected successfully`,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Failed to disconnect user session',
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Delete a user completely (session and auth data)
   */
  @Delete(':userId')
  async deleteUser(@Param('userId') userId: string) {
    try {
      await this.whatsappService.deleteUser(userId);
      
      return {
        success: true,
        message: `User ${userId} deleted successfully`,
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Failed to delete user',
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get system statistics
   */
  @Get('system/stats')
  async getSystemStats() {
    try {
      const stats = await this.whatsappService.getSystemStats();
      
      return {
        success: true,
        data: stats,
        message: 'System statistics retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Failed to retrieve system statistics',
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
