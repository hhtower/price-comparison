import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AccountService, type AccountUser } from './account.service.js';
import { readAccountToken } from './account-cookies.js';

@Injectable()
export class AccountGuard implements CanActivate {
  constructor(@Inject(AccountService) private readonly account: AccountService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ headers: { cookie?: string }; accountUser?: AccountUser }>();
    const user = await this.account.validate(readAccountToken(request.headers.cookie));
    if (!user) throw new UnauthorizedException('请先登录用户账号');
    request.accountUser = user;
    return true;
  }
}
