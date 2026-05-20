#!/bin/sh
# Substitute ${ROOT_DOMAIN} and ${ROOT_DOMAIN_ESCAPED} in the nginx template,
# then hand off to nginx. This runs at container start so the domain can be
# changed via environment variable without rebuilding the image.
set -e

DOMAIN="${ROOT_DOMAIN:-portivox.example.com}"

# Escape dots for the nginx wildcard server_name regex  (. → \.)
DOMAIN_ESCAPED=$(printf '%s' "$DOMAIN" | sed 's/\./\\./g')

export ROOT_DOMAIN="$DOMAIN"
export ROOT_DOMAIN_ESCAPED="$DOMAIN_ESCAPED"

envsubst '${ROOT_DOMAIN} ${ROOT_DOMAIN_ESCAPED}' \
  < /etc/nginx/nginx.conf.template \
  > /etc/nginx/nginx.conf

exec nginx -g 'daemon off;'
