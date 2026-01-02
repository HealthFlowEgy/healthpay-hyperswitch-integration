import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';

// Connectors
import { FawryConnectorService } from './connectors/fawry.connector';
import { OPayConnectorService } from './connectors/opay.connector';
import { UPGConnectorService } from './connectors/upg.connector';

// Services
import { EgyptPaymentService } from './egypt-payment.service';

// Controllers
import { EgyptPaymentController } from './egypt-payment.controller';
import { EgyptWebhookController } from './egypt-webhook.controller';

/**
 * Egypt Payment Module
 * 
 * Provides unified access to all Egypt payment methods:
 * - Fawry (Cash payment network)
 * - OPay (E-Wallet)
 * - UPG (Meeza, InstaPay, Cards)
 * 
 * Usage:
 * ```typescript
 * @Module({
 *   imports: [EgyptPaymentModule],
 * })
 * export class AppModule {}
 * ```
 */
@Module({
  imports: [
    HttpModule.register({
      timeout: 60000, // 60 seconds for payment requests
      maxRedirects: 5,
    }),
    ConfigModule,
  ],
  controllers: [
    EgyptPaymentController,
    EgyptWebhookController,
  ],
  providers: [
    // Connectors
    FawryConnectorService,
    OPayConnectorService,
    UPGConnectorService,
    
    // Unified Service
    EgyptPaymentService,
  ],
  exports: [
    // Export services for use in other modules
    FawryConnectorService,
    OPayConnectorService,
    UPGConnectorService,
    EgyptPaymentService,
  ],
})
export class EgyptPaymentModule {}
