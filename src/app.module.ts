import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";
import { SessionModule } from "./session/session.module";
import { ClientModule } from "./client/client.module";
import { UserManagementModule } from "./user-management/user-management.module";
import { HealthModule } from "./health/health.module";
import appConfig from "./config/app.config";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env.local", ".env"],
      load: [appConfig],
    }),
    MongooseModule.forRoot(
      process.env.MONGODB_URI || "mongodb://localhost:27017/whatsapp-api",
      {
        // Connection options for better reliability
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        bufferCommands: false,
        // bufferMaxEntries: 0,
      }
    ),
    SessionModule,
    ClientModule,
    UserManagementModule,
    HealthModule,
  ],
})
export class AppModule {}
