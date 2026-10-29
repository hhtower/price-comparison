import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { OfficialReferenceRepository } from './official-reference.repository.js';
import { OfficialReferenceService } from './official-reference.service.js';
import { OfficialReferenceController } from './official-reference.controller.js';

@Module({ imports: [DatabaseModule], controllers: [OfficialReferenceController],
  providers: [OfficialReferenceRepository, { provide: OfficialReferenceService, inject: [OfficialReferenceRepository], useFactory: (store: OfficialReferenceRepository) => new OfficialReferenceService(store) }],
  exports: [OfficialReferenceRepository, OfficialReferenceService],
})
export class OfficialReferenceModule {}
