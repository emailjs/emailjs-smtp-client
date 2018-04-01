'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }(); /* eslint-disable camelcase */

var _emailjsBase = require('emailjs-base64');

var _emailjsTcpSocket = require('emailjs-tcp-socket');

var _emailjsTcpSocket2 = _interopRequireDefault(_emailjsTcpSocket);

var _textEncoding = require('text-encoding');

var _parser = require('./parser');

var _parser2 = _interopRequireDefault(_parser);

var _logger = require('./logger');

var _logger2 = _interopRequireDefault(_logger);

var _common = require('./common');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var DEBUG_TAG = 'SMTP Client';

/**
 * Lower Bound for socket timeout to wait since the last data was written to a socket
 */
var TIMEOUT_SOCKET_LOWER_BOUND = 10000;

/**
 * Multiplier for socket timeout:
 *
 * We assume at least a GPRS connection with 115 kb/s = 14,375 kB/s tops, so 10 KB/s to be on
 * the safe side. We can timeout after a lower bound of 10s + (n KB / 10 KB/s). A 1 MB message
 * upload would be 110 seconds to wait for the timeout. 10 KB/s === 0.1 s/B
 */
var TIMEOUT_SOCKET_MULTIPLIER = 0.1;

var SmtpClient = function () {
  /**
   * Creates a connection object to a SMTP server and allows to send mail through it.
   * Call `connect` method to inititate the actual connection, the constructor only
   * defines the properties but does not actually connect.
   *
   * NB! The parameter order (host, port) differs from node.js "way" (port, host)
   *
   * @constructor
   *
   * @param {String} [host="localhost"] Hostname to conenct to
   * @param {Number} [port=25] Port number to connect to
   * @param {Object} [options] Optional options object
   * @param {Boolean} [options.useSecureTransport] Set to true, to use encrypted connection
   * @param {String} [options.name] Client hostname for introducing itself to the server
   * @param {Object} [options.auth] Authentication options. Depends on the preferred authentication method. Usually {user, pass}
   * @param {String} [options.authMethod] Force specific authentication method
   * @param {Boolean} [options.disableEscaping] If set to true, do not escape dots on the beginning of the lines
   */
  function SmtpClient(host, port) {
    var options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};

    _classCallCheck(this, SmtpClient);

    this.timeoutSocketLowerBound = TIMEOUT_SOCKET_LOWER_BOUND;
    this.timeoutSocketMultiplier = TIMEOUT_SOCKET_MULTIPLIER;

    this.port = port || (this.options.useSecureTransport ? 465 : 25);
    this.host = host || 'localhost';

    this.options = options;
    /**
     * If set to true, start an encrypted connection instead of the plaintext one
     * (recommended if applicable). If useSecureTransport is not set but the port used is 465,
     * then ecryption is used by default.
     */
    this.options.useSecureTransport = 'useSecureTransport' in this.options ? !!this.options.useSecureTransport : this.port === 465;

    this.options.auth = this.options.auth || false; // Authentication object. If not set, authentication step will be skipped.
    this.options.name = this.options.name || 'localhost'; // Hostname of the client, this will be used for introducing to the server
    this.socket = false; // Downstream TCP socket to the SMTP server, created with mozTCPSocket
    this.destroyed = false; // Indicates if the connection has been closed and can't be used anymore
    this.waitDrain = false; // Keeps track if the downstream socket is currently full and a drain event should be waited for or not

    // Private properties

    this._parser = new _parser2.default(); // SMTP response parser object. All data coming from the downstream server is feeded to this parser
    this._authenticatedAs = null; // If authenticated successfully, stores the username
    this._supportedAuth = []; // A list of authentication mechanisms detected from the EHLO response and which are compatible with this library
    this._dataMode = false; // If true, accepts data from the upstream to be passed directly to the downstream socket. Used after the DATA command
    this._lastDataBytes = ''; // Keep track of the last bytes to see how the terminating dot should be placed
    this._envelope = null; // Envelope object for tracking who is sending mail to whom
    this._currentAction = null; // Stores the function that should be run after a response has been received from the server
    this._secureMode = !!this.options.useSecureTransport; // Indicates if the connection is secured or plaintext
    this._socketTimeoutTimer = false; // Timer waiting to declare the socket dead starting from the last write
    this._socketTimeoutStart = false; // Start time of sending the first packet in data mode
    this._socketTimeoutPeriod = false; // Timeout for sending in data mode, gets extended with every send()

    // Activate logging
    this.createLogger();

    // Event placeholders
    this.onerror = function (e) {}; // Will be run when an error occurs. The `onclose` event will fire subsequently.
    this.ondrain = function () {}; // More data can be buffered in the socket.
    this.onclose = function () {}; // The connection to the server has been closed
    this.onidle = function () {}; // The connection is established and idle, you can send mail now
    this.onready = function (failedRecipients) {}; // Waiting for mail body, lists addresses that were not accepted as recipients
    this.ondone = function (success) {}; // The mail has been sent. Wait for `onidle` next. Indicates if the message was queued by the server.
  }

  /**
   * Initiate a connection to the server
   */


  _createClass(SmtpClient, [{
    key: 'connect',
    value: function connect() {
      var SocketContructor = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : _emailjsTcpSocket2.default;

      this.socket = SocketContructor.open(this.host, this.port, {
        binaryType: 'arraybuffer',
        useSecureTransport: this._secureMode,
        ca: this.options.ca,
        tlsWorkerPath: this.options.tlsWorkerPath,
        ws: this.options.ws
      });

      // allows certificate handling for platform w/o native tls support
      // oncert is non standard so setting it might throw if the socket object is immutable
      try {
        this.socket.oncert = this.oncert;
      } catch (E) {}
      this.socket.onerror = this._onError.bind(this);
      this.socket.onopen = this._onOpen.bind(this);
    }

    /**
     * Pauses `data` events from the downstream SMTP server
     */

  }, {
    key: 'suspend',
    value: function suspend() {
      if (this.socket && this.socket.readyState === 'open') {
        this.socket.suspend();
      }
    }

    /**
     * Resumes `data` events from the downstream SMTP server. Be careful of not
     * resuming something that is not suspended - an error is thrown in this case
     */

  }, {
    key: 'resume',
    value: function resume() {
      if (this.socket && this.socket.readyState === 'open') {
        this.socket.resume();
      }
    }

    /**
     * Sends QUIT
     */

  }, {
    key: 'quit',
    value: function quit() {
      this.logger.debug(DEBUG_TAG, 'Sending QUIT...');
      this._sendCommand('QUIT');
      this._currentAction = this.close;
    }

    /**
     * Reset authentication
     *
     * @param {Object} [auth] Use this if you want to authenticate as another user
     */

  }, {
    key: 'reset',
    value: function reset(auth) {
      this.options.auth = auth || this.options.auth;
      this.logger.debug(DEBUG_TAG, 'Sending RSET...');
      this._sendCommand('RSET');
      this._currentAction = this._actionRSET;
    }

    /**
     * Closes the connection to the server
     */

  }, {
    key: 'close',
    value: function close() {
      this.logger.debug(DEBUG_TAG, 'Closing connection...');
      if (this.socket && this.socket.readyState === 'open') {
        this.socket.close();
      } else {
        this._destroy();
      }
    }

    // Mail related methods

    /**
     * Initiates a new message by submitting envelope data, starting with
     * `MAIL FROM:` command. Use after `onidle` event
     *
     * @param {Object} envelope Envelope object in the form of {from:"...", to:["..."]}
     */

  }, {
    key: 'useEnvelope',
    value: function useEnvelope(envelope) {
      this._envelope = envelope || {};
      this._envelope.from = [].concat(this._envelope.from || 'anonymous@' + this.options.name)[0];
      this._envelope.to = [].concat(this._envelope.to || []);

      // clone the recipients array for latter manipulation
      this._envelope.rcptQueue = [].concat(this._envelope.to);
      this._envelope.rcptFailed = [];
      this._envelope.responseQueue = [];

      this._currentAction = this._actionMAIL;
      this.logger.debug(DEBUG_TAG, 'Sending MAIL FROM...');
      this._sendCommand('MAIL FROM:<' + this._envelope.from + '>');
    }

    /**
     * Send ASCII data to the server. Works only in data mode (after `onready` event), ignored
     * otherwise
     *
     * @param {String} chunk ASCII string (quoted-printable, base64 etc.) to be sent to the server
     * @return {Boolean} If true, it is safe to send more data, if false, you *should* wait for the ondrain event before sending more
     */

  }, {
    key: 'send',
    value: function send(chunk) {
      // works only in data mode
      if (!this._dataMode) {
        // this line should never be reached but if it does,
        // act like everything's normal.
        return true;
      }

      // TODO: if the chunk is an arraybuffer, use a separate function to send the data
      return this._sendString(chunk);
    }

    /**
     * Indicates that a data stream for the socket is ended. Works only in data
     * mode (after `onready` event), ignored otherwise. Use it when you are done
     * with sending the mail. This method does not close the socket. Once the mail
     * has been queued by the server, `ondone` and `onidle` are emitted.
     *
     * @param {Buffer} [chunk] Chunk of data to be sent to the server
     */

  }, {
    key: 'end',
    value: function end(chunk) {
      // works only in data mode
      if (!this._dataMode) {
        // this line should never be reached but if it does,
        // act like everything's normal.
        return true;
      }

      if (chunk && chunk.length) {
        this.send(chunk);
      }

      // redirect output from the server to _actionStream
      this._currentAction = this._actionStream;

      // indicate that the stream has ended by sending a single dot on its own line
      // if the client already closed the data with \r\n no need to do it again
      if (this._lastDataBytes === '\r\n') {
        this.waitDrain = this._send(new Uint8Array([0x2E, 0x0D, 0x0A]).buffer); // .\r\n
      } else if (this._lastDataBytes.substr(-1) === '\r') {
        this.waitDrain = this._send(new Uint8Array([0x0A, 0x2E, 0x0D, 0x0A]).buffer); // \n.\r\n
      } else {
        this.waitDrain = this._send(new Uint8Array([0x0D, 0x0A, 0x2E, 0x0D, 0x0A]).buffer); // \r\n.\r\n
      }

      // end data mode, reset the variables for extending the timeout in data mode
      this._dataMode = false;
      this._socketTimeoutStart = false;
      this._socketTimeoutPeriod = false;

      return this.waitDrain;
    }

    // PRIVATE METHODS

    // EVENT HANDLERS FOR THE SOCKET

    /**
     * Connection listener that is run when the connection to the server is opened.
     * Sets up different event handlers for the opened socket
     *
     * @event
     * @param {Event} evt Event object. Not used
     */

  }, {
    key: '_onOpen',
    value: function _onOpen(event) {
      if (event && event.data && event.data.proxyHostname) {
        this.options.name = event.data.proxyHostname;
      }

      this.socket.ondata = this._onData.bind(this);

      this.socket.onclose = this._onClose.bind(this);
      this.socket.ondrain = this._onDrain.bind(this);

      this._parser.ondata = this._onCommand.bind(this);

      this._currentAction = this._actionGreeting;
    }

    /**
     * Data listener for chunks of data emitted by the server
     *
     * @event
     * @param {Event} evt Event object. See `evt.data` for the chunk received
     */

  }, {
    key: '_onData',
    value: function _onData(evt) {
      clearTimeout(this._socketTimeoutTimer);
      var stringPayload = new _textEncoding.TextDecoder('UTF-8').decode(new Uint8Array(evt.data));
      this.logger.debug(DEBUG_TAG, 'SERVER: ' + stringPayload);
      this._parser.send(stringPayload);
    }

    /**
     * More data can be buffered in the socket, `waitDrain` is reset to false
     *
     * @event
     * @param {Event} evt Event object. Not used
     */

  }, {
    key: '_onDrain',
    value: function _onDrain() {
      this.waitDrain = false;
      this.ondrain();
    }

    /**
     * Error handler for the socket
     *
     * @event
     * @param {Event} evt Event object. See evt.data for the error
     */

  }, {
    key: '_onError',
    value: function _onError(evt) {
      if (evt instanceof Error && evt.message) {
        this.logger.error(DEBUG_TAG, evt);
        this.onerror(evt);
      } else if (evt && evt.data instanceof Error) {
        this.logger.error(DEBUG_TAG, evt.data);
        this.onerror(evt.data);
      } else {
        this.logger.error(DEBUG_TAG, new Error(evt && evt.data && evt.data.message || evt.data || evt || 'Error'));
        this.onerror(new Error(evt && evt.data && evt.data.message || evt.data || evt || 'Error'));
      }

      this.close();
    }

    /**
     * Indicates that the socket has been closed
     *
     * @event
     * @param {Event} evt Event object. Not used
     */

  }, {
    key: '_onClose',
    value: function _onClose() {
      this.logger.debug(DEBUG_TAG, 'Socket closed.');
      this._destroy();
    }

    /**
     * This is not a socket data handler but the handler for data emitted by the parser,
     * so this data is safe to use as it is always complete (server might send partial chunks)
     *
     * @event
     * @param {Object} command Parsed data
     */

  }, {
    key: '_onCommand',
    value: function _onCommand(command) {
      if (typeof this._currentAction === 'function') {
        this._currentAction(command);
      }
    }
  }, {
    key: '_onTimeout',
    value: function _onTimeout() {
      // inform about the timeout and shut down
      var error = new Error('Socket timed out!');
      this._onError(error);
    }

    /**
     * Ensures that the connection is closed and such
     */

  }, {
    key: '_destroy',
    value: function _destroy() {
      clearTimeout(this._socketTimeoutTimer);

      if (!this.destroyed) {
        this.destroyed = true;
        this.onclose();
      }
    }

    /**
     * Sends a string to the socket.
     *
     * @param {String} chunk ASCII string (quoted-printable, base64 etc.) to be sent to the server
     * @return {Boolean} If true, it is safe to send more data, if false, you *should* wait for the ondrain event before sending more
     */

  }, {
    key: '_sendString',
    value: function _sendString(chunk) {
      // escape dots
      if (!this.options.disableEscaping) {
        chunk = chunk.replace(/\n\./g, '\n..');
        if ((this._lastDataBytes.substr(-1) === '\n' || !this._lastDataBytes) && chunk.charAt(0) === '.') {
          chunk = '.' + chunk;
        }
      }

      // Keeping eye on the last bytes sent, to see if there is a <CR><LF> sequence
      // at the end which is needed to end the data stream
      if (chunk.length > 2) {
        this._lastDataBytes = chunk.substr(-2);
      } else if (chunk.length === 1) {
        this._lastDataBytes = this._lastDataBytes.substr(-1) + chunk;
      }

      this.logger.debug(DEBUG_TAG, 'Sending ' + chunk.length + ' bytes of payload');

      // pass the chunk to the socket
      this.waitDrain = this._send(new _textEncoding.TextEncoder('UTF-8').encode(chunk).buffer);
      return this.waitDrain;
    }

    /**
     * Send a string command to the server, also append \r\n if needed
     *
     * @param {String} str String to be sent to the server
     */

  }, {
    key: '_sendCommand',
    value: function _sendCommand(str) {
      this.waitDrain = this._send(new _textEncoding.TextEncoder('UTF-8').encode(str + (str.substr(-2) !== '\r\n' ? '\r\n' : '')).buffer);
    }
  }, {
    key: '_send',
    value: function _send(buffer) {
      this._setTimeout(buffer.byteLength);
      return this.socket.send(buffer);
    }
  }, {
    key: '_setTimeout',
    value: function _setTimeout(byteLength) {
      var prolongPeriod = Math.floor(byteLength * this.timeoutSocketMultiplier);
      var timeout;

      if (this._dataMode) {
        // we're in data mode, so we count only one timeout that get extended for every send().
        var now = Date.now();

        // the old timeout start time
        this._socketTimeoutStart = this._socketTimeoutStart || now;

        // the old timeout period, normalized to a minimum of TIMEOUT_SOCKET_LOWER_BOUND
        this._socketTimeoutPeriod = (this._socketTimeoutPeriod || this.timeoutSocketLowerBound) + prolongPeriod;

        // the new timeout is the delta between the new firing time (= timeout period + timeout start time) and now
        timeout = this._socketTimeoutStart + this._socketTimeoutPeriod - now;
      } else {
        // set new timout
        timeout = this.timeoutSocketLowerBound + prolongPeriod;
      }

      clearTimeout(this._socketTimeoutTimer); // clear pending timeouts
      this._socketTimeoutTimer = setTimeout(this._onTimeout.bind(this), timeout); // arm the next timeout
    }

    /**
     * Intitiate authentication sequence if needed
     */

  }, {
    key: '_authenticateUser',
    value: function _authenticateUser() {
      if (!this.options.auth) {
        // no need to authenticate, at least no data given
        this._currentAction = this._actionIdle;
        this.onidle(); // ready to take orders
        return;
      }

      var auth;

      if (!this.options.authMethod && this.options.auth.xoauth2) {
        this.options.authMethod = 'XOAUTH2';
      }

      if (this.options.authMethod) {
        auth = this.options.authMethod.toUpperCase().trim();
      } else {
        // use first supported
        auth = (this._supportedAuth[0] || 'PLAIN').toUpperCase().trim();
      }

      switch (auth) {
        case 'LOGIN':
          // LOGIN is a 3 step authentication process
          // C: AUTH LOGIN
          // C: BASE64(USER)
          // C: BASE64(PASS)
          this.logger.debug(DEBUG_TAG, 'Authentication via AUTH LOGIN');
          this._currentAction = this._actionAUTH_LOGIN_USER;
          this._sendCommand('AUTH LOGIN');
          return;
        case 'PLAIN':
          // AUTH PLAIN is a 1 step authentication process
          // C: AUTH PLAIN BASE64(\0 USER \0 PASS)
          this.logger.debug(DEBUG_TAG, 'Authentication via AUTH PLAIN');
          this._currentAction = this._actionAUTHComplete;
          this._sendCommand(
          // convert to BASE64
          'AUTH PLAIN ' + (0, _emailjsBase.encode)(
          // this.options.auth.user+'\u0000'+
          '\0' + // skip authorization identity as it causes problems with some servers
          this.options.auth.user + '\0' + this.options.auth.pass));
          return;
        case 'XOAUTH2':
          // See https://developers.google.com/gmail/xoauth2_protocol#smtp_protocol_exchange
          this.logger.debug(DEBUG_TAG, 'Authentication via AUTH XOAUTH2');
          this._currentAction = this._actionAUTH_XOAUTH2;
          this._sendCommand('AUTH XOAUTH2 ' + this._buildXOAuth2Token(this.options.auth.user, this.options.auth.xoauth2));
          return;
      }

      this._onError(new Error('Unknown authentication method ' + auth));
    }

    // ACTIONS FOR RESPONSES FROM THE SMTP SERVER

    /**
     * Initial response from the server, must have a status 220
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionGreeting',
    value: function _actionGreeting(command) {
      if (command.statusCode !== 220) {
        this._onError(new Error('Invalid greeting: ' + command.data));
        return;
      }

      if (this.options.lmtp) {
        this.logger.debug(DEBUG_TAG, 'Sending LHLO ' + this.options.name);

        this._currentAction = this._actionLHLO;
        this._sendCommand('LHLO ' + this.options.name);
      } else {
        this.logger.debug(DEBUG_TAG, 'Sending EHLO ' + this.options.name);

        this._currentAction = this._actionEHLO;
        this._sendCommand('EHLO ' + this.options.name);
      }
    }

    /**
     * Response to LHLO
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionLHLO',
    value: function _actionLHLO(command) {
      if (!command.success) {
        this.logger.error(DEBUG_TAG, 'LHLO not successful');
        this._onError(new Error(command.data));
        return;
      }

      // Process as EHLO response
      this._actionEHLO(command);
    }

    /**
     * Response to EHLO. If the response is an error, try HELO instead
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionEHLO',
    value: function _actionEHLO(command) {
      var match;

      if (!command.success) {
        if (!this._secureMode && this.options.requireTLS) {
          var errMsg = 'STARTTLS not supported without EHLO';
          this.logger.error(DEBUG_TAG, errMsg);
          this._onError(new Error(errMsg));
          return;
        }

        // Try HELO instead
        this.logger.warn(DEBUG_TAG, 'EHLO not successful, trying HELO ' + this.options.name);
        this._currentAction = this._actionHELO;
        this._sendCommand('HELO ' + this.options.name);
        return;
      }

      // Detect if the server supports PLAIN auth
      if (command.line.match(/AUTH(?:\s+[^\n]*\s+|\s+)PLAIN/i)) {
        this.logger.debug(DEBUG_TAG, 'Server supports AUTH PLAIN');
        this._supportedAuth.push('PLAIN');
      }

      // Detect if the server supports LOGIN auth
      if (command.line.match(/AUTH(?:\s+[^\n]*\s+|\s+)LOGIN/i)) {
        this.logger.debug(DEBUG_TAG, 'Server supports AUTH LOGIN');
        this._supportedAuth.push('LOGIN');
      }

      // Detect if the server supports XOAUTH2 auth
      if (command.line.match(/AUTH(?:\s+[^\n]*\s+|\s+)XOAUTH2/i)) {
        this.logger.debug(DEBUG_TAG, 'Server supports AUTH XOAUTH2');
        this._supportedAuth.push('XOAUTH2');
      }

      // Detect maximum allowed message size
      if ((match = command.line.match(/SIZE (\d+)/i)) && Number(match[1])) {
        var maxAllowedSize = Number(match[1]);
        this.logger.debug(DEBUG_TAG, 'Maximum allowd message size: ' + maxAllowedSize);
      }

      // Detect if the server supports STARTTLS
      if (!this._secureMode) {
        if (command.line.match(/[ -]STARTTLS\s?$/mi) && !this.options.ignoreTLS || !!this.options.requireTLS) {
          this._currentAction = this._actionSTARTTLS;
          this.logger.debug(DEBUG_TAG, 'Sending STARTTLS');
          this._sendCommand('STARTTLS');
          return;
        }
      }

      this._authenticateUser();
    }

    /**
     * Handles server response for STARTTLS command. If there's an error
     * try HELO instead, otherwise initiate TLS upgrade. If the upgrade
     * succeedes restart the EHLO
     *
     * @param {String} str Message from the server
     */

  }, {
    key: '_actionSTARTTLS',
    value: function _actionSTARTTLS(command) {
      if (!command.success) {
        this.logger.error(DEBUG_TAG, 'STARTTLS not successful');
        this._onError(new Error(command.data));
        return;
      }

      this._secureMode = true;
      this.socket.upgradeToSecure();

      // restart protocol flow
      this._currentAction = this._actionEHLO;
      this._sendCommand('EHLO ' + this.options.name);
    }

    /**
     * Response to HELO
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionHELO',
    value: function _actionHELO(command) {
      if (!command.success) {
        this.logger.error(DEBUG_TAG, 'HELO not successful');
        this._onError(new Error(command.data));
        return;
      }
      this._authenticateUser();
    }

    /**
     * Response to AUTH LOGIN, if successful expects base64 encoded username
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionAUTH_LOGIN_USER',
    value: function _actionAUTH_LOGIN_USER(command) {
      if (command.statusCode !== 334 || command.data !== 'VXNlcm5hbWU6') {
        this.logger.error(DEBUG_TAG, 'AUTH LOGIN USER not successful: ' + command.data);
        this._onError(new Error('Invalid login sequence while waiting for "334 VXNlcm5hbWU6 ": ' + command.data));
        return;
      }
      this.logger.debug(DEBUG_TAG, 'AUTH LOGIN USER successful');
      this._currentAction = this._actionAUTH_LOGIN_PASS;
      this._sendCommand((0, _emailjsBase.encode)(this.options.auth.user));
    }

    /**
     * Response to AUTH LOGIN username, if successful expects base64 encoded password
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionAUTH_LOGIN_PASS',
    value: function _actionAUTH_LOGIN_PASS(command) {
      if (command.statusCode !== 334 || command.data !== 'UGFzc3dvcmQ6') {
        this.logger.error(DEBUG_TAG, 'AUTH LOGIN PASS not successful: ' + command.data);
        this._onError(new Error('Invalid login sequence while waiting for "334 UGFzc3dvcmQ6 ": ' + command.data));
        return;
      }
      this.logger.debug(DEBUG_TAG, 'AUTH LOGIN PASS successful');
      this._currentAction = this._actionAUTHComplete;
      this._sendCommand((0, _emailjsBase.encode)(this.options.auth.pass));
    }

    /**
     * Response to AUTH XOAUTH2 token, if error occurs send empty response
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionAUTH_XOAUTH2',
    value: function _actionAUTH_XOAUTH2(command) {
      if (!command.success) {
        this.logger.warn(DEBUG_TAG, 'Error during AUTH XOAUTH2, sending empty response');
        this._sendCommand('');
        this._currentAction = this._actionAUTHComplete;
      } else {
        this._actionAUTHComplete(command);
      }
    }

    /**
     * Checks if authentication succeeded or not. If successfully authenticated
     * emit `idle` to indicate that an e-mail can be sent using this connection
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionAUTHComplete',
    value: function _actionAUTHComplete(command) {
      if (!command.success) {
        this.logger.debug(DEBUG_TAG, 'Authentication failed: ' + command.data);
        this._onError(new Error(command.data));
        return;
      }

      this.logger.debug(DEBUG_TAG, 'Authentication successful.');

      this._authenticatedAs = this.options.auth.user;

      this._currentAction = this._actionIdle;
      this.onidle(); // ready to take orders
    }

    /**
     * Used when the connection is idle and the server emits timeout
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionIdle',
    value: function _actionIdle(command) {
      if (command.statusCode > 300) {
        this._onError(new Error(command.line));
        return;
      }

      this._onError(new Error(command.data));
    }

    /**
     * Response to MAIL FROM command. Proceed to defining RCPT TO list if successful
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionMAIL',
    value: function _actionMAIL(command) {
      if (!command.success) {
        this.logger.debug(DEBUG_TAG, 'MAIL FROM unsuccessful: ' + command.data);
        this._onError(new Error(command.data));
        return;
      }

      if (!this._envelope.rcptQueue.length) {
        this._onError(new Error('Can\'t send mail - no recipients defined'));
      } else {
        this.logger.debug(DEBUG_TAG, 'MAIL FROM successful, proceeding with ' + this._envelope.rcptQueue.length + ' recipients');
        this.logger.debug(DEBUG_TAG, 'Adding recipient...');
        this._envelope.curRecipient = this._envelope.rcptQueue.shift();
        this._currentAction = this._actionRCPT;
        this._sendCommand('RCPT TO:<' + this._envelope.curRecipient + '>');
      }
    }

    /**
     * Response to a RCPT TO command. If the command is unsuccessful, try the next one,
     * as this might be related only to the current recipient, not a global error, so
     * the following recipients might still be valid
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionRCPT',
    value: function _actionRCPT(command) {
      if (!command.success) {
        this.logger.warn(DEBUG_TAG, 'RCPT TO failed for: ' + this._envelope.curRecipient);
        // this is a soft error
        this._envelope.rcptFailed.push(this._envelope.curRecipient);
      } else {
        this._envelope.responseQueue.push(this._envelope.curRecipient);
      }

      if (!this._envelope.rcptQueue.length) {
        if (this._envelope.rcptFailed.length < this._envelope.to.length) {
          this._currentAction = this._actionDATA;
          this.logger.debug(DEBUG_TAG, 'RCPT TO done, proceeding with payload');
          this._sendCommand('DATA');
        } else {
          this._onError(new Error('Can\'t send mail - all recipients were rejected'));
          this._currentAction = this._actionIdle;
        }
      } else {
        this.logger.debug(DEBUG_TAG, 'Adding recipient...');
        this._envelope.curRecipient = this._envelope.rcptQueue.shift();
        this._currentAction = this._actionRCPT;
        this._sendCommand('RCPT TO:<' + this._envelope.curRecipient + '>');
      }
    }

    /**
     * Response to the RSET command. If successful, clear the current authentication
     * information and reauthenticate.
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionRSET',
    value: function _actionRSET(command) {
      if (!command.success) {
        this.logger.error(DEBUG_TAG, 'RSET unsuccessful ' + command.data);
        this._onError(new Error(command.data));
        return;
      }

      this._authenticatedAs = null;
      this._authenticateUser();
    }

    /**
     * Response to the DATA command. Server is now waiting for a message, so emit `onready`
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionDATA',
    value: function _actionDATA(command) {
      // response should be 354 but according to this issue https://github.com/eleith/emailjs/issues/24
      // some servers might use 250 instead
      if ([250, 354].indexOf(command.statusCode) < 0) {
        this.logger.error(DEBUG_TAG, 'DATA unsuccessful ' + command.data);
        this._onError(new Error(command.data));
        return;
      }

      this._dataMode = true;
      this._currentAction = this._actionIdle;
      this.onready(this._envelope.rcptFailed);
    }

    /**
     * Response from the server, once the message stream has ended with <CR><LF>.<CR><LF>
     * Emits `ondone`.
     *
     * @param {Object} command Parsed command from the server {statusCode, data, line}
     */

  }, {
    key: '_actionStream',
    value: function _actionStream(command) {
      var rcpt;

      if (this.options.lmtp) {
        // LMTP returns a response code for *every* successfully set recipient
        // For every recipient the message might succeed or fail individually

        rcpt = this._envelope.responseQueue.shift();
        if (!command.success) {
          this.logger.error(DEBUG_TAG, 'Local delivery to ' + rcpt + ' failed.');
          this._envelope.rcptFailed.push(rcpt);
        } else {
          this.logger.error(DEBUG_TAG, 'Local delivery to ' + rcpt + ' succeeded.');
        }

        if (this._envelope.responseQueue.length) {
          this._currentAction = this._actionStream;
          return;
        }

        this._currentAction = this._actionIdle;
        this.ondone(true);
      } else {
        // For SMTP the message either fails or succeeds, there is no information
        // about individual recipients

        if (!command.success) {
          this.logger.error(DEBUG_TAG, 'Message sending failed.');
        } else {
          this.logger.debug(DEBUG_TAG, 'Message sent successfully.');
        }

        this._currentAction = this._actionIdle;
        this.ondone(!!command.success);
      }

      // If the client wanted to do something else (eg. to quit), do not force idle
      if (this._currentAction === this._actionIdle) {
        // Waiting for new connections
        this.logger.debug(DEBUG_TAG, 'Idling while waiting for new connections...');
        this.onidle();
      }
    }

    /**
     * Builds a login token for XOAUTH2 authentication command
     *
     * @param {String} user E-mail address of the user
     * @param {String} token Valid access token for the user
     * @return {String} Base64 formatted login token
     */

  }, {
    key: '_buildXOAuth2Token',
    value: function _buildXOAuth2Token(user, token) {
      var authData = ['user=' + (user || ''), 'auth=Bearer ' + token, '', ''];
      // base64("user={User}\x00auth=Bearer {Token}\x00\x00")
      return (0, _emailjsBase.encode)(authData.join('\x01'));
    }
  }, {
    key: 'createLogger',
    value: function createLogger() {
      var _this = this;

      var creator = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : _logger2.default;

      var logger = creator((this.options.auth || {}).user || '', this.host);
      this.logLevel = this.LOG_LEVEL_ALL;
      this.logger = {
        debug: function debug() {
          for (var _len = arguments.length, msgs = Array(_len), _key = 0; _key < _len; _key++) {
            msgs[_key] = arguments[_key];
          }

          if (_common.LOG_LEVEL_DEBUG >= _this.logLevel) {
            logger.debug(msgs);
          }
        },
        info: function info() {
          for (var _len2 = arguments.length, msgs = Array(_len2), _key2 = 0; _key2 < _len2; _key2++) {
            msgs[_key2] = arguments[_key2];
          }

          if (_common.LOG_LEVEL_INFO >= _this.logLevel) {
            logger.info(msgs);
          }
        },
        warn: function warn() {
          for (var _len3 = arguments.length, msgs = Array(_len3), _key3 = 0; _key3 < _len3; _key3++) {
            msgs[_key3] = arguments[_key3];
          }

          if (_common.LOG_LEVEL_WARN >= _this.logLevel) {
            logger.warn(msgs);
          }
        },
        error: function error() {
          for (var _len4 = arguments.length, msgs = Array(_len4), _key4 = 0; _key4 < _len4; _key4++) {
            msgs[_key4] = arguments[_key4];
          }

          if (_common.LOG_LEVEL_ERROR >= _this.logLevel) {
            logger.error(msgs);
          }
        }
      };
    }
  }]);

  return SmtpClient;
}();

