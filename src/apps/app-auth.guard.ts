import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { App } from '@prisma/client';
import { AppsService } from './apps.service';

// Not `app`: Express already uses req.app for the application object.
type AppRequest = { headers: Record<string, string | undefined>; payApp?: App };

/** Authenticates the calling app from `Authorization: Bearer <api key>`. */
@Injectable()
export class AppAuthGuard implements CanActivate {
  constructor(private readonly apps: AppsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const header = req.headers['authorization'] ?? '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const app = key ? await this.apps.findByApiKey(key) : null;
    if (!app) throw new UnauthorizedException('Invalid or missing API key');
    req.payApp = app;
    return true;
  }
}

/** The authenticated app (set by AppAuthGuard). */
export const CurrentApp = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): App =>
    ctx.switchToHttp().getRequest<AppRequest>().payApp!,
);
