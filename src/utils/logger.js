'use strict';
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const active = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function emit(level, ns, args) {
  if (LEVELS[level] > active) return;
  const tag = `[${level}]${ns ? `[${ns}]` : ''}`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(tag, ...args);
}

function make(ns) {
  return {
    error: (...a) => emit('error', ns, a),
    warn: (...a) => emit('warn', ns, a),
    info: (...a) => emit('info', ns, a),
    debug: (...a) => emit('debug', ns, a),
    child: (sub) => make(ns ? `${ns}:${sub}` : sub),
  };
}

module.exports = make('');
