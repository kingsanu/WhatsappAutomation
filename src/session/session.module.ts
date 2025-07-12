import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WhatsAppService } from '../services/whatsapp.service';
import { SessionHealthService } from '../services/session-health.service';
import { SessionPolicyService } from '../services/session-policy.service';
import { SessionBackupService } from '../services/session-backup.service';
import { PersistentAuthStateService } from '../services/persistent-auth-state.service';
import { AuthState, AuthStateSchema } from '../schemas/auth-state.schema';
import { SessionController } from './session.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AuthState.name, schema: AuthStateSchema },
    ]),
  ],
  controllers: [SessionController],
  providers: [WhatsAppService, SessionHealthService, SessionPolicyService, SessionBackupService, PersistentAuthStateService],
  exports: [WhatsAppService, SessionHealthService, SessionPolicyService, SessionBackupService, PersistentAuthStateService],
})
export class SessionModule {}