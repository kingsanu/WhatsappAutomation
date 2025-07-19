import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const apiKey = this.extractApiKey(request);

    if (!apiKey) {
      throw new UnauthorizedException("API key is required");
    }

    const validApiKeys = this.configService
      .get<string>("API_KEYS", "")
      .split(",")
      .filter(Boolean);

    if (!validApiKeys.length) {
      throw new UnauthorizedException("No valid API keys configured");
    }

    if (!validApiKeys.includes(apiKey)) {
      throw new UnauthorizedException("Invalid API key");
    }

    return true;
  }

  private extractApiKey(request: Request): string | undefined {
    // Support multiple auth methods
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      return authHeader.substring(7);
    }

    // Also check x-api-key header
    return request.headers["x-api-key"] as string;
  }
}
