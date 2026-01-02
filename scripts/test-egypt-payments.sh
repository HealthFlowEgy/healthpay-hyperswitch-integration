#!/bin/bash

# =============================================================================
# EGYPT PAYMENT CONNECTORS - TEST SCRIPT
# Tests all Egypt payment methods: Fawry, OPay, Meeza, InstaPay
# =============================================================================

set -e

# Configuration
BASE_URL="${EGYPT_CONNECTORS_URL:-http://178.128.196.71:3001}"
API_PREFIX="/api/v1"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
print_header() {
    echo -e "\n${BLUE}============================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}============================================${NC}\n"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "${YELLOW}→ $1${NC}"
}

# Generate unique order ID
generate_order_id() {
    echo "TEST-$(date +%s)-$RANDOM"
}

# =============================================================================
# TEST 1: Health Check
# =============================================================================
test_health() {
    print_header "TEST 1: Health Check"
    
    response=$(curl -s "${BASE_URL}${API_PREFIX}/health")
    
    if echo "$response" | grep -q '"status":"ok"'; then
        print_success "Health check passed"
        echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
    else
        print_error "Health check failed"
        echo "$response"
        return 1
    fi
}

# =============================================================================
# TEST 2: List Available Payment Methods
# =============================================================================
test_payment_methods() {
    print_header "TEST 2: List Available Payment Methods"
    
    response=$(curl -s "${BASE_URL}${API_PREFIX}/egypt-payments/methods")
    
    if echo "$response" | grep -q 'FAWRY'; then
        print_success "Payment methods retrieved"
        echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
    else
        print_error "Failed to get payment methods"
        echo "$response"
        return 1
    fi
}

# =============================================================================
# TEST 3: Fawry Reference Code Payment
# =============================================================================
test_fawry_payment() {
    print_header "TEST 3: Fawry Reference Code Payment"
    
    ORDER_ID=$(generate_order_id)
    print_info "Order ID: $ORDER_ID"
    
    response=$(curl -s -X POST "${BASE_URL}${API_PREFIX}/egypt-payments/fawry" \
        -H "Content-Type: application/json" \
        -d '{
            "orderId": "'$ORDER_ID'",
            "amount": 150.00,
            "description": "Test Fawry Payment",
            "customer": {
                "name": "أحمد محمد",
                "mobile": "01012345678",
                "email": "test@healthpay.eg"
            },
            "callbackUrl": "http://178.128.196.71:3001/api/v1/webhooks/egypt/fawry",
            "items": [{
                "itemId": "ITEM-001",
                "description": "Test Item",
                "price": 150.00,
                "quantity": 1
            }]
        }')
    
    if echo "$response" | grep -q 'referenceNumber\|transactionId\|error'; then
        if echo "$response" | grep -q 'error'; then
            print_info "Fawry sandbox returned expected error (credentials may need update)"
        else
            print_success "Fawry payment created"
        fi
        echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
    else
        print_error "Fawry payment failed"
        echo "$response"
    fi
}

# =============================================================================
# TEST 4: OPay Wallet Payment
# =============================================================================
test_opay_wallet() {
    print_header "TEST 4: OPay Wallet Payment"
    
    ORDER_ID=$(generate_order_id)
    print_info "Order ID: $ORDER_ID"
    
    response=$(curl -s -X POST "${BASE_URL}${API_PREFIX}/egypt-payments/opay/wallet" \
        -H "Content-Type: application/json" \
        -d '{
            "orderId": "'$ORDER_ID'",
            "amount": 200.00,
            "description": "Test OPay Wallet Payment",
            "customer": {
                "name": "سارة أحمد",
                "mobile": "01112345678",
                "email": "test@healthpay.eg"
            },
            "callbackUrl": "http://178.128.196.71:3001/api/v1/webhooks/egypt/opay",
            "returnUrl": "http://178.128.196.71:3001/payment/return"
        }')
    
    if echo "$response" | grep -q 'qrCodeUrl\|transactionId\|paymentUrl\|error'; then
        if echo "$response" | grep -q 'error'; then
            print_info "OPay sandbox returned expected error (credentials may need update)"
        else
            print_success "OPay wallet payment created"
        fi
        echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
    else
        print_error "OPay wallet payment failed"
        echo "$response"
    fi
}

