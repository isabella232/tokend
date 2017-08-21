'use strict';

const Vault = require('node-vault');
const promisify = require('./../utils/promisify');
const http = require('http');
const STATUS_CODES = require('./../control/util/status-codes');
const metadata = require('./../utils/metadata').metadata;
const preconditions = require('conditional');
const checkNotNull = preconditions.checkNotNull;

const METADATA_ENDPOINTS = [
  '/latest/dynamic/instance-identity/document',
  '/latest/dynamic/instance-identity/signature',
  '/latest/dynamic/instance-identity/pkcs7'
];

// Default Vault connection options
const DEFAULT_VAULT_PORT = Config.get('vault:port');
const DEFAULT_VAULT_HOST = Config.get('vault:host');
const DEFAULT_VAULT_TLS = Config.get('vault:tls');

// Default Warden connection options
const DEFAULT_WARDEN_HOST = Config.get('warden:host');
const DEFAULT_WARDEN_PORT = Config.get('warden:port');
const DEFAULT_WARDEN_PATH = Config.get('warden:path');

const VAULT_TOKEN_RENEW_INCREMENT = Config.get('vault:token_renew_increment');

/**
 * Provider type for Vault tokens
 *
 * This class is responsible for managing the coordination between Tokend, Warden, and Vault.
 */
class TokenProvider {
  /**
   * Constructor
   * @param {string} secret
   * @param {string} token
   * @param {object} [options]
   * @param {string} [options.metadata.host]
   * @param {AWS.MetadataService} [options.metadata.client]
   * @param {string} [options.vault.endpoint]
   * @param {Vault} [options.vault.client]
   * @param {string} [options.warden.host]
   * @param {number} [options.warden.port]
   * @returns {TokenProvider}
   */
  constructor(secret, token, options) {
    // Secret and token are required arguments based on how providers are instantiated in
    // StorageService#_getLeaseManager() and we need access to the options arg
    checkNotNull(secret, 'secret argument is required');
    checkNotNull(token, 'token argument is required');

    const opts = options || {};

    // Set metadata options
    this._metadata = metadata(opts);

    let client = null;

    // Set Vault connection options

    const vault = {
      endpoint: `${(DEFAULT_VAULT_TLS) ? 'https' : 'http'}://${DEFAULT_VAULT_HOST}:${DEFAULT_VAULT_PORT}`,
      token
    };

    if (opts.vault) {
      vault.endpoint = opts.vault.endpoint;
      client = opts.vault.client;
    }

    this._client = (!!client) ? client : new Vault(vault);

    // Set Warden connection options
    this._warden = {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      hostname: DEFAULT_WARDEN_HOST,
      port: DEFAULT_WARDEN_PORT,
      path: DEFAULT_WARDEN_PATH
    };

    if (opts.warden) {
      this._warden.hostname = opts.warden.host;
      this._warden.port = opts.warden.port;
    }

    this.token = null;
    this.data = null;
    this.creation_time = null;
    this.expiration_time = null;

    return this;
  }

  /**
   * Gets the initial authenticated Vault token
   *
   * POSTs the instance identity data to Warden and then parses
   * the response to return a token.
   *
   * @returns {Promise}
   */
  initialize() {
    if (this.data) {
      return Promise.resolve(this.data);
    }

    return this._getDocument()
      .then((data) => this._sendDocument(data))
      .then((data) => {
        const token = data.client_token;

        this.expiration_time = new Date(data.expiration_time).getTime();
        this.creation_time = new Date(data.creation_time).getTime();
        this.token = token;
        this.data = {
          lease_id: token,
          lease_duration: data.lease_duration,
          data: {
            token
          }
        };

        this._client.token = token;

        return this.data;
      });
  }

  /**
   * Renews the Vault auth token
   * @returns {Promise}
   */
  renew() {
    if (!this.token) {
      return Promise.reject(new Error('This token provider has not been initialized or has not received a valid' +
          ' token from' +
          ' Warden.'));
    }


    return this._client.tokenRenew({
      token: this.token,
      increment: VAULT_TOKEN_RENEW_INCREMENT
    }).then((data) => {
      this.data = {
        lease_duration: data.auth.lease_duration,
        data: {
          token: data.auth.client_token
        }
      };

      return this.data;
    }).catch((err) => {
      // Only consider StatusCodeError to be a failing condition. Anything else could be network
      // related or something else that we want to retry. StatusCodeError comes from request-promise which Vaulted
      // uses to hit Vault.
      if (err.name === 'StatusCodeError') {
        throw err;
      }

      // This is provider-specific
      Log.log('INFO', 'An error was thrown but was ignored', {
        provider: this.constructor.name,
        status: this.status,
        lease_duration: this.lease_duration,
        error: err
      });

      return this.data;
    });
  }

  /**
   * Removes cached data
   */
  invalidate() {
    this.data = null;
  }

  /**
   * Send the metadata instance identity document to Warden
   * @param {object} data
   * @returns {Promise}
   * @private
   */
  _sendDocument(data) {
    return this._post({
      document: data[0],
      signature: `-----BEGIN PKCS7-----\n${data[2]}\n-----END PKCS7-----\n`
    });
  }

  /**
   * Get the metadata instance identity document and signature
   * @returns {Promise}
   * @private
   */
  _getDocument() {
    return Promise.all(METADATA_ENDPOINTS.map((path) => { // eslint-disable-line arrow-body-style
      return promisify((done) => this._metadata.request(path, done));
    }));
  }

  /**
   * Sends the POST request wrapped in a Promise
   * @param {object} payload
   * @returns {Promise}
   * @private
   */
  _post(payload) {
    const payloadStr = JSON.stringify(payload);

    this._warden.headers['Content-Length'] = payloadStr.length;

    return new Promise((resolve, reject) => {
      const req = http.request(this._warden, (res) => {
        let body = '';

        res.setEncoding('utf8');
        res.on('data', (chunk) => body += chunk);
        res.on('end', (chunk) => {
          if (chunk) {
            body += chunk;
          }

          if (res.statusCode !== STATUS_CODES.OK) {
            reject(new Error(`${res.statusCode}: ${body}`));

            return;
          }

          let parsedBody;

          try {
            parsedBody = JSON.parse(body);
          } catch (ex) {
            req.emit('error', ex);

            return;
          }

          resolve(parsedBody);
        });
      }).on('error', (err) => reject(err));

      req.write(payloadStr);
      req.end();
    });
  }

  /**
   * Does the provider require a Vault token
   */
  requireVaultToken() { }
}

module.exports = TokenProvider;
