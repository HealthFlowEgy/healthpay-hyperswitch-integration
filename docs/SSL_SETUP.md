# SSL Setup Guide

This guide explains how to configure SSL/TLS for your EPOP Hyperswitch deployment.

## Prerequisites

1. A domain name pointing to your server IP (178.128.196.71)
2. SSH access to the server
3. DNS records configured:
   - `pay.healthpay.eg` → 178.128.196.71 (A record)
   - `dashboard.healthpay.eg` → 178.128.196.71 (A record, optional)
   - `monitoring.healthpay.eg` → 178.128.196.71 (A record, optional)

## Quick Setup

### Step 1: Configure DNS

Add the following DNS records in your domain registrar or DNS provider:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | pay | 178.128.196.71 | 300 |
| A | dashboard | 178.128.196.71 | 300 |
| A | monitoring | 178.128.196.71 | 300 |

Wait for DNS propagation (usually 5-30 minutes).

### Step 2: Verify DNS

```bash
# Check DNS resolution
dig pay.healthpay.eg +short
# Should return: 178.128.196.71

# Or using nslookup
nslookup pay.healthpay.eg
```

### Step 3: Run SSL Setup Script

```bash
# SSH into the server
ssh -i epop_deploy_key root@178.128.196.71

# Download and run the setup script
cd /opt/epop
curl -O https://raw.githubusercontent.com/HealthFlowEgy/healthpay-hyperswitch-integration/master/scripts/setup-ssl.sh
chmod +x setup-ssl.sh

# Run with your domain
./setup-ssl.sh pay.healthpay.eg admin@healthpay.eg
```

## Manual Setup

If you prefer manual configuration:

### 1. Install Certbot and Nginx

```bash
apt-get update
apt-get install -y certbot python3-certbot-nginx nginx
```

### 2. Create Nginx Configuration

```bash
cat > /etc/nginx/sites-available/hyperswitch << 'EOF'
# Rate limiting
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=100r/s;

upstream hyperswitch_api {
    server 127.0.0.1:8080;
    keepalive 32;
}

# HTTP - Redirect to HTTPS
server {
    listen 80;
    server_name pay.healthpay.eg;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$server_name$request_uri;
    }
}

# HTTPS
server {
    listen 443 ssl http2;
    server_name pay.healthpay.eg;

    ssl_certificate /etc/letsencrypt/live/pay.healthpay.eg/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pay.healthpay.eg/privkey.pem;
    
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    add_header Strict-Transport-Security "max-age=63072000" always;

    location / {
        limit_req zone=api_limit burst=200 nodelay;
        proxy_pass http://hyperswitch_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
```

### 3. Enable Site and Get Certificate

```bash
# Enable site
ln -sf /etc/nginx/sites-available/hyperswitch /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Create ACME challenge directory
mkdir -p /var/www/certbot

# Get certificate
certbot certonly --webroot -w /var/www/certbot \
    -d pay.healthpay.eg \
    --email admin@healthpay.eg \
    --agree-tos \
    --non-interactive

# Reload Nginx
nginx -t && systemctl reload nginx
```

### 4. Setup Auto-Renewal

```bash
# Add cron job for auto-renewal
(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --post-hook 'systemctl reload nginx'") | crontab -
```

## Post-Setup Configuration

### Update Webhook URL

After SSL is configured, update the webhook URL:

```bash
curl -X POST "http://localhost:8080/account/healthpay_eg/business_profile/pro_CILRiv5jY26Nri0wrChk" \
  -H "Content-Type: application/json" \
  -H "api-key: snd_Rh9hqv8uUmlwYeEtGcJgmlFuM1P2Cw4ueySA9fI3n9TQrBDvAq0gaqZ5vf3bGDVO" \
  -d '{
    "webhook_details": {
      "webhook_url": "https://api.healthpay.eg/webhooks/hyperswitch"
    }
  }'
```

### Update HealthPay Configuration

Update your HealthPay `.env` file:

```bash
# Before (HTTP)
HYPERSWITCH_BASE_URL=http://178.128.196.71:8080

# After (HTTPS)
HYPERSWITCH_BASE_URL=https://pay.healthpay.eg
```

## Verification

### Test SSL Configuration

```bash
# Check SSL certificate
curl -vI https://pay.healthpay.eg/health 2>&1 | grep -A5 "Server certificate"

# Test API endpoint
curl https://pay.healthpay.eg/health
```

### SSL Labs Test

Visit [SSL Labs](https://www.ssllabs.com/ssltest/) and test your domain for SSL configuration quality.

## Troubleshooting

### Certificate Not Found

```bash
# Check if certificate exists
ls -la /etc/letsencrypt/live/pay.healthpay.eg/

# If not, re-run certbot
certbot certonly --webroot -w /var/www/certbot -d pay.healthpay.eg
```

### Nginx Configuration Error

```bash
# Test configuration
nginx -t

# Check error logs
tail -f /var/log/nginx/error.log
```

### DNS Not Resolving

```bash
# Check DNS propagation
dig pay.healthpay.eg +trace

# Use Google DNS
dig @8.8.8.8 pay.healthpay.eg
```

### Certificate Renewal Failed

```bash
# Test renewal
certbot renew --dry-run

# Check certbot logs
cat /var/log/letsencrypt/letsencrypt.log
```

## Security Recommendations

1. **Enable HSTS** - Already configured in the Nginx template
2. **Use TLS 1.2+** - TLS 1.0 and 1.1 are disabled
3. **Regular Updates** - Keep Nginx and Certbot updated
4. **Monitor Expiry** - Set up alerts for certificate expiry

## Firewall Configuration

Ensure these ports are open:

```bash
# UFW
ufw allow 80/tcp
ufw allow 443/tcp

# Or iptables
iptables -A INPUT -p tcp --dport 80 -j ACCEPT
iptables -A INPUT -p tcp --dport 443 -j ACCEPT
```

## Support

- **Let's Encrypt**: https://letsencrypt.org/docs/
- **Nginx Docs**: https://nginx.org/en/docs/
- **Certbot Docs**: https://certbot.eff.org/docs/
