'use strict';

const GenericProvider = require('./generic');

/**
 * Static secret implementation of the Generic provider
 */
class SecretProvider extends GenericProvider {
    /**
   * Create a new instance of the `SecretProvider`.
   *
   * @param {string} path
   * @param {string} token
   */
  constructor(path, token) {
    super(`secret/${path}`, token);
  }
}

module.exports = SecretProvider;
