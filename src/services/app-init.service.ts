import { Injectable, OnModuleInit } from '@nestjs/common';
import { WhatsAppService } from '../services/whatsapp.service';

@Injectable()
export class AppInitService implements OnModuleInit {
  constructor(private readonly whatsAppService: WhatsAppService) {}

  async onModuleInit() {
    // Restore existing sessions on startup
    await this.whatsAppService.restoreExistingSessions();
  }
}
