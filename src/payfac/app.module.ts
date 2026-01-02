import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';

// Services
import { SettlementEngineService } from './settlement/settlement-engine.service';
import { PayoutService } from './payout/payout.service';
import { PaymentLinkService } from './payment-links/payment-link.service';
import { SubMerchantOnboardingService } from './onboarding/sub-merchant-onboarding.service';
import { SubMerchantService } from './sub-merchants/sub-merchant.service';
import { SmsService } from './sms/sms.service';

// Controllers
import { PaymentLinkController } from './payment-links/payment-link.controller';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
    }),
    ScheduleModule.forRoot(),
    HttpModule,
  ],
  controllers: [
    HealthController,
    PaymentLinkController,
  ],
  providers: [
    SettlementEngineService,
    PayoutService,
    PaymentLinkService,
    SubMerchantOnboardingService,
    SubMerchantService,
    SmsService,
  ],
  exports: [
    SettlementEngineService,
    PayoutService,
    PaymentLinkService,
    SubMerchantOnboardingService,
    SubMerchantService,
    SmsService,
  ],
})
export class AppModule {}
