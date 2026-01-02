import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable CORS
  app.enableCors({
    origin: process.env.CORS_ORIGINS?.split(',') || ['*'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // API prefix
  app.setGlobalPrefix('api/v1');

  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('EPOP PayFac API')
    .setDescription('HealthPay Payment Facilitator Platform API')
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'api-key')
    .addTag('Sub-Merchants', 'Sub-merchant management')
    .addTag('Transactions', 'Payment transactions')
    .addTag('Settlements', 'Settlement processing')
    .addTag('Payouts', 'Merchant payouts')
    .addTag('Payment Links', 'Payment link management')
    .addTag('Checkout', 'Hosted checkout sessions')
    .addTag('KYC', 'KYC document management')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = process.env.PAYFAC_PORT || 3002;
  await app.listen(port);

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                   EPOP PayFac Backend                        ║
╠══════════════════════════════════════════════════════════════╣
║  API Server:     http://localhost:${port}/api/v1              ║
║  Swagger Docs:   http://localhost:${port}/docs                ║
║  Health Check:   http://localhost:${port}/api/v1/health       ║
╚══════════════════════════════════════════════════════════════╝
  `);
}

bootstrap();
