'use strict';

class AutomationError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = this.constructor.name;
    this.meta = meta;
  }
}

class LoginError extends AutomationError {}
class SessionExpiredError extends AutomationError {}
class NavigationError extends AutomationError {}
class ExtractionError extends AutomationError {}

module.exports = { AutomationError, LoginError, SessionExpiredError, NavigationError, ExtractionError };
