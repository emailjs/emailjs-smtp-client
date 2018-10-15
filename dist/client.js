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

    this.options = options;

    this.timeoutSocketLowerBound = TIMEOUT_SOCKET_LOWER_BOUND;
    this.timeoutSocketMultiplier = TIMEOUT_SOCKET_MULTIPLIER;

    this.port = port || (this.options.useSecureTransport ? 465 : 25);
    this.host = host || 'localhost';

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9jbGllbnQuanMiXSwibmFtZXMiOlsiREVCVUdfVEFHIiwiVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkQiLCJUSU1FT1VUX1NPQ0tFVF9NVUxUSVBMSUVSIiwiU210cENsaWVudCIsImhvc3QiLCJwb3J0Iiwib3B0aW9ucyIsInRpbWVvdXRTb2NrZXRMb3dlckJvdW5kIiwidGltZW91dFNvY2tldE11bHRpcGxpZXIiLCJ1c2VTZWN1cmVUcmFuc3BvcnQiLCJhdXRoIiwibmFtZSIsInNvY2tldCIsImRlc3Ryb3llZCIsIndhaXREcmFpbiIsIl9wYXJzZXIiLCJTbXRwQ2xpZW50UmVzcG9uc2VQYXJzZXIiLCJfYXV0aGVudGljYXRlZEFzIiwiX3N1cHBvcnRlZEF1dGgiLCJfZGF0YU1vZGUiLCJfbGFzdERhdGFCeXRlcyIsIl9lbnZlbG9wZSIsIl9jdXJyZW50QWN0aW9uIiwiX3NlY3VyZU1vZGUiLCJfc29ja2V0VGltZW91dFRpbWVyIiwiX3NvY2tldFRpbWVvdXRTdGFydCIsIl9zb2NrZXRUaW1lb3V0UGVyaW9kIiwiY3JlYXRlTG9nZ2VyIiwib25lcnJvciIsImUiLCJvbmRyYWluIiwib25jbG9zZSIsIm9uaWRsZSIsIm9ucmVhZHkiLCJmYWlsZWRSZWNpcGllbnRzIiwib25kb25lIiwic3VjY2VzcyIsIlNvY2tldENvbnRydWN0b3IiLCJUQ1BTb2NrZXQiLCJvcGVuIiwiYmluYXJ5VHlwZSIsImNhIiwidGxzV29ya2VyUGF0aCIsIndzIiwib25jZXJ0IiwiRSIsIl9vbkVycm9yIiwiYmluZCIsIm9ub3BlbiIsIl9vbk9wZW4iLCJyZWFkeVN0YXRlIiwic3VzcGVuZCIsInJlc3VtZSIsImxvZ2dlciIsImRlYnVnIiwiX3NlbmRDb21tYW5kIiwiY2xvc2UiLCJfYWN0aW9uUlNFVCIsIl9kZXN0cm95IiwiZW52ZWxvcGUiLCJmcm9tIiwiY29uY2F0IiwidG8iLCJyY3B0UXVldWUiLCJyY3B0RmFpbGVkIiwicmVzcG9uc2VRdWV1ZSIsIl9hY3Rpb25NQUlMIiwiY2h1bmsiLCJfc2VuZFN0cmluZyIsImxlbmd0aCIsInNlbmQiLCJfYWN0aW9uU3RyZWFtIiwiX3NlbmQiLCJVaW50OEFycmF5IiwiYnVmZmVyIiwic3Vic3RyIiwiZXZlbnQiLCJkYXRhIiwicHJveHlIb3N0bmFtZSIsIm9uZGF0YSIsIl9vbkRhdGEiLCJfb25DbG9zZSIsIl9vbkRyYWluIiwiX29uQ29tbWFuZCIsIl9hY3Rpb25HcmVldGluZyIsImV2dCIsImNsZWFyVGltZW91dCIsInN0cmluZ1BheWxvYWQiLCJUZXh0RGVjb2RlciIsImRlY29kZSIsIkVycm9yIiwibWVzc2FnZSIsImVycm9yIiwiY29tbWFuZCIsImRpc2FibGVFc2NhcGluZyIsInJlcGxhY2UiLCJjaGFyQXQiLCJUZXh0RW5jb2RlciIsImVuY29kZSIsInN0ciIsIl9zZXRUaW1lb3V0IiwiYnl0ZUxlbmd0aCIsInByb2xvbmdQZXJpb2QiLCJNYXRoIiwiZmxvb3IiLCJ0aW1lb3V0Iiwibm93IiwiRGF0ZSIsInNldFRpbWVvdXQiLCJfb25UaW1lb3V0IiwiX2FjdGlvbklkbGUiLCJhdXRoTWV0aG9kIiwieG9hdXRoMiIsInRvVXBwZXJDYXNlIiwidHJpbSIsIl9hY3Rpb25BVVRIX0xPR0lOX1VTRVIiLCJfYWN0aW9uQVVUSENvbXBsZXRlIiwidXNlciIsInBhc3MiLCJfYWN0aW9uQVVUSF9YT0FVVEgyIiwiX2J1aWxkWE9BdXRoMlRva2VuIiwic3RhdHVzQ29kZSIsImxtdHAiLCJfYWN0aW9uTEhMTyIsIl9hY3Rpb25FSExPIiwibWF0Y2giLCJyZXF1aXJlVExTIiwiZXJyTXNnIiwid2FybiIsIl9hY3Rpb25IRUxPIiwibGluZSIsInB1c2giLCJOdW1iZXIiLCJtYXhBbGxvd2VkU2l6ZSIsImlnbm9yZVRMUyIsIl9hY3Rpb25TVEFSVFRMUyIsIl9hdXRoZW50aWNhdGVVc2VyIiwidXBncmFkZVRvU2VjdXJlIiwiX2FjdGlvbkFVVEhfTE9HSU5fUEFTUyIsImN1clJlY2lwaWVudCIsInNoaWZ0IiwiX2FjdGlvblJDUFQiLCJfYWN0aW9uREFUQSIsImluZGV4T2YiLCJyY3B0IiwidG9rZW4iLCJhdXRoRGF0YSIsImpvaW4iLCJjcmVhdG9yIiwiY3JlYXRlRGVmYXVsdExvZ2dlciIsImxvZ0xldmVsIiwiTE9HX0xFVkVMX0FMTCIsIm1zZ3MiLCJMT0dfTEVWRUxfREVCVUciLCJpbmZvIiwiTE9HX0xFVkVMX0lORk8iLCJMT0dfTEVWRUxfV0FSTiIsIkxPR19MRVZFTF9FUlJPUiJdLCJtYXBwaW5ncyI6Ijs7Ozs7O3FqQkFBQTs7QUFFQTs7QUFDQTs7OztBQUNBOztBQUNBOzs7O0FBQ0E7Ozs7QUFDQTs7Ozs7O0FBT0EsSUFBSUEsWUFBWSxhQUFoQjs7QUFFQTs7O0FBR0EsSUFBTUMsNkJBQTZCLEtBQW5DOztBQUVBOzs7Ozs7O0FBT0EsSUFBTUMsNEJBQTRCLEdBQWxDOztJQUVNQyxVO0FBQ0o7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQWtCQSxzQkFBYUMsSUFBYixFQUFtQkMsSUFBbkIsRUFBdUM7QUFBQSxRQUFkQyxPQUFjLHVFQUFKLEVBQUk7O0FBQUE7O0FBQ3JDLFNBQUtBLE9BQUwsR0FBZUEsT0FBZjs7QUFFQSxTQUFLQyx1QkFBTCxHQUErQk4sMEJBQS9CO0FBQ0EsU0FBS08sdUJBQUwsR0FBK0JOLHlCQUEvQjs7QUFFQSxTQUFLRyxJQUFMLEdBQVlBLFNBQVMsS0FBS0MsT0FBTCxDQUFhRyxrQkFBYixHQUFrQyxHQUFsQyxHQUF3QyxFQUFqRCxDQUFaO0FBQ0EsU0FBS0wsSUFBTCxHQUFZQSxRQUFRLFdBQXBCOztBQUVBOzs7OztBQUtBLFNBQUtFLE9BQUwsQ0FBYUcsa0JBQWIsR0FBa0Msd0JBQXdCLEtBQUtILE9BQTdCLEdBQXVDLENBQUMsQ0FBQyxLQUFLQSxPQUFMLENBQWFHLGtCQUF0RCxHQUEyRSxLQUFLSixJQUFMLEtBQWMsR0FBM0g7O0FBRUEsU0FBS0MsT0FBTCxDQUFhSSxJQUFiLEdBQW9CLEtBQUtKLE9BQUwsQ0FBYUksSUFBYixJQUFxQixLQUF6QyxDQWhCcUMsQ0FnQlU7QUFDL0MsU0FBS0osT0FB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QStCLHVFQUFyQkMsZ0JBQXFCOztBQUMzQyxVQUFNaEcsU0FBUytGLFFBQVEsQ0FBQyxLQUFLOUksT0FBTCxDQUFhSSxJQUFiLElBQXFCLEVBQXRCLEVBQTBCMkcsSUFBMUIsSUFBa0MsRUFBMUMsRUFBOEMsS0FBS2pILElBQW5ELENBQWY7QUFDQSxXQUFLa0osUUFBTCxHQUFnQixLQUFLQyxhQUFyQjtBQUNBLFdBQUtsRyxNQUFMLEdBQWM7QUFDWkMsZUFBTyxpQkFBYTtBQUFBLDRDQUFUa0csSUFBUztBQUFUQSxnQkFBUztBQUFBOztBQUFFLGNBQUlDLDJCQUFtQixNQUFLSCxRQUE1QixFQUFzQztBQUFFakcsbUJBQU9DLEtBQVAsQ0FBYWtHLElBQWI7QUFBb0I7QUFBRSxTQUR4RTtBQUVaRSxjQUFNLGdCQUFhO0FBQUEsNkNBQVRGLElBQVM7QUFBVEEsZ0JBQVM7QUFBQTs7QUFBRSxjQUFJRywwQkFBa0IsTUFBS0wsUUFBM0IsRUFBcUM7QUFBRWpHLG1CQUFPcUcsSUFBUCxDQUFZRixJQUFaO0FBQW1CO0FBQUUsU0FGckU7QUFHWnhCLGNBQU0sZ0JBQWE7QUFBQSw2Q0FBVHdCLElBQVM7QUFBVEEsZ0JBQVM7QUFBQTs7QUFBRSxjQUFJSSwwQkFBa0IsTUFBS04sUUFBM0IsRUFBcUM7QUFBRWpHLG1CQUFPMkUsSUFBUCxDQUFZd0IsSUFBWjtBQUFtQjtBQUFFLFNBSHJFO0FBSVo1RCxlQUFPLGlCQUFhO0FBQUEsNkNBQVQ0RCxJQUFTO0FBQVRBLGdCQUFTO0FBQUE7O0FBQUUsY0FBSUssMkJBQW1CLE1BQUtQLFFBQTVCLEVBQXNDO0FBQUVqRyxtQkFBT3VDLEtBQVAsQ0FBYTRELElBQWI7QUFBb0I7QUFBRTtBQUp4RSxPQUFkO0FBTUQ7Ozs7OztrQkFHWXJKLFUiLCJmaWxlIjoiY2xpZW50LmpzIiwic291cmNlc0NvbnRlbnQiOlsiLyogZXNsaW50LWRpc2FibGUgY2FtZWxjYXNlICovXG5cbmltcG9ydCB7IGVuY29kZSB9IGZyb20gJ2VtYWlsanMtYmFzZTY0J1xuaW1wb3J0IFRDUFNvY2tldCBmcm9tICdlbWFpbGpzLXRjcC1zb2NrZXQnXG5pbXBvcnQgeyBUZXh0RGVjb2RlciwgVGV4dEVuY29kZXIgfSBmcm9tICd0ZXh0LWVuY29kaW5nJ1xuaW1wb3J0IFNtdHBDbGllbnRSZXNwb25zZVBhcnNlciBmcm9tICcuL3BhcnNlcidcbmltcG9ydCBjcmVhdGVEZWZhdWx0TG9nZ2VyIGZyb20gJy4vbG9nZ2VyJ1xuaW1wb3J0IHtcbiAgTE9HX0xFVkVMX0VSUk9SLFxuICBMT0dfTEVWRUxfV0FSTixcbiAgTE9HX0xFVkVMX0lORk8sXG4gIExPR19MRVZFTF9ERUJVR1xufSBmcm9tICcuL2NvbW1vbidcblxudmFyIERFQlVHX1RBRyA9ICdTTVRQIENsaWVudCdcblxuLyoqXG4gKiBMb3dlciBCb3VuZCBmb3Igc29ja2V0IHRpbWVvdXQgdG8gd2FpdCBzaW5jZSB0aGUgbGFzdCBkYXRhIHdhcyB3cml0dGVuIHRvIGEgc29ja2V0XG4gKi9cbmNvbnN0IFRJTUVPVVRfU09DS0VUX0xPV0VSX0JPVU5EID0gMTAwMDBcblxuLyoqXG4gKiBNdWx0aXBsaWVyIGZvciBzb2NrZXQgdGltZW91dDpcbiAqXG4gKiBXZSBhc3N1bWUgYXQgbGVhc3QgYSBHUFJTIGNvbm5lY3Rpb24gd2l0aCAxMTUga2IvcyA9IDE0LDM3NSBrQi9zIHRvcHMsIHNvIDEwIEtCL3MgdG8gYmUgb25cbiAqIHRoZSBzYWZlIHNpZGUuIFdlIGNhbiB0aW1lb3V0IGFmdGVyIGEgbG93ZXIgYm91bmQgb2YgMTBzICsgKG4gS0IgLyAxMCBLQi9zKS4gQSAxIE1CIG1lc3NhZ2VcbiAqIHVwbG9hZCB3b3VsZCBiZSAxMTAgc2Vjb25kcyB0byB3YWl0IGZvciB0aGUgdGltZW91dC4gMTAgS0IvcyA9PT0gMC4xIHMvQlxuICovXG5jb25zdCBUSU1FT1VUX1NPQ0tFVF9NVUxUSVBMSUVSID0gMC4xXG5cbmNsYXNzIFNtdHBDbGllbnQge1xuICAvKipcbiAgICogQ3JlYXRlcyBhIGNvbm5lY3Rpb24gb2JqZWN0IHRvIGEgU01UUCBzZXJ2ZXIgYW5kIGFsbG93cyB0byBzZW5kIG1haWwgdGhyb3VnaCBpdC5cbiAgICogQ2FsbCBgY29ubmVjdGAgbWV0aG9kIHRvIGluaXRpdGF0ZSB0aGUgYWN0dWFsIGNvbm5lY3Rpb24sIHRoZSBjb25zdHJ1Y3RvciBvbmx5XG4gICAqIGRlZmluZXMgdGhlIHByb3BlcnRpZXMgYnV0IGRvZXMgbm90IGFjdHVhbGx5IGNvbm5lY3QuXG4gICAqXG4gICAqIE5CISBUaGUgcGFyYW1ldGVyIG9yZGVyIChob3N0LCBwb3J0KSBkaWZmZXJzIGZyb20gbm9kZS5qcyBcIndheVwiIChwb3J0LCBob3N0KVxuICAgKlxuICAgKiBAY29uc3RydWN0b3JcbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IFtob3N0PVwibG9jYWxob3N0XCJdIEhvc3RuYW1lIHRvIGNvbmVuY3QgdG9cbiAgICogQHBhcmFtIHtOdW1iZXJ9IFtwb3J0PTI1XSBQb3J0IG51bWJlciB0byBjb25uZWN0IHRvXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gT3B0aW9uYWwgb3B0aW9ucyBvYmplY3RcbiAgICogQHBhcmFtIHtCb29sZWFufSBbb3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnRdIFNldCB0byB0cnVlLCB0byB1c2UgZW5jcnlwdGVkIGNvbm5lY3Rpb25cbiAgICogQHBhcmFtIHtTdHJpbmd9IFtvcHRpb25zLm5hbWVdIENsaWVudCBob3N0bmFtZSBmb3IgaW50cm9kdWNpbmcgaXRzZWxmIHRvIHRoZSBzZXJ2ZXJcbiAgICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zLmF1dGhdIEF1dGhlbnRpY2F0aW9uIG9wdGlvbnMuIERlcGVuZHMgb24gdGhlIHByZWZlcnJlZCBhdXRoZW50aWNhdGlvbiBtZXRob2QuIFVzdWFsbHkge3VzZXIsIHBhc3N9XG4gICAqIEBwYXJhbSB7U3RyaW5nfSBbb3B0aW9ucy5hdXRoTWV0aG9kXSBGb3JjZSBzcGVjaWZpYyBhdXRoZW50aWNhdGlvbiBtZXRob2RcbiAgICogQHBhcmFtIHtCb29sZWFufSBbb3B0aW9ucy5kaXNhYmxlRXNjYXBpbmddIElmIHNldCB0byB0cnVlLCBkbyBub3QgZXNjYXBlIGRvdHMgb24gdGhlIGJlZ2lubmluZyBvZiB0aGUgbGluZXNcbiAgICovXG4gIGNvbnN0cnVjdG9yIChob3N0LCBwb3J0LCBvcHRpb25zID0ge30pIHtcbiAgICB0aGlzLm9wdGlvbnMgPSBvcHRpb25zXG5cbiAgICB0aGlzLnRpbWVvdXRTb2NrZXRMb3dlckJvdW5kID0gVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkRcbiAgICB0aGlzLnRpbWVvdXRTb2NrZXRNdWx0aXBsaWVyID0gVElNRU9VVF9TT0NLRVRfTVVMVElQTElFUlxuXG4gICAgdGhpcy5wb3J0ID0gcG9ydCB8fCAodGhpcy5vcHRpb25zLnVzZVNlY3VyZVRyYW5zcG9ydCA/IDQ2NSA6IDI1KVxuICAgIHRoaXMuaG9zdCA9IGhvc3QgfHwgJ2xvY2FsaG9zdCdcblxuICAgIC8qKlxuICAgICAqIElmIHNldCB0byB0cnVlLCBzdGFydCBhbiBlbmNyeXB0ZWQgY29ubmVjdGlvbiBpbnN0ZWFkIG9mIHRoZSBwbGFpbnRleHQgb25lXG4gICAgICogKHJlY29tbWVuZGVkIGlmIGFwcGxpY2FibGUpLiBJZiB1c2VTZWN1cmVUcmFuc3BvcnQgaXMgbm90IHNldCBidXQgdGhlIHBvcnQgdXNlZCBpcyA0NjUsXG4gICAgICogdGhlbiBlY3J5cHRpb24gaXMgdXNlZCBieSBkZWZhdWx0LlxuICAgICAqL1xuICAgIHRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnQgPSAndXNlU2VjdXJlVHJhbnNwb3J0JyBpbiB0aGlzLm9wdGlvbnMgPyAhIXRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnQgOiB0aGlzLnBvcnQgPT09IDQ2NVxuXG4gICAgdGhpcy5vcHRpb25zLmF1dGggPSB0aGlzLm9wdGlvbnMuYXV0aCB8fCBmYWxzZSAvLyBBdXRoZW50aWNhdGlvbiBvYmplY3QuIElmIG5vdCBzZXQsIGF1dGhlbnRpY2F0aW9uIHN0ZXAgd2lsbCBiZSBza2lwcGVkLlxuICAgIHRoaXMub3B0aW9ucy5uYW1lID0gdGhpcy5vcHRpb25zLm5hbWUgfHwgJ2xvY2FsaG9zdCcgLy8gSG9zdG5hbWUgb2YgdGhlIGNsaWVudCwgdGhpcyB3aWxsIGJlIHVzZWQgZm9yIGludHJvZHVjaW5nIHRvIHRoZSBzZXJ2ZXJcbiAgICB0aGlzLnNvY2tldCA9IGZhbHNlIC8vIERvd25zdHJlYW0gVENQIHNvY2tldCB0byB0aGUgU01UUCBzZXJ2ZXIsIGNyZWF0ZWQgd2l0aCBtb3pUQ1BTb2NrZXRcbiAgICB0aGlzLmRlc3Ryb3llZCA9IGZhbHNlIC8vIEluZGljYXRlcyBpZiB0aGUgY29ubmVjdGlvbiBoYXMgYmVlbiBjbG9zZWQgYW5kIGNhbid0IGJlIHVzZWQgYW55bW9yZVxuICAgIHRoaXMud2FpdERyYWluID0gZmFsc2UgLy8gS2VlcHMgdHJhY2sgaWYgdGhlIGRvd25zdHJlYW0gc29ja2V0IGlzIGN1cnJlbnRseSBmdWxsIGFuZCBhIGRyYWluIGV2ZW50IHNob3VsZCBiZSB3YWl0ZWQgZm9yIG9yIG5vdFxuXG4gICAgLy8gUHJpdmF0ZSBwcm9wZXJ0aWVzXG5cbiAgICB0aGlzLl9wYXJzZXIgPSBuZXcgU210cENsaWVudFJlc3BvbnNlUGFyc2VyKCkgLy8gU01UUCByZXNwb25zZSBwYXJzZXIgb2JqZWN0LiBBbGwgZGF0YSBjb21pbmcgZnJvbSB0aGUgZG93bnN0cmVhbSBzZXJ2ZXIgaXMgZmVlZGVkIHRvIHRoaXMgcGFyc2VyXG4gICAgdGhpcy5fYXV0aGVudGljYXRlZEFzID0gbnVsbCAvLyBJZiBhdXRoZW50aWNhdGVkIHN1Y2Nlc3NmdWxseSwgc3RvcmVzIHRoZSB1c2VybmFtZVxuICAgIHRoaXMuX3N1cHBvcnRlZEF1dGggPSBbXSAvLyBBIGxpc3Qgb2YgYXV0aGVudGljYXRpb24gbWVjaGFuaXNtcyBkZXRlY3RlZCBmcm9tIHRoZSBFSExPIHJlc3BvbnNlIGFuZCB3aGljaCBhcmUgY29tcGF0aWJsZSB3aXRoIHRoaXMgbGlicmFyeVxuICAgIHRoaXMuX2RhdGFNb2RlID0gZmFsc2UgLy8gSWYgdHJ1ZSwgYWNjZXB0cyBkYXRhIGZyb20gdGhlIHVwc3RyZWFtIHRvIGJlIHBhc3NlZCBkaXJlY3RseSB0byB0aGUgZG93bnN0cmVhbSBzb2NrZXQuIFVzZWQgYWZ0ZXIgdGhlIERBVEEgY29tbWFuZFxuICAgIHRoaXMuX2xhc3REYXRhQnl0ZXMgPSAnJyAvLyBLZWVwIHRyYWNrIG9mIHRoZSBsYXN0IGJ5dGVzIHRvIHNlZSBob3cgdGhlIHRlcm1pbmF0aW5nIGRvdCBzaG91bGQgYmUgcGxhY2VkXG4gICAgdGhpcy5fZW52ZWxvcGUgPSBudWxsIC8vIEVudmVsb3BlIG9iamVjdCBmb3IgdHJhY2tpbmcgd2hvIGlzIHNlbmRpbmcgbWFpbCB0byB3aG9tXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IG51bGwgLy8gU3RvcmVzIHRoZSBmdW5jdGlvbiB0aGF0IHNob3VsZCBiZSBydW4gYWZ0ZXIgYSByZXNwb25zZSBoYXMgYmVlbiByZWNlaXZlZCBmcm9tIHRoZSBzZXJ2ZXJcbiAgICB0aGlzLl9zZWN1cmVNb2RlID0gISF0aGlzLm9wdGlvbnMudXNlU2VjdXJlVHJhbnNwb3J0IC8vIEluZGljYXRlcyBpZiB0aGUgY29ubmVjdGlvbiBpcyBzZWN1cmVkIG9yIHBsYWludGV4dFxuICAgIHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lciA9IGZhbHNlIC8vIFRpbWVyIHdhaXRpbmcgdG8gZGVjbGFyZSB0aGUgc29ja2V0IGRlYWQgc3RhcnRpbmcgZnJvbSB0aGUgbGFzdCB3cml0ZVxuICAgIHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCA9IGZhbHNlIC8vIFN0YXJ0IHRpbWUgb2Ygc2VuZGluZyB0aGUgZmlyc3QgcGFja2V0IGluIGRhdGEgbW9kZVxuICAgIHRoaXMuX3NvY2tldFRpbWVvdXRQZXJpb2QgPSBmYWxzZSAvLyBUaW1lb3V0IGZvciBzZW5kaW5nIGluIGRhdGEgbW9kZSwgZ2V0cyBleHRlbmRlZCB3aXRoIGV2ZXJ5IHNlbmQoKVxuXG4gICAgLy8gQWN0aXZhdGUgbG9nZ2luZ1xuICAgIHRoaXMuY3JlYXRlTG9nZ2VyKClcblxuICAgIC8vIEV2ZW50IHBsYWNlaG9sZGVyc1xuICAgIHRoaXMub25lcnJvciA9IChlKSA9PiB7IH0gLy8gV2lsbCBiZSBydW4gd2hlbiBhbiBlcnJvciBvY2N1cnMuIFRoZSBgb25jbG9zZWAgZXZlbnQgd2lsbCBmaXJlIHN1YnNlcXVlbnRseS5cbiAgICB0aGlzLm9uZHJhaW4gPSAoKSA9PiB7IH0gLy8gTW9yZSBkYXRhIGNhbiBiZSBidWZmZXJlZCBpbiB0aGUgc29ja2V0LlxuICAgIHRoaXMub25jbG9zZSA9ICgpID0+IHsgfSAvLyBUaGUgY29ubmVjdGlvbiB0byB0aGUgc2VydmVyIGhhcyBiZWVuIGNsb3NlZFxuICAgIHRoaXMub25pZGxlID0gKCkgPT4geyB9IC8vIFRoZSBjb25uZWN0aW9uIGlzIGVzdGFibGlzaGVkIGFuZCBpZGxlLCB5b3UgY2FuIHNlbmQgbWFpbCBub3dcbiAgICB0aGlzLm9ucmVhZHkgPSAoZmFpbGVkUmVjaXBpZW50cykgPT4geyB9IC8vIFdhaXRpbmcgZm9yIG1haWwgYm9keSwgbGlzdHMgYWRkcmVzc2VzIHRoYXQgd2VyZSBub3QgYWNjZXB0ZWQgYXMgcmVjaXBpZW50c1xuICAgIHRoaXMub25kb25lID0gKHN1Y2Nlc3MpID0+IHsgfSAvLyBUaGUgbWFpbCBoYXMgYmVlbiBzZW50LiBXYWl0IGZvciBgb25pZGxlYCBuZXh0LiBJbmRpY2F0ZXMgaWYgdGhlIG1lc3NhZ2Ugd2FzIHF1ZXVlZCBieSB0aGUgc2VydmVyLlxuICB9XG5cbiAgLyoqXG4gICAqIEluaXRpYXRlIGEgY29ubmVjdGlvbiB0byB0aGUgc2VydmVyXG4gICAqL1xuICBjb25uZWN0IChTb2NrZXRDb250cnVjdG9yID0gVENQU29ja2V0KSB7XG4gICAgdGhpcy5zb2NrZXQgPSBTb2NrZXRDb250cnVjdG9yLm9wZW4odGhpcy5ob3N0LCB0aGlzLnBvcnQsIHtcbiAgICAgIGJpbmFyeVR5cGU6ICdhcnJheWJ1ZmZlcicsXG4gICAgICB1c2VTZWN1cmVUcmFuc3BvcnQ6IHRoaXMuX3NlY3VyZU1vZGUsXG4gICAgICBjYTogdGhpcy5vcHRpb25zLmNhLFxuICAgICAgdGxzV29ya2VyUGF0aDogdGhpcy5vcHRpb25zLnRsc1dvcmtlclBhdGgsXG4gICAgICB3czogdGhpcy5vcHRpb25zLndzXG4gICAgfSlcblxuICAgIC8vIGFsbG93cyBjZXJ0aWZpY2F0ZSBoYW5kbGluZyBmb3IgcGxhdGZvcm0gdy9vIG5hdGl2ZSB0bHMgc3VwcG9ydFxuICAgIC8vIG9uY2VydCBpcyBub24gc3RhbmRhcmQgc28gc2V0dGluZyBpdCBtaWdodCB0aHJvdyBpZiB0aGUgc29ja2V0IG9iamVjdCBpcyBpbW11dGFibGVcbiAgICB0cnkge1xuICAgICAgdGhpcy5zb2NrZXQub25jZXJ0ID0gdGhpcy5vbmNlcnRcbiAgICB9IGNhdGNoIChFKSB7IH1cbiAgICB0aGlzLnNvY2tldC5vbmVycm9yID0gdGhpcy5fb25FcnJvci5iaW5kKHRoaXMpXG4gICAgdGhpcy5zb2NrZXQub25vcGVuID0gdGhpcy5fb25PcGVuLmJpbmQodGhpcylcbiAgfVxuXG4gIC8qKlxuICAgKiBQYXVzZXMgYGRhdGFgIGV2ZW50cyBmcm9tIHRoZSBkb3duc3RyZWFtIFNNVFAgc2VydmVyXG4gICAqL1xuICBzdXNwZW5kICgpIHtcbiAgICBpZiAodGhpcy5zb2NrZXQgJiYgdGhpcy5zb2NrZXQucmVhZHlTdGF0ZSA9PT0gJ29wZW4nKSB7XG4gICAgICB0aGlzLnNvY2tldC5zdXNwZW5kKClcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmVzdW1lcyBgZGF0YWAgZXZlbnRzIGZyb20gdGhlIGRvd25zdHJlYW0gU01UUCBzZXJ2ZXIuIEJlIGNhcmVmdWwgb2Ygbm90XG4gICAqIHJlc3VtaW5nIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBzdXNwZW5kZWQgLSBhbiBlcnJvciBpcyB0aHJvd24gaW4gdGhpcyBjYXNlXG4gICAqL1xuICByZXN1bWUgKCkge1xuICAgIGlmICh0aGlzLnNvY2tldCAmJiB0aGlzLnNvY2tldC5yZWFkeVN0YXRlID09PSAnb3BlbicpIHtcbiAgICAgIHRoaXMuc29ja2V0LnJlc3VtZSgpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFNlbmRzIFFVSVRcbiAgICovXG4gIHF1aXQgKCkge1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgUVVJVC4uLicpXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoJ1FVSVQnKVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLmNsb3NlXG4gIH1cblxuICAvKipcbiAgICogUmVzZXQgYXV0aGVudGljYXRpb25cbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IFthdXRoXSBVc2UgdGhpcyBpZiB5b3Ugd2FudCB0byBhdXRoZW50aWNhdGUgYXMgYW5vdGhlciB1c2VyXG4gICAqL1xuICByZXNldCAoYXV0aCkge1xuICAgIHRoaXMub3B0aW9ucy5hdXRoID0gYXV0aCB8fCB0aGlzLm9wdGlvbnMuYXV0aFxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgUlNFVC4uLicpXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoJ1JTRVQnKVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25SU0VUXG4gIH1cblxuICAvKipcbiAgICogQ2xvc2VzIHRoZSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXJcbiAgICovXG4gIGNsb3NlICgpIHtcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdDbG9zaW5nIGNvbm5lY3Rpb24uLi4nKVxuICAgIGlmICh0aGlzLnNvY2tldCAmJiB0aGlzLnNvY2tldC5yZWFkeVN0YXRlID09PSAnb3BlbicpIHtcbiAgICAgIHRoaXMuc29ja2V0LmNsb3NlKClcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5fZGVzdHJveSgpXG4gICAgfVxuICB9XG5cbiAgLy8gTWFpbCByZWxhdGVkIG1ldGhvZHNcblxuICAvKipcbiAgICogSW5pdGlhdGVzIGEgbmV3IG1lc3NhZ2UgYnkgc3VibWl0dGluZyBlbnZlbG9wZSBkYXRhLCBzdGFydGluZyB3aXRoXG4gICAqIGBNQUlMIEZST006YCBjb21tYW5kLiBVc2UgYWZ0ZXIgYG9uaWRsZWAgZXZlbnRcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGVudmVsb3BlIEVudmVsb3BlIG9iamVjdCBpbiB0aGUgZm9ybSBvZiB7ZnJvbTpcIi4uLlwiLCB0bzpbXCIuLi5cIl19XG4gICAqL1xuICB1c2VFbnZlbG9wZSAoZW52ZWxvcGUpIHtcbiAgICB0aGlzLl9lbnZlbG9wZSA9IGVudmVsb3BlIHx8IHt9XG4gICAgdGhpcy5fZW52ZWxvcGUuZnJvbSA9IFtdLmNvbmNhdCh0aGlzLl9lbnZlbG9wZS5mcm9tIHx8ICgnYW5vbnltb3VzQCcgKyB0aGlzLm9wdGlvbnMubmFtZSkpWzBdXG4gICAgdGhpcy5fZW52ZWxvcGUudG8gPSBbXS5jb25jYXQodGhpcy5fZW52ZWxvcGUudG8gfHwgW10pXG5cbiAgICAvLyBjbG9uZSB0aGUgcmVjaXBpZW50cyBhcnJheSBmb3IgbGF0dGVyIG1hbmlwdWxhdGlvblxuICAgIHRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZSA9IFtdLmNvbmNhdCh0aGlzLl9lbnZlbG9wZS50bylcbiAgICB0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkID0gW11cbiAgICB0aGlzLl9lbnZlbG9wZS5yZXNwb25zZVF1ZXVlID0gW11cblxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25NQUlMXG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBNQUlMIEZST00uLi4nKVxuICAgIHRoaXMuX3NlbmRDb21tYW5kKCdNQUlMIEZST006PCcgKyAodGhpcy5fZW52ZWxvcGUuZnJvbSkgKyAnPicpXG4gIH1cblxuICAvKipcbiAgICogU2VuZCBBU0NJSSBkYXRhIHRvIHRoZSBzZXJ2ZXIuIFdvcmtzIG9ubHkgaW4gZGF0YSBtb2RlIChhZnRlciBgb25yZWFkeWAgZXZlbnQpLCBpZ25vcmVkXG4gICAqIG90aGVyd2lzZVxuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gY2h1bmsgQVNDSUkgc3RyaW5nIChxdW90ZWQtcHJpbnRhYmxlLCBiYXNlNjQgZXRjLikgdG8gYmUgc2VudCB0byB0aGUgc2VydmVyXG4gICAqIEByZXR1cm4ge0Jvb2xlYW59IElmIHRydWUsIGl0IGlzIHNhZmUgdG8gc2VuZCBtb3JlIGRhdGEsIGlmIGZhbHNlLCB5b3UgKnNob3VsZCogd2FpdCBmb3IgdGhlIG9uZHJhaW4gZXZlbnQgYmVmb3JlIHNlbmRpbmcgbW9yZVxuICAgKi9cbiAgc2VuZCAoY2h1bmspIHtcbiAgICAvLyB3b3JrcyBvbmx5IGluIGRhdGEgbW9kZVxuICAgIGlmICghdGhpcy5fZGF0YU1vZGUpIHtcbiAgICAgIC8vIHRoaXMgbGluZSBzaG91bGQgbmV2ZXIgYmUgcmVhY2hlZCBidXQgaWYgaXQgZG9lcyxcbiAgICAgIC8vIGFjdCBsaWtlIGV2ZXJ5dGhpbmcncyBub3JtYWwuXG4gICAgICByZXR1cm4gdHJ1ZVxuICAgIH1cblxuICAgIC8vIFRPRE86IGlmIHRoZSBjaHVuayBpcyBhbiBhcnJheWJ1ZmZlciwgdXNlIGEgc2VwYXJhdGUgZnVuY3Rpb24gdG8gc2VuZCB0aGUgZGF0YVxuICAgIHJldHVybiB0aGlzLl9zZW5kU3RyaW5nKGNodW5rKVxuICB9XG5cbiAgLyoqXG4gICAqIEluZGljYXRlcyB0aGF0IGEgZGF0YSBzdHJlYW0gZm9yIHRoZSBzb2NrZXQgaXMgZW5kZWQuIFdvcmtzIG9ubHkgaW4gZGF0YVxuICAgKiBtb2RlIChhZnRlciBgb25yZWFkeWAgZXZlbnQpLCBpZ25vcmVkIG90aGVyd2lzZS4gVXNlIGl0IHdoZW4geW91IGFyZSBkb25lXG4gICAqIHdpdGggc2VuZGluZyB0aGUgbWFpbC4gVGhpcyBtZXRob2QgZG9lcyBub3QgY2xvc2UgdGhlIHNvY2tldC4gT25jZSB0aGUgbWFpbFxuICAgKiBoYXMgYmVlbiBxdWV1ZWQgYnkgdGhlIHNlcnZlciwgYG9uZG9uZWAgYW5kIGBvbmlkbGVgIGFyZSBlbWl0dGVkLlxuICAgKlxuICAgKiBAcGFyYW0ge0J1ZmZlcn0gW2NodW5rXSBDaHVuayBvZiBkYXRhIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICAgKi9cbiAgZW5kIChjaHVuaykge1xuICAgIC8vIHdvcmtzIG9ubHkgaW4gZGF0YSBtb2RlXG4gICAgaWYgKCF0aGlzLl9kYXRhTW9kZSkge1xuICAgICAgLy8gdGhpcyBsaW5lIHNob3VsZCBuZXZlciBiZSByZWFjaGVkIGJ1dCBpZiBpdCBkb2VzLFxuICAgICAgLy8gYWN0IGxpa2UgZXZlcnl0aGluZydzIG5vcm1hbC5cbiAgICAgIHJldHVybiB0cnVlXG4gICAgfVxuXG4gICAgaWYgKGNodW5rICYmIGNodW5rLmxlbmd0aCkge1xuICAgICAgdGhpcy5zZW5kKGNodW5rKVxuICAgIH1cblxuICAgIC8vIHJlZGlyZWN0IG91dHB1dCBmcm9tIHRoZSBzZXJ2ZXIgdG8gX2FjdGlvblN0cmVhbVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25TdHJlYW1cblxuICAgIC8vIGluZGljYXRlIHRoYXQgdGhlIHN0cmVhbSBoYXMgZW5kZWQgYnkgc2VuZGluZyBhIHNpbmdsZSBkb3Qgb24gaXRzIG93biBsaW5lXG4gICAgLy8gaWYgdGhlIGNsaWVudCBhbHJlYWR5IGNsb3NlZCB0aGUgZGF0YSB3aXRoIFxcclxcbiBubyBuZWVkIHRvIGRvIGl0IGFnYWluXG4gICAgaWYgKHRoaXMuX2xhc3REYXRhQnl0ZXMgPT09ICdcXHJcXG4nKSB7XG4gICAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFVpbnQ4QXJyYXkoWzB4MkUsIDB4MEQsIDB4MEFdKS5idWZmZXIpIC8vIC5cXHJcXG5cbiAgICB9IGVsc2UgaWYgKHRoaXMuX2xhc3REYXRhQnl0ZXMuc3Vic3RyKC0xKSA9PT0gJ1xccicpIHtcbiAgICAgIHRoaXMud2FpdERyYWluID0gdGhpcy5fc2VuZChuZXcgVWludDhBcnJheShbMHgwQSwgMHgyRSwgMHgwRCwgMHgwQV0pLmJ1ZmZlcikgLy8gXFxuLlxcclxcblxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFVpbnQ4QXJyYXkoWzB4MEQsIDB4MEEsIDB4MkUsIDB4MEQsIDB4MEFdKS5idWZmZXIpIC8vIFxcclxcbi5cXHJcXG5cbiAgICB9XG5cbiAgICAvLyBlbmQgZGF0YSBtb2RlLCByZXNldCB0aGUgdmFyaWFibGVzIGZvciBleHRlbmRpbmcgdGhlIHRpbWVvdXQgaW4gZGF0YSBtb2RlXG4gICAgdGhpcy5fZGF0YU1vZGUgPSBmYWxzZVxuICAgIHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCA9IGZhbHNlXG4gICAgdGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCA9IGZhbHNlXG5cbiAgICByZXR1cm4gdGhpcy53YWl0RHJhaW5cbiAgfVxuXG4gIC8vIFBSSVZBVEUgTUVUSE9EU1xuXG4gIC8vIEVWRU5UIEhBTkRMRVJTIEZPUiBUSEUgU09DS0VUXG5cbiAgLyoqXG4gICAqIENvbm5lY3Rpb24gbGlzdGVuZXIgdGhhdCBpcyBydW4gd2hlbiB0aGUgY29ubmVjdGlvbiB0byB0aGUgc2VydmVyIGlzIG9wZW5lZC5cbiAgICogU2V0cyB1cCBkaWZmZXJlbnQgZXZlbnQgaGFuZGxlcnMgZm9yIHRoZSBvcGVuZWQgc29ja2V0XG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBOb3QgdXNlZFxuICAgKi9cbiAgX29uT3BlbiAoZXZlbnQpIHtcbiAgICBpZiAoZXZlbnQgJiYgZXZlbnQuZGF0YSAmJiBldmVudC5kYXRhLnByb3h5SG9zdG5hbWUpIHtcbiAgICAgIHRoaXMub3B0aW9ucy5uYW1lID0gZXZlbnQuZGF0YS5wcm94eUhvc3RuYW1lXG4gICAgfVxuXG4gICAgdGhpcy5zb2NrZXQub25kYXRhID0gdGhpcy5fb25EYXRhLmJpbmQodGhpcylcblxuICAgIHRoaXMuc29ja2V0Lm9uY2xvc2UgPSB0aGlzLl9vbkNsb3NlLmJpbmQodGhpcylcbiAgICB0aGlzLnNvY2tldC5vbmRyYWluID0gdGhpcy5fb25EcmFpbi5iaW5kKHRoaXMpXG5cbiAgICB0aGlzLl9wYXJzZXIub25kYXRhID0gdGhpcy5fb25Db21tYW5kLmJpbmQodGhpcylcblxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25HcmVldGluZ1xuICB9XG5cbiAgLyoqXG4gICAqIERhdGEgbGlzdGVuZXIgZm9yIGNodW5rcyBvZiBkYXRhIGVtaXR0ZWQgYnkgdGhlIHNlcnZlclxuICAgKlxuICAgKiBAZXZlbnRcbiAgICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gU2VlIGBldnQuZGF0YWAgZm9yIHRoZSBjaHVuayByZWNlaXZlZFxuICAgKi9cbiAgX29uRGF0YSAoZXZ0KSB7XG4gICAgY2xlYXJUaW1lb3V0KHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lcilcbiAgICB2YXIgc3RyaW5nUGF5bG9hZCA9IG5ldyBUZXh0RGVjb2RlcignVVRGLTgnKS5kZWNvZGUobmV3IFVpbnQ4QXJyYXkoZXZ0LmRhdGEpKVxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NFUlZFUjogJyArIHN0cmluZ1BheWxvYWQpXG4gICAgdGhpcy5fcGFyc2VyLnNlbmQoc3RyaW5nUGF5bG9hZClcbiAgfVxuXG4gIC8qKlxuICAgKiBNb3JlIGRhdGEgY2FuIGJlIGJ1ZmZlcmVkIGluIHRoZSBzb2NrZXQsIGB3YWl0RHJhaW5gIGlzIHJlc2V0IHRvIGZhbHNlXG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBOb3QgdXNlZFxuICAgKi9cbiAgX29uRHJhaW4gKCkge1xuICAgIHRoaXMud2FpdERyYWluID0gZmFsc2VcbiAgICB0aGlzLm9uZHJhaW4oKVxuICB9XG5cbiAgLyoqXG4gICAqIEVycm9yIGhhbmRsZXIgZm9yIHRoZSBzb2NrZXRcbiAgICpcbiAgICogQGV2ZW50XG4gICAqIEBwYXJhbSB7RXZlbnR9IGV2dCBFdmVudCBvYmplY3QuIFNlZSBldnQuZGF0YSBmb3IgdGhlIGVycm9yXG4gICAqL1xuICBfb25FcnJvciAoZXZ0KSB7XG4gICAgaWYgKGV2dCBpbnN0YW5jZW9mIEVycm9yICYmIGV2dC5tZXNzYWdlKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsIGV2dClcbiAgICAgIHRoaXMub25lcnJvcihldnQpXG4gICAgfSBlbHNlIGlmIChldnQgJiYgZXZ0LmRhdGEgaW5zdGFuY2VvZiBFcnJvcikge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCBldnQuZGF0YSlcbiAgICAgIHRoaXMub25lcnJvcihldnQuZGF0YSlcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCBuZXcgRXJyb3IoKGV2dCAmJiBldnQuZGF0YSAmJiBldnQuZGF0YS5tZXNzYWdlKSB8fCBldnQuZGF0YSB8fCBldnQgfHwgJ0Vycm9yJykpXG4gICAgICB0aGlzLm9uZXJyb3IobmV3IEVycm9yKChldnQgJiYgZXZ0LmRhdGEgJiYgZXZ0LmRhdGEubWVzc2FnZSkgfHwgZXZ0LmRhdGEgfHwgZXZ0IHx8ICdFcnJvcicpKVxuICAgIH1cblxuICAgIHRoaXMuY2xvc2UoKVxuICB9XG5cbiAgLyoqXG4gICAqIEluZGljYXRlcyB0aGF0IHRoZSBzb2NrZXQgaGFzIGJlZW4gY2xvc2VkXG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBOb3QgdXNlZFxuICAgKi9cbiAgX29uQ2xvc2UgKCkge1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NvY2tldCBjbG9zZWQuJylcbiAgICB0aGlzLl9kZXN0cm95KClcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGlzIGlzIG5vdCBhIHNvY2tldCBkYXRhIGhhbmRsZXIgYnV0IHRoZSBoYW5kbGVyIGZvciBkYXRhIGVtaXR0ZWQgYnkgdGhlIHBhcnNlcixcbiAgICogc28gdGhpcyBkYXRhIGlzIHNhZmUgdG8gdXNlIGFzIGl0IGlzIGFsd2F5cyBjb21wbGV0ZSAoc2VydmVyIG1pZ2h0IHNlbmQgcGFydGlhbCBjaHVua3MpXG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgZGF0YVxuICAgKi9cbiAgX29uQ29tbWFuZCAoY29tbWFuZCkge1xuICAgIGlmICh0eXBlb2YgdGhpcy5fY3VycmVudEFjdGlvbiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbihjb21tYW5kKVxuICAgIH1cbiAgfVxuXG4gIF9vblRpbWVvdXQgKCkge1xuICAgIC8vIGluZm9ybSBhYm91dCB0aGUgdGltZW91dCBhbmQgc2h1dCBkb3duXG4gICAgdmFyIGVycm9yID0gbmV3IEVycm9yKCdTb2NrZXQgdGltZWQgb3V0IScpXG4gICAgdGhpcy5fb25FcnJvcihlcnJvcilcbiAgfVxuXG4gIC8qKlxuICAgKiBFbnN1cmVzIHRoYXQgdGhlIGNvbm5lY3Rpb24gaXMgY2xvc2VkIGFuZCBzdWNoXG4gICAqL1xuICBfZGVzdHJveSAoKSB7XG4gICAgY2xlYXJUaW1lb3V0KHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lcilcblxuICAgIGlmICghdGhpcy5kZXN0cm95ZWQpIHtcbiAgICAgIHRoaXMuZGVzdHJveWVkID0gdHJ1ZVxuICAgICAgdGhpcy5vbmNsb3NlKClcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogU2VuZHMgYSBzdHJpbmcgdG8gdGhlIHNvY2tldC5cbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IGNodW5rIEFTQ0lJIHN0cmluZyAocXVvdGVkLXByaW50YWJsZSwgYmFzZTY0IGV0Yy4pIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICAgKiBAcmV0dXJuIHtCb29sZWFufSBJZiB0cnVlLCBpdCBpcyBzYWZlIHRvIHNlbmQgbW9yZSBkYXRhLCBpZiBmYWxzZSwgeW91ICpzaG91bGQqIHdhaXQgZm9yIHRoZSBvbmRyYWluIGV2ZW50IGJlZm9yZSBzZW5kaW5nIG1vcmVcbiAgICovXG4gIF9zZW5kU3RyaW5nIChjaHVuaykge1xuICAgIC8vIGVzY2FwZSBkb3RzXG4gICAgaWYgKCF0aGlzLm9wdGlvbnMuZGlzYWJsZUVzY2FwaW5nKSB7XG4gICAgICBjaHVuayA9IGNodW5rLnJlcGxhY2UoL1xcblxcLi9nLCAnXFxuLi4nKVxuICAgICAgaWYgKCh0aGlzLl9sYXN0RGF0YUJ5dGVzLnN1YnN0cigtMSkgPT09ICdcXG4nIHx8ICF0aGlzLl9sYXN0RGF0YUJ5dGVzKSAmJiBjaHVuay5jaGFyQXQoMCkgPT09ICcuJykge1xuICAgICAgICBjaHVuayA9ICcuJyArIGNodW5rXG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gS2VlcGluZyBleWUgb24gdGhlIGxhc3QgYnl0ZXMgc2VudCwgdG8gc2VlIGlmIHRoZXJlIGlzIGEgPENSPjxMRj4gc2VxdWVuY2VcbiAgICAvLyBhdCB0aGUgZW5kIHdoaWNoIGlzIG5lZWRlZCB0byBlbmQgdGhlIGRhdGEgc3RyZWFtXG4gICAgaWYgKGNodW5rLmxlbmd0aCA+IDIpIHtcbiAgICAgIHRoaXMuX2xhc3REYXRhQnl0ZXMgPSBjaHVuay5zdWJzdHIoLTIpXG4gICAgfSBlbHNlIGlmIChjaHVuay5sZW5ndGggPT09IDEpIHtcbiAgICAgIHRoaXMuX2xhc3REYXRhQnl0ZXMgPSB0aGlzLl9sYXN0RGF0YUJ5dGVzLnN1YnN0cigtMSkgKyBjaHVua1xuICAgIH1cblxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgJyArIGNodW5rLmxlbmd0aCArICcgYnl0ZXMgb2YgcGF5bG9hZCcpXG5cbiAgICAvLyBwYXNzIHRoZSBjaHVuayB0byB0aGUgc29ja2V0XG4gICAgdGhpcy53YWl0RHJhaW4gPSB0aGlzLl9zZW5kKG5ldyBUZXh0RW5jb2RlcignVVRGLTgnKS5lbmNvZGUoY2h1bmspLmJ1ZmZlcilcbiAgICByZXR1cm4gdGhpcy53YWl0RHJhaW5cbiAgfVxuXG4gIC8qKlxuICAgKiBTZW5kIGEgc3RyaW5nIGNvbW1hbmQgdG8gdGhlIHNlcnZlciwgYWxzbyBhcHBlbmQgXFxyXFxuIGlmIG5lZWRlZFxuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gc3RyIFN0cmluZyB0byBiZSBzZW50IHRvIHRoZSBzZXJ2ZXJcbiAgICovXG4gIF9zZW5kQ29tbWFuZCAoc3RyKSB7XG4gICAgdGhpcy53YWl0RHJhaW4gPSB0aGlzLl9zZW5kKG5ldyBUZXh0RW5jb2RlcignVVRGLTgnKS5lbmNvZGUoc3RyICsgKHN0ci5zdWJzdHIoLTIpICE9PSAnXFxyXFxuJyA/ICdcXHJcXG4nIDogJycpKS5idWZmZXIpXG4gIH1cblxuICBfc2VuZCAoYnVmZmVyKSB7XG4gICAgdGhpcy5fc2V0VGltZW91dChidWZmZXIuYnl0ZUxlbmd0aClcbiAgICByZXR1cm4gdGhpcy5zb2NrZXQuc2VuZChidWZmZXIpXG4gIH1cblxuICBfc2V0VGltZW91dCAoYnl0ZUxlbmd0aCkge1xuICAgIHZhciBwcm9sb25nUGVyaW9kID0gTWF0aC5mbG9vcihieXRlTGVuZ3RoICogdGhpcy50aW1lb3V0U29ja2V0TXVsdGlwbGllcilcbiAgICB2YXIgdGltZW91dFxuXG4gICAgaWYgKHRoaXMuX2RhdGFNb2RlKSB7XG4gICAgICAvLyB3ZSdyZSBpbiBkYXRhIG1vZGUsIHNvIHdlIGNvdW50IG9ubHkgb25lIHRpbWVvdXQgdGhhdCBnZXQgZXh0ZW5kZWQgZm9yIGV2ZXJ5IHNlbmQoKS5cbiAgICAgIHZhciBub3cgPSBEYXRlLm5vdygpXG5cbiAgICAgIC8vIHRoZSBvbGQgdGltZW91dCBzdGFydCB0aW1lXG4gICAgICB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgPSB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgfHwgbm93XG5cbiAgICAgIC8vIHRoZSBvbGQgdGltZW91dCBwZXJpb2QsIG5vcm1hbGl6ZWQgdG8gYSBtaW5pbXVtIG9mIFRJTUVPVVRfU09DS0VUX0xPV0VSX0JPVU5EXG4gICAgICB0aGlzLl9zb2NrZXRUaW1lb3V0UGVyaW9kID0gKHRoaXMuX3NvY2tldFRpbWVvdXRQZXJpb2QgfHwgdGhpcy50aW1lb3V0U29ja2V0TG93ZXJCb3VuZCkgKyBwcm9sb25nUGVyaW9kXG5cbiAgICAgIC8vIHRoZSBuZXcgdGltZW91dCBpcyB0aGUgZGVsdGEgYmV0d2VlbiB0aGUgbmV3IGZpcmluZyB0aW1lICg9IHRpbWVvdXQgcGVyaW9kICsgdGltZW91dCBzdGFydCB0aW1lKSBhbmQgbm93XG4gICAgICB0aW1lb3V0ID0gdGhpcy5fc29ja2V0VGltZW91dFN0YXJ0ICsgdGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCAtIG5vd1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBzZXQgbmV3IHRpbW91dFxuICAgICAgdGltZW91dCA9IHRoaXMudGltZW91dFNvY2tldExvd2VyQm91bmQgKyBwcm9sb25nUGVyaW9kXG4gICAgfVxuXG4gICAgY2xlYXJUaW1lb3V0KHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lcikgLy8gY2xlYXIgcGVuZGluZyB0aW1lb3V0c1xuICAgIHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lciA9IHNldFRpbWVvdXQodGhpcy5fb25UaW1lb3V0LmJpbmQodGhpcyksIHRpbWVvdXQpIC8vIGFybSB0aGUgbmV4dCB0aW1lb3V0XG4gIH1cblxuICAvKipcbiAgICogSW50aXRpYXRlIGF1dGhlbnRpY2F0aW9uIHNlcXVlbmNlIGlmIG5lZWRlZFxuICAgKi9cbiAgX2F1dGhlbnRpY2F0ZVVzZXIgKCkge1xuICAgIGlmICghdGhpcy5vcHRpb25zLmF1dGgpIHtcbiAgICAgIC8vIG5vIG5lZWQgdG8gYXV0aGVudGljYXRlLCBhdCBsZWFzdCBubyBkYXRhIGdpdmVuXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgICAgdGhpcy5vbmlkbGUoKSAvLyByZWFkeSB0byB0YWtlIG9yZGVyc1xuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgdmFyIGF1dGhcblxuICAgIGlmICghdGhpcy5vcHRpb25zLmF1dGhNZXRob2QgJiYgdGhpcy5vcHRpb25zLmF1dGgueG9hdXRoMikge1xuICAgICAgdGhpcy5vcHRpb25zLmF1dGhNZXRob2QgPSAnWE9BVVRIMidcbiAgICB9XG5cbiAgICBpZiAodGhpcy5vcHRpb25zLmF1dGhNZXRob2QpIHtcbiAgICAgIGF1dGggPSB0aGlzLm9wdGlvbnMuYXV0aE1ldGhvZC50b1VwcGVyQ2FzZSgpLnRyaW0oKVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyB1c2UgZmlyc3Qgc3VwcG9ydGVkXG4gICAgICBhdXRoID0gKHRoaXMuX3N1cHBvcnRlZEF1dGhbMF0gfHwgJ1BMQUlOJykudG9VcHBlckNhc2UoKS50cmltKClcbiAgICB9XG5cbiAgICBzd2l0Y2ggKGF1dGgpIHtcbiAgICAgIGNhc2UgJ0xPR0lOJzpcbiAgICAgICAgLy8gTE9HSU4gaXMgYSAzIHN0ZXAgYXV0aGVudGljYXRpb24gcHJvY2Vzc1xuICAgICAgICAvLyBDOiBBVVRIIExPR0lOXG4gICAgICAgIC8vIEM6IEJBU0U2NChVU0VSKVxuICAgICAgICAvLyBDOiBCQVNFNjQoUEFTUylcbiAgICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQXV0aGVudGljYXRpb24gdmlhIEFVVEggTE9HSU4nKVxuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSF9MT0dJTl9VU0VSXG4gICAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdBVVRIIExPR0lOJylcbiAgICAgICAgcmV0dXJuXG4gICAgICBjYXNlICdQTEFJTic6XG4gICAgICAgIC8vIEFVVEggUExBSU4gaXMgYSAxIHN0ZXAgYXV0aGVudGljYXRpb24gcHJvY2Vzc1xuICAgICAgICAvLyBDOiBBVVRIIFBMQUlOIEJBU0U2NChcXDAgVVNFUiBcXDAgUEFTUylcbiAgICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQXV0aGVudGljYXRpb24gdmlhIEFVVEggUExBSU4nKVxuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSENvbXBsZXRlXG4gICAgICAgIHRoaXMuX3NlbmRDb21tYW5kKFxuICAgICAgICAgIC8vIGNvbnZlcnQgdG8gQkFTRTY0XG4gICAgICAgICAgJ0FVVEggUExBSU4gJyArXG4gICAgICAgICAgZW5jb2RlKFxuICAgICAgICAgICAgLy8gdGhpcy5vcHRpb25zLmF1dGgudXNlcisnXFx1MDAwMCcrXG4gICAgICAgICAgICAnXFx1MDAwMCcgKyAvLyBza2lwIGF1dGhvcml6YXRpb24gaWRlbnRpdHkgYXMgaXQgY2F1c2VzIHByb2JsZW1zIHdpdGggc29tZSBzZXJ2ZXJzXG4gICAgICAgICAgICB0aGlzLm9wdGlvbnMuYXV0aC51c2VyICsgJ1xcdTAwMDAnICtcbiAgICAgICAgICAgIHRoaXMub3B0aW9ucy5hdXRoLnBhc3MpXG4gICAgICAgIClcbiAgICAgICAgcmV0dXJuXG4gICAgICBjYXNlICdYT0FVVEgyJzpcbiAgICAgICAgLy8gU2VlIGh0dHBzOi8vZGV2ZWxvcGVycy5nb29nbGUuY29tL2dtYWlsL3hvYXV0aDJfcHJvdG9jb2wjc210cF9wcm90b2NvbF9leGNoYW5nZVxuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiB2aWEgQVVUSCBYT0FVVEgyJylcbiAgICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhfWE9BVVRIMlxuICAgICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnQVVUSCBYT0FVVEgyICcgKyB0aGlzLl9idWlsZFhPQXV0aDJUb2tlbih0aGlzLm9wdGlvbnMuYXV0aC51c2VyLCB0aGlzLm9wdGlvbnMuYXV0aC54b2F1dGgyKSlcbiAgICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ1Vua25vd24gYXV0aGVudGljYXRpb24gbWV0aG9kICcgKyBhdXRoKSlcbiAgfVxuXG4gIC8vIEFDVElPTlMgRk9SIFJFU1BPTlNFUyBGUk9NIFRIRSBTTVRQIFNFUlZFUlxuXG4gIC8qKlxuICAgKiBJbml0aWFsIHJlc3BvbnNlIGZyb20gdGhlIHNlcnZlciwgbXVzdCBoYXZlIGEgc3RhdHVzIDIyMFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gICAqL1xuICBfYWN0aW9uR3JlZXRpbmcgKGNvbW1hbmQpIHtcbiAgICBpZiAoY29tbWFuZC5zdGF0dXNDb2RlICE9PSAyMjApIHtcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdJbnZhbGlkIGdyZWV0aW5nOiAnICsgY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIGlmICh0aGlzLm9wdGlvbnMubG10cCkge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBMSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcblxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkxITE9cbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdMSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBFSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcblxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkVITE9cbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdFSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gTEhMT1xuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gICAqL1xuICBfYWN0aW9uTEhMTyAoY29tbWFuZCkge1xuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdMSExPIG5vdCBzdWNjZXNzZnVsJylcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICAvLyBQcm9jZXNzIGFzIEVITE8gcmVzcG9uc2VcbiAgICB0aGlzLl9hY3Rpb25FSExPKGNvbW1hbmQpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gRUhMTy4gSWYgdGhlIHJlc3BvbnNlIGlzIGFuIGVycm9yLCB0cnkgSEVMTyBpbnN0ZWFkXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAgICovXG4gIF9hY3Rpb25FSExPIChjb21tYW5kKSB7XG4gICAgdmFyIG1hdGNoXG5cbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgaWYgKCF0aGlzLl9zZWN1cmVNb2RlICYmIHRoaXMub3B0aW9ucy5yZXF1aXJlVExTKSB7XG4gICAgICAgIHZhciBlcnJNc2cgPSAnU1RBUlRUTFMgbm90IHN1cHBvcnRlZCB3aXRob3V0IEVITE8nXG4gICAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgZXJyTXNnKVxuICAgICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihlcnJNc2cpKVxuICAgICAgICByZXR1cm5cbiAgICAgIH1cblxuICAgICAgLy8gVHJ5IEhFTE8gaW5zdGVhZFxuICAgICAgdGhpcy5sb2dnZXIud2FybihERUJVR19UQUcsICdFSExPIG5vdCBzdWNjZXNzZnVsLCB0cnlpbmcgSEVMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSEVMT1xuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0hFTE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gRGV0ZWN0IGlmIHRoZSBzZXJ2ZXIgc3VwcG9ydHMgUExBSU4gYXV0aFxuICAgIGlmIChjb21tYW5kLmxpbmUubWF0Y2goL0FVVEgoPzpcXHMrW15cXG5dKlxccyt8XFxzKylQTEFJTi9pKSkge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VydmVyIHN1cHBvcnRzIEFVVEggUExBSU4nKVxuICAgICAgdGhpcy5fc3VwcG9ydGVkQXV0aC5wdXNoKCdQTEFJTicpXG4gICAgfVxuXG4gICAgLy8gRGV0ZWN0IGlmIHRoZSBzZXJ2ZXIgc3VwcG9ydHMgTE9HSU4gYXV0aFxuICAgIGlmIChjb21tYW5kLmxpbmUubWF0Y2goL0FVVEgoPzpcXHMrW15cXG5dKlxccyt8XFxzKylMT0dJTi9pKSkge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VydmVyIHN1cHBvcnRzIEFVVEggTE9HSU4nKVxuICAgICAgdGhpcy5fc3VwcG9ydGVkQXV0aC5wdXNoKCdMT0dJTicpXG4gICAgfVxuXG4gICAgLy8gRGV0ZWN0IGlmIHRoZSBzZXJ2ZXIgc3VwcG9ydHMgWE9BVVRIMiBhdXRoXG4gICAgaWYgKGNvbW1hbmQubGluZS5tYXRjaCgvQVVUSCg/OlxccytbXlxcbl0qXFxzK3xcXHMrKVhPQVVUSDIvaSkpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlcnZlciBzdXBwb3J0cyBBVVRIIFhPQVVUSDInKVxuICAgICAgdGhpcy5fc3VwcG9ydGVkQXV0aC5wdXNoKCdYT0FVVEgyJylcbiAgICB9XG5cbiAgICAvLyBEZXRlY3QgbWF4aW11bSBhbGxvd2VkIG1lc3NhZ2Ugc2l6ZVxuICAgIGlmICgobWF0Y2ggPSBjb21tYW5kLmxpbmUubWF0Y2goL1NJWkUgKFxcZCspL2kpKSAmJiBOdW1iZXIobWF0Y2hbMV0pKSB7XG4gICAgICBjb25zdCBtYXhBbGxvd2VkU2l6ZSA9IE51bWJlcihtYXRjaFsxXSlcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ01heGltdW0gYWxsb3dkIG1lc3NhZ2Ugc2l6ZTogJyArIG1heEFsbG93ZWRTaXplKVxuICAgIH1cblxuICAgIC8vIERldGVjdCBpZiB0aGUgc2VydmVyIHN1cHBvcnRzIFNUQVJUVExTXG4gICAgaWYgKCF0aGlzLl9zZWN1cmVNb2RlKSB7XG4gICAgICBpZiAoKGNvbW1hbmQubGluZS5tYXRjaCgvWyAtXVNUQVJUVExTXFxzPyQvbWkpICYmICF0aGlzLm9wdGlvbnMuaWdub3JlVExTKSB8fCAhIXRoaXMub3B0aW9ucy5yZXF1aXJlVExTKSB7XG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25TVEFSVFRMU1xuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIFNUQVJUVExTJylcbiAgICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ1NUQVJUVExTJylcbiAgICAgICAgcmV0dXJuXG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5fYXV0aGVudGljYXRlVXNlcigpXG4gIH1cblxuICAvKipcbiAgICogSGFuZGxlcyBzZXJ2ZXIgcmVzcG9uc2UgZm9yIFNUQVJUVExTIGNvbW1hbmQuIElmIHRoZXJlJ3MgYW4gZXJyb3JcbiAgICogdHJ5IEhFTE8gaW5zdGVhZCwgb3RoZXJ3aXNlIGluaXRpYXRlIFRMUyB1cGdyYWRlLiBJZiB0aGUgdXBncmFkZVxuICAgKiBzdWNjZWVkZXMgcmVzdGFydCB0aGUgRUhMT1xuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gc3RyIE1lc3NhZ2UgZnJvbSB0aGUgc2VydmVyXG4gICAqL1xuICBfYWN0aW9uU1RBUlRUTFMgKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnU1RBUlRUTFMgbm90IHN1Y2Nlc3NmdWwnKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRoaXMuX3NlY3VyZU1vZGUgPSB0cnVlXG4gICAgdGhpcy5zb2NrZXQudXBncmFkZVRvU2VjdXJlKClcblxuICAgIC8vIHJlc3RhcnQgcHJvdG9jb2wgZmxvd1xuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25FSExPXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoJ0VITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIEhFTE9cbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICAgKi9cbiAgX2FjdGlvbkhFTE8gKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnSEVMTyBub3Qgc3VjY2Vzc2Z1bCcpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuICAgIHRoaXMuX2F1dGhlbnRpY2F0ZVVzZXIoKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIEFVVEggTE9HSU4sIGlmIHN1Y2Nlc3NmdWwgZXhwZWN0cyBiYXNlNjQgZW5jb2RlZCB1c2VybmFtZVxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gICAqL1xuICBfYWN0aW9uQVVUSF9MT0dJTl9VU0VSIChjb21tYW5kKSB7XG4gICAgaWYgKGNvbW1hbmQuc3RhdHVzQ29kZSAhPT0gMzM0IHx8IGNvbW1hbmQuZGF0YSAhPT0gJ1ZYTmxjbTVoYldVNicpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0FVVEggTE9HSU4gVVNFUiBub3Qgc3VjY2Vzc2Z1bDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdJbnZhbGlkIGxvZ2luIHNlcXVlbmNlIHdoaWxlIHdhaXRpbmcgZm9yIFwiMzM0IFZYTmxjbTVoYldVNiBcIjogJyArIGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQVVUSCBMT0dJTiBVU0VSIHN1Y2Nlc3NmdWwnKVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIX0xPR0lOX1BBU1NcbiAgICB0aGlzLl9zZW5kQ29tbWFuZChlbmNvZGUodGhpcy5vcHRpb25zLmF1dGgudXNlcikpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gQVVUSCBMT0dJTiB1c2VybmFtZSwgaWYgc3VjY2Vzc2Z1bCBleHBlY3RzIGJhc2U2NCBlbmNvZGVkIHBhc3N3b3JkXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAgICovXG4gIF9hY3Rpb25BVVRIX0xPR0lOX1BBU1MgKGNvbW1hbmQpIHtcbiAgICBpZiAoY29tbWFuZC5zdGF0dXNDb2RlICE9PSAzMzQgfHwgY29tbWFuZC5kYXRhICE9PSAnVUdGemMzZHZjbVE2Jykge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnQVVUSCBMT0dJTiBQQVNTIG5vdCBzdWNjZXNzZnVsOiAnICsgY29tbWFuZC5kYXRhKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ0ludmFsaWQgbG9naW4gc2VxdWVuY2Ugd2hpbGUgd2FpdGluZyBmb3IgXCIzMzQgVUdGemMzZHZjbVE2IFwiOiAnICsgY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBVVRIIExPR0lOIFBBU1Mgc3VjY2Vzc2Z1bCcpXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhDb21wbGV0ZVxuICAgIHRoaXMuX3NlbmRDb21tYW5kKGVuY29kZSh0aGlzLm9wdGlvbnMuYXV0aC5wYXNzKSlcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBBVVRIIFhPQVVUSDIgdG9rZW4sIGlmIGVycm9yIG9jY3VycyBzZW5kIGVtcHR5IHJlc3BvbnNlXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAgICovXG4gIF9hY3Rpb25BVVRIX1hPQVVUSDIgKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIud2FybihERUJVR19UQUcsICdFcnJvciBkdXJpbmcgQVVUSCBYT0FVVEgyLCBzZW5kaW5nIGVtcHR5IHJlc3BvbnNlJylcbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCcnKVxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhDb21wbGV0ZVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLl9hY3Rpb25BVVRIQ29tcGxldGUoY29tbWFuZClcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQ2hlY2tzIGlmIGF1dGhlbnRpY2F0aW9uIHN1Y2NlZWRlZCBvciBub3QuIElmIHN1Y2Nlc3NmdWxseSBhdXRoZW50aWNhdGVkXG4gICAqIGVtaXQgYGlkbGVgIHRvIGluZGljYXRlIHRoYXQgYW4gZS1tYWlsIGNhbiBiZSBzZW50IHVzaW5nIHRoaXMgY29ubmVjdGlvblxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gICAqL1xuICBfYWN0aW9uQVVUSENvbXBsZXRlIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0F1dGhlbnRpY2F0aW9uIGZhaWxlZDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiBzdWNjZXNzZnVsLicpXG5cbiAgICB0aGlzLl9hdXRoZW50aWNhdGVkQXMgPSB0aGlzLm9wdGlvbnMuYXV0aC51c2VyXG5cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgIHRoaXMub25pZGxlKCkgLy8gcmVhZHkgdG8gdGFrZSBvcmRlcnNcbiAgfVxuXG4gIC8qKlxuICAgKiBVc2VkIHdoZW4gdGhlIGNvbm5lY3Rpb24gaXMgaWRsZSBhbmQgdGhlIHNlcnZlciBlbWl0cyB0aW1lb3V0XG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAgICovXG4gIF9hY3Rpb25JZGxlIChjb21tYW5kKSB7XG4gICAgaWYgKGNvbW1hbmQuc3RhdHVzQ29kZSA+IDMwMCkge1xuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5saW5lKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gTUFJTCBGUk9NIGNvbW1hbmQuIFByb2NlZWQgdG8gZGVmaW5pbmcgUkNQVCBUTyBsaXN0IGlmIHN1Y2Nlc3NmdWxcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICAgKi9cbiAgX2FjdGlvbk1BSUwgKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnTUFJTCBGUk9NIHVuc3VjY2Vzc2Z1bDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICBpZiAoIXRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5sZW5ndGgpIHtcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdDYW5cXCd0IHNlbmQgbWFpbCAtIG5vIHJlY2lwaWVudHMgZGVmaW5lZCcpKVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdNQUlMIEZST00gc3VjY2Vzc2Z1bCwgcHJvY2VlZGluZyB3aXRoICcgKyB0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUubGVuZ3RoICsgJyByZWNpcGllbnRzJylcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0FkZGluZyByZWNpcGllbnQuLi4nKVxuICAgICAgdGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50ID0gdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLnNoaWZ0KClcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25SQ1BUXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnUkNQVCBUTzo8JyArIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudCArICc+JylcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gYSBSQ1BUIFRPIGNvbW1hbmQuIElmIHRoZSBjb21tYW5kIGlzIHVuc3VjY2Vzc2Z1bCwgdHJ5IHRoZSBuZXh0IG9uZSxcbiAgICogYXMgdGhpcyBtaWdodCBiZSByZWxhdGVkIG9ubHkgdG8gdGhlIGN1cnJlbnQgcmVjaXBpZW50LCBub3QgYSBnbG9iYWwgZXJyb3IsIHNvXG4gICAqIHRoZSBmb2xsb3dpbmcgcmVjaXBpZW50cyBtaWdodCBzdGlsbCBiZSB2YWxpZFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gICAqL1xuICBfYWN0aW9uUkNQVCAoY29tbWFuZCkge1xuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICB0aGlzLmxvZ2dlci53YXJuKERFQlVHX1RBRywgJ1JDUFQgVE8gZmFpbGVkIGZvcjogJyArIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudClcbiAgICAgIC8vIHRoaXMgaXMgYSBzb2Z0IGVycm9yXG4gICAgICB0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkLnB1c2godGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50KVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLl9lbnZlbG9wZS5yZXNwb25zZVF1ZXVlLnB1c2godGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50KVxuICAgIH1cblxuICAgIGlmICghdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLmxlbmd0aCkge1xuICAgICAgaWYgKHRoaXMuX2VudmVsb3BlLnJjcHRGYWlsZWQubGVuZ3RoIDwgdGhpcy5fZW52ZWxvcGUudG8ubGVuZ3RoKSB7XG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25EQVRBXG4gICAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1JDUFQgVE8gZG9uZSwgcHJvY2VlZGluZyB3aXRoIHBheWxvYWQnKVxuICAgICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnREFUQScpXG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignQ2FuXFwndCBzZW5kIG1haWwgLSBhbGwgcmVjaXBpZW50cyB3ZXJlIHJlamVjdGVkJykpXG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0FkZGluZyByZWNpcGllbnQuLi4nKVxuICAgICAgdGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50ID0gdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLnNoaWZ0KClcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25SQ1BUXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnUkNQVCBUTzo8JyArIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudCArICc+JylcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gdGhlIFJTRVQgY29tbWFuZC4gSWYgc3VjY2Vzc2Z1bCwgY2xlYXIgdGhlIGN1cnJlbnQgYXV0aGVudGljYXRpb25cbiAgICogaW5mb3JtYXRpb24gYW5kIHJlYXV0aGVudGljYXRlLlxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gICAqL1xuICBfYWN0aW9uUlNFVCAoY29tbWFuZCkge1xuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdSU0VUIHVuc3VjY2Vzc2Z1bCAnICsgY29tbWFuZC5kYXRhKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRoaXMuX2F1dGhlbnRpY2F0ZWRBcyA9IG51bGxcbiAgICB0aGlzLl9hdXRoZW50aWNhdGVVc2VyKClcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byB0aGUgREFUQSBjb21tYW5kLiBTZXJ2ZXIgaXMgbm93IHdhaXRpbmcgZm9yIGEgbWVzc2FnZSwgc28gZW1pdCBgb25yZWFkeWBcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICAgKi9cbiAgX2FjdGlvbkRBVEEgKGNvbW1hbmQpIHtcbiAgICAvLyByZXNwb25zZSBzaG91bGQgYmUgMzU0IGJ1dCBhY2NvcmRpbmcgdG8gdGhpcyBpc3N1ZSBodHRwczovL2dpdGh1Yi5jb20vZWxlaXRoL2VtYWlsanMvaXNzdWVzLzI0XG4gICAgLy8gc29tZSBzZXJ2ZXJzIG1pZ2h0IHVzZSAyNTAgaW5zdGVhZFxuICAgIGlmIChbMjUwLCAzNTRdLmluZGV4T2YoY29tbWFuZC5zdGF0dXNDb2RlKSA8IDApIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0RBVEEgdW5zdWNjZXNzZnVsICcgKyBjb21tYW5kLmRhdGEpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgdGhpcy5fZGF0YU1vZGUgPSB0cnVlXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICB0aGlzLm9ucmVhZHkodGhpcy5fZW52ZWxvcGUucmNwdEZhaWxlZClcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSBmcm9tIHRoZSBzZXJ2ZXIsIG9uY2UgdGhlIG1lc3NhZ2Ugc3RyZWFtIGhhcyBlbmRlZCB3aXRoIDxDUj48TEY+LjxDUj48TEY+XG4gICAqIEVtaXRzIGBvbmRvbmVgLlxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gICAqL1xuICBfYWN0aW9uU3RyZWFtIChjb21tYW5kKSB7XG4gICAgdmFyIHJjcHRcblxuICAgIGlmICh0aGlzLm9wdGlvbnMubG10cCkge1xuICAgICAgLy8gTE1UUCByZXR1cm5zIGEgcmVzcG9uc2UgY29kZSBmb3IgKmV2ZXJ5KiBzdWNjZXNzZnVsbHkgc2V0IHJlY2lwaWVudFxuICAgICAgLy8gRm9yIGV2ZXJ5IHJlY2lwaWVudCB0aGUgbWVzc2FnZSBtaWdodCBzdWNjZWVkIG9yIGZhaWwgaW5kaXZpZHVhbGx5XG5cbiAgICAgIHJjcHQgPSB0aGlzLl9lbnZlbG9wZS5yZXNwb25zZVF1ZXVlLnNoaWZ0KClcbiAgICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0xvY2FsIGRlbGl2ZXJ5IHRvICcgKyByY3B0ICsgJyBmYWlsZWQuJylcbiAgICAgICAgdGhpcy5fZW52ZWxvcGUucmNwdEZhaWxlZC5wdXNoKHJjcHQpXG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdMb2NhbCBkZWxpdmVyeSB0byAnICsgcmNwdCArICcgc3VjY2VlZGVkLicpXG4gICAgICB9XG5cbiAgICAgIGlmICh0aGlzLl9lbnZlbG9wZS5yZXNwb25zZVF1ZXVlLmxlbmd0aCkge1xuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uU3RyZWFtXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgICAgdGhpcy5vbmRvbmUodHJ1ZSlcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gRm9yIFNNVFAgdGhlIG1lc3NhZ2UgZWl0aGVyIGZhaWxzIG9yIHN1Y2NlZWRzLCB0aGVyZSBpcyBubyBpbmZvcm1hdGlvblxuICAgICAgLy8gYWJvdXQgaW5kaXZpZHVhbCByZWNpcGllbnRzXG5cbiAgICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ01lc3NhZ2Ugc2VuZGluZyBmYWlsZWQuJylcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ01lc3NhZ2Ugc2VudCBzdWNjZXNzZnVsbHkuJylcbiAgICAgIH1cblxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICAgIHRoaXMub25kb25lKCEhY29tbWFuZC5zdWNjZXNzKVxuICAgIH1cblxuICAgIC8vIElmIHRoZSBjbGllbnQgd2FudGVkIHRvIGRvIHNvbWV0aGluZyBlbHNlIChlZy4gdG8gcXVpdCksIGRvIG5vdCBmb3JjZSBpZGxlXG4gICAgaWYgKHRoaXMuX2N1cnJlbnRBY3Rpb24gPT09IHRoaXMuX2FjdGlvbklkbGUpIHtcbiAgICAgIC8vIFdhaXRpbmcgZm9yIG5ldyBjb25uZWN0aW9uc1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnSWRsaW5nIHdoaWxlIHdhaXRpbmcgZm9yIG5ldyBjb25uZWN0aW9ucy4uLicpXG4gICAgICB0aGlzLm9uaWRsZSgpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEJ1aWxkcyBhIGxvZ2luIHRva2VuIGZvciBYT0FVVEgyIGF1dGhlbnRpY2F0aW9uIGNvbW1hbmRcbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IHVzZXIgRS1tYWlsIGFkZHJlc3Mgb2YgdGhlIHVzZXJcbiAgICogQHBhcmFtIHtTdHJpbmd9IHRva2VuIFZhbGlkIGFjY2VzcyB0b2tlbiBmb3IgdGhlIHVzZXJcbiAgICogQHJldHVybiB7U3RyaW5nfSBCYXNlNjQgZm9ybWF0dGVkIGxvZ2luIHRva2VuXG4gICAqL1xuICBfYnVpbGRYT0F1dGgyVG9rZW4gKHVzZXIsIHRva2VuKSB7XG4gICAgdmFyIGF1dGhEYXRhID0gW1xuICAgICAgJ3VzZXI9JyArICh1c2VyIHx8ICcnKSxcbiAgICAgICdhdXRoPUJlYXJlciAnICsgdG9rZW4sXG4gICAgICAnJyxcbiAgICAgICcnXG4gICAgXVxuICAgIC8vIGJhc2U2NChcInVzZXI9e1VzZXJ9XFx4MDBhdXRoPUJlYXJlciB7VG9rZW59XFx4MDBcXHgwMFwiKVxuICAgIHJldHVybiBlbmNvZGUoYXV0aERhdGEuam9pbignXFx4MDEnKSlcbiAgfVxuXG4gIGNyZWF0ZUxvZ2dlciAoY3JlYXRvciA9IGNyZWF0ZURlZmF1bHRMb2dnZXIpIHtcbiAgICBjb25zdCBsb2dnZXIgPSBjcmVhdG9yKCh0aGlzLm9wdGlvbnMuYXV0aCB8fCB7fSkudXNlciB8fCAnJywgdGhpcy5ob3N0KVxuICAgIHRoaXMubG9nTGV2ZWwgPSB0aGlzLkxPR19MRVZFTF9BTExcbiAgICB0aGlzLmxvZ2dlciA9IHtcbiAgICAgIGRlYnVnOiAoLi4ubXNncykgPT4geyBpZiAoTE9HX0xFVkVMX0RFQlVHID49IHRoaXMubG9nTGV2ZWwpIHsgbG9nZ2VyLmRlYnVnKG1zZ3MpIH0gfSxcbiAgICAgIGluZm86ICguLi5tc2dzKSA9PiB7IGlmIChMT0dfTEVWRUxfSU5GTyA+PSB0aGlzLmxvZ0xldmVsKSB7IGxvZ2dlci5pbmZvKG1zZ3MpIH0gfSxcbiAgICAgIHdhcm46ICguLi5tc2dzKSA9PiB7IGlmIChMT0dfTEVWRUxfV0FSTiA+PSB0aGlzLmxvZ0xldmVsKSB7IGxvZ2dlci53YXJuKG1zZ3MpIH0gfSxcbiAgICAgIGVycm9yOiAoLi4ubXNncykgPT4geyBpZiAoTE9HX0xFVkVMX0VSUk9SID49IHRoaXMubG9nTGV2ZWwpIHsgbG9nZ2VyLmVycm9yKG1zZ3MpIH0gfVxuICAgIH1cbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBTbXRwQ2xpZW50XG4iXX0=