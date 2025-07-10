import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WhatsAppService } from '../services/whatsapp.service';
import { AuthState, AuthStateSchema } from '../schemas/auth-state.schema';
import { UserManagementController } from './user-management.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AuthState.name, schema: AuthStateSchema },
    ]),
  ],
  controllers: [UserManagementController],
  providers: [WhatsAppService],
  exports: [WhatsAppService],
})
export class UserManagementModule {}
