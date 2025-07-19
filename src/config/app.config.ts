import { registerAs } from "@nestjs/config";
import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  validateSync,
} from "class-validator";
import { plainToClass, Transform } from "class-transformer";

class AppConfiguration {
  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10))
  PORT: number = 3000;

  @IsString()
  API_PREFIX: string = "api/v1";

  @IsString()
  NODE_ENV: string = "development";

  @IsString()
  MONGODB_URI: string = "mongodb://localhost:27017/whatsapp-api";

  @IsString()
  @IsOptional()
  API_KEYS?: string;

  @IsString()
  @IsOptional()
  WEBHOOK_URL?: string;

  @IsString()
  @IsOptional()
  WHATSAPP_DEVICE_NAME?: string = "WhatsApp API";

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10))
  @IsOptional()
  MAX_ACTIVE_SESSIONS?: number = 1000;

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10))
  @IsOptional()
  RATE_LIMIT_REQUESTS?: number = 100;

  @IsNumber()
  @Transform(({ value }) => parseInt(value, 10))
  @IsOptional()
  RATE_LIMIT_WINDOW_MS?: number = 60000;

  @IsBoolean()
  @Transform(({ value }) => value === "true")
  @IsOptional()
  ENABLE_API_KEY_AUTH?: boolean = true;

  @IsBoolean()
  @Transform(({ value }) => value === "true")
  @IsOptional()
  ENABLE_RATE_LIMITING?: boolean = true;

  @IsBoolean()
  @Transform(({ value }) => value === "true")
  @IsOptional()
  ENABLE_REQUEST_LOGGING?: boolean = true;
}

export default registerAs("app", (): AppConfiguration => {
  const config = plainToClass(AppConfiguration, process.env, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(config, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(`Configuration validation error: ${errors.toString()}`);
  }

  return config;
});
