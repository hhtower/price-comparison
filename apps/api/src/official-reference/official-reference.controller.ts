import { Controller, Get, Header, Inject } from '@nestjs/common';
import { OfficialReferenceService } from './official-reference.service.js';

@Controller({ path: 'official-reference', version: '1' })
export class OfficialReferenceController {
  constructor(@Inject(OfficialReferenceService) private readonly service: OfficialReferenceService) {}

  @Get('catalog')
  @Header('Cache-Control', 'public, max-age=60')
  catalog() { return this.service.catalog(); }
}
