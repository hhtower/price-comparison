import { Module } from '@nestjs/common';
import { ShopsController } from './shops.controller.js';
import { ShopsRepository } from './shops.repository.js';
import { ShopsService } from './shops.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { PlatformsModule } from '../platforms/platforms.module.js';

@Module({
  imports: [AuthModule, PlatformsModule],
  controllers: [ShopsController],
  providers: [ShopsRepository, ShopsService],
  exports: [ShopsRepository, ShopsService],
})
export class ShopsModule {}
