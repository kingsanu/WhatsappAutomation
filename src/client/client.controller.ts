import {
  Controller,
  Post,
  Param,
  Body,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { WhatsAppService } from '../services/whatsapp.service';
import { SendMessageDto } from '../dto/send-message.dto';

@Controller('client')
export class ClientController {
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

      const result = await this.whatsappService.sendMessage(
        username,
        whatsappNumber,
        message,
        document,
      );

      return {
        success: true,
        data: result,
        message: 'Message sent successfully',
      };
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
}
