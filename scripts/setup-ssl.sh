#!/bin/bash
#
# EPOP Hyperswitch SSL Setup Script
# This script configures Nginx with SSL using Let's Encrypt
#
# Usage: ./setup-ssl.sh <domain>
# Example: ./setup-ssl.sh pay.healthpay.eg
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if domain is provided
if [ -z "$1" ]; then
    echo -e "${RED}Error: Domain name is required${NC}"
    echo "Usage: ./setup-ssl.sh <domain>"
    echo "Example: ./setup-ssl.sh pay.healthpay.eg"
    exit 1
fi

DOMAIN=$1
EMAIL="${2:-admin@healthpay.eg}"

echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}EPOP Hyperswitch SSL Setup${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "Domain: ${YELLOW}${DOMAIN}${NC}"
echo -e "Email: ${YELLOW}${EMAIL}${NC}"
echo ""

# Step 1: Install Certbot and Nginx
echo -e "${GREEN}[1/5] Installing Certbot and Nginx...${NC}"
apt-get update
apt-get install -y certbot python3-certbot-nginx nginx

# Step 2: Create Nginx configuration
echo -e "${GREEN}[2/5] Creating Nginx configuration...${NC}"

cat > /etc/nginx/sites-available/hyperswitch << EOF
# EPOP Hyperswitch Nginx Configuration
# Domain: ${DOMAIN}

# Rate limiting
limit_req_zone \$binary_remote_addr zone=api_limit:10m rate=100r/s;
limit_conn_zone \$binary_remote_addr zone=conn_limit:10m;

# Upstream servers
upstream hyperswitch_api {
    server 127.0.0.1:8080;
    keepalive 32;
}

upstream hyperswitch_control_center {
    server 127.0.0.1:9000;
    keepalive 16;
}

upstream grafana {
    server 127.0.0.1:3000;
    keepalive 16;
}

# HTTP - Redirect to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$server_name\$request_uri;
    }
}

# HTTPS - Main API
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN};

    # SSL Configuration (will be updated by Certbot)
    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:50m;
    ssl_session_tickets off;

    # Modern SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # HSTS
    add_header Strict-Transport-Security "max-age=63072000" always;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Logging
    access_log /var/log/nginx/hyperswitch_access.log;
    error_log /var/log/nginx/hyperswitch_error.log;

    # Hyperswitch API
    location / {
        limit_req zone=api_limit burst=200 nodelay;
        limit_conn conn_limit 100;

        proxy_pass http://hyperswitch_api;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        
        proxy_buffering on;
        proxy_buffer_size 4k;
        proxy_buffers 8 4k;
    }

    # Health check endpoint (no rate limiting)
    location /health {
        proxy_pass http://hyperswitch_api/health;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Connection "";
    }

    # Webhooks endpoint
    location /webhooks {
        proxy_pass http://hyperswitch_api/webhooks;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
    }
}

# Control Center (Optional - can be on subdomain)
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name dashboard.${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;

    location / {
        proxy_pass http://hyperswitch_control_center;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

# Grafana (Optional - can be on subdomain)
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name monitoring.${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;

    location / {
        proxy_pass http://grafana;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

# Step 3: Enable the site
echo -e "${GREEN}[3/5] Enabling Nginx site...${NC}"
ln -sf /etc/nginx/sites-available/hyperswitch /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Create directory for ACME challenge
mkdir -p /var/www/certbot

# Test Nginx configuration (without SSL first)
cat > /etc/nginx/sites-available/hyperswitch-temp << EOF
server {
    listen 80;
    server_name ${DOMAIN};
    
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    
    location / {
        return 200 'Ready for SSL setup';
        add_header Content-Type text/plain;
    }
}
EOF

ln -sf /etc/nginx/sites-available/hyperswitch-temp /etc/nginx/sites-enabled/hyperswitch
nginx -t && systemctl reload nginx

# Step 4: Obtain SSL certificate
echo -e "${GREEN}[4/5] Obtaining SSL certificate from Let's Encrypt...${NC}"
certbot certonly --webroot -w /var/www/certbot \
    -d ${DOMAIN} \
    --email ${EMAIL} \
    --agree-tos \
    --non-interactive

# Step 5: Enable full configuration
echo -e "${GREEN}[5/5] Enabling full SSL configuration...${NC}"
ln -sf /etc/nginx/sites-available/hyperswitch /etc/nginx/sites-enabled/hyperswitch
nginx -t && systemctl reload nginx

# Setup auto-renewal
echo -e "${GREEN}Setting up automatic certificate renewal...${NC}"
(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --post-hook 'systemctl reload nginx'") | crontab -

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}SSL Setup Complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "Your Hyperswitch API is now available at:"
echo -e "  ${YELLOW}https://${DOMAIN}${NC}"
echo ""
echo -e "Control Center (if DNS configured):"
echo -e "  ${YELLOW}https://dashboard.${DOMAIN}${NC}"
echo ""
echo -e "Grafana (if DNS configured):"
echo -e "  ${YELLOW}https://monitoring.${DOMAIN}${NC}"
echo ""
echo -e "${GREEN}Certificate auto-renewal is configured.${NC}"
echo ""
