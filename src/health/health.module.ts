import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SessionHealthService } from '../services/session-health.service';
import { WhatsAppService } from '../services/whatsapp.service';
import { PersistentAuthStateService } from '../services/persistent-auth-state.service';
import { AuthState, AuthStateSchema } from '../schemas/auth-state.schema';
import { HealthController } from './health.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AuthState.name, schema: AuthStateSchema },
    ]),
  ],
  controllers: [HealthController],
  providers: [SessionHealthService, WhatsAppService, PersistentAuthStateService],
  exports: [SessionHealthService],
})
export class HealthModule {}
