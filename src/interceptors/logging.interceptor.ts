import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { tap, catchError } from "rxjs/operators";
import { Request, Response } from "express";

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const { method, url, ip } = request;
    const userAgent = request.get("User-Agent") || "";
    const startTime = Date.now();

    // Log request
    this.logger.log(`📥 ${method} ${url} - ${ip} - ${userAgent}`);

    return next.handle().pipe(
      tap((_data) => {
        const duration = Date.now() - startTime;
        const { statusCode } = response;

        this.logger.log(
          `📤 ${method} ${url} - ${statusCode} - ${duration}ms - ${ip}`
        );
      }),
      catchError((error) => {
        const duration = Date.now() - startTime;
        const statusCode = error.status || 500;

        this.logger.error(
          `❌ ${method} ${url} - ${statusCode} - ${duration}ms - ${ip} - ${error.message}`
        );

        throw error;
      })
    );
  }
}
