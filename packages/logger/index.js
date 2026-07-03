// Structured JSON logger: one machine-parseable object per line so log
// aggregators (Loki/ELK/Datadog) can index level, scope, timestamp and
// arbitrary metadata without fragile prefix parsing.

function emit(stream, scope, level, message, meta) {
  const record = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: typeof message === "string" ? message : String(message),
  };
  if (meta !== undefined && meta !== null) {
    if (typeof meta === "object" && !Array.isArray(meta)) {
      Object.assign(record, meta);
    } else {
      record.meta = meta;
    }
  }
  let line;
  try {
    line = JSON.stringify(record);
  } catch {
    // Fall back to a minimal record if meta contains circular references.
    line = JSON.stringify({ ts: record.ts, level, scope, msg: record.msg, meta: "[unserializable-meta]" });
  }
  stream(line);
}

function createLogger(scope) {
  return {
    info(message, meta) {
      emit(console.log, scope, "info", message, meta);
    },
    warn(message, meta) {
      emit(console.warn, scope, "warn", message, meta);
    },
    error(message, meta) {
      emit(console.error, scope, "error", message, meta);
    },
  };
}

module.exports = { createLogger };
