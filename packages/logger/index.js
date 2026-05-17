function serialize(meta) {
  if (meta === undefined) {
    return "";
  }
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return " [unserializable-meta]";
  }
}

function createLogger(scope) {
  const prefix = `[${scope}]`;

  return {
    info(message, meta) {
      console.log(`${prefix} INFO ${message}${serialize(meta)}`);
    },
    warn(message, meta) {
      console.warn(`${prefix} WARN ${message}${serialize(meta)}`);
    },
    error(message, meta) {
      console.error(`${prefix} ERROR ${message}${serialize(meta)}`);
    },
  };
}

module.exports = { createLogger };