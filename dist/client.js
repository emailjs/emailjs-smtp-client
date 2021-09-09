'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }(); /* eslint-disable camelcase */

var _emailjsBase = require('emailjs-base64');

var _emailjsTcpSocket = require('emailjs-tcp-socket');

var _emailjsTcpSocket2 = _interopRequireDefault(_emailjsTcpSocket);

var _textEncoding = require('text-encoding');

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
   * @param {Boolean} [options.logger] A winston-compatible logger
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

    this._parseBlock = { data: [], statusCode: null };
    this._parseRemainder = ''; // If the complete line is not received yet, contains the beginning of it

    var dummyLogger = ['error', 'warning', 'info', 'debug'].reduce(function (o, l) {
      o[l] = function () {};return o;
    }, {});
    this.logger = options.logger || dummyLogger;

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

    /**
     * Queue some data from the server for parsing.
     *
     * @param {String} chunk Chunk of data received from the server
     */

  }, {
    key: '_parse',
    value: function _parse(chunk) {
      // Lines should always end with <CR><LF> but you never know, might be only <LF> as well
      var lines = (this._parseRemainder + (chunk || '')).split(/\r?\n/);
      this._parseRemainder = lines.pop(); // not sure if the line has completely arrived yet

      for (var i = 0, len = lines.length; i < len; i++) {
        if (!lines[i].trim()) {
          // nothing to check, empty line
          continue;
        }

        // possible input strings for the regex:
        // 250-MULTILINE REPLY
        // 250 LAST LINE OF REPLY
        // 250 1.2.3 MESSAGE

        var match = lines[i].match(/^(\d{3})([- ])(?:(\d+\.\d+\.\d+)(?: ))?(.*)/);

        if (match) {
          this._parseBlock.data.push(match[4]);

          if (match[2] === '-') {
            // this is a multiline reply
            this._parseBlock.statusCode = this._parseBlock.statusCode || Number(match[1]);
          } else {
            var statusCode = Number(match[1]) || 0;
            var response = {
              statusCode: statusCode,
              data: this._parseBlock.data.join('\n'),
              success: statusCode >= 200 && statusCode < 300
            };

            this._onCommand(response);
            this._parseBlock = {
              data: [],
              statusCode: null
            };
          }
        } else {
          this._onCommand({
            success: false,
            statusCode: this._parseBlock.statusCode || null,
            data: [lines[i]].join('\n')
          });
          this._parseBlock = {
            data: [],
            statusCode: null
          };
        }
      }
    }

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
      this._parse(stringPayload);
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
     * @param {Object} command Parsed command from the server {statusCode, data}
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
     * @param {Object} command Parsed command from the server {statusCode, data}
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
     * @param {Object} command Parsed command from the server {statusCode, data}
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
        this.logger.warning(DEBUG_TAG, 'EHLO not successful, trying HELO ' + this.options.name);
        this._currentAction = this._actionHELO;
        this._sendCommand('HELO ' + this.options.name);
        return;
      }

      // Detect if the server supports PLAIN auth
      if (command.data.match(/AUTH(?:\s+[^\n]*\s+|\s+)PLAIN/i)) {
        this.logger.debug(DEBUG_TAG, 'Server supports AUTH PLAIN');
        this._supportedAuth.push('PLAIN');
      }

      // Detect if the server supports LOGIN auth
      if (command.data.match(/AUTH(?:\s+[^\n]*\s+|\s+)LOGIN/i)) {
        this.logger.debug(DEBUG_TAG, 'Server supports AUTH LOGIN');
        this._supportedAuth.push('LOGIN');
      }

      // Detect if the server supports XOAUTH2 auth
      if (command.data.match(/AUTH(?:\s+[^\n]*\s+|\s+)XOAUTH2/i)) {
        this.logger.debug(DEBUG_TAG, 'Server supports AUTH XOAUTH2');
        this._supportedAuth.push('XOAUTH2');
      }

      // Detect maximum allowed message size
      if ((match = command.data.match(/SIZE (\d+)/i)) && Number(match[1])) {
        var maxAllowedSize = Number(match[1]);
        this.logger.debug(DEBUG_TAG, 'Maximum allowd message size: ' + maxAllowedSize);
      }

      // Detect if the server supports STARTTLS
      if (!this._secureMode) {
        if (command.data.match(/STARTTLS\s?$/mi) && !this.options.ignoreTLS || !!this.options.requireTLS) {
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
     * @param {Object} command Parsed command from the server {statusCode, data}
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
     * @param {Object} command Parsed command from the server {statusCode, data}
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
     * @param {Object} command Parsed command from the server {statusCode, data}
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
     * @param {Object} command Parsed command from the server {statusCode, data}
     */

  }, {
    key: '_actionAUTH_XOAUTH2',
    value: function _actionAUTH_XOAUTH2(command) {
      if (!command.success) {
        this.logger.warning(DEBUG_TAG, 'Error during AUTH XOAUTH2, sending empty response');
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
     * @param {Object} command Parsed command from the server {statusCode, data}
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
     * @param {Object} command Parsed command from the server {statusCode, data}
     */

  }, {
    key: '_actionIdle',
    value: function _actionIdle(command) {
      if (command.statusCode > 300) {
        this._onError(new Error(command.data));
        return;
      }

      this._onError(new Error(command.data));
    }

    /**
     * Response to MAIL FROM command. Proceed to defining RCPT TO list if successful
     *
     * @param {Object} command Parsed command from the server {statusCode, data}
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
     * @param {Object} command Parsed command from the server {statusCode, data}
     */

  }, {
    key: '_actionRCPT',
    value: function _actionRCPT(command) {
      if (!command.success) {
        this.logger.warning(DEBUG_TAG, 'RCPT TO failed for: ' + this._envelope.curRecipient);
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
     * Response to the DATA command. Server is now waiting for a message, so emit `onready`
     *
     * @param {Object} command Parsed command from the server {statusCode, data}
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
     * @param {Object} command Parsed command from the server {statusCode, data}
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
  }]);

  return SmtpClient;
}();

exports.default = SmtpClient;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9jbGllbnQuanMiXSwibmFtZXMiOlsiREVCVUdfVEFHIiwiVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkQiLCJUSU1FT1VUX1NPQ0tFVF9NVUxUSVBMSUVSIiwiU210cENsaWVudCIsImhvc3QiLCJwb3J0Iiwib3B0aW9ucyIsInRpbWVvdXRTb2NrZXRMb3dlckJvdW5kIiwidGltZW91dFNvY2tldE11bHRpcGxpZXIiLCJ1c2VTZWN1cmVUcmFuc3BvcnQiLCJhdXRoIiwibmFtZSIsInNvY2tldCIsImRlc3Ryb3llZCIsIndhaXREcmFpbiIsIl9hdXRoZW50aWNhdGVkQXMiLCJfc3VwcG9ydGVkQXV0aCIsIl9kYXRhTW9kZSIsIl9sYXN0RGF0YUJ5dGVzIiwiX2VudmVsb3BlIiwiX2N1cnJlbnRBY3Rpb24iLCJfc2VjdXJlTW9kZSIsIl9zb2NrZXRUaW1lb3V0VGltZXIiLCJfc29ja2V0VGltZW91dFN0YXJ0IiwiX3NvY2tldFRpbWVvdXRQZXJpb2QiLCJfcGFyc2VCbG9jayIsImRhdGEiLCJzdGF0dXNDb2RlIiwiX3BhcnNlUmVtYWluZGVyIiwiZHVtbXlMb2dnZXIiLCJyZWR1Y2UiLCJvIiwibCIsImxvZ2dlciIsIm9uZXJyb3IiLCJlIiwib25kcmFpbiIsIm9uY2xvc2UiLCJvbmlkbGUiLCJvbnJlYWR5IiwiZmFpbGVkUmVjaXBpZW50cyIsIm9uZG9uZSIsInN1Y2Nlc3MiLCJTb2NrZXRDb250cnVjdG9yIiwiVENQU29ja2V0Iiwib3BlbiIsImJpbmFyeVR5cGUiLCJjYSIsInRsc1dvcmtlclBhdGgiLCJ3cyIsIm9uY2VydCIsIkUiLCJfb25FcnJvciIsImJpbmQiLCJvbm9wZW4iLCJfb25PcGVuIiwiZGVidWciLCJfc2VuZENvbW1hbmQiLCJjbG9zZSIsInJlYWR5U3RhdGUiLCJfZGVzdHJveSIsImVudmVsb3BlIiwiZnJvbSIsImNvbmNhdCIsInRvIiwicmNwdFF1ZXVlIiwicmNwdEZhaWxlZCIsInJlc3BvbnNlUXVldWUiLCJfYWN0aW9uTUFJTCIsImNodW5rIiwiX3NlbmRTdHJpbmciLCJsZW5ndGgiLCJzZW5kIiwiX2FjdGlvblN0cmVhbSIsIl9zZW5kIiwiVWludDhBcnJheSIsImJ1ZmZlciIsInN1YnN0ciIsImxpbmVzIiwic3BsaXQiLCJwb3AiLCJpIiwibGVuIiwidHJpbSIsIm1hdGNoIiwicHVzaCIsIk51bWJlciIsInJlc3BvbnNlIiwiam9pbiIsIl9vbkNvbW1hbmQiLCJldmVudCIsInByb3h5SG9zdG5hbWUiLCJvbmRhdGEiLCJfb25EYXRhIiwiX29uQ2xvc2UiLCJfb25EcmFpbiIsIl9hY3Rpb25HcmVldGluZyIsImV2dCIsImNsZWFyVGltZW91dCIsInN0cmluZ1BheWxvYWQiLCJUZXh0RGVjb2RlciIsImRlY29kZSIsIl9wYXJzZSIsIkVycm9yIiwibWVzc2FnZSIsImVycm9yIiwiY29tbWFuZCIsImRpc2FibGVFc2NhcGluZyIsInJlcGxhY2UiLCJjaGFyQXQiLCJUZXh0RW5jb2RlciIsImVuY29kZSIsInN0ciIsIl9zZXRUaW1lb3V0IiwiYnl0ZUxlbmd0aCIsInByb2xvbmdQZXJpb2QiLCJNYXRoIiwiZmxvb3IiLCJ0aW1lb3V0Iiwibm93IiwiRGF0ZSIsInNldFRpbWVvdXQiLCJfb25UaW1lb3V0IiwiX2FjdGlvbklkbGUiLCJhdXRoTWV0aG9kIiwieG9hdXRoMiIsInRvVXBwZXJDYXNlIiwiX2FjdGlvbkFVVEhfTE9HSU5fVVNFUiIsIl9hY3Rpb25BVVRIQ29tcGxldGUiLCJ1c2VyIiwicGFzcyIsIl9hY3Rpb25BVVRIX1hPQVVUSDIiLCJfYnVpbGRYT0F1dGgyVG9rZW4iLCJsbXRwIiwiX2FjdGlvbkxITE8iLCJfYWN0aW9uRUhMTyIsInJlcXVpcmVUTFMiLCJlcnJNc2ciLCJ3YXJuaW5nIiwiX2FjdGlvbkhFTE8iLCJtYXhBbGxvd2VkU2l6ZSIsImlnbm9yZVRMUyIsIl9hY3Rpb25TVEFSVFRMUyIsIl9hdXRoZW50aWNhdGVVc2VyIiwidXBncmFkZVRvU2VjdXJlIiwiX2FjdGlvbkFVVEhfTE9HSU5fUEFTUyIsImN1clJlY2lwaWVudCIsInNoaWZ0IiwiX2FjdGlvblJDUFQiLCJfYWN0aW9uREFUQSIsImluZGV4T2YiLCJyY3B0IiwidG9rZW4iLCJhdXRoRGF0YSJdLCJtYXBwaW5ncyI6Ijs7Ozs7O3FqQkFBQTs7QUFFQTs7QUFDQTs7OztBQUNBOzs7Ozs7QUFFQSxJQUFJQSxZQUFZLGFBQWhCOztBQUVBOzs7QUFHQSxJQUFNQyw2QkFBNkIsS0FBbkM7O0FBRUE7Ozs7Ozs7QUFPQSxJQUFNQyw0QkFBNEIsR0FBbEM7O0lBRU1DLFU7QUFDSjs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQW1CQSxzQkFBYUMsSUFBYixFQUFtQkMsSUFBbkIsRUFBdUM7QUFBQSxRQUFkQyxPQUFjLHVFQUFKLEVBQUk7O0FBQUE7O0FBQ3JDLFNBQUtBLE9BQUwsR0FBZUEsT0FBZjs7QUFFQSxTQUFLQyx1QkFBTCxHQUErQk4sMEJBQS9CO0FBQ0EsU0FBS08sdUJBQUwsR0FBK0JOLHlCQUEvQjs7QUFFQSxTQUFLRyxJQUFMLEdBQVlBLFNBQVMsS0FBS0MsT0FBTCxDQUFhRyxrQkFBYixHQUFrQyxHQUFsQyxHQUF3QyxFQUFqRCxDQUFaO0FBQ0EsU0FBS0wsSUFBTCxHQUFZQSxRQUFRLFdBQXBCOztBQUVBOzs7OztBQUtBLFNBQUtFLE9BQUwsQ0FBYUcsa0JBQWIsR0FBa0Msd0JBQXdCLEtBQUtILE9BQTdCLEdBQXVDLENBQUMsQ0FBQyxLQUFLQSxPQUFMLENBQWFHLGtCQUF0RCxHQUEyRSxLQUFLSixJQUFMLEtBQWMsR0FBM0g7O0FBRUEsU0FBS0MsT0FBTCxDQUFhSSxJQUFiLEdBQW9CLEtBQUtKLE9BQUwsQ0FBYUksSUFBYixJQUFxQixLQUF6QyxDQWhCcUMsQ0FnQlU7QUFDL0MsU0FBS0osT0FBTCxDQUFhSyxJQUFiLEdBQW9CLEtBQUtMLE9BQUwsQ0FBYUssSUFBYixJQUFxQixXQUF6QyxDQWpCcUMsQ0FpQmdCO0FBQ3JELFNBQUtDLE1BQUwsR0FBYyxLQUFkLENBbEJxQyxDQWtCakI7QUFDcEIsU0FBS0MsU0FBTCxHQUFpQixLQUFqQixD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TCxDQUFZd0UsS0FBWixDQUFrQnpHLFNBQWxCLEVBQTZCLHlCQUE3QjtBQUNELFNBRkQsTUFFTztBQUNMLGVBQUtpQyxNQUFMLENBQVl1QixLQUFaLENBQWtCeEQsU0FBbEIsRUFBNkIsNEJBQTdCO0FBQ0Q7O0FBRUQsYUFBS29CLGNBQUwsR0FBc0IsS0FBS3VHLFdBQTNCO0FBQ0EsYUFBS2xGLE1BQUwsQ0FBWSxDQUFDLENBQUNpRSxRQUFRaEUsT0FBdEI7QUFDRDs7QUFFRDtBQUNBLFVBQUksS0FBS3RCLGNBQUwsS0FBd0IsS0FBS3VHLFdBQWpDLEVBQThDO0FBQzVDO0FBQ0EsYUFBSzFGLE1BQUwsQ0FBWXVCLEtBQVosQ0FBa0J4RCxTQUFsQixFQUE2Qiw2Q0FBN0I7QUFDQSxhQUFLc0MsTUFBTDtBQUNEO0FBQ0Y7O0FBRUQ7Ozs7Ozs7Ozs7dUNBT29CMkYsSSxFQUFNdUIsSyxFQUFPO0FBQy9CLFVBQUlDLFdBQVcsQ0FDYixXQUFXeEIsUUFBUSxFQUFuQixDQURhLEVBRWIsaUJBQWlCdUIsS0FGSixFQUdiLEVBSGEsRUFJYixFQUphLENBQWY7QUFNQTtBQUNBLGFBQU8seUJBQU9DLFNBQVNqRSxJQUFULENBQWMsTUFBZCxDQUFQLENBQVA7QUFDRDs7Ozs7O2tCQUdZckYsVSIsImZpbGUiOiJjbGllbnQuanMiLCJzb3VyY2VzQ29udGVudCI6WyIvKiBlc2xpbnQtZGlzYWJsZSBjYW1lbGNhc2UgKi9cblxuaW1wb3J0IHsgZW5jb2RlIH0gZnJvbSAnZW1haWxqcy1iYXNlNjQnXG5pbXBvcnQgVENQU29ja2V0IGZyb20gJ2VtYWlsanMtdGNwLXNvY2tldCdcbmltcG9ydCB7IFRleHREZWNvZGVyLCBUZXh0RW5jb2RlciB9IGZyb20gJ3RleHQtZW5jb2RpbmcnXG5cbnZhciBERUJVR19UQUcgPSAnU01UUCBDbGllbnQnXG5cbi8qKlxuICogTG93ZXIgQm91bmQgZm9yIHNvY2tldCB0aW1lb3V0IHRvIHdhaXQgc2luY2UgdGhlIGxhc3QgZGF0YSB3YXMgd3JpdHRlbiB0byBhIHNvY2tldFxuICovXG5jb25zdCBUSU1FT1VUX1NPQ0tFVF9MT1dFUl9CT1VORCA9IDEwMDAwXG5cbi8qKlxuICogTXVsdGlwbGllciBmb3Igc29ja2V0IHRpbWVvdXQ6XG4gKlxuICogV2UgYXNzdW1lIGF0IGxlYXN0IGEgR1BSUyBjb25uZWN0aW9uIHdpdGggMTE1IGtiL3MgPSAxNCwzNzUga0IvcyB0b3BzLCBzbyAxMCBLQi9zIHRvIGJlIG9uXG4gKiB0aGUgc2FmZSBzaWRlLiBXZSBjYW4gdGltZW91dCBhZnRlciBhIGxvd2VyIGJvdW5kIG9mIDEwcyArIChuIEtCIC8gMTAgS0IvcykuIEEgMSBNQiBtZXNzYWdlXG4gKiB1cGxvYWQgd291bGQgYmUgMTEwIHNlY29uZHMgdG8gd2FpdCBmb3IgdGhlIHRpbWVvdXQuIDEwIEtCL3MgPT09IDAuMSBzL0JcbiAqL1xuY29uc3QgVElNRU9VVF9TT0NLRVRfTVVMVElQTElFUiA9IDAuMVxuXG5jbGFzcyBTbXRwQ2xpZW50IHtcbiAgLyoqXG4gICAqIENyZWF0ZXMgYSBjb25uZWN0aW9uIG9iamVjdCB0byBhIFNNVFAgc2VydmVyIGFuZCBhbGxvd3MgdG8gc2VuZCBtYWlsIHRocm91Z2ggaXQuXG4gICAqIENhbGwgYGNvbm5lY3RgIG1ldGhvZCB0byBpbml0aXRhdGUgdGhlIGFjdHVhbCBjb25uZWN0aW9uLCB0aGUgY29uc3RydWN0b3Igb25seVxuICAgKiBkZWZpbmVzIHRoZSBwcm9wZXJ0aWVzIGJ1dCBkb2VzIG5vdCBhY3R1YWxseSBjb25uZWN0LlxuICAgKlxuICAgKiBOQiEgVGhlIHBhcmFtZXRlciBvcmRlciAoaG9zdCwgcG9ydCkgZGlmZmVycyBmcm9tIG5vZGUuanMgXCJ3YXlcIiAocG9ydCwgaG9zdClcbiAgICpcbiAgICogQGNvbnN0cnVjdG9yXG4gICAqXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBbaG9zdD1cImxvY2FsaG9zdFwiXSBIb3N0bmFtZSB0byBjb25lbmN0IHRvXG4gICAqIEBwYXJhbSB7TnVtYmVyfSBbcG9ydD0yNV0gUG9ydCBudW1iZXIgdG8gY29ubmVjdCB0b1xuICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdIE9wdGlvbmFsIG9wdGlvbnMgb2JqZWN0XG4gICAqIEBwYXJhbSB7Qm9vbGVhbn0gW29wdGlvbnMudXNlU2VjdXJlVHJhbnNwb3J0XSBTZXQgdG8gdHJ1ZSwgdG8gdXNlIGVuY3J5cHRlZCBjb25uZWN0aW9uXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBbb3B0aW9ucy5uYW1lXSBDbGllbnQgaG9zdG5hbWUgZm9yIGludHJvZHVjaW5nIGl0c2VsZiB0byB0aGUgc2VydmVyXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9ucy5hdXRoXSBBdXRoZW50aWNhdGlvbiBvcHRpb25zLiBEZXBlbmRzIG9uIHRoZSBwcmVmZXJyZWQgYXV0aGVudGljYXRpb24gbWV0aG9kLiBVc3VhbGx5IHt1c2VyLCBwYXNzfVxuICAgKiBAcGFyYW0ge1N0cmluZ30gW29wdGlvbnMuYXV0aE1ldGhvZF0gRm9yY2Ugc3BlY2lmaWMgYXV0aGVudGljYXRpb24gbWV0aG9kXG4gICAqIEBwYXJhbSB7Qm9vbGVhbn0gW29wdGlvbnMuZGlzYWJsZUVzY2FwaW5nXSBJZiBzZXQgdG8gdHJ1ZSwgZG8gbm90IGVzY2FwZSBkb3RzIG9uIHRoZSBiZWdpbm5pbmcgb2YgdGhlIGxpbmVzXG4gICAqIEBwYXJhbSB7Qm9vbGVhbn0gW29wdGlvbnMubG9nZ2VyXSBBIHdpbnN0b24tY29tcGF0aWJsZSBsb2dnZXJcbiAgICovXG4gIGNvbnN0cnVjdG9yIChob3N0LCBwb3J0LCBvcHRpb25zID0ge30pIHtcbiAgICB0aGlzLm9wdGlvbnMgPSBvcHRpb25zXG5cbiAgICB0aGlzLnRpbWVvdXRTb2NrZXRMb3dlckJvdW5kID0gVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkRcbiAgICB0aGlzLnRpbWVvdXRTb2NrZXRNdWx0aXBsaWVyID0gVElNRU9VVF9TT0NLRVRfTVVMVElQTElFUlxuXG4gICAgdGhpcy5wb3J0ID0gcG9ydCB8fCAodGhpcy5vcHRpb25zLnVzZVNlY3VyZVRyYW5zcG9ydCA/IDQ2NSA6IDI1KVxuICAgIHRoaXMuaG9zdCA9IGhvc3QgfHwgJ2xvY2FsaG9zdCdcblxuICAgIC8qKlxuICAgICAqIElmIHNldCB0byB0cnVlLCBzdGFydCBhbiBlbmNyeXB0ZWQgY29ubmVjdGlvbiBpbnN0ZWFkIG9mIHRoZSBwbGFpbnRleHQgb25lXG4gICAgICogKHJlY29tbWVuZGVkIGlmIGFwcGxpY2FibGUpLiBJZiB1c2VTZWN1cmVUcmFuc3BvcnQgaXMgbm90IHNldCBidXQgdGhlIHBvcnQgdXNlZCBpcyA0NjUsXG4gICAgICogdGhlbiBlY3J5cHRpb24gaXMgdXNlZCBieSBkZWZhdWx0LlxuICAgICAqL1xuICAgIHRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnQgPSAndXNlU2VjdXJlVHJhbnNwb3J0JyBpbiB0aGlzLm9wdGlvbnMgPyAhIXRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnQgOiB0aGlzLnBvcnQgPT09IDQ2NVxuXG4gICAgdGhpcy5vcHRpb25zLmF1dGggPSB0aGlzLm9wdGlvbnMuYXV0aCB8fCBmYWxzZSAvLyBBdXRoZW50aWNhdGlvbiBvYmplY3QuIElmIG5vdCBzZXQsIGF1dGhlbnRpY2F0aW9uIHN0ZXAgd2lsbCBiZSBza2lwcGVkLlxuICAgIHRoaXMub3B0aW9ucy5uYW1lID0gdGhpcy5vcHRpb25zLm5hbWUgfHwgJ2xvY2FsaG9zdCcgLy8gSG9zdG5hbWUgb2YgdGhlIGNsaWVudCwgdGhpcyB3aWxsIGJlIHVzZWQgZm9yIGludHJvZHVjaW5nIHRvIHRoZSBzZXJ2ZXJcbiAgICB0aGlzLnNvY2tldCA9IGZhbHNlIC8vIERvd25zdHJlYW0gVENQIHNvY2tldCB0byB0aGUgU01UUCBzZXJ2ZXIsIGNyZWF0ZWQgd2l0aCBtb3pUQ1BTb2NrZXRcbiAgICB0aGlzLmRlc3Ryb3llZCA9IGZhbHNlIC8vIEluZGljYXRlcyBpZiB0aGUgY29ubmVjdGlvbiBoYXMgYmVlbiBjbG9zZWQgYW5kIGNhbid0IGJlIHVzZWQgYW55bW9yZVxuICAgIHRoaXMud2FpdERyYWluID0gZmFsc2UgLy8gS2VlcHMgdHJhY2sgaWYgdGhlIGRvd25zdHJlYW0gc29ja2V0IGlzIGN1cnJlbnRseSBmdWxsIGFuZCBhIGRyYWluIGV2ZW50IHNob3VsZCBiZSB3YWl0ZWQgZm9yIG9yIG5vdFxuXG4gICAgLy8gUHJpdmF0ZSBwcm9wZXJ0aWVzXG5cbiAgICB0aGlzLl9hdXRoZW50aWNhdGVkQXMgPSBudWxsIC8vIElmIGF1dGhlbnRpY2F0ZWQgc3VjY2Vzc2Z1bGx5LCBzdG9yZXMgdGhlIHVzZXJuYW1lXG4gICAgdGhpcy5fc3VwcG9ydGVkQXV0aCA9IFtdIC8vIEEgbGlzdCBvZiBhdXRoZW50aWNhdGlvbiBtZWNoYW5pc21zIGRldGVjdGVkIGZyb20gdGhlIEVITE8gcmVzcG9uc2UgYW5kIHdoaWNoIGFyZSBjb21wYXRpYmxlIHdpdGggdGhpcyBsaWJyYXJ5XG4gICAgdGhpcy5fZGF0YU1vZGUgPSBmYWxzZSAvLyBJZiB0cnVlLCBhY2NlcHRzIGRhdGEgZnJvbSB0aGUgdXBzdHJlYW0gdG8gYmUgcGFzc2VkIGRpcmVjdGx5IHRvIHRoZSBkb3duc3RyZWFtIHNvY2tldC4gVXNlZCBhZnRlciB0aGUgREFUQSBjb21tYW5kXG4gICAgdGhpcy5fbGFzdERhdGFCeXRlcyA9ICcnIC8vIEtlZXAgdHJhY2sgb2YgdGhlIGxhc3QgYnl0ZXMgdG8gc2VlIGhvdyB0aGUgdGVybWluYXRpbmcgZG90IHNob3VsZCBiZSBwbGFjZWRcbiAgICB0aGlzLl9lbnZlbG9wZSA9IG51bGwgLy8gRW52ZWxvcGUgb2JqZWN0IGZvciB0cmFja2luZyB3aG8gaXMgc2VuZGluZyBtYWlsIHRvIHdob21cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gbnVsbCAvLyBTdG9yZXMgdGhlIGZ1bmN0aW9uIHRoYXQgc2hvdWxkIGJlIHJ1biBhZnRlciBhIHJlc3BvbnNlIGhhcyBiZWVuIHJlY2VpdmVkIGZyb20gdGhlIHNlcnZlclxuICAgIHRoaXMuX3NlY3VyZU1vZGUgPSAhIXRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnQgLy8gSW5kaWNhdGVzIGlmIHRoZSBjb25uZWN0aW9uIGlzIHNlY3VyZWQgb3IgcGxhaW50ZXh0XG4gICAgdGhpcy5fc29ja2V0VGltZW91dFRpbWVyID0gZmFsc2UgLy8gVGltZXIgd2FpdGluZyB0byBkZWNsYXJlIHRoZSBzb2NrZXQgZGVhZCBzdGFydGluZyBmcm9tIHRoZSBsYXN0IHdyaXRlXG4gICAgdGhpcy5fc29ja2V0VGltZW91dFN0YXJ0ID0gZmFsc2UgLy8gU3RhcnQgdGltZSBvZiBzZW5kaW5nIHRoZSBmaXJzdCBwYWNrZXQgaW4gZGF0YSBtb2RlXG4gICAgdGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCA9IGZhbHNlIC8vIFRpbWVvdXQgZm9yIHNlbmRpbmcgaW4gZGF0YSBtb2RlLCBnZXRzIGV4dGVuZGVkIHdpdGggZXZlcnkgc2VuZCgpXG5cbiAgICB0aGlzLl9wYXJzZUJsb2NrID0geyBkYXRhOiBbXSwgc3RhdHVzQ29kZTogbnVsbCB9XG4gICAgdGhpcy5fcGFyc2VSZW1haW5kZXIgPSAnJyAvLyBJZiB0aGUgY29tcGxldGUgbGluZSBpcyBub3QgcmVjZWl2ZWQgeWV0LCBjb250YWlucyB0aGUgYmVnaW5uaW5nIG9mIGl0XG5cbiAgICBjb25zdCBkdW1teUxvZ2dlciA9IFsnZXJyb3InLCAnd2FybmluZycsICdpbmZvJywgJ2RlYnVnJ10ucmVkdWNlKChvLCBsKSA9PiB7IG9bbF0gPSAoKSA9PiB7fTsgcmV0dXJuIG8gfSwge30pXG4gICAgdGhpcy5sb2dnZXIgPSBvcHRpb25zLmxvZ2dlciB8fCBkdW1teUxvZ2dlclxuXG4gICAgLy8gRXZlbnQgcGxhY2Vob2xkZXJzXG4gICAgdGhpcy5vbmVycm9yID0gKGUpID0+IHsgfSAvLyBXaWxsIGJlIHJ1biB3aGVuIGFuIGVycm9yIG9jY3Vycy4gVGhlIGBvbmNsb3NlYCBldmVudCB3aWxsIGZpcmUgc3Vic2VxdWVudGx5LlxuICAgIHRoaXMub25kcmFpbiA9ICgpID0+IHsgfSAvLyBNb3JlIGRhdGEgY2FuIGJlIGJ1ZmZlcmVkIGluIHRoZSBzb2NrZXQuXG4gICAgdGhpcy5vbmNsb3NlID0gKCkgPT4geyB9IC8vIFRoZSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXIgaGFzIGJlZW4gY2xvc2VkXG4gICAgdGhpcy5vbmlkbGUgPSAoKSA9PiB7IH0gLy8gVGhlIGNvbm5lY3Rpb24gaXMgZXN0YWJsaXNoZWQgYW5kIGlkbGUsIHlvdSBjYW4gc2VuZCBtYWlsIG5vd1xuICAgIHRoaXMub25yZWFkeSA9IChmYWlsZWRSZWNpcGllbnRzKSA9PiB7IH0gLy8gV2FpdGluZyBmb3IgbWFpbCBib2R5LCBsaXN0cyBhZGRyZXNzZXMgdGhhdCB3ZXJlIG5vdCBhY2NlcHRlZCBhcyByZWNpcGllbnRzXG4gICAgdGhpcy5vbmRvbmUgPSAoc3VjY2VzcykgPT4geyB9IC8vIFRoZSBtYWlsIGhhcyBiZWVuIHNlbnQuIFdhaXQgZm9yIGBvbmlkbGVgIG5leHQuIEluZGljYXRlcyBpZiB0aGUgbWVzc2FnZSB3YXMgcXVldWVkIGJ5IHRoZSBzZXJ2ZXIuXG4gIH1cblxuICAvKipcbiAgICogSW5pdGlhdGUgYSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXJcbiAgICovXG4gIGNvbm5lY3QgKFNvY2tldENvbnRydWN0b3IgPSBUQ1BTb2NrZXQpIHtcbiAgICB0aGlzLnNvY2tldCA9IFNvY2tldENvbnRydWN0b3Iub3Blbih0aGlzLmhvc3QsIHRoaXMucG9ydCwge1xuICAgICAgYmluYXJ5VHlwZTogJ2FycmF5YnVmZmVyJyxcbiAgICAgIHVzZVNlY3VyZVRyYW5zcG9ydDogdGhpcy5fc2VjdXJlTW9kZSxcbiAgICAgIGNhOiB0aGlzLm9wdGlvbnMuY2EsXG4gICAgICB0bHNXb3JrZXJQYXRoOiB0aGlzLm9wdGlvbnMudGxzV29ya2VyUGF0aCxcbiAgICAgIHdzOiB0aGlzLm9wdGlvbnMud3NcbiAgICB9KVxuXG4gICAgLy8gYWxsb3dzIGNlcnRpZmljYXRlIGhhbmRsaW5nIGZvciBwbGF0Zm9ybSB3L28gbmF0aXZlIHRscyBzdXBwb3J0XG4gICAgLy8gb25jZXJ0IGlzIG5vbiBzdGFuZGFyZCBzbyBzZXR0aW5nIGl0IG1pZ2h0IHRocm93IGlmIHRoZSBzb2NrZXQgb2JqZWN0IGlzIGltbXV0YWJsZVxuICAgIHRyeSB7XG4gICAgICB0aGlzLnNvY2tldC5vbmNlcnQgPSB0aGlzLm9uY2VydFxuICAgIH0gY2F0Y2ggKEUpIHsgfVxuICAgIHRoaXMuc29ja2V0Lm9uZXJyb3IgPSB0aGlzLl9vbkVycm9yLmJpbmQodGhpcylcbiAgICB0aGlzLnNvY2tldC5vbm9wZW4gPSB0aGlzLl9vbk9wZW4uYmluZCh0aGlzKVxuICB9XG5cbiAgLyoqXG4gICAqIFNlbmRzIFFVSVRcbiAgICovXG4gIHF1aXQgKCkge1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgUVVJVC4uLicpXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoJ1FVSVQnKVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLmNsb3NlXG4gIH1cblxuICAvKipcbiAgICogQ2xvc2VzIHRoZSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXJcbiAgICovXG4gIGNsb3NlICgpIHtcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdDbG9zaW5nIGNvbm5lY3Rpb24uLi4nKVxuICAgIGlmICh0aGlzLnNvY2tldCAmJiB0aGlzLnNvY2tldC5yZWFkeVN0YXRlID09PSAnb3BlbicpIHtcbiAgICAgIHRoaXMuc29ja2V0LmNsb3NlKClcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5fZGVzdHJveSgpXG4gICAgfVxuICB9XG5cbiAgLy8gTWFpbCByZWxhdGVkIG1ldGhvZHNcblxuICAvKipcbiAgICogSW5pdGlhdGVzIGEgbmV3IG1lc3NhZ2UgYnkgc3VibWl0dGluZyBlbnZlbG9wZSBkYXRhLCBzdGFydGluZyB3aXRoXG4gICAqIGBNQUlMIEZST006YCBjb21tYW5kLiBVc2UgYWZ0ZXIgYG9uaWRsZWAgZXZlbnRcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGVudmVsb3BlIEVudmVsb3BlIG9iamVjdCBpbiB0aGUgZm9ybSBvZiB7ZnJvbTpcIi4uLlwiLCB0bzpbXCIuLi5cIl19XG4gICAqL1xuICB1c2VFbnZlbG9wZSAoZW52ZWxvcGUpIHtcbiAgICB0aGlzLl9lbnZlbG9wZSA9IGVudmVsb3BlIHx8IHt9XG4gICAgdGhpcy5fZW52ZWxvcGUuZnJvbSA9IFtdLmNvbmNhdCh0aGlzLl9lbnZlbG9wZS5mcm9tIHx8ICgnYW5vbnltb3VzQCcgKyB0aGlzLm9wdGlvbnMubmFtZSkpWzBdXG4gICAgdGhpcy5fZW52ZWxvcGUudG8gPSBbXS5jb25jYXQodGhpcy5fZW52ZWxvcGUudG8gfHwgW10pXG5cbiAgICAvLyBjbG9uZSB0aGUgcmVjaXBpZW50cyBhcnJheSBmb3IgbGF0dGVyIG1hbmlwdWxhdGlvblxuICAgIHRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZSA9IFtdLmNvbmNhdCh0aGlzLl9lbnZlbG9wZS50bylcbiAgICB0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkID0gW11cbiAgICB0aGlzLl9lbnZlbG9wZS5yZXNwb25zZVF1ZXVlID0gW11cblxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25NQUlMXG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBNQUlMIEZST00uLi4nKVxuICAgIHRoaXMuX3NlbmRDb21tYW5kKCdNQUlMIEZST006PCcgKyAodGhpcy5fZW52ZWxvcGUuZnJvbSkgKyAnPicpXG4gIH1cblxuICAvKipcbiAgICogU2VuZCBBU0NJSSBkYXRhIHRvIHRoZSBzZXJ2ZXIuIFdvcmtzIG9ubHkgaW4gZGF0YSBtb2RlIChhZnRlciBgb25yZWFkeWAgZXZlbnQpLCBpZ25vcmVkXG4gICAqIG90aGVyd2lzZVxuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gY2h1bmsgQVNDSUkgc3RyaW5nIChxdW90ZWQtcHJpbnRhYmxlLCBiYXNlNjQgZXRjLikgdG8gYmUgc2VudCB0byB0aGUgc2VydmVyXG4gICAqIEByZXR1cm4ge0Jvb2xlYW59IElmIHRydWUsIGl0IGlzIHNhZmUgdG8gc2VuZCBtb3JlIGRhdGEsIGlmIGZhbHNlLCB5b3UgKnNob3VsZCogd2FpdCBmb3IgdGhlIG9uZHJhaW4gZXZlbnQgYmVmb3JlIHNlbmRpbmcgbW9yZVxuICAgKi9cbiAgc2VuZCAoY2h1bmspIHtcbiAgICAvLyB3b3JrcyBvbmx5IGluIGRhdGEgbW9kZVxuICAgIGlmICghdGhpcy5fZGF0YU1vZGUpIHtcbiAgICAgIC8vIHRoaXMgbGluZSBzaG91bGQgbmV2ZXIgYmUgcmVhY2hlZCBidXQgaWYgaXQgZG9lcyxcbiAgICAgIC8vIGFjdCBsaWtlIGV2ZXJ5dGhpbmcncyBub3JtYWwuXG4gICAgICByZXR1cm4gdHJ1ZVxuICAgIH1cblxuICAgIC8vIFRPRE86IGlmIHRoZSBjaHVuayBpcyBhbiBhcnJheWJ1ZmZlciwgdXNlIGEgc2VwYXJhdGUgZnVuY3Rpb24gdG8gc2VuZCB0aGUgZGF0YVxuICAgIHJldHVybiB0aGlzLl9zZW5kU3RyaW5nKGNodW5rKVxuICB9XG5cbiAgLyoqXG4gICAqIEluZGljYXRlcyB0aGF0IGEgZGF0YSBzdHJlYW0gZm9yIHRoZSBzb2NrZXQgaXMgZW5kZWQuIFdvcmtzIG9ubHkgaW4gZGF0YVxuICAgKiBtb2RlIChhZnRlciBgb25yZWFkeWAgZXZlbnQpLCBpZ25vcmVkIG90aGVyd2lzZS4gVXNlIGl0IHdoZW4geW91IGFyZSBkb25lXG4gICAqIHdpdGggc2VuZGluZyB0aGUgbWFpbC4gVGhpcyBtZXRob2QgZG9lcyBub3QgY2xvc2UgdGhlIHNvY2tldC4gT25jZSB0aGUgbWFpbFxuICAgKiBoYXMgYmVlbiBxdWV1ZWQgYnkgdGhlIHNlcnZlciwgYG9uZG9uZWAgYW5kIGBvbmlkbGVgIGFyZSBlbWl0dGVkLlxuICAgKlxuICAgKiBAcGFyYW0ge0J1ZmZlcn0gW2NodW5rXSBDaHVuayBvZiBkYXRhIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICAgKi9cbiAgZW5kIChjaHVuaykge1xuICAgIC8vIHdvcmtzIG9ubHkgaW4gZGF0YSBtb2RlXG4gICAgaWYgKCF0aGlzLl9kYXRhTW9kZSkge1xuICAgICAgLy8gdGhpcyBsaW5lIHNob3VsZCBuZXZlciBiZSByZWFjaGVkIGJ1dCBpZiBpdCBkb2VzLFxuICAgICAgLy8gYWN0IGxpa2UgZXZlcnl0aGluZydzIG5vcm1hbC5cbiAgICAgIHJldHVybiB0cnVlXG4gICAgfVxuXG4gICAgaWYgKGNodW5rICYmIGNodW5rLmxlbmd0aCkge1xuICAgICAgdGhpcy5zZW5kKGNodW5rKVxuICAgIH1cblxuICAgIC8vIHJlZGlyZWN0IG91dHB1dCBmcm9tIHRoZSBzZXJ2ZXIgdG8gX2FjdGlvblN0cmVhbVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25TdHJlYW1cblxuICAgIC8vIGluZGljYXRlIHRoYXQgdGhlIHN0cmVhbSBoYXMgZW5kZWQgYnkgc2VuZGluZyBhIHNpbmdsZSBkb3Qgb24gaXRzIG93biBsaW5lXG4gICAgLy8gaWYgdGhlIGNsaWVudCBhbHJlYWR5IGNsb3NlZCB0aGUgZGF0YSB3aXRoIFxcclxcbiBubyBuZWVkIHRvIGRvIGl0IGFnYWluXG4gICAgaWYgKHRoaXMuX2xhc3REYXRhQnl0ZXMgPT09ICdcXHJcXG4nKSB7XG4gICAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFVpbnQ4QXJyYXkoWzB4MkUsIDB4MEQsIDB4MEFdKS5idWZmZXIpIC8vIC5cXHJcXG5cbiAgICB9IGVsc2UgaWYgKHRoaXMuX2xhc3REYXRhQnl0ZXMuc3Vic3RyKC0xKSA9PT0gJ1xccicpIHtcbiAgICAgIHRoaXMud2FpdERyYWluID0gdGhpcy5fc2VuZChuZXcgVWludDhBcnJheShbMHgwQSwgMHgyRSwgMHgwRCwgMHgwQV0pLmJ1ZmZlcikgLy8gXFxuLlxcclxcblxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFVpbnQ4QXJyYXkoWzB4MEQsIDB4MEEsIDB4MkUsIDB4MEQsIDB4MEFdKS5idWZmZXIpIC8vIFxcclxcbi5cXHJcXG5cbiAgICB9XG5cbiAgICAvLyBlbmQgZGF0YSBtb2RlLCByZXNldCB0aGUgdmFyaWFibGVzIGZvciBleHRlbmRpbmcgdGhlIHRpbWVvdXQgaW4gZGF0YSBtb2RlXG4gICAgdGhpcy5fZGF0YU1vZGUgPSBmYWxzZVxuICAgIHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCA9IGZhbHNlXG4gICAgdGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCA9IGZhbHNlXG5cbiAgICByZXR1cm4gdGhpcy53YWl0RHJhaW5cbiAgfVxuXG4gIC8vIFBSSVZBVEUgTUVUSE9EU1xuXG4gIC8qKlxuICAgKiBRdWV1ZSBzb21lIGRhdGEgZnJvbSB0aGUgc2VydmVyIGZvciBwYXJzaW5nLlxuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gY2h1bmsgQ2h1bmsgb2YgZGF0YSByZWNlaXZlZCBmcm9tIHRoZSBzZXJ2ZXJcbiAgICovXG4gIF9wYXJzZSAoY2h1bmspIHtcbiAgICAvLyBMaW5lcyBzaG91bGQgYWx3YXlzIGVuZCB3aXRoIDxDUj48TEY+IGJ1dCB5b3UgbmV2ZXIga25vdywgbWlnaHQgYmUgb25seSA8TEY+IGFzIHdlbGxcbiAgICB2YXIgbGluZXMgPSAodGhpcy5fcGFyc2VSZW1haW5kZXIgKyAoY2h1bmsgfHwgJycpKS5zcGxpdCgvXFxyP1xcbi8pXG4gICAgdGhpcy5fcGFyc2VSZW1haW5kZXIgPSBsaW5lcy5wb3AoKSAvLyBub3Qgc3VyZSBpZiB0aGUgbGluZSBoYXMgY29tcGxldGVseSBhcnJpdmVkIHlldFxuXG4gICAgZm9yIChsZXQgaSA9IDAsIGxlbiA9IGxpbmVzLmxlbmd0aDsgaSA8IGxlbjsgaSsrKSB7XG4gICAgICBpZiAoIWxpbmVzW2ldLnRyaW0oKSkge1xuICAgICAgICAvLyBub3RoaW5nIHRvIGNoZWNrLCBlbXB0eSBsaW5lXG4gICAgICAgIGNvbnRpbnVlXG4gICAgICB9XG5cbiAgICAgIC8vIHBvc3NpYmxlIGlucHV0IHN0cmluZ3MgZm9yIHRoZSByZWdleDpcbiAgICAgIC8vIDI1MC1NVUxUSUxJTkUgUkVQTFlcbiAgICAgIC8vIDI1MCBMQVNUIExJTkUgT0YgUkVQTFlcbiAgICAgIC8vIDI1MCAxLjIuMyBNRVNTQUdFXG5cbiAgICAgIGNvbnN0IG1hdGNoID0gbGluZXNbaV0ubWF0Y2goL14oXFxkezN9KShbLSBdKSg/OihcXGQrXFwuXFxkK1xcLlxcZCspKD86ICkpPyguKikvKVxuXG4gICAgICBpZiAobWF0Y2gpIHtcbiAgICAgICAgdGhpcy5fcGFyc2VCbG9jay5kYXRhLnB1c2gobWF0Y2hbNF0pXG5cbiAgICAgICAgaWYgKG1hdGNoWzJdID09PSAnLScpIHtcbiAgICAgICAgICAvLyB0aGlzIGlzIGEgbXVsdGlsaW5lIHJlcGx5XG4gICAgICAgICAgdGhpcy5fcGFyc2VCbG9jay5zdGF0dXNDb2RlID0gdGhpcy5fcGFyc2VCbG9jay5zdGF0dXNDb2RlIHx8IE51bWJlcihtYXRjaFsxXSlcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjb25zdCBzdGF0dXNDb2RlID0gTnVtYmVyKG1hdGNoWzFdKSB8fCAwXG4gICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSB7XG4gICAgICAgICAgICBzdGF0dXNDb2RlLFxuICAgICAgICAgICAgZGF0YTogdGhpcy5fcGFyc2VCbG9jay5kYXRhLmpvaW4oJ1xcbicpLFxuICAgICAgICAgICAgc3VjY2Vzczogc3RhdHVzQ29kZSA+PSAyMDAgJiYgc3RhdHVzQ29kZSA8IDMwMFxuICAgICAgICAgIH1cblxuICAgICAgICAgIHRoaXMuX29uQ29tbWFuZChyZXNwb25zZSlcbiAgICAgICAgICB0aGlzLl9wYXJzZUJsb2NrID0ge1xuICAgICAgICAgICAgZGF0YTogW10sXG4gICAgICAgICAgICBzdGF0dXNDb2RlOiBudWxsXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLl9vbkNvbW1hbmQoe1xuICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgIHN0YXR1c0NvZGU6IHRoaXMuX3BhcnNlQmxvY2suc3RhdHVzQ29kZSB8fCBudWxsLFxuICAgICAgICAgIGRhdGE6IFtsaW5lc1tpXV0uam9pbignXFxuJylcbiAgICAgICAgfSlcbiAgICAgICAgdGhpcy5fcGFyc2VCbG9jayA9IHtcbiAgICAgICAgICBkYXRhOiBbXSxcbiAgICAgICAgICBzdGF0dXNDb2RlOiBudWxsXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBFVkVOVCBIQU5ETEVSUyBGT1IgVEhFIFNPQ0tFVFxuXG4gIC8qKlxuICAgKiBDb25uZWN0aW9uIGxpc3RlbmVyIHRoYXQgaXMgcnVuIHdoZW4gdGhlIGNvbm5lY3Rpb24gdG8gdGhlIHNlcnZlciBpcyBvcGVuZWQuXG4gICAqIFNldHMgdXAgZGlmZmVyZW50IGV2ZW50IGhhbmRsZXJzIGZvciB0aGUgb3BlbmVkIHNvY2tldFxuICAgKlxuICAgKiBAZXZlbnRcbiAgICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gTm90IHVzZWRcbiAgICovXG4gIF9vbk9wZW4gKGV2ZW50KSB7XG4gICAgaWYgKGV2ZW50ICYmIGV2ZW50LmRhdGEgJiYgZXZlbnQuZGF0YS5wcm94eUhvc3RuYW1lKSB7XG4gICAgICB0aGlzLm9wdGlvbnMubmFtZSA9IGV2ZW50LmRhdGEucHJveHlIb3N0bmFtZVxuICAgIH1cblxuICAgIHRoaXMuc29ja2V0Lm9uZGF0YSA9IHRoaXMuX29uRGF0YS5iaW5kKHRoaXMpXG5cbiAgICB0aGlzLnNvY2tldC5vbmNsb3NlID0gdGhpcy5fb25DbG9zZS5iaW5kKHRoaXMpXG4gICAgdGhpcy5zb2NrZXQub25kcmFpbiA9IHRoaXMuX29uRHJhaW4uYmluZCh0aGlzKVxuXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkdyZWV0aW5nXG4gIH1cblxuICAvKipcbiAgICogRGF0YSBsaXN0ZW5lciBmb3IgY2h1bmtzIG9mIGRhdGEgZW1pdHRlZCBieSB0aGUgc2VydmVyXG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBTZWUgYGV2dC5kYXRhYCBmb3IgdGhlIGNodW5rIHJlY2VpdmVkXG4gICAqL1xuICBfb25EYXRhIChldnQpIHtcbiAgICBjbGVhclRpbWVvdXQodGhpcy5fc29ja2V0VGltZW91dFRpbWVyKVxuICAgIHZhciBzdHJpbmdQYXlsb2FkID0gbmV3IFRleHREZWNvZGVyKCdVVEYtOCcpLmRlY29kZShuZXcgVWludDhBcnJheShldnQuZGF0YSkpXG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU0VSVkVSOiAnICsgc3RyaW5nUGF5bG9hZClcbiAgICB0aGlzLl9wYXJzZShzdHJpbmdQYXlsb2FkKVxuICB9XG5cbiAgLyoqXG4gICAqIE1vcmUgZGF0YSBjYW4gYmUgYnVmZmVyZWQgaW4gdGhlIHNvY2tldCwgYHdhaXREcmFpbmAgaXMgcmVzZXQgdG8gZmFsc2VcbiAgICpcbiAgICogQGV2ZW50XG4gICAqIEBwYXJhbSB7RXZlbnR9IGV2dCBFdmVudCBvYmplY3QuIE5vdCB1c2VkXG4gICAqL1xuICBfb25EcmFpbiAoKSB7XG4gICAgdGhpcy53YWl0RHJhaW4gPSBmYWxzZVxuICAgIHRoaXMub25kcmFpbigpXG4gIH1cblxuICAvKipcbiAgICogRXJyb3IgaGFuZGxlciBmb3IgdGhlIHNvY2tldFxuICAgKlxuICAgKiBAZXZlbnRcbiAgICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gU2VlIGV2dC5kYXRhIGZvciB0aGUgZXJyb3JcbiAgICovXG4gIF9vbkVycm9yIChldnQpIHtcbiAgICBpZiAoZXZ0IGluc3RhbmNlb2YgRXJyb3IgJiYgZXZ0Lm1lc3NhZ2UpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgZXZ0KVxuICAgICAgdGhpcy5vbmVycm9yKGV2dClcbiAgICB9IGVsc2UgaWYgKGV2dCAmJiBldnQuZGF0YSBpbnN0YW5jZW9mIEVycm9yKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsIGV2dC5kYXRhKVxuICAgICAgdGhpcy5vbmVycm9yKGV2dC5kYXRhKVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsIG5ldyBFcnJvcigoZXZ0ICYmIGV2dC5kYXRhICYmIGV2dC5kYXRhLm1lc3NhZ2UpIHx8IGV2dC5kYXRhIHx8IGV2dCB8fCAnRXJyb3InKSlcbiAgICAgIHRoaXMub25lcnJvcihuZXcgRXJyb3IoKGV2dCAmJiBldnQuZGF0YSAmJiBldnQuZGF0YS5tZXNzYWdlKSB8fCBldnQuZGF0YSB8fCBldnQgfHwgJ0Vycm9yJykpXG4gICAgfVxuXG4gICAgdGhpcy5jbG9zZSgpXG4gIH1cblxuICAvKipcbiAgICogSW5kaWNhdGVzIHRoYXQgdGhlIHNvY2tldCBoYXMgYmVlbiBjbG9zZWRcbiAgICpcbiAgICogQGV2ZW50XG4gICAqIEBwYXJhbSB7RXZlbnR9IGV2dCBFdmVudCBvYmplY3QuIE5vdCB1c2VkXG4gICAqL1xuICBfb25DbG9zZSAoKSB7XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU29ja2V0IGNsb3NlZC4nKVxuICAgIHRoaXMuX2Rlc3Ryb3koKVxuICB9XG5cbiAgLyoqXG4gICAqIFRoaXMgaXMgbm90IGEgc29ja2V0IGRhdGEgaGFuZGxlciBidXQgdGhlIGhhbmRsZXIgZm9yIGRhdGEgZW1pdHRlZCBieSB0aGUgcGFyc2VyLFxuICAgKiBzbyB0aGlzIGRhdGEgaXMgc2FmZSB0byB1c2UgYXMgaXQgaXMgYWx3YXlzIGNvbXBsZXRlIChzZXJ2ZXIgbWlnaHQgc2VuZCBwYXJ0aWFsIGNodW5rcylcbiAgICpcbiAgICogQGV2ZW50XG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBkYXRhXG4gICAqL1xuICBfb25Db21tYW5kIChjb21tYW5kKSB7XG4gICAgaWYgKHR5cGVvZiB0aGlzLl9jdXJyZW50QWN0aW9uID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uKGNvbW1hbmQpXG4gICAgfVxuICB9XG5cbiAgX29uVGltZW91dCAoKSB7XG4gICAgLy8gaW5mb3JtIGFib3V0IHRoZSB0aW1lb3V0IGFuZCBzaHV0IGRvd25cbiAgICB2YXIgZXJyb3IgPSBuZXcgRXJyb3IoJ1NvY2tldCB0aW1lZCBvdXQhJylcbiAgICB0aGlzLl9vbkVycm9yKGVycm9yKVxuICB9XG5cbiAgLyoqXG4gICAqIEVuc3VyZXMgdGhhdCB0aGUgY29ubmVjdGlvbiBpcyBjbG9zZWQgYW5kIHN1Y2hcbiAgICovXG4gIF9kZXN0cm95ICgpIHtcbiAgICBjbGVhclRpbWVvdXQodGhpcy5fc29ja2V0VGltZW91dFRpbWVyKVxuXG4gICAgaWYgKCF0aGlzLmRlc3Ryb3llZCkge1xuICAgICAgdGhpcy5kZXN0cm95ZWQgPSB0cnVlXG4gICAgICB0aGlzLm9uY2xvc2UoKVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBTZW5kcyBhIHN0cmluZyB0byB0aGUgc29ja2V0LlxuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gY2h1bmsgQVNDSUkgc3RyaW5nIChxdW90ZWQtcHJpbnRhYmxlLCBiYXNlNjQgZXRjLikgdG8gYmUgc2VudCB0byB0aGUgc2VydmVyXG4gICAqIEByZXR1cm4ge0Jvb2xlYW59IElmIHRydWUsIGl0IGlzIHNhZmUgdG8gc2VuZCBtb3JlIGRhdGEsIGlmIGZhbHNlLCB5b3UgKnNob3VsZCogd2FpdCBmb3IgdGhlIG9uZHJhaW4gZXZlbnQgYmVmb3JlIHNlbmRpbmcgbW9yZVxuICAgKi9cbiAgX3NlbmRTdHJpbmcgKGNodW5rKSB7XG4gICAgLy8gZXNjYXBlIGRvdHNcbiAgICBpZiAoIXRoaXMub3B0aW9ucy5kaXNhYmxlRXNjYXBpbmcpIHtcbiAgICAgIGNodW5rID0gY2h1bmsucmVwbGFjZSgvXFxuXFwuL2csICdcXG4uLicpXG4gICAgICBpZiAoKHRoaXMuX2xhc3REYXRhQnl0ZXMuc3Vic3RyKC0xKSA9PT0gJ1xcbicgfHwgIXRoaXMuX2xhc3REYXRhQnl0ZXMpICYmIGNodW5rLmNoYXJBdCgwKSA9PT0gJy4nKSB7XG4gICAgICAgIGNodW5rID0gJy4nICsgY2h1bmtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBLZWVwaW5nIGV5ZSBvbiB0aGUgbGFzdCBieXRlcyBzZW50LCB0byBzZWUgaWYgdGhlcmUgaXMgYSA8Q1I+PExGPiBzZXF1ZW5jZVxuICAgIC8vIGF0IHRoZSBlbmQgd2hpY2ggaXMgbmVlZGVkIHRvIGVuZCB0aGUgZGF0YSBzdHJlYW1cbiAgICBpZiAoY2h1bmsubGVuZ3RoID4gMikge1xuICAgICAgdGhpcy5fbGFzdERhdGFCeXRlcyA9IGNodW5rLnN1YnN0cigtMilcbiAgICB9IGVsc2UgaWYgKGNodW5rLmxlbmd0aCA9PT0gMSkge1xuICAgICAgdGhpcy5fbGFzdERhdGFCeXRlcyA9IHRoaXMuX2xhc3REYXRhQnl0ZXMuc3Vic3RyKC0xKSArIGNodW5rXG4gICAgfVxuXG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyAnICsgY2h1bmsubGVuZ3RoICsgJyBieXRlcyBvZiBwYXlsb2FkJylcblxuICAgIC8vIHBhc3MgdGhlIGNodW5rIHRvIHRoZSBzb2NrZXRcbiAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFRleHRFbmNvZGVyKCdVVEYtOCcpLmVuY29kZShjaHVuaykuYnVmZmVyKVxuICAgIHJldHVybiB0aGlzLndhaXREcmFpblxuICB9XG5cbiAgLyoqXG4gICAqIFNlbmQgYSBzdHJpbmcgY29tbWFuZCB0byB0aGUgc2VydmVyLCBhbHNvIGFwcGVuZCBcXHJcXG4gaWYgbmVlZGVkXG4gICAqXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBzdHIgU3RyaW5nIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICAgKi9cbiAgX3NlbmRDb21tYW5kIChzdHIpIHtcbiAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFRleHRFbmNvZGVyKCdVVEYtOCcpLmVuY29kZShzdHIgKyAoc3RyLnN1YnN0cigtMikgIT09ICdcXHJcXG4nID8gJ1xcclxcbicgOiAnJykpLmJ1ZmZlcilcbiAgfVxuXG4gIF9zZW5kIChidWZmZXIpIHtcbiAgICB0aGlzLl9zZXRUaW1lb3V0KGJ1ZmZlci5ieXRlTGVuZ3RoKVxuICAgIHJldHVybiB0aGlzLnNvY2tldC5zZW5kKGJ1ZmZlcilcbiAgfVxuXG4gIF9zZXRUaW1lb3V0IChieXRlTGVuZ3RoKSB7XG4gICAgdmFyIHByb2xvbmdQZXJpb2QgPSBNYXRoLmZsb29yKGJ5dGVMZW5ndGggKiB0aGlzLnRpbWVvdXRTb2NrZXRNdWx0aXBsaWVyKVxuICAgIHZhciB0aW1lb3V0XG5cbiAgICBpZiAodGhpcy5fZGF0YU1vZGUpIHtcbiAgICAgIC8vIHdlJ3JlIGluIGRhdGEgbW9kZSwgc28gd2UgY291bnQgb25seSBvbmUgdGltZW91dCB0aGF0IGdldCBleHRlbmRlZCBmb3IgZXZlcnkgc2VuZCgpLlxuICAgICAgdmFyIG5vdyA9IERhdGUubm93KClcblxuICAgICAgLy8gdGhlIG9sZCB0aW1lb3V0IHN0YXJ0IHRpbWVcbiAgICAgIHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCA9IHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCB8fCBub3dcblxuICAgICAgLy8gdGhlIG9sZCB0aW1lb3V0IHBlcmlvZCwgbm9ybWFsaXplZCB0byBhIG1pbmltdW0gb2YgVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkRcbiAgICAgIHRoaXMuX3NvY2tldFRpbWVvdXRQZXJpb2QgPSAodGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCB8fCB0aGlzLnRpbWVvdXRTb2NrZXRMb3dlckJvdW5kKSArIHByb2xvbmdQZXJpb2RcblxuICAgICAgLy8gdGhlIG5ldyB0aW1lb3V0IGlzIHRoZSBkZWx0YSBiZXR3ZWVuIHRoZSBuZXcgZmlyaW5nIHRpbWUgKD0gdGltZW91dCBwZXJpb2QgKyB0aW1lb3V0IHN0YXJ0IHRpbWUpIGFuZCBub3dcbiAgICAgIHRpbWVvdXQgPSB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgKyB0aGlzLl9zb2NrZXRUaW1lb3V0UGVyaW9kIC0gbm93XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIHNldCBuZXcgdGltb3V0XG4gICAgICB0aW1lb3V0ID0gdGhpcy50aW1lb3V0U29ja2V0TG93ZXJCb3VuZCArIHByb2xvbmdQZXJpb2RcbiAgICB9XG5cbiAgICBjbGVhclRpbWVvdXQodGhpcy5fc29ja2V0VGltZW91dFRpbWVyKSAvLyBjbGVhciBwZW5kaW5nIHRpbWVvdXRzXG4gICAgdGhpcy5fc29ja2V0VGltZW91dFRpbWVyID0gc2V0VGltZW91dCh0aGlzLl9vblRpbWVvdXQuYmluZCh0aGlzKSwgdGltZW91dCkgLy8gYXJtIHRoZSBuZXh0IHRpbWVvdXRcbiAgfVxuXG4gIC8qKlxuICAgKiBJbnRpdGlhdGUgYXV0aGVudGljYXRpb24gc2VxdWVuY2UgaWYgbmVlZGVkXG4gICAqL1xuICBfYXV0aGVudGljYXRlVXNlciAoKSB7XG4gICAgaWYgKCF0aGlzLm9wdGlvbnMuYXV0aCkge1xuICAgICAgLy8gbm8gbmVlZCB0byBhdXRoZW50aWNhdGUsIGF0IGxlYXN0IG5vIGRhdGEgZ2l2ZW5cbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgICB0aGlzLm9uaWRsZSgpIC8vIHJlYWR5IHRvIHRha2Ugb3JkZXJzXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB2YXIgYXV0aFxuXG4gICAgaWYgKCF0aGlzLm9wdGlvbnMuYXV0aE1ldGhvZCAmJiB0aGlzLm9wdGlvbnMuYXV0aC54b2F1dGgyKSB7XG4gICAgICB0aGlzLm9wdGlvbnMuYXV0aE1ldGhvZCA9ICdYT0FVVEgyJ1xuICAgIH1cblxuICAgIGlmICh0aGlzLm9wdGlvbnMuYXV0aE1ldGhvZCkge1xuICAgICAgYXV0aCA9IHRoaXMub3B0aW9ucy5hdXRoTWV0aG9kLnRvVXBwZXJDYXNlKCkudHJpbSgpXG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIHVzZSBmaXJzdCBzdXBwb3J0ZWRcbiAgICAgIGF1dGggPSAodGhpcy5fc3VwcG9ydGVkQXV0aFswXSB8fCAnUExBSU4nKS50b1VwcGVyQ2FzZSgpLnRyaW0oKVxuICAgIH1cblxuICAgIHN3aXRjaCAoYXV0aCkge1xuICAgICAgY2FzZSAnTE9HSU4nOlxuICAgICAgICAvLyBMT0dJTiBpcyBhIDMgc3RlcCBhdXRoZW50aWNhdGlvbiBwcm9jZXNzXG4gICAgICAgIC8vIEM6IEFVVEggTE9HSU5cbiAgICAgICAgLy8gQzogQkFTRTY0KFVTRVIpXG4gICAgICAgIC8vIEM6IEJBU0U2NChQQVNTKVxuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiB2aWEgQVVUSCBMT0dJTicpXG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIX0xPR0lOX1VTRVJcbiAgICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0FVVEggTE9HSU4nKVxuICAgICAgICByZXR1cm5cbiAgICAgIGNhc2UgJ1BMQUlOJzpcbiAgICAgICAgLy8gQVVUSCBQTEFJTiBpcyBhIDEgc3RlcCBhdXRoZW50aWNhdGlvbiBwcm9jZXNzXG4gICAgICAgIC8vIEM6IEFVVEggUExBSU4gQkFTRTY0KFxcMCBVU0VSIFxcMCBQQVNTKVxuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiB2aWEgQVVUSCBQTEFJTicpXG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIQ29tcGxldGVcbiAgICAgICAgdGhpcy5fc2VuZENvbW1hbmQoXG4gICAgICAgICAgLy8gY29udmVydCB0byBCQVNFNjRcbiAgICAgICAgICAnQVVUSCBQTEFJTiAnICtcbiAgICAgICAgICBlbmNvZGUoXG4gICAgICAgICAgICAvLyB0aGlzLm9wdGlvbnMuYXV0aC51c2VyKydcXHUwMDAwJytcbiAgICAgICAgICAgICdcXHUwMDAwJyArIC8vIHNraXAgYXV0aG9yaXphdGlvbiBpZGVudGl0eSBhcyBpdCBjYXVzZXMgcHJvYmxlbXMgd2l0aCBzb21lIHNlcnZlcnNcbiAgICAgICAgICAgIHRoaXMub3B0aW9ucy5hdXRoLnVzZXIgKyAnXFx1MDAwMCcgK1xuICAgICAgICAgICAgdGhpcy5vcHRpb25zLmF1dGgucGFzcylcbiAgICAgICAgKVxuICAgICAgICByZXR1cm5cbiAgICAgIGNhc2UgJ1hPQVVUSDInOlxuICAgICAgICAvLyBTZWUgaHR0cHM6Ly9kZXZlbG9wZXJzLmdvb2dsZS5jb20vZ21haWwveG9hdXRoMl9wcm90b2NvbCNzbXRwX3Byb3RvY29sX2V4Y2hhbmdlXG4gICAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0F1dGhlbnRpY2F0aW9uIHZpYSBBVVRIIFhPQVVUSDInKVxuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSF9YT0FVVEgyXG4gICAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdBVVRIIFhPQVVUSDIgJyArIHRoaXMuX2J1aWxkWE9BdXRoMlRva2VuKHRoaXMub3B0aW9ucy5hdXRoLnVzZXIsIHRoaXMub3B0aW9ucy5hdXRoLnhvYXV0aDIpKVxuICAgICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignVW5rbm93biBhdXRoZW50aWNhdGlvbiBtZXRob2QgJyArIGF1dGgpKVxuICB9XG5cbiAgLy8gQUNUSU9OUyBGT1IgUkVTUE9OU0VTIEZST00gVEhFIFNNVFAgU0VSVkVSXG5cbiAgLyoqXG4gICAqIEluaXRpYWwgcmVzcG9uc2UgZnJvbSB0aGUgc2VydmVyLCBtdXN0IGhhdmUgYSBzdGF0dXMgMjIwXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25HcmVldGluZyAoY29tbWFuZCkge1xuICAgIGlmIChjb21tYW5kLnN0YXR1c0NvZGUgIT09IDIyMCkge1xuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ0ludmFsaWQgZ3JlZXRpbmc6ICcgKyBjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgaWYgKHRoaXMub3B0aW9ucy5sbXRwKSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIExITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uTEhMT1xuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0xITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIEVITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uRUhMT1xuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0VITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBMSExPXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25MSExPIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0xITE8gbm90IHN1Y2Nlc3NmdWwnKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIC8vIFByb2Nlc3MgYXMgRUhMTyByZXNwb25zZVxuICAgIHRoaXMuX2FjdGlvbkVITE8oY29tbWFuZClcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBFSExPLiBJZiB0aGUgcmVzcG9uc2UgaXMgYW4gZXJyb3IsIHRyeSBIRUxPIGluc3RlYWRcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvbkVITE8gKGNvbW1hbmQpIHtcbiAgICB2YXIgbWF0Y2hcblxuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICBpZiAoIXRoaXMuX3NlY3VyZU1vZGUgJiYgdGhpcy5vcHRpb25zLnJlcXVpcmVUTFMpIHtcbiAgICAgICAgdmFyIGVyck1zZyA9ICdTVEFSVFRMUyBub3Qgc3VwcG9ydGVkIHdpdGhvdXQgRUhMTydcbiAgICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCBlcnJNc2cpXG4gICAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGVyck1zZykpXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuXG4gICAgICAvLyBUcnkgSEVMTyBpbnN0ZWFkXG4gICAgICB0aGlzLmxvZ2dlci53YXJuaW5nKERFQlVHX1RBRywgJ0VITE8gbm90IHN1Y2Nlc3NmdWwsIHRyeWluZyBIRUxPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25IRUxPXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnSEVMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICAvLyBEZXRlY3QgaWYgdGhlIHNlcnZlciBzdXBwb3J0cyBQTEFJTiBhdXRoXG4gICAgaWYgKGNvbW1hbmQuZGF0YS5tYXRjaCgvQVVUSCg/OlxccytbXlxcbl0qXFxzK3xcXHMrKVBMQUlOL2kpKSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZXJ2ZXIgc3VwcG9ydHMgQVVUSCBQTEFJTicpXG4gICAgICB0aGlzLl9zdXBwb3J0ZWRBdXRoLnB1c2goJ1BMQUlOJylcbiAgICB9XG5cbiAgICAvLyBEZXRlY3QgaWYgdGhlIHNlcnZlciBzdXBwb3J0cyBMT0dJTiBhdXRoXG4gICAgaWYgKGNvbW1hbmQuZGF0YS5tYXRjaCgvQVVUSCg/OlxccytbXlxcbl0qXFxzK3xcXHMrKUxPR0lOL2kpKSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZXJ2ZXIgc3VwcG9ydHMgQVVUSCBMT0dJTicpXG4gICAgICB0aGlzLl9zdXBwb3J0ZWRBdXRoLnB1c2goJ0xPR0lOJylcbiAgICB9XG5cbiAgICAvLyBEZXRlY3QgaWYgdGhlIHNlcnZlciBzdXBwb3J0cyBYT0FVVEgyIGF1dGhcbiAgICBpZiAoY29tbWFuZC5kYXRhLm1hdGNoKC9BVVRIKD86XFxzK1teXFxuXSpcXHMrfFxccyspWE9BVVRIMi9pKSkge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VydmVyIHN1cHBvcnRzIEFVVEggWE9BVVRIMicpXG4gICAgICB0aGlzLl9zdXBwb3J0ZWRBdXRoLnB1c2goJ1hPQVVUSDInKVxuICAgIH1cblxuICAgIC8vIERldGVjdCBtYXhpbXVtIGFsbG93ZWQgbWVzc2FnZSBzaXplXG4gICAgaWYgKChtYXRjaCA9IGNvbW1hbmQuZGF0YS5tYXRjaCgvU0laRSAoXFxkKykvaSkpICYmIE51bWJlcihtYXRjaFsxXSkpIHtcbiAgICAgIGNvbnN0IG1heEFsbG93ZWRTaXplID0gTnVtYmVyKG1hdGNoWzFdKVxuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnTWF4aW11bSBhbGxvd2QgbWVzc2FnZSBzaXplOiAnICsgbWF4QWxsb3dlZFNpemUpXG4gICAgfVxuXG4gICAgLy8gRGV0ZWN0IGlmIHRoZSBzZXJ2ZXIgc3VwcG9ydHMgU1RBUlRUTFNcbiAgICBpZiAoIXRoaXMuX3NlY3VyZU1vZGUpIHtcbiAgICAgIGlmICgoY29tbWFuZC5kYXRhLm1hdGNoKC9TVEFSVFRMU1xccz8kL21pKSAmJiAhdGhpcy5vcHRpb25zLmlnbm9yZVRMUykgfHwgISF0aGlzLm9wdGlvbnMucmVxdWlyZVRMUykge1xuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uU1RBUlRUTFNcbiAgICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBTVEFSVFRMUycpXG4gICAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdTVEFSVFRMUycpXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMuX2F1dGhlbnRpY2F0ZVVzZXIoKVxuICB9XG5cbiAgLyoqXG4gICAqIEhhbmRsZXMgc2VydmVyIHJlc3BvbnNlIGZvciBTVEFSVFRMUyBjb21tYW5kLiBJZiB0aGVyZSdzIGFuIGVycm9yXG4gICAqIHRyeSBIRUxPIGluc3RlYWQsIG90aGVyd2lzZSBpbml0aWF0ZSBUTFMgdXBncmFkZS4gSWYgdGhlIHVwZ3JhZGVcbiAgICogc3VjY2VlZGVzIHJlc3RhcnQgdGhlIEVITE9cbiAgICpcbiAgICogQHBhcmFtIHtTdHJpbmd9IHN0ciBNZXNzYWdlIGZyb20gdGhlIHNlcnZlclxuICAgKi9cbiAgX2FjdGlvblNUQVJUVExTIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ1NUQVJUVExTIG5vdCBzdWNjZXNzZnVsJylcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0aGlzLl9zZWN1cmVNb2RlID0gdHJ1ZVxuICAgIHRoaXMuc29ja2V0LnVwZ3JhZGVUb1NlY3VyZSgpXG5cbiAgICAvLyByZXN0YXJ0IHByb3RvY29sIGZsb3dcbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uRUhMT1xuICAgIHRoaXMuX3NlbmRDb21tYW5kKCdFSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBIRUxPXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25IRUxPIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0hFTE8gbm90IHN1Y2Nlc3NmdWwnKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cbiAgICB0aGlzLl9hdXRoZW50aWNhdGVVc2VyKClcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBBVVRIIExPR0lOLCBpZiBzdWNjZXNzZnVsIGV4cGVjdHMgYmFzZTY0IGVuY29kZWQgdXNlcm5hbWVcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvbkFVVEhfTE9HSU5fVVNFUiAoY29tbWFuZCkge1xuICAgIGlmIChjb21tYW5kLnN0YXR1c0NvZGUgIT09IDMzNCB8fCBjb21tYW5kLmRhdGEgIT09ICdWWE5sY201aGJXVTYnKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdBVVRIIExPR0lOIFVTRVIgbm90IHN1Y2Nlc3NmdWw6ICcgKyBjb21tYW5kLmRhdGEpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignSW52YWxpZCBsb2dpbiBzZXF1ZW5jZSB3aGlsZSB3YWl0aW5nIGZvciBcIjMzNCBWWE5sY201aGJXVTYgXCI6ICcgKyBjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0FVVEggTE9HSU4gVVNFUiBzdWNjZXNzZnVsJylcbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSF9MT0dJTl9QQVNTXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoZW5jb2RlKHRoaXMub3B0aW9ucy5hdXRoLnVzZXIpKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIEFVVEggTE9HSU4gdXNlcm5hbWUsIGlmIHN1Y2Nlc3NmdWwgZXhwZWN0cyBiYXNlNjQgZW5jb2RlZCBwYXNzd29yZFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uQVVUSF9MT0dJTl9QQVNTIChjb21tYW5kKSB7XG4gICAgaWYgKGNvbW1hbmQuc3RhdHVzQ29kZSAhPT0gMzM0IHx8IGNvbW1hbmQuZGF0YSAhPT0gJ1VHRnpjM2R2Y21RNicpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0FVVEggTE9HSU4gUEFTUyBub3Qgc3VjY2Vzc2Z1bDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdJbnZhbGlkIGxvZ2luIHNlcXVlbmNlIHdoaWxlIHdhaXRpbmcgZm9yIFwiMzM0IFVHRnpjM2R2Y21RNiBcIjogJyArIGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQVVUSCBMT0dJTiBQQVNTIHN1Y2Nlc3NmdWwnKVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIQ29tcGxldGVcbiAgICB0aGlzLl9zZW5kQ29tbWFuZChlbmNvZGUodGhpcy5vcHRpb25zLmF1dGgucGFzcykpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gQVVUSCBYT0FVVEgyIHRva2VuLCBpZiBlcnJvciBvY2N1cnMgc2VuZCBlbXB0eSByZXNwb25zZVxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uQVVUSF9YT0FVVEgyIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLndhcm5pbmcoREVCVUdfVEFHLCAnRXJyb3IgZHVyaW5nIEFVVEggWE9BVVRIMiwgc2VuZGluZyBlbXB0eSByZXNwb25zZScpXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnJylcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIQ29tcGxldGVcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5fYWN0aW9uQVVUSENvbXBsZXRlKGNvbW1hbmQpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIENoZWNrcyBpZiBhdXRoZW50aWNhdGlvbiBzdWNjZWVkZWQgb3Igbm90LiBJZiBzdWNjZXNzZnVsbHkgYXV0aGVudGljYXRlZFxuICAgKiBlbWl0IGBpZGxlYCB0byBpbmRpY2F0ZSB0aGF0IGFuIGUtbWFpbCBjYW4gYmUgc2VudCB1c2luZyB0aGlzIGNvbm5lY3Rpb25cbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvbkFVVEhDb21wbGV0ZSAoY29tbWFuZCkge1xuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiBmYWlsZWQ6ICcgKyBjb21tYW5kLmRhdGEpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQXV0aGVudGljYXRpb24gc3VjY2Vzc2Z1bC4nKVxuXG4gICAgdGhpcy5fYXV0aGVudGljYXRlZEFzID0gdGhpcy5vcHRpb25zLmF1dGgudXNlclxuXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICB0aGlzLm9uaWRsZSgpIC8vIHJlYWR5IHRvIHRha2Ugb3JkZXJzXG4gIH1cblxuICAvKipcbiAgICogVXNlZCB3aGVuIHRoZSBjb25uZWN0aW9uIGlzIGlkbGUgYW5kIHRoZSBzZXJ2ZXIgZW1pdHMgdGltZW91dFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uSWRsZSAoY29tbWFuZCkge1xuICAgIGlmIChjb21tYW5kLnN0YXR1c0NvZGUgPiAzMDApIHtcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIE1BSUwgRlJPTSBjb21tYW5kLiBQcm9jZWVkIHRvIGRlZmluaW5nIFJDUFQgVE8gbGlzdCBpZiBzdWNjZXNzZnVsXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25NQUlMIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ01BSUwgRlJPTSB1bnN1Y2Nlc3NmdWw6ICcgKyBjb21tYW5kLmRhdGEpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUubGVuZ3RoKSB7XG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignQ2FuXFwndCBzZW5kIG1haWwgLSBubyByZWNpcGllbnRzIGRlZmluZWQnKSlcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnTUFJTCBGUk9NIHN1Y2Nlc3NmdWwsIHByb2NlZWRpbmcgd2l0aCAnICsgdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLmxlbmd0aCArICcgcmVjaXBpZW50cycpXG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBZGRpbmcgcmVjaXBpZW50Li4uJylcbiAgICAgIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudCA9IHRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5zaGlmdCgpXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uUkNQVFxuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ1JDUFQgVE86PCcgKyB0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQgKyAnPicpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIGEgUkNQVCBUTyBjb21tYW5kLiBJZiB0aGUgY29tbWFuZCBpcyB1bnN1Y2Nlc3NmdWwsIHRyeSB0aGUgbmV4dCBvbmUsXG4gICAqIGFzIHRoaXMgbWlnaHQgYmUgcmVsYXRlZCBvbmx5IHRvIHRoZSBjdXJyZW50IHJlY2lwaWVudCwgbm90IGEgZ2xvYmFsIGVycm9yLCBzb1xuICAgKiB0aGUgZm9sbG93aW5nIHJlY2lwaWVudHMgbWlnaHQgc3RpbGwgYmUgdmFsaWRcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvblJDUFQgKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIud2FybmluZyhERUJVR19UQUcsICdSQ1BUIFRPIGZhaWxlZCBmb3I6ICcgKyB0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQpXG4gICAgICAvLyB0aGlzIGlzIGEgc29mdCBlcnJvclxuICAgICAgdGhpcy5fZW52ZWxvcGUucmNwdEZhaWxlZC5wdXNoKHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudClcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5fZW52ZWxvcGUucmVzcG9uc2VRdWV1ZS5wdXNoKHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudClcbiAgICB9XG5cbiAgICBpZiAoIXRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5sZW5ndGgpIHtcbiAgICAgIGlmICh0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkLmxlbmd0aCA8IHRoaXMuX2VudmVsb3BlLnRvLmxlbmd0aCkge1xuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uREFUQVxuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdSQ1BUIFRPIGRvbmUsIHByb2NlZWRpbmcgd2l0aCBwYXlsb2FkJylcbiAgICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0RBVEEnKVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ0NhblxcJ3Qgc2VuZCBtYWlsIC0gYWxsIHJlY2lwaWVudHMgd2VyZSByZWplY3RlZCcpKVxuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBZGRpbmcgcmVjaXBpZW50Li4uJylcbiAgICAgIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudCA9IHRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5zaGlmdCgpXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uUkNQVFxuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ1JDUFQgVE86PCcgKyB0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQgKyAnPicpXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIHRoZSBEQVRBIGNvbW1hbmQuIFNlcnZlciBpcyBub3cgd2FpdGluZyBmb3IgYSBtZXNzYWdlLCBzbyBlbWl0IGBvbnJlYWR5YFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uREFUQSAoY29tbWFuZCkge1xuICAgIC8vIHJlc3BvbnNlIHNob3VsZCBiZSAzNTQgYnV0IGFjY29yZGluZyB0byB0aGlzIGlzc3VlIGh0dHBzOi8vZ2l0aHViLmNvbS9lbGVpdGgvZW1haWxqcy9pc3N1ZXMvMjRcbiAgICAvLyBzb21lIHNlcnZlcnMgbWlnaHQgdXNlIDI1MCBpbnN0ZWFkXG4gICAgaWYgKFsyNTAsIDM1NF0uaW5kZXhPZihjb21tYW5kLnN0YXR1c0NvZGUpIDwgMCkge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnREFUQSB1bnN1Y2Nlc3NmdWwgJyArIGNvbW1hbmQuZGF0YSlcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0aGlzLl9kYXRhTW9kZSA9IHRydWVcbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgIHRoaXMub25yZWFkeSh0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIGZyb20gdGhlIHNlcnZlciwgb25jZSB0aGUgbWVzc2FnZSBzdHJlYW0gaGFzIGVuZGVkIHdpdGggPENSPjxMRj4uPENSPjxMRj5cbiAgICogRW1pdHMgYG9uZG9uZWAuXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25TdHJlYW0gKGNvbW1hbmQpIHtcbiAgICB2YXIgcmNwdFxuXG4gICAgaWYgKHRoaXMub3B0aW9ucy5sbXRwKSB7XG4gICAgICAvLyBMTVRQIHJldHVybnMgYSByZXNwb25zZSBjb2RlIGZvciAqZXZlcnkqIHN1Y2Nlc3NmdWxseSBzZXQgcmVjaXBpZW50XG4gICAgICAvLyBGb3IgZXZlcnkgcmVjaXBpZW50IHRoZSBtZXNzYWdlIG1pZ2h0IHN1Y2NlZWQgb3IgZmFpbCBpbmRpdmlkdWFsbHlcblxuICAgICAgcmNwdCA9IHRoaXMuX2VudmVsb3BlLnJlc3BvbnNlUXVldWUuc2hpZnQoKVxuICAgICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnTG9jYWwgZGVsaXZlcnkgdG8gJyArIHJjcHQgKyAnIGZhaWxlZC4nKVxuICAgICAgICB0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkLnB1c2gocmNwdClcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0xvY2FsIGRlbGl2ZXJ5IHRvICcgKyByY3B0ICsgJyBzdWNjZWVkZWQuJylcbiAgICAgIH1cblxuICAgICAgaWYgKHRoaXMuX2VudmVsb3BlLnJlc3BvbnNlUXVldWUubGVuZ3RoKSB7XG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25TdHJlYW1cbiAgICAgICAgcmV0dXJuXG4gICAgICB9XG5cbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgICB0aGlzLm9uZG9uZSh0cnVlKVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBGb3IgU01UUCB0aGUgbWVzc2FnZSBlaXRoZXIgZmFpbHMgb3Igc3VjY2VlZHMsIHRoZXJlIGlzIG5vIGluZm9ybWF0aW9uXG4gICAgICAvLyBhYm91dCBpbmRpdmlkdWFsIHJlY2lwaWVudHNcblxuICAgICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnTWVzc2FnZSBzZW5kaW5nIGZhaWxlZC4nKVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnTWVzc2FnZSBzZW50IHN1Y2Nlc3NmdWxseS4nKVxuICAgICAgfVxuXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgICAgdGhpcy5vbmRvbmUoISFjb21tYW5kLnN1Y2Nlc3MpXG4gICAgfVxuXG4gICAgLy8gSWYgdGhlIGNsaWVudCB3YW50ZWQgdG8gZG8gc29tZXRoaW5nIGVsc2UgKGVnLiB0byBxdWl0KSwgZG8gbm90IGZvcmNlIGlkbGVcbiAgICBpZiAodGhpcy5fY3VycmVudEFjdGlvbiA9PT0gdGhpcy5fYWN0aW9uSWRsZSkge1xuICAgICAgLy8gV2FpdGluZyBmb3IgbmV3IGNvbm5lY3Rpb25zXG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdJZGxpbmcgd2hpbGUgd2FpdGluZyBmb3IgbmV3IGNvbm5lY3Rpb25zLi4uJylcbiAgICAgIHRoaXMub25pZGxlKClcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQnVpbGRzIGEgbG9naW4gdG9rZW4gZm9yIFhPQVVUSDIgYXV0aGVudGljYXRpb24gY29tbWFuZFxuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gdXNlciBFLW1haWwgYWRkcmVzcyBvZiB0aGUgdXNlclxuICAgKiBAcGFyYW0ge1N0cmluZ30gdG9rZW4gVmFsaWQgYWNjZXNzIHRva2VuIGZvciB0aGUgdXNlclxuICAgKiBAcmV0dXJuIHtTdHJpbmd9IEJhc2U2NCBmb3JtYXR0ZWQgbG9naW4gdG9rZW5cbiAgICovXG4gIF9idWlsZFhPQXV0aDJUb2tlbiAodXNlciwgdG9rZW4pIHtcbiAgICB2YXIgYXV0aERhdGEgPSBbXG4gICAgICAndXNlcj0nICsgKHVzZXIgfHwgJycpLFxuICAgICAgJ2F1dGg9QmVhcmVyICcgKyB0b2tlbixcbiAgICAgICcnLFxuICAgICAgJydcbiAgICBdXG4gICAgLy8gYmFzZTY0KFwidXNlcj17VXNlcn1cXHgwMGF1dGg9QmVhcmVyIHtUb2tlbn1cXHgwMFxceDAwXCIpXG4gICAgcmV0dXJuIGVuY29kZShhdXRoRGF0YS5qb2luKCdcXHgwMScpKVxuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IFNtdHBDbGllbnRcbiJdfQ==