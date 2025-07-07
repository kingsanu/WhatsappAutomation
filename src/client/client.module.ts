import { Module } from '@nestjs/common';
import { ClientController } from './client.controller';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [SessionModule],
  controllers: [ClientController],
})
export class ClientModule {}
