import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { PaymentAdapterService } from './payment-adapter.service';
import { PaymentAdapterController } from './payment-adapter.controller';
import { WebhookController } from './webhook.controller';

@Module({
  imports: [
    HttpModule.register({
      timeout: 30000, // 30 seconds timeout for payment requests
      maxRedirects: 5,
    }),
    ConfigModule,
  ],
  controllers: [PaymentAdapterController, WebhookController],
  providers: [PaymentAdapterService],
  exports: [PaymentAdapterService],
})
export class PaymentAdapterModule {}
