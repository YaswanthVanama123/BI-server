'use strict';
const mongoose = require('mongoose');
const { Schema, baseOptions } = require('./common');

const routeUserSchema = new Schema({
  routeCode: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  source: { type: String },
  asOf: { type: Date },
}, baseOptions);

module.exports = { RouteUser: mongoose.model('RouteUser', routeUserSchema) };
