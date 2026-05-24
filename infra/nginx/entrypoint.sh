#!/bin/sh
set -e

# Inject ROOT_DOMAIN into the nginx config template so the subdomain
# server block uses the correct domain without hardcoding it.
# Dots are escaped (. → \.) so the value is safe inside an nginx regex.
export ROOT_DOMAIN="${ROOT_DOMAIN:-portivox.braintechsolution.com}"
ROOT_DOMAIN_REGEX=$(printf '%s' "$ROOT_DOMAIN" | sed 's/\./\\./g')
export ROOT_DOMAIN_REGEX

envsubst '${ROOT_DOMAIN_REGEX}' \
  < /etc/nginx/nginx.conf.template \
  > /etc/nginx/nginx.conf

exec nginx -g 'daemon off;'