exports.default = SmtpClient;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9jbGllbnQuanMiXSwibmFtZXMiOlsiREVCVUdfVEFHIiwiVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkQiLCJUSU1FT1VUX1NPQ0tFVF9NVUxUSVBMSUVSIiwiU210cENsaWVudCIsImhvc3QiLCJwb3J0Iiwib3B0aW9ucyIsInRpbWVvdXRTb2NrZXRMb3dlckJvdW5kIiwidGltZW91dFNvY2tldE11bHRpcGxpZXIiLCJ1c2VTZWN1cmVUcmFuc3BvcnQiLCJhdXRoIiwibmFtZSIsInNvY2tldCIsImRlc3Ryb3llZCIsIndhaXREcmFpbiIsIl9wYXJzZXIiLCJfYXV0aGVudGljYXRlZEFzIiwiX3N1cHBvcnRlZEF1dGgiLCJfZGF0YU1vZGUiLCJfbGFzdERhdGFCeXRlcyIsIl9lbnZlbG9wZSIsIl9jdXJyZW50QWN0aW9uIiwiX3NlY3VyZU1vZGUiLCJfc29ja2V0VGltZW91dFRpbWVyIiwiX3NvY2tldFRpbWVvdXRTdGFydCIsIl9zb2NrZXRUaW1lb3V0UGVyaW9kIiwiY3JlYXRlTG9nZ2VyIiwib25lcnJvciIsImUiLCJvbmRyYWluIiwib25jbG9zZSIsIm9uaWRsZSIsIm9ucmVhZHkiLCJmYWlsZWRSZWNpcGllbnRzIiwib25kb25lIiwic3VjY2VzcyIsIlNvY2tldENvbnRydWN0b3IiLCJvcGVuIiwiYmluYXJ5VHlwZSIsImNhIiwidGxzV29ya2VyUGF0aCIsIndzIiwib25jZXJ0IiwiRSIsIl9vbkVycm9yIiwiYmluZCIsIm9ub3BlbiIsIl9vbk9wZW4iLCJyZWFkeVN0YXRlIiwic3VzcGVuZCIsInJlc3VtZSIsImxvZ2dlciIsImRlYnVnIiwiX3NlbmRDb21tYW5kIiwiY2xvc2UiLCJfYWN0aW9uUlNFVCIsIl9kZXN0cm95IiwiZW52ZWxvcGUiLCJmcm9tIiwiY29uY2F0IiwidG8iLCJyY3B0UXVldWUiLCJyY3B0RmFpbGVkIiwicmVzcG9uc2VRdWV1ZSIsIl9hY3Rpb25NQUlMIiwiY2h1bmsiLCJfc2VuZFN0cmluZyIsImxlbmd0aCIsInNlbmQiLCJfYWN0aW9uU3RyZWFtIiwiX3NlbmQiLCJVaW50OEFycmF5IiwiYnVmZmVyIiwic3Vic3RyIiwiZXZlbnQiLCJkYXRhIiwicHJveHlIb3N0bmFtZSIsIm9uZGF0YSIsIl9vbkRhdGEiLCJfb25DbG9zZSIsIl9vbkRyYWluIiwiX29uQ29tbWFuZCIsIl9hY3Rpb25HcmVldGluZyIsImV2dCIsImNsZWFyVGltZW91dCIsInN0cmluZ1BheWxvYWQiLCJkZWNvZGUiLCJFcnJvciIsIm1lc3NhZ2UiLCJlcnJvciIsImNvbW1hbmQiLCJkaXNhYmxlRXNjYXBpbmciLCJyZXBsYWNlIiwiY2hhckF0IiwiZW5jb2RlIiwic3RyIiwiX3NldFRpbWVvdXQiLCJieXRlTGVuZ3RoIiwicHJvbG9uZ1BlcmlvZCIsIk1hdGgiLCJmbG9vciIsInRpbWVvdXQiLCJub3ciLCJEYXRlIiwic2V0VGltZW91dCIsIl9vblRpbWVvdXQiLCJfYWN0aW9uSWRsZSIsImF1dGhNZXRob2QiLCJ4b2F1dGgyIiwidG9VcHBlckNhc2UiLCJ0cmltIiwiX2FjdGlvbkFVVEhfTE9HSU5fVVNFUiIsIl9hY3Rpb25BVVRIQ29tcGxldGUiLCJ1c2VyIiwicGFzcyIsIl9hY3Rpb25BVVRIX1hPQVVUSDIiLCJfYnVpbGRYT0F1dGgyVG9rZW4iLCJzdGF0dXNDb2RlIiwibG10cCIsIl9hY3Rpb25MSExPIiwiX2FjdGlvbkVITE8iLCJtYXRjaCIsInJlcXVpcmVUTFMiLCJlcnJNc2ciLCJ3YXJuIiwiX2FjdGlvbkhFTE8iLCJsaW5lIiwicHVzaCIsIk51bWJlciIsIm1heEFsbG93ZWRTaXplIiwiaWdub3JlVExTIiwiX2FjdGlvblNUQVJUVExTIiwiX2F1dGhlbnRpY2F0ZVVzZXIiLCJ1cGdyYWRlVG9TZWN1cmUiLCJfYWN0aW9uQVVUSF9MT0dJTl9QQVNTIiwiY3VyUmVjaXBpZW50Iiwic2hpZnQiLCJfYWN0aW9uUkNQVCIsIl9hY3Rpb25EQVRBIiwiaW5kZXhPZiIsInJjcHQiLCJ0b2tlbiIsImF1dGhEYXRhIiwiam9pbiIsImNyZWF0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QW1CLE1BQUtGLFFBQTVCLEVBQXNDO0FBQUU5RixtQkFBT0MsS0FBUCxDQUFhK0YsSUFBYjtBQUFvQjtBQUFFLFNBRHhFO0FBRVpDLGNBQU0sZ0JBQWE7QUFBQSw2Q0FBVEQsSUFBUztBQUFUQSxnQkFBUztBQUFBOztBQUFFLGNBQUksMEJBQWtCLE1BQUtGLFFBQTNCLEVBQXFDO0FBQUU5RixtQkFBT2lHLElBQVAsQ0FBWUQsSUFBWjtBQUFtQjtBQUFFLFNBRnJFO0FBR1p2QixjQUFNLGdCQUFhO0FBQUEsNkNBQVR1QixJQUFTO0FBQVRBLGdCQUFTO0FBQUE7O0FBQUUsY0FBSSwwQkFBa0IsTUFBS0YsUUFBM0IsRUFBcUM7QUFBRTlGLG1CQUFPeUUsSUFBUCxDQUFZdUIsSUFBWjtBQUFtQjtBQUFFLFNBSHJFO0FBSVoxRCxlQUFPLGlCQUFhO0FBQUEsNkNBQVQwRCxJQUFTO0FBQVRBLGdCQUFTO0FBQUE7O0FBQUUsY0FBSSwyQkFBbUIsTUFBS0YsUUFBNUIsRUFBc0M7QUFBRTlGLG1CQUFPc0MsS0FBUCxDQUFhMEQsSUFBYjtBQUFvQjtBQUFFO0FBSnhFLE9BQWQ7QUFNRDs7Ozs7O2tCQUdZaEosVSIsImZpbGUiOiJjbGllbnQuanMiLCJzb3VyY2VzQ29udGVudCI6WyIvKiBlc2xpbnQtZGlzYWJsZSBjYW1lbGNhc2UgKi9cblxuaW1wb3J0IHsgZW5jb2RlIH0gZnJvbSAnZW1haWxqcy1iYXNlNjQnXG5pbXBvcnQgVENQU29ja2V0IGZyb20gJ2VtYWlsanMtdGNwLXNvY2tldCdcbmltcG9ydCB7IFRleHREZWNvZGVyLCBUZXh0RW5jb2RlciB9IGZyb20gJ3RleHQtZW5jb2RpbmcnXG5pbXBvcnQgU210cENsaWVudFJlc3BvbnNlUGFyc2VyIGZyb20gJy4vcGFyc2VyJ1xuaW1wb3J0IGNyZWF0ZURlZmF1bHRMb2dnZXIgZnJvbSAnLi9sb2dnZXInXG5pbXBvcnQge1xuICBMT0dfTEVWRUxfRVJST1IsXG4gIExPR19MRVZFTF9XQVJOLFxuICBMT0dfTEVWRUxfSU5GTyxcbiAgTE9HX0xFVkVMX0RFQlVHXG59IGZyb20gJy4vY29tbW9uJ1xuXG52YXIgREVCVUdfVEFHID0gJ1NNVFAgQ2xpZW50J1xuXG4vKipcbiAqIExvd2VyIEJvdW5kIGZvciBzb2NrZXQgdGltZW91dCB0byB3YWl0IHNpbmNlIHRoZSBsYXN0IGRhdGEgd2FzIHdyaXR0ZW4gdG8gYSBzb2NrZXRcbiAqL1xuY29uc3QgVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkQgPSAxMDAwMFxuXG4vKipcbiAqIE11bHRpcGxpZXIgZm9yIHNvY2tldCB0aW1lb3V0OlxuICpcbiAqIFdlIGFzc3VtZSBhdCBsZWFzdCBhIEdQUlMgY29ubmVjdGlvbiB3aXRoIDExNSBrYi9zID0gMTQsMzc1IGtCL3MgdG9wcywgc28gMTAgS0IvcyB0byBiZSBvblxuICogdGhlIHNhZmUgc2lkZS4gV2UgY2FuIHRpbWVvdXQgYWZ0ZXIgYSBsb3dlciBib3VuZCBvZiAxMHMgKyAobiBLQiAvIDEwIEtCL3MpLiBBIDEgTUIgbWVzc2FnZVxuICogdXBsb2FkIHdvdWxkIGJlIDExMCBzZWNvbmRzIHRvIHdhaXQgZm9yIHRoZSB0aW1lb3V0LiAxMCBLQi9zID09PSAwLjEgcy9CXG4gKi9cbmNvbnN0IFRJTUVPVVRfU09DS0VUX01VTFRJUExJRVIgPSAwLjFcblxuY2xhc3MgU210cENsaWVudCB7XG4gIC8qKlxuICAgKiBDcmVhdGVzIGEgY29ubmVjdGlvbiBvYmplY3QgdG8gYSBTTVRQIHNlcnZlciBhbmQgYWxsb3dzIHRvIHNlbmQgbWFpbCB0aHJvdWdoIGl0LlxuICAgKiBDYWxsIGBjb25uZWN0YCBtZXRob2QgdG8gaW5pdGl0YXRlIHRoZSBhY3R1YWwgY29ubmVjdGlvbiwgdGhlIGNvbnN0cnVjdG9yIG9ubHlcbiAgICogZGVmaW5lcyB0aGUgcHJvcGVydGllcyBidXQgZG9lcyBub3QgYWN0dWFsbHkgY29ubmVjdC5cbiAgICpcbiAgICogTkIhIFRoZSBwYXJhbWV0ZXIgb3JkZXIgKGhvc3QsIHBvcnQpIGRpZmZlcnMgZnJvbSBub2RlLmpzIFwid2F5XCIgKHBvcnQsIGhvc3QpXG4gICAqXG4gICAqIEBjb25zdHJ1Y3RvclxuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gW2hvc3Q9XCJsb2NhbGhvc3RcIl0gSG9zdG5hbWUgdG8gY29uZW5jdCB0b1xuICAgKiBAcGFyYW0ge051bWJlcn0gW3BvcnQ9MjVdIFBvcnQgbnVtYmVyIHRvIGNvbm5lY3QgdG9cbiAgICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXSBPcHRpb25hbCBvcHRpb25zIG9iamVjdFxuICAgKiBAcGFyYW0ge0Jvb2xlYW59IFtvcHRpb25zLnVzZVNlY3VyZVRyYW5zcG9ydF0gU2V0IHRvIHRydWUsIHRvIHVzZSBlbmNyeXB0ZWQgY29ubmVjdGlvblxuICAgKiBAcGFyYW0ge1N0cmluZ30gW29wdGlvbnMubmFtZV0gQ2xpZW50IGhvc3RuYW1lIGZvciBpbnRyb2R1Y2luZyBpdHNlbGYgdG8gdGhlIHNlcnZlclxuICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnMuYXV0aF0gQXV0aGVudGljYXRpb24gb3B0aW9ucy4gRGVwZW5kcyBvbiB0aGUgcHJlZmVycmVkIGF1dGhlbnRpY2F0aW9uIG1ldGhvZC4gVXN1YWxseSB7dXNlciwgcGFzc31cbiAgICogQHBhcmFtIHtTdHJpbmd9IFtvcHRpb25zLmF1dGhNZXRob2RdIEZvcmNlIHNwZWNpZmljIGF1dGhlbnRpY2F0aW9uIG1ldGhvZFxuICAgKiBAcGFyYW0ge0Jvb2xlYW59IFtvcHRpb25zLmRpc2FibGVFc2NhcGluZ10gSWYgc2V0IHRvIHRydWUsIGRvIG5vdCBlc2NhcGUgZG90cyBvbiB0aGUgYmVnaW5uaW5nIG9mIHRoZSBsaW5lc1xuICAgKi9cbiAgY29uc3RydWN0b3IgKGhvc3QsIHBvcnQsIG9wdGlvbnMgPSB7fSkge1xuICAgIHRoaXMudGltZW91dFNvY2tldExvd2VyQm91bmQgPSBUSU1FT1VUX1NPQ0tFVF9MT1dFUl9CT1VORFxuICAgIHRoaXMudGltZW91dFNvY2tldE11bHRpcGxpZXIgPSBUSU1FT1VUX1NPQ0tFVF9NVUxUSVBMSUVSXG5cbiAgICB0aGlzLnBvcnQgPSBwb3J0IHx8ICh0aGlzLm9wdGlvbnMudXNlU2VjdXJlVHJhbnNwb3J0ID8gNDY1IDogMjUpXG4gICAgdGhpcy5ob3N0ID0gaG9zdCB8fCAnbG9jYWxob3N0J1xuXG4gICAgdGhpcy5vcHRpb25zID0gb3B0aW9uc1xuICAgIC8qKlxuICAgICAqIElmIHNldCB0byB0cnVlLCBzdGFydCBhbiBlbmNyeXB0ZWQgY29ubmVjdGlvbiBpbnN0ZWFkIG9mIHRoZSBwbGFpbnRleHQgb25lXG4gICAgICogKHJlY29tbWVuZGVkIGlmIGFwcGxpY2FibGUpLiBJZiB1c2VTZWN1cmVUcmFuc3BvcnQgaXMgbm90IHNldCBidXQgdGhlIHBvcnQgdXNlZCBpcyA0NjUsXG4gICAgICogdGhlbiBlY3J5cHRpb24gaXMgdXNlZCBieSBkZWZhdWx0LlxuICAgICAqL1xuICAgIHRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnQgPSAndXNlU2VjdXJlVHJhbnNwb3J0JyBpbiB0aGlzLm9wdGlvbnMgPyAhIXRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnQgOiB0aGlzLnBvcnQgPT09IDQ2NVxuXG4gICAgdGhpcy5vcHRpb25zLmF1dGggPSB0aGlzLm9wdGlvbnMuYXV0aCB8fCBmYWxzZSAvLyBBdXRoZW50aWNhdGlvbiBvYmplY3QuIElmIG5vdCBzZXQsIGF1dGhlbnRpY2F0aW9uIHN0ZXAgd2lsbCBiZSBza2lwcGVkLlxuICAgIHRoaXMub3B0aW9ucy5uYW1lID0gdGhpcy5vcHRpb25zLm5hbWUgfHwgJ2xvY2FsaG9zdCcgLy8gSG9zdG5hbWUgb2YgdGhlIGNsaWVudCwgdGhpcyB3aWxsIGJlIHVzZWQgZm9yIGludHJvZHVjaW5nIHRvIHRoZSBzZXJ2ZXJcbiAgICB0aGlzLnNvY2tldCA9IGZhbHNlIC8vIERvd25zdHJlYW0gVENQIHNvY2tldCB0byB0aGUgU01UUCBzZXJ2ZXIsIGNyZWF0ZWQgd2l0aCBtb3pUQ1BTb2NrZXRcbiAgICB0aGlzLmRlc3Ryb3llZCA9IGZhbHNlIC8vIEluZGljYXRlcyBpZiB0aGUgY29ubmVjdGlvbiBoYXMgYmVlbiBjbG9zZWQgYW5kIGNhbid0IGJlIHVzZWQgYW55bW9yZVxuICAgIHRoaXMud2FpdERyYWluID0gZmFsc2UgLy8gS2VlcHMgdHJhY2sgaWYgdGhlIGRvd25zdHJlYW0gc29ja2V0IGlzIGN1cnJlbnRseSBmdWxsIGFuZCBhIGRyYWluIGV2ZW50IHNob3VsZCBiZSB3YWl0ZWQgZm9yIG9yIG5vdFxuXG4gICAgLy8gUHJpdmF0ZSBwcm9wZXJ0aWVzXG5cbiAgICB0aGlzLl9wYXJzZXIgPSBuZXcgU210cENsaWVudFJlc3BvbnNlUGFyc2VyKCkgLy8gU01UUCByZXNwb25zZSBwYXJzZXIgb2JqZWN0LiBBbGwgZGF0YSBjb21pbmcgZnJvbSB0aGUgZG93bnN0cmVhbSBzZXJ2ZXIgaXMgZmVlZGVkIHRvIHRoaXMgcGFyc2VyXG4gICAgdGhpcy5fYXV0aGVudGljYXRlZEFzID0gbnVsbCAvLyBJZiBhdXRoZW50aWNhdGVkIHN1Y2Nlc3NmdWxseSwgc3RvcmVzIHRoZSB1c2VybmFtZVxuICAgIHRoaXMuX3N1cHBvcnRlZEF1dGggPSBbXSAvLyBBIGxpc3Qgb2YgYXV0aGVudGljYXRpb24gbWVjaGFuaXNtcyBkZXRlY3RlZCBmcm9tIHRoZSBFSExPIHJlc3BvbnNlIGFuZCB3aGljaCBhcmUgY29tcGF0aWJsZSB3aXRoIHRoaXMgbGlicmFyeVxuICAgIHRoaXMuX2RhdGFNb2RlID0gZmFsc2UgLy8gSWYgdHJ1ZSwgYWNjZXB0cyBkYXRhIGZyb20gdGhlIHVwc3RyZWFtIHRvIGJlIHBhc3NlZCBkaXJlY3RseSB0byB0aGUgZG93bnN0cmVhbSBzb2NrZXQuIFVzZWQgYWZ0ZXIgdGhlIERBVEEgY29tbWFuZFxuICAgIHRoaXMuX2xhc3REYXRhQnl0ZXMgPSAnJyAvLyBLZWVwIHRyYWNrIG9mIHRoZSBsYXN0IGJ5dGVzIHRvIHNlZSBob3cgdGhlIHRlcm1pbmF0aW5nIGRvdCBzaG91bGQgYmUgcGxhY2VkXG4gICAgdGhpcy5fZW52ZWxvcGUgPSBudWxsIC8vIEVudmVsb3BlIG9iamVjdCBmb3IgdHJhY2tpbmcgd2hvIGlzIHNlbmRpbmcgbWFpbCB0byB3aG9tXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IG51bGwgLy8gU3RvcmVzIHRoZSBmdW5jdGlvbiB0aGF0IHNob3VsZCBiZSBydW4gYWZ0ZXIgYSByZXNwb25zZSBoYXMgYmVlbiByZWNlaXZlZCBmcm9tIHRoZSBzZXJ2ZXJcbiAgICB0aGlzLl9zZWN1cmVNb2RlID0gISF0aGlzLm9wdGlvbnMudXNlU2VjdXJlVHJhbnNwb3J0IC8vIEluZGljYXRlcyBpZiB0aGUgY29ubmVjdGlvbiBpcyBzZWN1cmVkIG9yIHBsYWludGV4dFxuICAgIHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lciA9IGZhbHNlIC8vIFRpbWVyIHdhaXRpbmcgdG8gZGVjbGFyZSB0aGUgc29ja2V0IGRlYWQgc3RhcnRpbmcgZnJvbSB0aGUgbGFzdCB3cml0ZVxuICAgIHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCA9IGZhbHNlIC8vIFN0YXJ0IHRpbWUgb2Ygc2VuZGluZyB0aGUgZmlyc3QgcGFja2V0IGluIGRhdGEgbW9kZVxuICAgIHRoaXMuX3NvY2tldFRpbWVvdXRQZXJpb2QgPSBmYWxzZSAvLyBUaW1lb3V0IGZvciBzZW5kaW5nIGluIGRhdGEgbW9kZSwgZ2V0cyBleHRlbmRlZCB3aXRoIGV2ZXJ5IHNlbmQoKVxuXG4gICAgLy8gQWN0aXZhdGUgbG9nZ2luZ1xuICAgIHRoaXMuY3JlYXRlTG9nZ2VyKClcblxuICAgIC8vIEV2ZW50IHBsYWNlaG9sZGVyc1xuICAgIHRoaXMub25lcnJvciA9IChlKSA9PiB7IH0gLy8gV2lsbCBiZSBydW4gd2hlbiBhbiBlcnJvciBvY2N1cnMuIFRoZSBgb25jbG9zZWAgZXZlbnQgd2lsbCBmaXJlIHN1YnNlcXVlbnRseS5cbiAgICB0aGlzLm9uZHJhaW4gPSAoKSA9PiB7IH0gLy8gTW9yZSBkYXRhIGNhbiBiZSBidWZmZXJlZCBpbiB0aGUgc29ja2V0LlxuICAgIHRoaXMub25jbG9zZSA9ICgpID0+IHsgfSAvLyBUaGUgY29ubmVjdGlvbiB0byB0aGUgc2VydmVyIGhhcyBiZWVuIGNsb3NlZFxuICAgIHRoaXMub25pZGxlID0gKCkgPT4geyB9IC8vIFRoZSBjb25uZWN0aW9uIGlzIGVzdGFibGlzaGVkIGFuZCBpZGxlLCB5b3UgY2FuIHNlbmQgbWFpbCBub3dcbiAgICB0aGlzLm9ucmVhZHkgPSAoZmFpbGVkUmVjaXBpZW50cykgPT4geyB9IC8vIFdhaXRpbmcgZm9yIG1haWwgYm9keSwgbGlzdHMgYWRkcmVzc2VzIHRoYXQgd2VyZSBub3QgYWNjZXB0ZWQgYXMgcmVjaXBpZW50c1xuICAgIHRoaXMub25kb25lID0gKHN1Y2Nlc3MpID0+IHsgfSAvLyBUaGUgbWFpbCBoYXMgYmVlbiBzZW50LiBXYWl0IGZvciBgb25pZGxlYCBuZXh0LiBJbmRpY2F0ZXMgaWYgdGhlIG1lc3NhZ2Ugd2FzIHF1ZXVlZCBieSB0aGUgc2VydmVyLlxuICB9XG5cbiAgLyoqXG4gICAqIEluaXRpYXRlIGEgY29ubmVjdGlvbiB0byB0aGUgc2VydmVyXG4gICAqL1xuICBjb25uZWN0IChTb2NrZXRDb250cnVjdG9yID0gVENQU29ja2V0KSB7XG4gICAgdGhpcy5zb2NrZXQgPSBTb2NrZXRDb250cnVjdG9yLm9wZW4odGhpcy5ob3N0LCB0aGlzLnBvcnQsIHtcbiAgICAgIGJpbmFyeVR5cGU6ICdhcnJheWJ1ZmZlcicsXG4gICAgICB1c2VTZWN1cmVUcmFuc3BvcnQ6IHRoaXMuX3NlY3VyZU1vZGUsXG4gICAgICBjYTogdGhpcy5vcHRpb25zLmNhLFxuICAgICAgdGxzV29ya2VyUGF0aDogdGhpcy5vcHRpb25zLnRsc1dvcmtlclBhdGgsXG4gICAgICB3czogdGhpcy5vcHRpb25zLndzXG4gICAgfSlcblxuICAgIC8vIGFsbG93cyBjZXJ0aWZpY2F0ZSBoYW5kbGluZyBmb3IgcGxhdGZvcm0gdy9vIG5hdGl2ZSB0bHMgc3VwcG9ydFxuICAgIC8vIG9uY2VydCBpcyBub24gc3RhbmRhcmQgc28gc2V0dGluZyBpdCBtaWdodCB0aHJvdyBpZiB0aGUgc29ja2V0IG9iamVjdCBpcyBpbW11dGFibGVcbiAgICB0cnkge1xuICAgICAgdGhpcy5zb2NrZXQub25jZXJ0ID0gdGhpcy5vbmNlcnRcbiAgICB9IGNhdGNoIChFKSB7IH1cbiAgICB0aGlzLnNvY2tldC5vbmVycm9yID0gdGhpcy5fb25FcnJvci5iaW5kKHRoaXMpXG4gICAgdGhpcy5zb2NrZXQub25vcGVuID0gdGhpcy5fb25PcGVuLmJpbmQodGhpcylcbiAgfVxuXG4gIC8qKlxuICAgKiBQYXVzZXMgYGRhdGFgIGV2ZW50cyBmcm9tIHRoZSBkb3duc3RyZWFtIFNNVFAgc2VydmVyXG4gICAqL1xuICBzdXNwZW5kICgpIHtcbiAgICBpZiAodGhpcy5zb2NrZXQgJiYgdGhpcy5zb2NrZXQucmVhZHlTdGF0ZSA9PT0gJ29wZW4nKSB7XG4gICAgICB0aGlzLnNvY2tldC5zdXNwZW5kKClcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmVzdW1lcyBgZGF0YWAgZXZlbnRzIGZyb20gdGhlIGRvd25zdHJlYW0gU01UUCBzZXJ2ZXIuIEJlIGNhcmVmdWwgb2Ygbm90XG4gICAqIHJlc3VtaW5nIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBzdXNwZW5kZWQgLSBhbiBlcnJvciBpcyB0aHJvd24gaW4gdGhpcyBjYXNlXG4gICAqL1xuICByZXN1bWUgKCkge1xuICAgIGlmICh0aGlzLnNvY2tldCAmJiB0aGlzLnNvY2tldC5yZWFkeVN0YXRlID09PSAnb3BlbicpIHtcbiAgICAgIHRoaXMuc29ja2V0LnJlc3VtZSgpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFNlbmRzIFFVSVRcbiAgICovXG4gIHF1aXQgKCkge1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgUVVJVC4uLicpXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoJ1FVSVQnKVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLmNsb3NlXG4gIH1cblxuICAvKipcbiAgICogUmVzZXQgYXV0aGVudGljYXRpb25cbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IFthdXRoXSBVc2UgdGhpcyBpZiB5b3Ugd2FudCB0byBhdXRoZW50aWNhdGUgYXMgYW5vdGhlciB1c2VyXG4gICAqL1xuICByZXNldCAoYXV0aCkge1xuICAgIHRoaXMub3B0aW9ucy5hdXRoID0gYXV0aCB8fCB0aGlzLm9wdGlvbnMuYXV0aFxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgUlNFVC4uLicpXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoJ1JTRVQnKVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25SU0VUXG4gIH1cblxuICAvKipcbiAgICogQ2xvc2VzIHRoZSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXJcbiAgICovXG4gIGNsb3NlICgpIHtcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdDbG9zaW5nIGNvbm5lY3Rpb24uLi4nKVxuICAgIGlmICh0aGlzLnNvY2tldCAmJiB0aGlzLnNvY2tldC5yZWFkeVN0YXRlID09PSAnb3BlbicpIHtcbiAgICAgIHRoaXMuc29ja2V0LmNsb3NlKClcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5fZGVzdHJveSgpXG4gICAgfVxuICB9XG5cbiAgLy8gTWFpbCByZWxhdGVkIG1ldGhvZHNcblxuICAvKipcbiAgICogSW5pdGlhdGVzIGEgbmV3IG1lc3NhZ2UgYnkgc3VibWl0dGluZyBlbnZlbG9wZSBkYXRhLCBzdGFydGluZyB3aXRoXG4gICAqIGBNQUlMIEZST006YCBjb21tYW5kLiBVc2UgYWZ0ZXIgYG9uaWRsZWAgZXZlbnRcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGVudmVsb3BlIEVudmVsb3BlIG9iamVjdCBpbiB0aGUgZm9ybSBvZiB7ZnJvbTpcIi4uLlwiLCB0bzpbXCIuLi5cIl19XG4gICAqL1xuICB1c2VFbnZlbG9wZSAoZW52ZWxvcGUpIHtcbiAgICB0aGlzLl9lbnZlbG9wZSA9IGVudmVsb3BlIHx8IHt9XG4gICAgdGhpcy5fZW52ZWxvcGUuZnJvbSA9IFtdLmNvbmNhdCh0aGlzLl9lbnZlbG9wZS5mcm9tIHx8ICgnYW5vbnltb3VzQCcgKyB0aGlzLm9wdGlvbnMubmFtZSkpWzBdXG4gICAgdGhpcy5fZW52ZWxvcGUudG8gPSBbXS5jb25jYXQodGhpcy5fZW52ZWxvcGUudG8gfHwgW10pXG5cbiAgICAvLyBjbG9uZSB0aGUgcmVjaXBpZW50cyBhcnJheSBmb3IgbGF0dGVyIG1hbmlwdWxhdGlvblxuICAgIHRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZSA9IFtdLmNvbmNhdCh0aGlzLl9lbnZlbG9wZS50bylcbiAgICB0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkID0gW11cbiAgICB0aGlzLl9lbnZlbG9wZS5yZXNwb25zZVF1ZXVlID0gW11cblxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25NQUlMXG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBNQUlMIEZST00uLi4nKVxuICAgIHRoaXMuX3NlbmRDb21tYW5kKCdNQUlMIEZST006PCcgKyAodGhpcy5fZW52ZWxvcGUuZnJvbSkgKyAnPicpXG4gIH1cblxuICAvKipcbiAgICogU2VuZCBBU0NJSSBkYXRhIHRvIHRoZSBzZXJ2ZXIuIFdvcmtzIG9ubHkgaW4gZGF0YSBtb2RlIChhZnRlciBgb25yZWFkeWAgZXZlbnQpLCBpZ25vcmVkXG4gICAqIG90aGVyd2lzZVxuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gY2h1bmsgQVNDSUkgc3RyaW5nIChxdW90ZWQtcHJpbnRhYmxlLCBiYXNlNjQgZXRjLikgdG8gYmUgc2VudCB0byB0aGUgc2VydmVyXG4gICAqIEByZXR1cm4ge0Jvb2xlYW59IElmIHRydWUsIGl0IGlzIHNhZmUgdG8gc2VuZCBtb3JlIGRhdGEsIGlmIGZhbHNlLCB5b3UgKnNob3VsZCogd2FpdCBmb3IgdGhlIG9uZHJhaW4gZXZlbnQgYmVmb3JlIHNlbmRpbmcgbW9yZVxuICAgKi9cbiAgc2VuZCAoY2h1bmspIHtcbiAgICAvLyB3b3JrcyBvbmx5IGluIGRhdGEgbW9kZVxuICAgIGlmICghdGhpcy5fZGF0YU1vZGUpIHtcbiAgICAgIC8vIHRoaXMgbGluZSBzaG91bGQgbmV2ZXIgYmUgcmVhY2hlZCBidXQgaWYgaXQgZG9lcyxcbiAgICAgIC8vIGFjdCBsaWtlIGV2ZXJ5dGhpbmcncyBub3JtYWwuXG4gICAgICByZXR1cm4gdHJ1ZVxuICAgIH1cblxuICAgIC8vIFRPRE86IGlmIHRoZSBjaHVuayBpcyBhbiBhcnJheWJ1ZmZlciwgdXNlIGEgc2VwYXJhdGUgZnVuY3Rpb24gdG8gc2VuZCB0aGUgZGF0YVxuICAgIHJldHVybiB0aGlzLl9zZW5kU3RyaW5nKGNodW5rKVxuICB9XG5cbiAgLyoqXG4gICAqIEluZGljYXRlcyB0aGF0IGEgZGF0YSBzdHJlYW0gZm9yIHRoZSBzb2NrZXQgaXMgZW5kZWQuIFdvcmtzIG9ubHkgaW4gZGF0YVxuICAgKiBtb2RlIChhZnRlciBgb25yZWFkeWAgZXZlbnQpLCBpZ25vcmVkIG90aGVyd2lzZS4gVXNlIGl0IHdoZW4geW91IGFyZSBkb25lXG4gICAqIHdpdGggc2VuZGluZyB0aGUgbWFpbC4gVGhpcyBtZXRob2QgZG9lcyBub3QgY2xvc2UgdGhlIHNvY2tldC4gT25jZSB0aGUgbWFpbFxuICAgKiBoYXMgYmVlbiBxdWV1ZWQgYnkgdGhlIHNlcnZlciwgYG9uZG9uZWAgYW5kIGBvbmlkbGVgIGFyZSBlbWl0dGVkLlxuICAgKlxuICAgKiBAcGFyYW0ge0J1ZmZlcn0gW2NodW5rXSBDaHVuayBvZiBkYXRhIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICAgKi9cbiAgZW5kIChjaHVuaykge1xuICAgIC8vIHdvcmtzIG9ubHkgaW4gZGF0YSBtb2RlXG4gICAgaWYgKCF0aGlzLl9kYXRhTW9kZSkge1xuICAgICAgLy8gdGhpcyBsaW5lIHNob3VsZCBuZXZlciBiZSByZWFjaGVkIGJ1dCBpZiBpdCBkb2VzLFxuICAgICAgLy8gYWN0IGxpa2UgZXZlcnl0aGluZydzIG5vcm1hbC5cbiAgICAgIHJldHVybiB0cnVlXG4gICAgfVxuXG4gICAgaWYgKGNodW5rICYmIGNodW5rLmxlbmd0aCkge1xuICAgICAgdGhpcy5zZW5kKGNodW5rKVxuICAgIH1cblxuICAgIC8vIHJlZGlyZWN0IG91dHB1dCBmcm9tIHRoZSBzZXJ2ZXIgdG8gX2FjdGlvblN0cmVhbVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25TdHJlYW1cblxuICAgIC8vIGluZGljYXRlIHRoYXQgdGhlIHN0cmVhbSBoYXMgZW5kZWQgYnkgc2VuZGluZyBhIHNpbmdsZSBkb3Qgb24gaXRzIG93biBsaW5lXG4gICAgLy8gaWYgdGhlIGNsaWVudCBhbHJlYWR5IGNsb3NlZCB0aGUgZGF0YSB3aXRoIFxcclxcbiBubyBuZWVkIHRvIGRvIGl0IGFnYWluXG4gICAgaWYgKHRoaXMuX2xhc3REYXRhQnl0ZXMgPT09ICdcXHJcXG4nKSB7XG4gICAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFVpbnQ4QXJyYXkoWzB4MkUsIDB4MEQsIDB4MEFdKS5idWZmZXIpIC8vIC5cXHJcXG5cbiAgICB9IGVsc2UgaWYgKHRoaXMuX2xhc3REYXRhQnl0ZXMuc3Vic3RyKC0xKSA9PT0gJ1xccicpIHtcbiAgICAgIHRoaXMud2FpdERyYWluID0gdGhpcy5fc2VuZChuZXcgVWludDhBcnJheShbMHgwQSwgMHgyRSwgMHgwRCwgMHgwQV0pLmJ1ZmZlcikgLy8gXFxuLlxcclxcblxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFVpbnQ4QXJyYXkoWzB4MEQsIDB4MEEsIDB4MkUsIDB4MEQsIDB4MEFdKS5idWZmZXIpIC8vIFxcclxcbi5cXHJcXG5cbiAgICB9XG5cbiAgICAvLyBlbmQgZGF0YSBtb2RlLCByZXNldCB0aGUgdmFyaWFibGVzIGZvciBleHRlbmRpbmcgdGhlIHRpbWVvdXQgaW4gZGF0YSBtb2RlXG4gICAgdGhpcy5fZGF0YU1vZGUgPSBmYWxzZVxuICAgIHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCA9IGZhbHNlXG4gICAgdGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCA9IGZhbHNlXG5cbiAgICByZXR1cm4gdGhpcy53YWl0RHJhaW5cbiAgfVxuXG4gIC8vIFBSSVZBVEUgTUVUSE9EU1xuXG4gIC8vIEVWRU5UIEhBTkRMRVJTIEZPUiBUSEUgU09DS0VUXG5cbiAgLyoqXG4gICAqIENvbm5lY3Rpb24gbGlzdGVuZXIgdGhhdCBpcyBydW4gd2hlbiB0aGUgY29ubmVjdGlvbiB0byB0aGUgc2VydmVyIGlzIG9wZW5lZC5cbiAgICogU2V0cyB1cCBkaWZmZXJlbnQgZXZlbnQgaGFuZGxlcnMgZm9yIHRoZSBvcGVuZWQgc29ja2V0XG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBOb3QgdXNlZFxuICAgKi9cbiAgX29uT3BlbiAoZXZlbnQpIHtcbiAgICBpZiAoZXZlbnQgJiYgZXZlbnQuZGF0YSAmJiBldmVudC5kYXRhLnByb3h5SG9zdG5hbWUpIHtcbiAgICAgIHRoaXMub3B0aW9ucy5uYW1lID0gZXZlbnQuZGF0YS5wcm94eUhvc3RuYW1lXG4gICAgfVxuXG4gICAgdGhpcy5zb2NrZXQub25kYXRhID0gdGhpcy5fb25EYXRhLmJpbmQodGhpcylcblxuICAgIHRoaXMuc29ja2V0Lm9uY2xvc2UgPSB0aGlzLl9vbkNsb3NlLmJpbmQodGhpcylcbiAgICB0aGlzLnNvY2tldC5vbmRyYWluID0gdGhpcy5fb25EcmFpbi5iaW5kKHRoaXMpXG5cbiAgICB0aGlzLl9wYXJzZXIub25kYXRhID0gdGhpcy5fb25Db21tYW5kLmJpbmQodGhpcylcblxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25HcmVldGluZ1xuICB9XG5cbiAgLyoqXG4gICAqIERhdGEgbGlzdGVuZXIgZm9yIGNodW5rcyBvZiBkYXRhIGVtaXR0ZWQgYnkgdGhlIHNlcnZlclxuICAgKlxuICAgKiBAZXZlbnRcbiAgICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gU2VlIGBldnQuZGF0YWAgZm9yIHRoZSBjaHVuayByZWNlaXZlZFxuICAgKi9cbiAgX29uRGF0YSAoZXZ0KSB7XG4gICAgY2xlYXJUaW1lb3V0KHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lcilcbiAgICB2YXIgc3RyaW5nUGF5bG9hZCA9IG5ldyBUZXh0RGVjb2RlcignVVRGLTgnKS5kZWNvZGUobmV3IFVpbnQ4QXJyYXkoZXZ0LmRhdGEpKVxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NFUlZFUjogJyArIHN0cmluZ1BheWxvYWQpXG4gICAgdGhpcy5fcGFyc2VyLnNlbmQoc3RyaW5nUGF5bG9hZClcbiAgfVxuXG4gIC8qKlxuICAgKiBNb3JlIGRhdGEgY2FuIGJlIGJ1ZmZlcmVkIGluIHRoZSBzb2NrZXQsIGB3YWl0RHJhaW5gIGlzIHJlc2V0IHRvIGZhbHNlXG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBOb3QgdXNlZFxuICAgKi9cbiAgX29uRHJhaW4gKCkge1xuICAgIHRoaXMud2FpdERyYWluID0gZmFsc2VcbiAgICB0aGlzLm9uZHJhaW4oKVxuICB9XG5cbiAgLyoqXG4gICAqIEVycm9yIGhhbmRsZXIgZm9yIHRoZSBzb2NrZXRcbiAgICpcbiAgICogQGV2ZW50XG4gICAqIEBwYXJhbSB7RXZlbnR9IGV2dCBFdmVudCBvYmplY3QuIFNlZSBldnQuZGF0YSBmb3IgdGhlIGVycm9yXG4gICAqL1xuICBfb25FcnJvciAoZXZ0KSB7XG4gICAgaWYgKGV2dCBpbnN0YW5jZW9mIEVycm9yICYmIGV2dC5tZXNzYWdlKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsIGV2dClcbiAgICAgIHRoaXMub25lcnJvcihldnQpXG4gICAgfSBlbHNlIGlmIChldnQgJiYgZXZ0LmRhdGEgaW5zdGFuY2VvZiBFcnJvcikge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCBldnQuZGF0YSlcbiAgICAgIHRoaXMub25lcnJvcihldnQuZGF0YSlcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCBuZXcgRXJyb3IoKGV2dCAmJiBldnQuZGF0YSAmJiBldnQuZGF0YS5tZXNzYWdlKSB8fCBldnQuZGF0YSB8fCBldnQgfHwgJ0Vycm9yJykpXG4gICAgICB0aGlzLm9uZXJyb3IobmV3IEVycm9yKChldnQgJiYgZXZ0LmRhdGEgJiYgZXZ0LmRhdGEubWVzc2FnZSkgfHwgZXZ0LmRhdGEgfHwgZXZ0IHx8ICdFcnJvcicpKVxuICAgIH1cblxuICAgIHRoaXMuY2xvc2UoKVxuICB9XG5cbiAgLyoqXG4gICAqIEluZGljYXRlcyB0aGF0IHRoZSBzb2NrZXQgaGFzIGJlZW4gY2xvc2VkXG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBOb3QgdXNlZFxuICAgKi9cbiAgX29uQ2xvc2UgKCkge1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NvY2tldCBjbG9zZWQuJylcbiAgICB0aGlzLl9kZXN0cm95KClcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGlzIGlzIG5vdCBhIHNvY2tldCBkYXRhIGhhbmRsZXIgYnV0IHRoZSBoYW5kbGVyIGZvciBkYXRhIGVtaXR0ZWQgYnkgdGhlIHBhcnNlcixcbiAgICogc28gdGhpcyBkYXRhIGlzIHNhZmUgdG8gdXNlIGFzIGl0IGlzIGFsd2F5cyBjb21wbGV0ZSAoc2VydmVyIG1pZ2h0IHNlbmQgcGFydGlhbCBjaHVua3MpXG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgZGF0YVxuICAgKi9cbiAgX29uQ29tbWFuZCAoY29tbWFuZCkge1xuICAgIGlmICh0eXBlb2YgdGhpcy5fY3VycmVudEFjdGlvbiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbihjb21tYW5kKVxuICAgIH1cbiAgfVxuXG4gIF9vblRpbWVvdXQgKCkge1xuICAgIC8vIGluZm9ybSBhYm91dCB0aGUgdGltZW91dCBhbmQgc2h1dCBkb3duXG4gICAgdmFyIGVycm9yID0gbmV3IEVycm9yKCdTb2NrZXQgdGltZWQgb3V0IScpXG4gICAgdGhpcy5fb25FcnJvcihlcnJvcilcbiAgfVxuXG4gIC8qKlxuICAgKiBFbnN1cmVzIHRoYXQgdGhlIGNvbm5lY3Rpb24gaXMgY2xvc2VkIGFuZCBzdWNoXG4gICAqL1xuICBfZGVzdHJveSAoKSB7XG4gICAgY2xlYXJUaW1lb3V0KHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lcilcblxuICAgIGlmICghdGhpcy5kZXN0cm95ZWQpIHtcbiAgICAgIHRoaXMuZGVzdHJveWVkID0gdHJ1ZVxuICAgICAgdGhpcy5vbmNsb3NlKClcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogU2VuZHMgYSBzdHJpbmcgdG8gdGhlIHNvY2tldC5cbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IGNodW5rIEFTQ0lJIHN0cmluZyAocXVvdGVkLXByaW50YWJsZSwgYmFzZTY0IGV0Yy4pIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICAgKiBAcmV0dXJuIHtCb29sZWFufSBJZiB0cnVlLCBpdCBpcyBzYWZlIHRvIHNlbmQgbW9yZSBkYXRhLCBpZiBmYWxzZSwgeW91ICpzaG91bGQqIHdhaXQgZm9yIHRoZSBvbmRyYWluIGV2ZW50IGJlZm9yZSBzZW5kaW5nIG1vcmVcbiAgICovXG4gIF9zZW5kU3RyaW5nIChjaHVuaykge1xuICAgIC8vIGVzY2FwZSBkb3RzXG4gICAgaWYgKCF0aGlzLm9wdGlvbnMuZGlzYWJsZUVzY2FwaW5nKSB7XG4gICAgICBjaHVuayA9IGNodW5rLnJlcGxhY2UoL1xcblxcLi9nLCAnXFxuLi4nKVxuICAgICAgaWYgKCh0aGlzLl9sYXN0RGF0YUJ5dGVzLnN1YnN0cigtMSkgPT09ICdcXG4nIHx8ICF0aGlzLl9sYXN0RGF0YUJ5dGVzKSAmJiBjaHVuay5jaGFyQXQoMCkgPT09ICcuJykge1xuICAgICAgICBjaHVuayA9ICcuJyArIGNodW5rXG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gS2VlcGluZyBleWUgb24gdGhlIGxhc3QgYnl0ZXMgc2VudCwgdG8gc2VlIGlmIHRoZXJlIGlzIGEgPENSPjxMRj4gc2VxdWVuY2VcbiAgICAvLyBhdCB0aGUgZW5kIHdoaWNoIGlzIG5lZWRlZCB0byBlbmQgdGhlIGRhdGEgc3RyZWFtXG4gICAgaWYgKGNodW5rLmxlbmd0aCA+IDIpIHtcbiAgICAgIHRoaXMuX2xhc3REYXRhQnl0ZXMgPSBjaHVuay5zdWJzdHIoLTIpXG4gICAgfSBlbHNlIGlmIChjaHVuay5sZW5ndGggPT09IDEpIHtcbiAgICAgIHRoaXMuX2xhc3REYXRhQnl0ZXMgPSB0aGlzLl9sYXN0RGF0YUJ5dGVzLnN1YnN0cigtMSkgKyBjaHVua1xuICAgIH1cblxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgJyArIGNodW5rLmxlbmd0aCArICcgYnl0ZXMgb2YgcGF5bG9hZCcpXG5cbiAgICAvLyBwYXNzIHRoZSBjaHVuayB0byB0aGUgc29ja2V0XG4gICAgdGhpcy53YWl0RHJhaW4gPSB0aGlzLl9zZW5kKG5ldyBUZXh0RW5jb2RlcignVVRGLTgnKS5lbmNvZGUoY2h1bmspLmJ1ZmZlcilcbiAgICByZXR1cm4gdGhpcy53YWl0RHJhaW5cbiAgfVxuXG4gIC8qKlxuICAgKiBTZW5kIGEgc3RyaW5nIGNvbW1hbmQgdG8gdGhlIHNlcnZlciwgYWxzbyBhcHBlbmQgXFxyXFxuIGlmIG5lZWRlZFxuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gc3RyIFN0cmluZyB0byBiZSBzZW50IHRvIHRoZSBzZXJ2ZXJcbiAgICovXG4gIF9zZW5kQ29tbWFuZCAoc3RyKSB7XG4gICAgdGhpcy53YWl0RHJhaW4gPSB0aGlzLl9zZW5kKG5ldyBUZXh0RW5jb2RlcignVVRGLTgnKS5lbmNvZGUoc3RyICsgKHN0ci5zdWJzdHIoLTIpICE9PSAnXFxyXFxuJyA/ICdcXHJcXG4nIDogJycpKS5idWZmZXIpXG4gIH1cblxuICBfc2VuZCAoYnVmZmVyKSB7XG4gICAgdGhpcy5fc2V0VGltZW91dChidWZmZXIuYnl0ZUxlbmd0aClcbiAgICByZXR1cm4gdGhpcy5zb2NrZXQuc2VuZChidWZmZXIpXG4gIH1cblxuICBfc2V0VGltZW91dCAoYnl0ZUxlbmd0aCkge1xuICAgIHZhciBwcm9sb25nUGVyaW9kID0gTWF0aC5mbG9vcihieXRlTGVuZ3RoICogdGhpcy50aW1lb3V0U29ja2V0TXVsdGlwbGllcilcbiAgICB2YXIgdGltZW91dFxuXG4gICAgaWYgKHRoaXMuX2RhdGFNb2RlKSB7XG4gICAgICAvLyB3ZSdyZSBpbiBkYXRhIG1vZGUsIHNvIHdlIGNvdW50IG9ubHkgb25lIHRpbWVvdXQgdGhhdCBnZXQgZXh0ZW5kZWQgZm9yIGV2ZXJ5IHNlbmQoKS5cbiAgICAgIHZhciBub3cgPSBEYXRlLm5vdygpXG5cbiAgICAgIC8vIHRoZSBvbGQgdGltZW91dCBzdGFydCB0aW1lXG4gICAgICB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgPSB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgfHwgbm93XG5cbiAgICAgIC8vIHRoZSBvbGQgdGltZW91dCBwZXJpb2QsIG5vcm1hbGl6ZWQgdG8gYSBtaW5pbXVtIG9mIFRJTUVPVVRfU09DS0VUX0xPV0VSX0JPVU5EXG4gICAgICB0aGlzLl9zb2NrZXRUaW1lb3V0UGVyaW9kID0gKHRoaXMuX3NvY2tldFRpbWVvdXRQZXJpb2QgfHwgdGhpcy50aW1lb3V0U29ja2V0TG93ZXJCb3VuZCkgKyBwcm9sb25nUGVyaW9kXG5cbiAgICAgIC8vIHRoZSBuZXcgdGltZW91dCBpcyB0aGUgZGVsdGEgYmV0d2VlbiB0aGUgbmV3IGZpcmluZyB0aW1lICg9IHRpbWVvdXQgcGVyaW9kICsgdGltZW91dCBzdGFydCB0aW1lKSBhbmQgbm93XG4gICAgICB0aW1lb3V0ID0gdGhpcy5fc29ja2V0VGltZW91dFN0YXJ0ICsgdGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCAtIG5vd1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBzZXQgbmV3IHRpbW91dFxuICAgICAgdGltZW91dCA9IHRoaXMudGltZW91dFNvY2tldExvd2VyQm91bmQgKyBwcm9sb25nUGVyaW9kXG4gICAgfVxuXG4gICAgY2xlYXJUaW1lb3V0KHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lcikgLy8gY2xlYXIgcGVuZGluZyB0aW1lb3V0c1xuICAgIHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lciA9IHNldFRpbWVvdXQodGhpcy5fb25UaW1lb3V0LmJpbmQodGhpcyksIHRpbWVvdXQpIC8vIGFybSB0aGUgbmV4dCB0aW1lb3V0XG4gIH1cblxuICAvKipcbiAgICogSW50aXRpYXRlIGF1dGhlbnRpY2F0aW9uIHNlcXVlbmNlIGlmIG5lZWRlZFxuICAgKi9cbiAgX2F1dGhlbnRpY2F0ZVVzZXIgKCkge1xuICAgIGlmICghdGhpcy5vcHRpb25zLmF1dGgpIHtcbiAgICAgIC8vIG5vIG5lZWQgdG8gYXV0aGVudGljYXRlLCBhdCBsZWFzdCBubyBkYXRhIGdpdmVuXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgICAgdGhpcy5vbmlkbGUoKSAvLyByZWFkeSB0byB0YWtlIG9yZGVyc1xuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgdmFyIGF1dGhcblxuICAgIGlmICghdGhpcy5vcHRpb25zLmF1dGhNZXRob2QgJiYgdGhpcy5vcHRpb25zLmF1dGgueG9hdXRoMikge1xuICAgICAgdGhpcy5vcHRpb25zLmF1dGhNZXRob2QgPSAnWE9BVVRIMidcbiAgICB9XG5cbiAgICBpZiAodGhpcy5vcHRpb25zLmF1dGhNZXRob2QpIHtcbiAgICAgIGF1dGggPSB0aGlzLm9wdGlvbnMuYXV0aE1ldGhvZC50b1VwcGVyQ2FzZSgpLnRyaW0oKVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyB1c2UgZmlyc3Qgc3VwcG9ydGVkXG4gICAgICBhdXRoID0gKHRoaXMuX3N1cHBvcnRlZEF1dGhbMF0gfHwgJ1BMQUlOJykudG9VcHBlckNhc2UoKS50cmltKClcbiAgICB9XG5cbiAgICBzd2l0Y2ggKGF1dGgpIHtcbiAgICAgIGNhc2UgJ0xPR0lOJzpcbiAgICAgICAgLy8gTE9HSU4gaXMgYSAzIHN0ZXAgYXV0aGVudGljYXRpb24gcHJvY2Vzc1xuICAgICAgICAvLyBDOiBBVVRIIExPR0lOXG4gICAgICAgIC8vIEM6IEJBU0U2NChVU0VSKVxuICAgICAgICAvLyBDOiBCQVNFNjQoUEFTUylcbiAgICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQXV0aGVudGljYXRpb24gdmlhIEFVVEggTE9HSU4nKVxuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSF9MT0dJTl9VU0VSXG4gICAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdBVVRIIExPR0lOJylcbiAgICAgICAgcmV0dXJuXG4gICAgICBjYXNlICdQTEFJTic6XG4gICAgICAgIC8vIEFVVEggUExBSU4gaXMgYSAxIHN0ZXAgYXV0aGVudGljYXRpb24gcHJvY2Vzc1xuICAgICAgICAvLyBDOiBBVVRIIFBMQUlOIEJBU0U2NChcXDAgVVNFUiBcXDAgUEFTUylcbiAgICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQXV0aGVudGljYXRpb24gdmlhIEFVVEggUExBSU4nKVxuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSENvbXBsZXRlXG4gICAgICAgIHRoaXMuX3NlbmRDb21tYW5kKFxuICAgICAgICAgIC8vIGNvbnZlcnQgdG8gQkFTRTY0XG4gICAgICAgICAgJ0FVVEggUExBSU4gJyArXG4gICAgICAgICAgZW5jb2RlKFxuICAgICAgICAgICAgLy8gdGhpcy5vcHRpb25zLmF1dGgudXNlcisnXFx1MDAwMCcrXG4gICAgICAgICAgICAnXFx1MDAwMCcgKyAvLyBza2lwIGF1dGhvcml6YXRpb24gaWRlbnRpdHkgYXMgaXQgY2F1c2VzIHByb2JsZW1zIHdpdGggc29tZSBzZXJ2ZXJzXG4gICAgICAgICAgICB0aGlzLm9wdGlvbnMuYXV0aC51c2VyICsgJ1xcdTAwMDAnICtcbiAgICAgICAgICAgIHRoaXMub3B0aW9ucy5hdXRoLnBhc3MpXG4gICAgICAgIClcbiAgICAgICAgcmV0dXJuXG4gICAgICBjYXNlICdYT0FVVEgyJzpcbiAgICAgICAgLy8gU2VlIGh0dHBzOi8vZGV2ZWxvcGVycy5nb29nbGUuY29tL2dtYWlsL3hvYXV0aDJfcHJvdG9jb2wjc210cF9wcm90b2NvbF9leGNoYW5nZVxuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiB2aWEgQVVUSCBYT0FVVEgyJylcbiAgICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhfWE9BVVRIMlxuICAgICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnQVVUSCBYT0FVVEgyICcgKyB0aGlzLl9idWlsZFhPQXV0aDJUb2tlbih0aGlzLm9wdGlvbnMuYXV0aC51c2VyLCB0aGlzLm9wdGlvbnMuYXV0aC54b2F1dGgyKSlcbiAgICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ1Vua25vd24gYXV0aGVudGljYXRpb24gbWV0aG9kICcgKyBhdXRoKSlcbiAgfVxuXG4gIC8vIEFDVElPTlMgRk9SIFJFU1BPTlNFUyBGUk9NIFRIRSBTTVRQIFNFUlZFUlxuXG4gIC8qKlxuICAgKiBJbml0aWFsIHJlc3BvbnNlIGZyb20gdGhlIHNlcnZlciwgbXVzdCBoYXZlIGEgc3RhdHVzIDIyMFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gICAqL1xuICBfYWN0aW9uR3JlZXRpbmcgKGNvbW1hbmQpIHtcbiAgICBpZiAoY29tbWFuZC5zdGF0dXNDb2RlICE9PSAyMjApIHtcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdJbnZhbGlkIGdyZWV0aW5nOiAnICsgY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIGlmICh0aGlzLm9wdGlvbnMubG10cCkge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBMSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcblxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkxITE9cbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdMSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBFSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcblxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkVITE9cbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdFSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gTEhMT1xuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gICAqL1xuICBfYWN0aW9uTEhMTyAoY29tbWFuZCkge1xuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdMSExPIG5vdCBzdWNjZXNzZnVsJylcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICAvLyBQcm9jZXNzIGFzIEVITE8gcmVzcG9uc2VcbiAgICB0aGlzLl9hY3Rpb25FSExPKGNvbW1hbmQpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gRUhMTy4gSWYgdGhlIHJlc3BvbnNlIGlzIGFuIGVycm9yLCB0cnkgSEVMTyBpbnN0ZWFkXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAgICovXG4gIF9hY3Rpb25FSExPIChjb21tYW5kKSB7XG4gICAgdmFyIG1hdGNoXG5cbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgaWYgKCF0aGlzLl9zZWN1cmVNb2RlICYmIHRoaXMub3B0aW9ucy5yZXF1aXJlVExTKSB7XG4gICAgICAgIHZhciBlcnJNc2cgPSAnU1RBUlRUTFMgbm90IHN1cHBvcnRlZCB3aXRob3V0IEVITE8nXG4gICAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgZXJyTXNnKVxuICAgICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihlcnJNc2cpKVxuICAgICAgICByZXR1cm5cbiAgICAgIH1cblxuICAgICAgLy8gVHJ5IEhFTE8gaW5zdGVhZFxuICAgICAgdGhpcy5sb2dnZXIud2FybihERUJVR19UQUcsICdFSExPIG5vdCBzdWNjZXNzZnVsLCB0cnlpbmcgSEVMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSEVMT1xuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0hFTE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gRGV0ZWN0IGlmIHRoZSBzZXJ2ZXIgc3VwcG9ydHMgUExBSU4gYXV0aFxuICAgIGlmIChjb21tYW5kLmxpbmUubWF0Y2goL0FVVEgoPzpcXHMrW15cXG5dKlxccyt8XFxzKylQTEFJTi9pKSkge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VydmVyIHN1cHBvcnRzIEFVVEggUExBSU4nKVxuICAgICAgdGhpcy5fc3VwcG9ydGVkQXV0aC5wdXNoKCdQTEFJTicpXG4gICAgfVxuXG4gICAgLy8gRGV0ZWN0IGlmIHRoZSBzZXJ2ZXIgc3VwcG9ydHMgTE9HSU4gYXV0aFxuICAgIGlmIChjb21tYW5kLmxpbmUubWF0Y2goL0FVVEgoPzpcXHMrW15cXG5dKlxccyt8XFxzKylMT0dJTi9pKSkge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VydmVyIHN1cHBvcnRzIEFVVEggTE9HSU4nKVxuICAgICAgdGhpcy5fc3VwcG9ydGVkQXV0aC5wdXNoKCdMT0dJTicpXG4gICAgfVxuXG4gICAgLy8gRGV0ZWN0IGlmIHRoZSBzZXJ2ZXIgc3VwcG9ydHMgWE9BVVRIMiBhdXRoXG4gICAgaWYgKGNvbW1hbmQubGluZS5tYXRjaCgvQVVUSCg/OlxccytbXlxcbl0qXFxzK3xcXHMrKVhPQVVUSDIvaSkpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlcnZlciBzdXBwb3J0cyBBVVRIIFhPQVVUSDInKVxuICAgICAgdGhpcy5fc3VwcG9ydGVkQXV0aC5wdXNoKCdYT0FVVEgyJylcbiAgICB9XG5cbiAgICAvLyBEZXRlY3QgbWF4aW11bSBhbGxvd2VkIG1lc3NhZ2Ugc2l6ZVxuICAgIGlmICgobWF0Y2ggPSBjb21tYW5kLmxpbmUubWF0Y2goL1NJWkUgKFxcZCspL2kpKSAmJiBOdW1iZXIobWF0Y2hbMV0pKSB7XG4gICAgICBjb25zdCBtYXhBbGxvd2VkU2l6ZSA9IE51bWJlcihtYXRjaFsxXSlcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ01heGltdW0gYWxsb3dkIG1lc3NhZ2Ugc2l6ZTogJyArIG1heEFsbG93ZWRTaXplKVxuICAgIH1cblxuICAgIC8vIERldGVjdCBpZiB0aGUgc2VydmVyIHN1cHBvcnRzIFNUQVJUVExTXG4gICAgaWYgKCF0aGlzLl9zZWN1cmVNb2RlKSB7XG4gICAgICBpZiAoKGNvbW1hbmQubGluZS5tYXRjaCgvWyAtXVNUQVJUVExTXFxzPyQvbWkpICYmICF0aGlzLm9wdGlvbnMuaWdub3JlVExTKSB8fCAhIXRoaXMub3B0aW9ucy5yZXF1aXJlVExTKSB7XG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25TVEFSVFRMU1xuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIFNUQVJUVExTJylcbiAgICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ1NUQVJUVExTJylcbiAgICAgICAgcmV0dXJuXG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5fYXV0aGVudGljYXRlVXNlcigpXG4gIH1cblxuICAvKipcbiAgICogSGFuZGxlcyBzZXJ2ZXIgcmVzcG9uc2UgZm9yIFNUQVJUVExTIGNvbW1hbmQuIElmIHRoZXJlJ3MgYW4gZXJyb3JcbiAgICogdHJ5IEhFTE8gaW5zdGVhZCwgb3RoZXJ3aXNlIGluaXRpYXRlIFRMUyB1cGdyYWRlLiBJZiB0aGUgdXBncmFkZVxuICAgKiBzdWNjZWVkZXMgcmVzdGFydCB0aGUgRUhMT1xuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gc3RyIE1lc3NhZ2UgZnJvbSB0aGUgc2VydmVyXG4gICAqL1xuICBfYWN0aW9uU1RBUlRUTFMgKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnU1RBUlRUTFMgbm90IHN1Y2Nlc3NmdWwnKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRoaXMuX3NlY3VyZU1vZGUgPSB0cnVlXG4gICAgdGhpcy5zb2NrZXQudXBncmFkZVRvU2VjdXJlKClcblxuICAgIC8vIHJlc3RhcnQgcHJvdG9jb2wgZmxvd1xuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25FSExPXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoJ0VITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIEhFTE9cbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICAgKi9cbiAgX2FjdGlvbkhFTE8gKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnSEVMTyBub3Qgc3VjY2Vzc2Z1bCcpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuICAgIHRoaXMuX2F1dGhlbnRpY2F0ZVVzZXIoKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIEFVVEggTE9HSU4sIGlmIHN1Y2Nlc3NmdWwgZXhwZWN0cyBiYXNlNjQgZW5jb2RlZCB1c2VybmFtZVxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gICAqL1xuICBfYWN0aW9uQVVUSF9MT0dJTl9VU0VSIChjb21tYW5kKSB7XG4gICAgaWYgKGNvbW1hbmQuc3RhdHVzQ29kZSAhPT0gMzM0IHx8IGNvbW1hbmQuZGF0YSAhPT0gJ1ZYTmxjbTVoYldVNicpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0FVVEggTE9HSU4gVVNFUiBub3Qgc3VjY2Vzc2Z1bDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdJbnZhbGlkIGxvZ2luIHNlcXVlbmNlIHdoaWxlIHdhaXRpbmcgZm9yIFwiMzM0IFZYTmxjbTVoYldVNiBcIjogJyArIGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQVVUSCBMT0dJTiBVU0VSIHN1Y2Nlc3NmdWwnKVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIX0xPR0lOX1BBU1NcbiAgICB0aGlzLl9zZW5kQ29tbWFuZChlbmNvZGUodGhpcy5vcHRpb25zLmF1dGgudXNlcikpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gQVVUSCBMT0dJTiB1c2VybmFtZSwgaWYgc3VjY2Vzc2Z1bCBleHBlY3RzIGJhc2U2NCBlbmNvZGVkIHBhc3N3b3JkXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAgICovXG4gIF9hY3Rpb25BVVRIX0xPR0lOX1BBU1MgKGNvbW1hbmQpIHtcbiAgICBpZiAoY29tbWFuZC5zdGF0dXNDb2RlICE9PSAzMzQgfHwgY29tbWFuZC5kYXRhICE9PSAnVUdGemMzZHZjbVE2Jykge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnQVVUSCBMT0dJTiBQQVNTIG5vdCBzdWNjZXNzZnVsOiAnICsgY29tbWFuZC5kYXRhKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ0ludmFsaWQgbG9naW4gc2VxdWVuY2Ugd2hpbGUgd2FpdGluZyBmb3IgXCIzMzQgVUdGemMzZHZjbVE2IFwiOiAnICsgY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBVVRIIExPR0lOIFBBU1Mgc3VjY2Vzc2Z1bCcpXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhDb21wbGV0ZVxuICAgIHRoaXMuX3NlbmRDb21tYW5kKGVuY29kZSh0aGlzLm9wdGlvbnMuYXV0aC5wYXNzKSlcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBBVVRIIFhPQVVUSDIgdG9rZW4sIGlmIGVycm9yIG9jY3VycyBzZW5kIGVtcHR5IHJlc3BvbnNlXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAgICovXG4gIF9hY3Rpb25BVVRIX1hPQVVUSDIgKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIud2FybihERUJVR19UQUcsICdFcnJvciBkdXJpbmcgQVVUSCBYT0FVVEgyLCBzZW5kaW5nIGVtcHR5IHJlc3BvbnNlJylcbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCcnKVxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhDb21wbGV0ZVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLl9hY3Rpb25BVVRIQ29tcGxldGUoY29tbWFuZClcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQ2hlY2tzIGlmIGF1dGhlbnRpY2F0aW9uIHN1Y2NlZWRlZCBvciBub3QuIElmIHN1Y2Nlc3NmdWxseSBhdXRoZW50aWNhdGVkXG4gICAqIGVtaXQgYGlkbGVgIHRvIGluZGljYXRlIHRoYXQgYW4gZS1tYWlsIGNhbiBiZSBzZW50IHVzaW5nIHRoaXMgY29ubmVjdGlvblxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gICAqL1xuICBfYWN0aW9uQVVUSENvbXBsZXRlIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0F1dGhlbnRpY2F0aW9uIGZhaWxlZDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiBzdWNjZXNzZnVsLicpXG5cbiAgICB0aGlzLl9hdXRoZW50aWNhdGVkQXMgPSB0aGlzLm9wdGlvbnMuYXV0aC51c2VyXG5cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgIHRoaXMub25pZGxlKCkgLy8gcmVhZHkgdG8gdGFrZSBvcmRlcnNcbiAgfVxuXG4gIC8qKlxuICAgKiBVc2VkIHdoZW4gdGhlIGNvbm5lY3Rpb24gaXMgaWRsZSBhbmQgdGhlIHNlcnZlciBlbWl0cyB0aW1lb3V0XG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAgICovXG4gIF9hY3Rpb25JZGxlIChjb21tYW5kKSB7XG4gICAgaWYgKGNvbW1hbmQuc3RhdHVzQ29kZSA+IDMwMCkge1xuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5saW5lKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gTUFJTCBGUk9NIGNvbW1hbmQuIFByb2NlZWQgdG8gZGVmaW5pbmcgUkNQVCBUTyBsaXN0IGlmIHN1Y2Nlc3NmdWxcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICAgKi9cbiAgX2FjdGlvbk1BSUwgKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnTUFJTCBGUk9NIHVuc3VjY2Vzc2Z1bDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICBpZiAoIXRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5sZW5ndGgpIHtcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdDYW5cXCd0IHNlbmQgbWFpbCAtIG5vIHJlY2lwaWVudHMgZGVmaW5lZCcpKVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdNQUlMIEZST00gc3VjY2Vzc2Z1bCwgcHJvY2VlZGluZyB3aXRoICcgKyB0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUubGVuZ3RoICsgJyByZWNpcGllbnRzJylcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0FkZGluZyByZWNpcGllbnQuLi4nKVxuICAgICAgdGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50ID0gdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLnNoaWZ0KClcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25SQ1BUXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnUkNQVCBUTzo8JyArIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudCArICc+JylcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gYSBSQ1BUIFRPIGNvbW1hbmQuIElmIHRoZSBjb21tYW5kIGlzIHVuc3VjY2Vzc2Z1bCwgdHJ5IHRoZSBuZXh0IG9uZSxcbiAgICogYXMgdGhpcyBtaWdodCBiZSByZWxhdGVkIG9ubHkgdG8gdGhlIGN1cnJlbnQgcmVjaXBpZW50LCBub3QgYSBnbG9iYWwgZXJyb3IsIHNvXG4gICAqIHRoZSBmb2xsb3dpbmcgcmVjaXBpZW50cyBtaWdodCBzdGlsbCBiZSB2YWxpZFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gICAqL1xuICBfYWN0aW9uUkNQVCAoY29tbWFuZCkge1xuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICB0aGlzLmxvZ2dlci53YXJuKERFQlVHX1RBRywgJ1JDUFQgVE8gZmFpbGVkIGZvcjogJyArIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudClcbiAgICAgIC8vIHRoaXMgaXMgYSBzb2Z0IGVycm9yXG4gICAgICB0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkLnB1c2godGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50KVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLl9lbnZlbG9wZS5yZXNwb25zZVF1ZXVlLnB1c2godGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50KVxuICAgIH1cblxuICAgIGlmICghdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLmxlbmd0aCkge1xuICAgICAgaWYgKHRoaXMuX2VudmVsb3BlLnJjcHRGYWlsZWQubGVuZ3RoIDwgdGhpcy5fZW52ZWxvcGUudG8ubGVuZ3RoKSB7XG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25EQVRBXG4gICAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1JDUFQgVE8gZG9uZSwgcHJvY2VlZGluZyB3aXRoIHBheWxvYWQnKVxuICAgICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnREFUQScpXG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignQ2FuXFwndCBzZW5kIG1haWwgLSBhbGwgcmVjaXBpZW50cyB3ZXJlIHJlamVjdGVkJykpXG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0FkZGluZyByZWNpcGllbnQuLi4nKVxuICAgICAgdGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50ID0gdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLnNoaWZ0KClcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25SQ1BUXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnUkNQVCBUTzo8JyArIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudCArICc+JylcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gdGhlIFJTRVQgY29tbWFuZC4gSWYgc3VjY2Vzc2Z1bCwgY2xlYXIgdGhlIGN1cnJlbnQgYXV0aGVudGljYXRpb25cbiAgICogaW5mb3JtYXRpb24gYW5kIHJlYXV0aGVudGljYXRlLlxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gICAqL1xuICBfYWN0aW9uUlNFVCAoY29tbWFuZCkge1xuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdSU0VUIHVuc3VjY2Vzc2Z1bCAnICsgY29tbWFuZC5kYXRhKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRoaXMuX2F1dGhlbnRpY2F0ZWRBcyA9IG51bGxcbiAgICB0aGlzLl9hdXRoZW50aWNhdGVVc2VyKClcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byB0aGUgREFUQSBjb21tYW5kLiBTZXJ2ZXIgaXMgbm93IHdhaXRpbmcgZm9yIGEgbWVzc2FnZSwgc28gZW1pdCBgb25yZWFkeWBcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICAgKi9cbiAgX2FjdGlvbkRBVEEgKGNvbW1hbmQpIHtcbiAgICAvLyByZXNwb25zZSBzaG91bGQgYmUgMzU0IGJ1dCBhY2NvcmRpbmcgdG8gdGhpcyBpc3N1ZSBodHRwczovL2dpdGh1Yi5jb20vZWxlaXRoL2VtYWlsanMvaXNzdWVzLzI0XG4gICAgLy8gc29tZSBzZXJ2ZXJzIG1pZ2h0IHVzZSAyNTAgaW5zdGVhZFxuICAgIGlmIChbMjUwLCAzNTRdLmluZGV4T2YoY29tbWFuZC5zdGF0dXNDb2RlKSA8IDApIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0RBVEEgdW5zdWNjZXNzZnVsICcgKyBjb21tYW5kLmRhdGEpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgdGhpcy5fZGF0YU1vZGUgPSB0cnVlXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICB0aGlzLm9ucmVhZHkodGhpcy5fZW52ZWxvcGUucmNwdEZhaWxlZClcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSBmcm9tIHRoZSBzZXJ2ZXIsIG9uY2UgdGhlIG1lc3NhZ2Ugc3RyZWFtIGhhcyBlbmRlZCB3aXRoIDxDUj48TEY+LjxDUj48TEY+XG4gICAqIEVtaXRzIGBvbmRvbmVgLlxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gICAqL1xuICBfYWN0aW9uU3RyZWFtIChjb21tYW5kKSB7XG4gICAgdmFyIHJjcHRcblxuICAgIGlmICh0aGlzLm9wdGlvbnMubG10cCkge1xuICAgICAgLy8gTE1UUCByZXR1cm5zIGEgcmVzcG9uc2UgY29kZSBmb3IgKmV2ZXJ5KiBzdWNjZXNzZnVsbHkgc2V0IHJlY2lwaWVudFxuICAgICAgLy8gRm9yIGV2ZXJ5IHJlY2lwaWVudCB0aGUgbWVzc2FnZSBtaWdodCBzdWNjZWVkIG9yIGZhaWwgaW5kaXZpZHVhbGx5XG5cbiAgICAgIHJjcHQgPSB0aGlzLl9lbnZlbG9wZS5yZXNwb25zZVF1ZXVlLnNoaWZ0KClcbiAgICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0xvY2FsIGRlbGl2ZXJ5IHRvICcgKyByY3B0ICsgJyBmYWlsZWQuJylcbiAgICAgICAgdGhpcy5fZW52ZWxvcGUucmNwdEZhaWxlZC5wdXNoKHJjcHQpXG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdMb2NhbCBkZWxpdmVyeSB0byAnICsgcmNwdCArICcgc3VjY2VlZGVkLicpXG4gICAgICB9XG5cbiAgICAgIGlmICh0aGlzLl9lbnZlbG9wZS5yZXNwb25zZVF1ZXVlLmxlbmd0aCkge1xuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uU3RyZWFtXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgICAgdGhpcy5vbmRvbmUodHJ1ZSlcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gRm9yIFNNVFAgdGhlIG1lc3NhZ2UgZWl0aGVyIGZhaWxzIG9yIHN1Y2NlZWRzLCB0aGVyZSBpcyBubyBpbmZvcm1hdGlvblxuICAgICAgLy8gYWJvdXQgaW5kaXZpZHVhbCByZWNpcGllbnRzXG5cbiAgICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ01lc3NhZ2Ugc2VuZGluZyBmYWlsZWQuJylcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ01lc3NhZ2Ugc2VudCBzdWNjZXNzZnVsbHkuJylcbiAgICAgIH1cblxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICAgIHRoaXMub25kb25lKCEhY29tbWFuZC5zdWNjZXNzKVxuICAgIH1cblxuICAgIC8vIElmIHRoZSBjbGllbnQgd2FudGVkIHRvIGRvIHNvbWV0aGluZyBlbHNlIChlZy4gdG8gcXVpdCksIGRvIG5vdCBmb3JjZSBpZGxlXG4gICAgaWYgKHRoaXMuX2N1cnJlbnRBY3Rpb24gPT09IHRoaXMuX2FjdGlvbklkbGUpIHtcbiAgICAgIC8vIFdhaXRpbmcgZm9yIG5ldyBjb25uZWN0aW9uc1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnSWRsaW5nIHdoaWxlIHdhaXRpbmcgZm9yIG5ldyBjb25uZWN0aW9ucy4uLicpXG4gICAgICB0aGlzLm9uaWRsZSgpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEJ1aWxkcyBhIGxvZ2luIHRva2VuIGZvciBYT0FVVEgyIGF1dGhlbnRpY2F0aW9uIGNvbW1hbmRcbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IHVzZXIgRS1tYWlsIGFkZHJlc3Mgb2YgdGhlIHVzZXJcbiAgICogQHBhcmFtIHtTdHJpbmd9IHRva2VuIFZhbGlkIGFjY2VzcyB0b2tlbiBmb3IgdGhlIHVzZXJcbiAgICogQHJldHVybiB7U3RyaW5nfSBCYXNlNjQgZm9ybWF0dGVkIGxvZ2luIHRva2VuXG4gICAqL1xuICBfYnVpbGRYT0F1dGgyVG9rZW4gKHVzZXIsIHRva2VuKSB7XG4gICAgdmFyIGF1dGhEYXRhID0gW1xuICAgICAgJ3VzZXI9JyArICh1c2VyIHx8ICcnKSxcbiAgICAgICdhdXRoPUJlYXJlciAnICsgdG9rZW4sXG4gICAgICAnJyxcbiAgICAgICcnXG4gICAgXVxuICAgIC8vIGJhc2U2NChcInVzZXI9e1VzZXJ9XFx4MDBhdXRoPUJlYXJlciB7VG9rZW59XFx4MDBcXHgwMFwiKVxuICAgIHJldHVybiBlbmNvZGUoYXV0aERhdGEuam9pbignXFx4MDEnKSlcbiAgfVxuXG4gIGNyZWF0ZUxvZ2dlciAoY3JlYXRvciA9IGNyZWF0ZURlZmF1bHRMb2dnZXIpIHtcbiAgICBjb25zdCBsb2dnZXIgPSBjcmVhdG9yKCh0aGlzLm9wdGlvbnMuYXV0aCB8fCB7fSkudXNlciB8fCAnJywgdGhpcy5ob3N0KVxuICAgIHRoaXMubG9nTGV2ZWwgPSB0aGlzLkxPR19MRVZFTF9BTExcbiAgICB0aGlzLmxvZ2dlciA9IHtcbiAgICAgIGRlYnVnOiAoLi4ubXNncykgPT4geyBpZiAoTE9HX0xFVkVMX0RFQlVHID49IHRoaXMubG9nTGV2ZWwpIHsgbG9nZ2VyLmRlYnVnKG1zZ3MpIH0gfSxcbiAgICAgIGluZm86ICguLi5tc2dzKSA9PiB7IGlmIChMT0dfTEVWRUxfSU5GTyA+PSB0aGlzLmxvZ0xldmVsKSB7IGxvZ2dlci5pbmZvKG1zZ3MpIH0gfSxcbiAgICAgIHdhcm46ICguLi5tc2dzKSA9PiB7IGlmIChMT0dfTEVWRUxfV0FSTiA+PSB0aGlzLmxvZ0xldmVsKSB7IGxvZ2dlci53YXJuKG1zZ3MpIH0gfSxcbiAgICAgIGVycm9yOiAoLi4ubXNncykgPT4geyBpZiAoTE9HX0xFVkVMX0VSUk9SID49IHRoaXMubG9nTGV2ZWwpIHsgbG9nZ2VyLmVycm9yKG1zZ3MpIH0gfVxuICAgIH1cbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBTbXRwQ2xpZW50XG4iXX0=