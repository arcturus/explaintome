/**
 * Leveled logging: DEBUG/INFO/WARN/ERROR.
 * LOG_LEVEL overrides defaults; NODE_ENV=production → info + JSON (set LOG_FORMAT=pretty for readable prod logs).
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function parseLevel(name) {
  const key = (name || '').toLowerCase();
  return key in LEVELS ? key : null;
}

function resolveLevel() {
  const fromEnv = parseLevel(process.env.LOG_LEVEL);
  if (fromEnv) return fromEnv;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

function isStructured() {
  return process.env.NODE_ENV === 'production' || process.env.LOG_FORMAT === 'json';
}

let currentLevel = resolveLevel();

function shouldLog(level) {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function write(level, line) {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function format(level, message, meta) {
  const extra = meta && Object.keys(meta).length > 0 ? meta : undefined;
  if (isStructured()) {
    return JSON.stringify({
      time: new Date().toISOString(),
      level,
      msg: message,
      ...extra,
    });
  }
  const prefix = `[${level.toUpperCase()}]`;
  if (!extra) return `${prefix} ${message}`;
  return `${prefix} ${message} ${JSON.stringify(extra)}`;
}

function log(level, message, meta) {
  if (!shouldLog(level)) return;
  write(level, format(level, message, meta));
}

const logger = {
  debug: (message, meta) => log('debug', message, meta),
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
  level: () => currentLevel,
};

module.exports = { logger };
