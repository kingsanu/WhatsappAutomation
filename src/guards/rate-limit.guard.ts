import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Request } from "express";

interface RateLimitInfo {
  count: number;
  resetTime: number;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly requests = new Map<string, RateLimitInfo>();
  private readonly WINDOW_MS = 60 * 1000; // 1 minute
  private readonly MAX_REQUESTS = 100; // 100 requests per minute per IP

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const key = this.getClientKey(request);

    const now = Date.now();
    const rateLimitInfo = this.requests.get(key);

    if (!rateLimitInfo || now > rateLimitInfo.resetTime) {
      // Reset or create new rate limit info
      this.requests.set(key, {
        count: 1,
        resetTime: now + this.WINDOW_MS,
      });
      return true;
    }

    if (rateLimitInfo.count >= this.MAX_REQUESTS) {
      throw new HttpException(
        {
          status: HttpStatus.TOO_MANY_REQUESTS,
          error: "Rate limit exceeded",
          message: `Too many requests. Limit: ${this.MAX_REQUESTS} per minute`,
          retryAfter: Math.ceil((rateLimitInfo.resetTime - now) / 1000),
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    rateLimitInfo.count++;
    return true;
  }

  private getClientKey(request: Request): string {
    // Use API key if available, otherwise fall back to IP
    const apiKey =
      request.headers.authorization?.substring(7) ||
      (Array.isArray(request.headers["x-api-key"])
        ? request.headers["x-api-key"][0]
        : request.headers["x-api-key"]);
    return (apiKey as string) || request.ip || "unknown";
  }

  // Cleanup old entries periodically (called internally)
  private cleanup(): void {
    const now = Date.now();
    for (const [key, info] of this.requests.entries()) {
      if (now > info.resetTime) {
        this.requests.delete(key);
      }
    }
  }

  // Auto-cleanup every 5 minutes
  constructor() {
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }
}
