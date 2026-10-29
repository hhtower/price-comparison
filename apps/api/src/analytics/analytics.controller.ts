import { BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthGuard } from '../auth/auth.guard.js';
import { AnalyticsRepository } from './analytics.repository.js';
import { parseCollection, parseAnalyticsQuery, parseExcludedIp } from './analytics-input.js';
import { AnalyticsNetworkService, analyticsClientIp } from './analytics-network.js';

@Controller({ path: 'analytics', version: '1' })
export class AnalyticsController {
  constructor(@Inject(AnalyticsRepository) private readonly repository: AnalyticsRepository, @Inject(AnalyticsNetworkService) private readonly network: AnalyticsNetworkService) {}
  @Post('collect') @HttpCode(204) @Header('Cache-Control', 'no-store')
  async collect(@Body() body: unknown, @Req() request: FastifyRequest): Promise<void> {
    const input = parseCollection(body);
    const snapshot = await this.repository.visitNetwork(input);
    const needsLocation = !snapshot || (snapshot.ip && ['unknown', 'unavailable'].includes(snapshot.geoStatus));
    const network = needsLocation ? await this.network.lookup(snapshot ? snapshot.ip : analyticsClientIp(request)) : snapshot;
    await this.repository.collect(input, network);
  }
}
@Controller({ path: 'admin/analytics', version: '1' })
@UseGuards(AuthGuard)
export class AdminAnalyticsController {
  constructor(@Inject(AnalyticsRepository) private readonly repository: AnalyticsRepository) {}
  @Get('summary') @Header('Cache-Control', 'no-store')
  summary(@Query() query: Record<string, unknown>) { return this.repository.summary(parseAnalyticsQuery(query)); }
  @Get('visits') @Header('Cache-Control', 'no-store')
  visits(@Query() query: Record<string, unknown>) { return this.repository.visits(parseAnalyticsQuery(query)); }

  @Get('excluded-ips') @Header('Cache-Control', 'no-store')
  async excludedIps(@Req() request: FastifyRequest) {
    return { ips: await this.repository.excludedIps(), currentIp: analyticsClientIp(request) };
  }

  @Post('excluded-ips') @HttpCode(204) @Header('Cache-Control', 'no-store')
  addExcludedIp(@Body() body: unknown) { return this.repository.addExcludedIp(parseExcludedIp(body)); }

  @Post('excluded-ips/current') @HttpCode(204) @Header('Cache-Control', 'no-store')
  async excludeCurrentIp(@Req() request: FastifyRequest) {
    const ip = analyticsClientIp(request);
    if (!ip) throw new BadRequestException('无法识别当前 IP，请手动添加');
    await this.repository.addExcludedIp(ip);
  }

  @Delete('excluded-ips/:ip') @HttpCode(204) @Header('Cache-Control', 'no-store')
  removeExcludedIp(@Param('ip') ip: string) { return this.repository.removeExcludedIp(parseExcludedIp({ ip })); }
}
