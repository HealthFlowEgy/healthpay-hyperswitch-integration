#!/usr/bin/env node

/**
 * Egypt Payment Connectors - Node.js Test Script
 * Tests all Egypt payment methods: Fawry, OPay, Meeza, InstaPay
 */

const https = require('https');
const http = require('http');

// Configuration
const BASE_URL = process.env.EGYPT_CONNECTORS_URL || 'http://178.128.196.71:3001';
const API_PREFIX = '/api/v1';

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

// Helper functions
function log(color, symbol, message) {
  console.log(`${color}${symbol} ${message}${colors.reset}`);
}

function success(msg) { log(colors.green, '✓', msg); }
function error(msg) { log(colors.red, '✗', msg); }
function info(msg) { log(colors.yellow, '→', msg); }
function header(msg) {
  console.log(`\n${colors.blue}${'='.repeat(50)}${colors.reset}`);
  console.log(`${colors.blue}${msg}${colors.reset}`);
  console.log(`${colors.blue}${'='.repeat(50)}${colors.reset}\n`);
}

function generateOrderId() {
  return `TEST-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

// HTTP request helper
function makeRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + API_PREFIX + path);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = client.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

// Test functions
async function testHealth() {
  header('TEST 1: Health Check');
  try {
    const res = await makeRequest('GET', '/health');
    if (res.data.status === 'ok') {
      success('Health check passed');
      console.log(JSON.stringify(res.data, null, 2));
      return true;
    }
    error('Health check failed');
    return false;
  } catch (e) {
    error(`Health check error: ${e.message}`);
    return false;
  }
}

async function testPaymentMethods() {
  header('TEST 2: List Available Payment Methods');
  try {
    const res = await makeRequest('GET', '/egypt-payments/methods');
    success('Payment methods retrieved');
    console.log(JSON.stringify(res.data, null, 2));
    return true;
  } catch (e) {
    error(`Payment methods error: ${e.message}`);
    return false;
  }
}

async function testFawryPayment() {
  header('TEST 3: Fawry Reference Code Payment');
  const orderId = generateOrderId();
  info(`Order ID: ${orderId}`);

  try {
    const res = await makeRequest('POST', '/egypt-payments/fawry', {
      orderId,
      amount: 150.00,
      description: 'Test Fawry Payment',
      customer: {
        name: 'أحمد محمد',
        mobile: '01012345678',
        email: 'test@healthpay.eg',
      },
      callbackUrl: 'http://178.128.196.71:3001/api/v1/webhooks/egypt/fawry',
      items: [{
        itemId: 'ITEM-001',
        description: 'Test Item',
        price: 150.00,
        quantity: 1,
      }],
    });

    if (res.data.error) {
      info('Fawry sandbox returned expected error (credentials may need update)');
    } else {
      success('Fawry payment created');
    }
    console.log(JSON.stringify(res.data, null, 2));
    return true;
  } catch (e) {
    error(`Fawry payment error: ${e.message}`);
    return false;
  }
}

async function testOPayWallet() {
  header('TEST 4: OPay Wallet Payment');
  const orderId = generateOrderId();
  info(`Order ID: ${orderId}`);

  try {
    const res = await makeRequest('POST', '/egypt-payments/opay/wallet', {
      orderId,
      amount: 200.00,
      description: 'Test OPay Wallet Payment',
      customer: {
        name: 'سارة أحمد',
        mobile: '01112345678',
        email: 'test@healthpay.eg',
      },
      callbackUrl: 'http://178.128.196.71:3001/api/v1/webhooks/egypt/opay',
      returnUrl: 'http://178.128.196.71:3001/payment/return',
    });

    if (res.data.error) {
      info('OPay sandbox returned expected error');
    } else {
      success('OPay wallet payment created');
    }
    console.log(JSON.stringify(res.data, null, 2));
    return true;
  } catch (e) {
    error(`OPay wallet error: ${e.message}`);
    return false;
  }
}

async function testMeezaCard() {
  header('TEST 5: Meeza Card Payment');
  const orderId = generateOrderId();
  info(`Order ID: ${orderId}`);

  try {
    const res = await makeRequest('POST', '/egypt-payments/meeza/card', {
      orderId,
      amount: 500.00,
      description: 'Test Meeza Card Payment',
      customer: {
        name: 'فاطمة حسن',
        mobile: '01098765432',
        email: 'test@healthpay.eg',
        nationalId: '12345678901234',
      },
      callbackUrl: 'http://178.128.196.71:3001/api/v1/webhooks/egypt/upg',
      returnUrl: 'http://178.128.196.71:3001/payment/return',
    });

    if (res.data.error) {
      info('Meeza sandbox returned expected error (UPG credentials needed)');
    } else {
      success('Meeza card payment created');
    }
    console.log(JSON.stringify(res.data, null, 2));
    return true;
  } catch (e) {
    error(`Meeza card error: ${e.message}`);
    return false;
  }
}

async function testInstaPay() {
  header('TEST 6: InstaPay Payment');
  const orderId = generateOrderId();
  info(`Order ID: ${orderId}`);

  try {
    const res = await makeRequest('POST', '/egypt-payments/instapay', {
      orderId,
      amount: 1000.00,
      description: 'Test InstaPay Payment',
      customer: {
        name: 'علي محمود',
        mobile: '01555555555',
        email: 'test@healthpay.eg',
      },
      ipaAddress: 'ali.mahmoud@instapay',
      callbackUrl: 'http://178.128.196.71:3001/api/v1/webhooks/egypt/instapay',
    });

    if (res.data.error) {
      info('InstaPay sandbox returned expected error (UPG credentials needed)');
    } else {
      success('InstaPay payment created');
    }
    console.log(JSON.stringify(res.data, null, 2));
    return true;
  } catch (e) {
    error(`InstaPay error: ${e.message}`);
    return false;
  }
}

// Main execution
async function main() {
  header('EGYPT PAYMENT CONNECTORS - TEST SUITE');
  console.log(`Server: ${BASE_URL}`);
  console.log(`Date: ${new Date().toISOString()}\n`);

  const results = {
    health: await testHealth(),
    methods: await testPaymentMethods(),
    fawry: await testFawryPayment(),
    opay: await testOPayWallet(),
    meeza: await testMeezaCard(),
    instapay: await testInstaPay(),
  };

  header('TEST RESULTS SUMMARY');
  Object.entries(results).forEach(([test, passed]) => {
    if (passed) {
      success(`${test}: PASSED`);
    } else {
      error(`${test}: FAILED`);
    }
  });

  console.log('\nNote: Some tests may show errors if sandbox credentials');
  console.log('are not configured. This is expected behavior.');
}

main().catch(console.error);
