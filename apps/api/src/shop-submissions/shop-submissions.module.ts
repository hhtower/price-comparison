import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ShopsModule } from '../shops/shops.module.js';
import { PlatformsModule } from '../platforms/platforms.module.js';
import { AdminShopSubmissionsController, ShopSubmissionsController } from './shop-submissions.controller.js';
import { ShopSubmissionsRepository } from './shop-submissions.repository.js';
import { ShopSubmissionsService } from './shop-submissions.service.js';

@Module({
  imports: [AuthModule, ShopsModule, PlatformsModule],
  controllers: [ShopSubmissionsController, AdminShopSubmissionsController],
  providers: [ShopSubmissionsRepository, ShopSubmissionsService],
  exports: [ShopSubmissionsService],
})
export class ShopSubmissionsModule {}
