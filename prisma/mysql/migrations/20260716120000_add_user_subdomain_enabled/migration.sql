-- Add per-user subdomain subscription entitlement.
ALTER TABLE `User` ADD COLUMN `subdomainEnabled` BOOLEAN NOT NULL DEFAULT false;
