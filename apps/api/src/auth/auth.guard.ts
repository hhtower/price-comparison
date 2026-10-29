import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { readSessionToken } from './auth-cookies.js';
import { AuthService } from './auth.service.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ headers?: { cookie?: string }; user?: unknown }>();
    const token = readSessionToken(request.headers?.cookie);
    const user = await this.auth.validate(token);
    if (!user) throw new UnauthorizedException('需要登录');
    request.user = user;
    return true;
  }
}
