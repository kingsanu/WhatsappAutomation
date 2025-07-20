import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ValidationPipe, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiKeyGuard } from "./guards/api-key.guard";
import { RateLimitGuard } from "./guards/rate-limit.guard";
import { LoggingInterceptor } from "./interceptors/logging.interceptor";

// Global error handlers to prevent application crashes
const logger = new Logger("GlobalErrorHandler");

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Promise Rejection:", reason);
  logger.error("Promise:", promise);
  // Don't exit the process - just log the error
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", error);
  // For uncaught exceptions, we should exit gracefully
  process.exit(1);
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ["log", "warn", "error"],
  });

  const configService = app.get(ConfigService);
  const appConfig = configService.get("app");
  const port = appConfig.PORT || 3000;
  const apiPrefix = appConfig.API_PREFIX || "api/v1";
  const enableAuth = appConfig.ENABLE_API_KEY_AUTH;
  const enableRateLimit = appConfig.ENABLE_RATE_LIMITING;
  const enableLogging = appConfig.ENABLE_REQUEST_LOGGING;

  logger.log(`Starting WhatsApp API server...`);
  logger.log(`Port: ${port}`);
  logger.log(`API Prefix: ${apiPrefix}`);
  logger.log(`API Key Auth: ${enableAuth ? "Enabled" : "Disabled"}`);
  logger.log(`Rate Limiting: ${enableRateLimit ? "Enabled" : "Disabled"}`);
  logger.log(`Request Logging: ${enableLogging ? "Enabled" : "Disabled"}`);

  // Enable CORS
  app.enableCors({
    origin: true,
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    })
  );

  // 🔒 Security: API Key Authentication (optional)
  if (enableAuth) {
    app.useGlobalGuards(new ApiKeyGuard(configService));
  }

  // 🛡️ Security: Rate Limiting (optional)
  if (enableRateLimit) {
    app.useGlobalGuards(new RateLimitGuard());
  }

  // 📝 Logging: Request/Response Interceptor (optional)
  if (enableLogging) {
    app.useGlobalInterceptors(new LoggingInterceptor());
  }

  // Set global prefix
  app.setGlobalPrefix(apiPrefix);

  await app.listen(port);
  logger.log(
    `🚀 WhatsApp API server is running on http://localhost:${port}/${apiPrefix}`
  );

  if (enableAuth) {
    logger.log(
      `🔒 API Key authentication is enabled. Set API_KEYS environment variable.`
    );
  }
}

bootstrap();
