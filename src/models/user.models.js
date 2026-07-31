'use strict';
const mongoose = require('mongoose');
const { Schema, baseOptions } = require('./common');

const userSchema = new Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  name: { type: String, trim: true },
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
  active: { type: Boolean, default: true },
  lastLoginAt: { type: Date },
}, baseOptions);

module.exports = { User: mongoose.model('User', userSchema) };
