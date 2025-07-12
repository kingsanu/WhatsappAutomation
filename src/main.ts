import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Global error handlers to prevent application crashes
const logger = new Logger('GlobalErrorHandler');

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection:', reason);
  logger.error('Promise:', promise);
  // Don't exit the process - just log the error
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  // For uncaught exceptions, we should exit gracefully
  process.exit(1);
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);
  const apiPrefix = configService.get<string>('API_PREFIX', 'api/v1');

  logger.log(`Starting WhatsApp API server...`);
  logger.log(`Port: ${port}`);
  logger.log(`API Prefix: ${apiPrefix}`);

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
    }),
  );

  // Set global prefix
  app.setGlobalPrefix(apiPrefix);

  await app.listen(port);
  logger.log(`🚀 WhatsApp API server is running on http://localhost:${port}/${apiPrefix}`);
}

bootstrap();