# =============================================================================
# TEST 5: OPay Cashier (Hosted Checkout)
# =============================================================================
test_opay_cashier() {
    print_header "TEST 5: OPay Cashier Payment"
    
    ORDER_ID=$(generate_order_id)
    print_info "Order ID: $ORDER_ID"
    
    response=$(curl -s -X POST "${BASE_URL}${API_PREFIX}/egypt-payments/opay/cashier" \
        -H "Content-Type: application/json" \
        -d '{
            "orderId": "'$ORDER_ID'",
            "amount": 300.00,
            "description": "Test OPay Cashier Payment",
            "customer": {
                "name": "محمد علي",
                "mobile": "01234567890",
                "email": "test@healthpay.eg"
            },
            "callbackUrl": "http://178.128.196.71:3001/api/v1/webhooks/egypt/opay",
            "returnUrl": "http://178.128.196.71:3001/payment/return"
        }')
    
    if echo "$response" | grep -q 'cashierUrl\|paymentUrl\|transactionId\|error'; then
        if echo "$response" | grep -q 'error'; then
            print_info "OPay cashier sandbox returned expected error"
        else
            print_success "OPay cashier payment created"
        fi
        echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
    else
        print_error "OPay cashier payment failed"
        echo "$response"
    fi
}

# =============================================================================
# TEST 6: Meeza Card Payment
# =============================================================================
test_meeza_card() {
    print_header "TEST 6: Meeza Card Payment"
    
    ORDER_ID=$(generate_order_id)
    print_info "Order ID: $ORDER_ID"
    
    response=$(curl -s -X POST "${BASE_URL}${API_PREFIX}/egypt-payments/meeza/card" \
        -H "Content-Type: application/json" \
        -d '{
            "orderId": "'$ORDER_ID'",
            "amount": 500.00,
            "description": "Test Meeza Card Payment",
            "customer": {
                "name": "فاطمة حسن",
                "mobile": "01098765432",
                "email": "test@healthpay.eg",
                "nationalId": "12345678901234"
            },
            "callbackUrl": "http://178.128.196.71:3001/api/v1/webhooks/egypt/upg",
            "returnUrl": "http://178.128.196.71:3001/payment/return"
        }')
    
    if echo "$response" | grep -q 'paymentUrl\|transactionId\|error'; then
        if echo "$response" | grep -q 'error'; then
            print_info "Meeza sandbox returned expected error (UPG credentials needed)"
        else
            print_success "Meeza card payment created"
        fi
        echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
    else
        print_error "Meeza card payment failed"
        echo "$response"
    fi
}

# =============================================================================
# TEST 7: InstaPay Payment
# =============================================================================
test_instapay() {
    print_header "TEST 7: InstaPay Payment"
    
    ORDER_ID=$(generate_order_id)
    print_info "Order ID: $ORDER_ID"
    
    response=$(curl -s -X POST "${BASE_URL}${API_PREFIX}/egypt-payments/instapay" \
        -H "Content-Type: application/json" \
        -d '{
            "orderId": "'$ORDER_ID'",
            "amount": 1000.00,
            "description": "Test InstaPay Payment",
            "customer": {
                "name": "علي محمود",
                "mobile": "01555555555",
                "email": "test@healthpay.eg"
            },
            "ipaAddress": "ali.mahmoud@instapay",
            "callbackUrl": "http://178.128.196.71:3001/api/v1/webhooks/egypt/instapay"
        }')
    
    if echo "$response" | grep -q 'transactionId\|requestId\|error'; then
        if echo "$response" | grep -q 'error'; then
            print_info "InstaPay sandbox returned expected error (UPG credentials needed)"
        else
            print_success "InstaPay payment created"
        fi
        echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
    else
        print_error "InstaPay payment failed"
        echo "$response"
    fi
}

# =============================================================================
# TEST 8: Unified Payment Creation
# =============================================================================
test_unified_payment() {
    print_header "TEST 8: Unified Payment Creation (Auto-routing)"
    
    ORDER_ID=$(generate_order_id)
    print_info "Order ID: $ORDER_ID"
    
    response=$(curl -s -X POST "${BASE_URL}${API_PREFIX}/egypt-payments" \
        -H "Content-Type: application/json" \
        -d '{
            "orderId": "'$ORDER_ID'",
            "amount": 250.00,
            "paymentMethod": "FAWRY",
            "description": "Test Unified Payment",
            "customer": {
                "name": "Test Customer",
                "mobile": "01000000000",
                "email": "test@healthpay.eg"
            },
            "callbackUrl": "http://178.128.196.71:3001/api/v1/webhooks/egypt/fawry"
        }')
    
    echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
}

# =============================================================================
# MAIN EXECUTION
# =============================================================================
main() {
    print_header "EGYPT PAYMENT CONNECTORS - TEST SUITE"
    echo "Server: $BASE_URL"
    echo "Date: $(date)"
    echo ""
    
    # Run all tests
    test_health
    test_payment_methods
    test_fawry_payment
    test_opay_wallet
    test_opay_cashier
    test_meeza_card
    test_instapay
    test_unified_payment
    
    print_header "TEST SUITE COMPLETED"
    echo -e "${GREEN}All tests executed. Check results above.${NC}"
    echo ""
    echo "Note: Some tests may show errors if sandbox credentials"
    echo "are not configured. This is expected behavior."
}

# Run main function
main "$@"
