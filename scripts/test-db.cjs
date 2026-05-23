#!/usr/bin/env node
// Quick DB connectivity test — run with: node scripts/test-db.cjs
const { PrismaClient } = require("@prisma/client");

const p = new PrismaClient();

p.$connect()
  .then(() => p.$queryRaw`SHOW TABLES`)
  .then((rows) => {
    console.log("✅ DB CONNECTED OK");
    console.log("   Tables:", rows.map((r) => Object.values(r)[0]).join(", "));
  })
  .catch((e) => {
    console.error("❌ DB ERROR:", e.message);
    if (e.message.includes("P1001")) {
      console.error("   → Cannot reach DB server. Check host/port/firewall.");
    } else if (e.message.includes("P1003")) {
      console.error("   → DB does not exist. Run: npm run db:migrate:deploy");
    } else if (e.message.includes("P1017") || e.message.includes("Access denied")) {
      console.error("   → Wrong credentials in DATABASE_URL.");
    }
  })
  .finally(() => p.$disconnect());
