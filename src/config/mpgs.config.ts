/**
 * MPGS (Mastercard Payment Gateway Services) Configuration
 * Banque Misr Integration for Egypt
 * 
 * This configuration is used for the MPGS connector on Hyperswitch
 */

export const MPGSConfig = {
  // Connector Details
  connector: {
    name: 'nmi', // Hyperswitch connector name for MPGS-compatible gateways
    label: 'mpgs_banquemisr',
    connectorId: 'mca_uY7MAi0ieiaP9KAsHtFu',
  },

  // Merchant Details (from Banque Misr)
  merchant: {
    id: 'HEALTHPAY_PF',
    name: 'HEALTHPAY_PF',
    apiUsername: 'Merchant.HEALTHPAY_PF',
    // API Password should be stored in environment variables, not in code
  },

  // Gateway Configuration
  gateway: {
    name: 'MPGS',
    acquirer: 'Banque Misr',
    country: 'EG',
    currency: 'EGP',
    integrationMode: 'Hosted Payment Form',
  },

  // Payment Methods
  paymentMethods: {
    card: {
      networks: ['Visa', 'Mastercard'],
      types: ['credit', 'debit'],
      minimumAmount: 100, // 1.00 EGP in minor units
      maximumAmount: 100000000, // 1,000,000.00 EGP in minor units
      recurringEnabled: true,
      installmentEnabled: false,
    },
  },

  // 3D Secure Configuration
  threeDSecure: {
    enabled: true,
    challengeIndicator: 'challenge_requested',
    version: '2.0',
  },

  // Test Mode
  testMode: false, // Set to true for sandbox testing

  // API Endpoints (for reference)
  endpoints: {
    production: 'https://banquemisr.gateway.mastercard.com/api/rest/version/73',
    sandbox: 'https://banquemisr.gateway.mastercard.com/api/rest/version/73',
    documentation: 'https://banquemisr.gateway.mastercard.com/api/documentation/',
  },

  // Test Cards (for sandbox testing)
  testCards: {
    success: {
      mastercard: '5123450000000008',
      visa: '4508750015741019',
    },
    declined: {
      mastercard: '5123450000000016',
      visa: '4000000000000002',
    },
    threeDSecure: {
      mastercard: '5123450000000024',
    },
  },
};

export default MPGSConfig;
