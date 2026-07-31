'use strict';
// Self-contained auth (no external deps): scrypt password hashing + HMAC-signed JWT-style tokens.
const crypto = require('crypto');
const env = require('../../config/env');

const SECRET = env.auth.secret;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (obj) => b64url(JSON.stringify(obj));
const signPart = (part) => crypto.createHmac('sha256', SECRET).update(part).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function signToken(payload, { expiresInSec = env.auth.tokenTtlSec } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSec };
  const head = `${b64urlJson({ alg: 'HS256', typ: 'JWT' })}.${b64urlJson(body)}`;
  return `${head}.${signPart(head)}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;
  const expected = signPart(`${h}.${b}`);
  const sBuf = Buffer.from(s);
  const eBuf = Buffer.from(expected);
  if (sBuf.length !== eBuf.length || !crypto.timingSafeEqual(sBuf, eBuf)) return null;
  let body;
  try { body = JSON.parse(Buffer.from(b.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch (e) { return null; }
  if (body.exp && Math.floor(Date.now() / 1000) > body.exp) return null;
  return body;
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
