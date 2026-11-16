import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PAY_CONFIG, loadConfig } from './config';
import { PrismaService } from './prisma.service';
import { PaystackClient } from './paystack/paystack.client';
import { AppsService } from './apps/apps.service';
import { AppAuthGuard } from './apps/app-auth.guard';
import { cipherProvider } from './payments/cipher.provider';
import { PaymentsService } from './payments/payments.service';
import { PaymentsController } from './payments/payments.controller';
import { WebhooksService } from './webhooks/webhooks.service';
import { DeliveryService } from './webhooks/delivery.service';
import { WebhooksController } from './webhooks/webhooks.controller';

@Controller()
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('health')
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  }
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ScheduleModule.forRoot()],
  controllers: [HealthController, PaymentsController, WebhooksController],
  providers: [
    { provide: PAY_CONFIG, useFactory: () => loadConfig() },
    PrismaService,
    PaystackClient,
    AppsService,
    AppAuthGuard,
    cipherProvider,
    PaymentsService,
    WebhooksService,
    DeliveryService,
  ],
})
export class AppModule {}
