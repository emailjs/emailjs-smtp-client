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
    this._maxAllowedSize = 0; // Stores the max message size supported by the server as reported in the greeting
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
        this._maxAllowedSize = maxAllowedSize;
        this.logger.debug(DEBUG_TAG, 'Maximum allowed message size: ' + maxAllowedSize);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9jbGllbnQuanMiXSwibmFtZXMiOlsiREVCVUdfVEFHIiwiVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkQiLCJUSU1FT1VUX1NPQ0tFVF9NVUxUSVBMSUVSIiwiU210cENsaWVudCIsImhvc3QiLCJwb3J0Iiwib3B0aW9ucyIsInRpbWVvdXRTb2NrZXRMb3dlckJvdW5kIiwidGltZW91dFNvY2tldE11bHRpcGxpZXIiLCJ1c2VTZWN1cmVUcmFuc3BvcnQiLCJhdXRoIiwibmFtZSIsInNvY2tldCIsImRlc3Ryb3llZCIsIndhaXREcmFpbiIsIl9hdXRoZW50aWNhdGVkQXMiLCJfc3VwcG9ydGVkQXV0aCIsIl9kYXRhTW9kZSIsIl9sYXN0RGF0YUJ5dGVzIiwiX2VudmVsb3BlIiwiX2N1cnJlbnRBY3Rpb24iLCJfbWF4QWxsb3dlZFNpemUiLCJfc2VjdXJlTW9kZSIsIl9zb2NrZXRUaW1lb3V0VGltZXIiLCJfc29ja2V0VGltZW91dFN0YXJ0IiwiX3NvY2tldFRpbWVvdXRQZXJpb2QiLCJfcGFyc2VCbG9jayIsImRhdGEiLCJzdGF0dXNDb2RlIiwiX3BhcnNlUmVtYWluZGVyIiwiZHVtbXlMb2dnZXIiLCJyZWR1Y2UiLCJvIiwibCIsImxvZ2dlciIsIm9uZXJyb3IiLCJlIiwib25kcmFpbiIsIm9uY2xvc2UiLCJvbmlkbGUiLCJvbnJlYWR5IiwiZmFpbGVkUmVjaXBpZW50cyIsIm9uZG9uZSIsInN1Y2Nlc3MiLCJTb2NrZXRDb250cnVjdG9yIiwiVENQU29ja2V0Iiwib3BlbiIsImJpbmFyeVR5cGUiLCJjYSIsInRsc1dvcmtlclBhdGgiLCJ3cyIsIm9uY2VydCIsIkUiLCJfb25FcnJvciIsImJpbmQiLCJvbm9wZW4iLCJfb25PcGVuIiwiZGVidWciLCJfc2VuZENvbW1hbmQiLCJjbG9zZSIsInJlYWR5U3RhdGUiLCJfZGVzdHJveSIsImVudmVsb3BlIiwiZnJvbSIsImNvbmNhdCIsInRvIiwicmNwdFF1ZXVlIiwicmNwdEZhaWxlZCIsInJlc3BvbnNlUXVldWUiLCJfYWN0aW9uTUFJTCIsImNodW5rIiwiX3NlbmRTdHJpbmciLCJsZW5ndGgiLCJzZW5kIiwiX2FjdGlvblN0cmVhbSIsIl9zZW5kIiwiVWludDhBcnJheSIsImJ1ZmZlciIsInN1YnN0ciIsImxpbmVzIiwic3BsaXQiLCJwb3AiLCJpIiwibGVuIiwidHJpbSIsIm1hdGNoIiwicHVzaCIsIk51bWJlciIsInJlc3BvbnNlIiwiam9pbiIsIl9vbkNvbW1hbmQiLCJldmVudCIsInByb3h5SG9zdG5hbWUiLCJvbmRhdGEiLCJfb25EYXRhIiwiX29uQ2xvc2UiLCJfb25EcmFpbiIsIl9hY3Rpb25HcmVldGluZyIsImV2dCIsImNsZWFyVGltZW91dCIsInN0cmluZ1BheWxvYWQiLCJUZXh0RGVjb2RlciIsImRlY29kZSIsIl9wYXJzZSIsIkVycm9yIiwibWVzc2FnZSIsImVycm9yIiwiY29tbWFuZCIsImRpc2FibGVFc2NhcGluZyIsInJlcGxhY2UiLCJjaGFyQXQiLCJUZXh0RW5jb2RlciIsImVuY29kZSIsInN0ciIsIl9zZXRUaW1lb3V0IiwiYnl0ZUxlbmd0aCIsInByb2xvbmdQZXJpb2QiLCJNYXRoIiwiZmxvb3IiLCJ0aW1lb3V0Iiwibm93IiwiRGF0ZSIsInNldFRpbWVvdXQiLCJfb25UaW1lb3V0IiwiX2FjdGlvbklkbGUiLCJhdXRoTWV0aG9kIiwieG9hdXRoMiIsInRvVXBwZXJDYXNlIiwiX2FjdGlvbkFVVEhfTE9HSU5fVVNFUiIsIl9hY3Rpb25BVVRIQ29tcGxldGUiLCJ1c2VyIiwicGFzcyIsIl9hY3Rpb25BVVRIX1hPQVVUSDIiLCJfYnVpbGRYT0F1dGgyVG9rZW4iLCJsbXRwIiwiX2FjdGlvbkxITE8iLCJfYWN0aW9uRUhMTyIsInJlcXVpcmVUTFMiLCJlcnJNc2ciLCJ3YXJuaW5nIiwiX2FjdGlvbkhFTE8iLCJtYXhBbGxvd2VkU2l6ZSIsImlnbm9yZVRMUyIsIl9hY3Rpb25TVEFSVFRMUyIsIl9hdXRoZW50aWNhdGVVc2VyIiwidXBncmFkZVRvU2VjdXJlIiwiX2FjdGlvbkFVVEhfTE9HSU5fUEFTUyIsImN1clJlY2lwaWVudCIsInNoaWZ0IiwiX2FjdGlvblJDUFQiLCJfYWN0aW9uREFUQSIsImluZGV4T2YiLCJyY3B0IiwidG9rZW4iLCJhdXRoRGF0YSJdLCJtYXBwaW5ncyI6Ijs7Ozs7O3FqQkFBQTs7QUFFQTs7QUFDQTs7OztBQUNBOzs7Ozs7QUFFQSxJQUFJQSxZQUFZLGFBQWhCOztBQUVBOzs7QUFHQSxJQUFNQyw2QkFBNkIsS0FBbkM7O0FBRUE7Ozs7Ozs7QUFPQSxJQUFNQyw0QkFBNEIsR0FBbEM7O0lBRU1DLFU7QUFDSjs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQW1CQSxzQkFBYUMsSUFBYixFQUFtQkMsSUFBbkIsRUFBdUM7QUFBQSxRQUFkQyxPQUFjLHVFQUFKLEVBQUk7O0FBQUE7O0FBQ3JDLFNBQUtBLE9BQUwsR0FBZUEsT0FBZjs7QUFFQSxTQUFLQyx1QkFBTCxHQUErQk4sMEJBQS9CO0FBQ0EsU0FBS08sdUJBQUwsR0FBK0JOLHlCQUEvQjs7QUFFQSxTQUFLRyxJQUFMLEdBQVlBLFNBQVMsS0FBS0MsT0FBTCxDQUFhRyxrQkFBYixHQUFrQyxHQUFsQyxHQUF3QyxFQUFqRCxDQUFaO0FBQ0EsU0FBS0wsSUFBTCxHQUFZQSxRQUFRLFdBQXBCOztBQUVBOzs7OztBQUtBLFNBQUtFLE9BQUwsQ0FBYUcsa0JBQWIsR0FBa0Msd0JBQXdCLEtBQUtILE9BQTdCLEdBQXVDLENBQUMsQ0FBQyxLQUFLQSxPQUFMLENBQWFHLGtCQUF0RCxHQUEyRSxLQUFLSixJQUFMLEtBQWMsR0FBM0g7O0FBRUEsU0FBS0MsT0FBTCxDQUFhSSxJQUFiLEdBQW9CLEtBQUtKLE9BQUwsQ0FBYUksSUFBYixJQUFxQixLQUF6QyxDQWhCcUMsQ0FnQlU7QUFDL0MsU0FBS0osT0FBTCxDQUFhSyxJQUFiLEdBQW9CLEtBQUtMLE9BQUwsQ0FBYUssSUFBYixJQUFxQixXQUF6QyxDQWpCcUMsQ0FpQmdCO0FBQ3JELFNBQUtDLE1BQUwsR0FBYyxLQUFkLENBbEJxQyxDQWtCakI7QUFDcEIsU0FBS0Ms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TUFBTCxDQUFZLElBQVo7QUFDRCxPQW5CRCxNQW1CTztBQUNMO0FBQ0E7O0FBRUEsWUFBSSxDQUFDaUUsUUFBUWhFLE9BQWIsRUFBc0I7QUFDcEIsZUFBS1QsTUFBTCxDQUFZd0UsS0FBWixDQUFrQjFHLFNBQWxCLEVBQTZCLHlCQUE3QjtBQUNELFNBRkQsTUFFTztBQUNMLGVBQUtrQyxNQUFMLENBQVl1QixLQUFaLENBQWtCekQsU0FBbEIsRUFBNkIsNEJBQTdCO0FBQ0Q7O0FBRUQsYUFBS29CLGNBQUwsR0FBc0IsS0FBS3dHLFdBQTNCO0FBQ0EsYUFBS2xGLE1BQUwsQ0FBWSxDQUFDLENBQUNpRSxRQUFRaEUsT0FBdEI7QUFDRDs7QUFFRDtBQUNBLFVBQUksS0FBS3ZCLGNBQUwsS0FBd0IsS0FBS3dHLFdBQWpDLEVBQThDO0FBQzVDO0FBQ0EsYUFBSzFGLE1BQUwsQ0FBWXVCLEtBQVosQ0FBa0J6RCxTQUFsQixFQUE2Qiw2Q0FBN0I7QUFDQSxhQUFLdUMsTUFBTDtBQUNEO0FBQ0Y7O0FBRUQ7Ozs7Ozs7Ozs7dUNBT29CMkYsSSxFQUFNdUIsSyxFQUFPO0FBQy9CLFVBQUlDLFdBQVcsQ0FDYixXQUFXeEIsUUFBUSxFQUFuQixDQURhLEVBRWIsaUJBQWlCdUIsS0FGSixFQUdiLEVBSGEsRUFJYixFQUphLENBQWY7QUFNQTtBQUNBLGFBQU8seUJBQU9DLFNBQVNqRSxJQUFULENBQWMsTUFBZCxDQUFQLENBQVA7QUFDRDs7Ozs7O2tCQUdZdEYsVSIsImZpbGUiOiJjbGllbnQuanMiLCJzb3VyY2VzQ29udGVudCI6WyIvKiBlc2xpbnQtZGlzYWJsZSBjYW1lbGNhc2UgKi9cblxuaW1wb3J0IHsgZW5jb2RlIH0gZnJvbSAnZW1haWxqcy1iYXNlNjQnXG5pbXBvcnQgVENQU29ja2V0IGZyb20gJ2VtYWlsanMtdGNwLXNvY2tldCdcbmltcG9ydCB7IFRleHREZWNvZGVyLCBUZXh0RW5jb2RlciB9IGZyb20gJ3RleHQtZW5jb2RpbmcnXG5cbnZhciBERUJVR19UQUcgPSAnU01UUCBDbGllbnQnXG5cbi8qKlxuICogTG93ZXIgQm91bmQgZm9yIHNvY2tldCB0aW1lb3V0IHRvIHdhaXQgc2luY2UgdGhlIGxhc3QgZGF0YSB3YXMgd3JpdHRlbiB0byBhIHNvY2tldFxuICovXG5jb25zdCBUSU1FT1VUX1NPQ0tFVF9MT1dFUl9CT1VORCA9IDEwMDAwXG5cbi8qKlxuICogTXVsdGlwbGllciBmb3Igc29ja2V0IHRpbWVvdXQ6XG4gKlxuICogV2UgYXNzdW1lIGF0IGxlYXN0IGEgR1BSUyBjb25uZWN0aW9uIHdpdGggMTE1IGtiL3MgPSAxNCwzNzUga0IvcyB0b3BzLCBzbyAxMCBLQi9zIHRvIGJlIG9uXG4gKiB0aGUgc2FmZSBzaWRlLiBXZSBjYW4gdGltZW91dCBhZnRlciBhIGxvd2VyIGJvdW5kIG9mIDEwcyArIChuIEtCIC8gMTAgS0IvcykuIEEgMSBNQiBtZXNzYWdlXG4gKiB1cGxvYWQgd291bGQgYmUgMTEwIHNlY29uZHMgdG8gd2FpdCBmb3IgdGhlIHRpbWVvdXQuIDEwIEtCL3MgPT09IDAuMSBzL0JcbiAqL1xuY29uc3QgVElNRU9VVF9TT0NLRVRfTVVMVElQTElFUiA9IDAuMVxuXG5jbGFzcyBTbXRwQ2xpZW50IHtcbiAgLyoqXG4gICAqIENyZWF0ZXMgYSBjb25uZWN0aW9uIG9iamVjdCB0byBhIFNNVFAgc2VydmVyIGFuZCBhbGxvd3MgdG8gc2VuZCBtYWlsIHRocm91Z2ggaXQuXG4gICAqIENhbGwgYGNvbm5lY3RgIG1ldGhvZCB0byBpbml0aXRhdGUgdGhlIGFjdHVhbCBjb25uZWN0aW9uLCB0aGUgY29uc3RydWN0b3Igb25seVxuICAgKiBkZWZpbmVzIHRoZSBwcm9wZXJ0aWVzIGJ1dCBkb2VzIG5vdCBhY3R1YWxseSBjb25uZWN0LlxuICAgKlxuICAgKiBOQiEgVGhlIHBhcmFtZXRlciBvcmRlciAoaG9zdCwgcG9ydCkgZGlmZmVycyBmcm9tIG5vZGUuanMgXCJ3YXlcIiAocG9ydCwgaG9zdClcbiAgICpcbiAgICogQGNvbnN0cnVjdG9yXG4gICAqXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBbaG9zdD1cImxvY2FsaG9zdFwiXSBIb3N0bmFtZSB0byBjb25lbmN0IHRvXG4gICAqIEBwYXJhbSB7TnVtYmVyfSBbcG9ydD0yNV0gUG9ydCBudW1iZXIgdG8gY29ubmVjdCB0b1xuICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdIE9wdGlvbmFsIG9wdGlvbnMgb2JqZWN0XG4gICAqIEBwYXJhbSB7Qm9vbGVhbn0gW29wdGlvbnMudXNlU2VjdXJlVHJhbnNwb3J0XSBTZXQgdG8gdHJ1ZSwgdG8gdXNlIGVuY3J5cHRlZCBjb25uZWN0aW9uXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBbb3B0aW9ucy5uYW1lXSBDbGllbnQgaG9zdG5hbWUgZm9yIGludHJvZHVjaW5nIGl0c2VsZiB0byB0aGUgc2VydmVyXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9ucy5hdXRoXSBBdXRoZW50aWNhdGlvbiBvcHRpb25zLiBEZXBlbmRzIG9uIHRoZSBwcmVmZXJyZWQgYXV0aGVudGljYXRpb24gbWV0aG9kLiBVc3VhbGx5IHt1c2VyLCBwYXNzfVxuICAgKiBAcGFyYW0ge1N0cmluZ30gW29wdGlvbnMuYXV0aE1ldGhvZF0gRm9yY2Ugc3BlY2lmaWMgYXV0aGVudGljYXRpb24gbWV0aG9kXG4gICAqIEBwYXJhbSB7Qm9vbGVhbn0gW29wdGlvbnMuZGlzYWJsZUVzY2FwaW5nXSBJZiBzZXQgdG8gdHJ1ZSwgZG8gbm90IGVzY2FwZSBkb3RzIG9uIHRoZSBiZWdpbm5pbmcgb2YgdGhlIGxpbmVzXG4gICAqIEBwYXJhbSB7Qm9vbGVhbn0gW29wdGlvbnMubG9nZ2VyXSBBIHdpbnN0b24tY29tcGF0aWJsZSBsb2dnZXJcbiAgICovXG4gIGNvbnN0cnVjdG9yIChob3N0LCBwb3J0LCBvcHRpb25zID0ge30pIHtcbiAgICB0aGlzLm9wdGlvbnMgPSBvcHRpb25zXG5cbiAgICB0aGlzLnRpbWVvdXRTb2NrZXRMb3dlckJvdW5kID0gVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkRcbiAgICB0aGlzLnRpbWVvdXRTb2NrZXRNdWx0aXBsaWVyID0gVElNRU9VVF9TT0NLRVRfTVVMVElQTElFUlxuXG4gICAgdGhpcy5wb3J0ID0gcG9ydCB8fCAodGhpcy5vcHRpb25zLnVzZVNlY3VyZVRyYW5zcG9ydCA/IDQ2NSA6IDI1KVxuICAgIHRoaXMuaG9zdCA9IGhvc3QgfHwgJ2xvY2FsaG9zdCdcblxuICAgIC8qKlxuICAgICAqIElmIHNldCB0byB0cnVlLCBzdGFydCBhbiBlbmNyeXB0ZWQgY29ubmVjdGlvbiBpbnN0ZWFkIG9mIHRoZSBwbGFpbnRleHQgb25lXG4gICAgICogKHJlY29tbWVuZGVkIGlmIGFwcGxpY2FibGUpLiBJZiB1c2VTZWN1cmVUcmFuc3BvcnQgaXMgbm90IHNldCBidXQgdGhlIHBvcnQgdXNlZCBpcyA0NjUsXG4gICAgICogdGhlbiBlY3J5cHRpb24gaXMgdXNlZCBieSBkZWZhdWx0LlxuICAgICAqL1xuICAgIHRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnQgPSAndXNlU2VjdXJlVHJhbnNwb3J0JyBpbiB0aGlzLm9wdGlvbnMgPyAhIXRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnQgOiB0aGlzLnBvcnQgPT09IDQ2NVxuXG4gICAgdGhpcy5vcHRpb25zLmF1dGggPSB0aGlzLm9wdGlvbnMuYXV0aCB8fCBmYWxzZSAvLyBBdXRoZW50aWNhdGlvbiBvYmplY3QuIElmIG5vdCBzZXQsIGF1dGhlbnRpY2F0aW9uIHN0ZXAgd2lsbCBiZSBza2lwcGVkLlxuICAgIHRoaXMub3B0aW9ucy5uYW1lID0gdGhpcy5vcHRpb25zLm5hbWUgfHwgJ2xvY2FsaG9zdCcgLy8gSG9zdG5hbWUgb2YgdGhlIGNsaWVudCwgdGhpcyB3aWxsIGJlIHVzZWQgZm9yIGludHJvZHVjaW5nIHRvIHRoZSBzZXJ2ZXJcbiAgICB0aGlzLnNvY2tldCA9IGZhbHNlIC8vIERvd25zdHJlYW0gVENQIHNvY2tldCB0byB0aGUgU01UUCBzZXJ2ZXIsIGNyZWF0ZWQgd2l0aCBtb3pUQ1BTb2NrZXRcbiAgICB0aGlzLmRlc3Ryb3llZCA9IGZhbHNlIC8vIEluZGljYXRlcyBpZiB0aGUgY29ubmVjdGlvbiBoYXMgYmVlbiBjbG9zZWQgYW5kIGNhbid0IGJlIHVzZWQgYW55bW9yZVxuICAgIHRoaXMud2FpdERyYWluID0gZmFsc2UgLy8gS2VlcHMgdHJhY2sgaWYgdGhlIGRvd25zdHJlYW0gc29ja2V0IGlzIGN1cnJlbnRseSBmdWxsIGFuZCBhIGRyYWluIGV2ZW50IHNob3VsZCBiZSB3YWl0ZWQgZm9yIG9yIG5vdFxuXG4gICAgLy8gUHJpdmF0ZSBwcm9wZXJ0aWVzXG5cbiAgICB0aGlzLl9hdXRoZW50aWNhdGVkQXMgPSBudWxsIC8vIElmIGF1dGhlbnRpY2F0ZWQgc3VjY2Vzc2Z1bGx5LCBzdG9yZXMgdGhlIHVzZXJuYW1lXG4gICAgdGhpcy5fc3VwcG9ydGVkQXV0aCA9IFtdIC8vIEEgbGlzdCBvZiBhdXRoZW50aWNhdGlvbiBtZWNoYW5pc21zIGRldGVjdGVkIGZyb20gdGhlIEVITE8gcmVzcG9uc2UgYW5kIHdoaWNoIGFyZSBjb21wYXRpYmxlIHdpdGggdGhpcyBsaWJyYXJ5XG4gICAgdGhpcy5fZGF0YU1vZGUgPSBmYWxzZSAvLyBJZiB0cnVlLCBhY2NlcHRzIGRhdGEgZnJvbSB0aGUgdXBzdHJlYW0gdG8gYmUgcGFzc2VkIGRpcmVjdGx5IHRvIHRoZSBkb3duc3RyZWFtIHNvY2tldC4gVXNlZCBhZnRlciB0aGUgREFUQSBjb21tYW5kXG4gICAgdGhpcy5fbGFzdERhdGFCeXRlcyA9ICcnIC8vIEtlZXAgdHJhY2sgb2YgdGhlIGxhc3QgYnl0ZXMgdG8gc2VlIGhvdyB0aGUgdGVybWluYXRpbmcgZG90IHNob3VsZCBiZSBwbGFjZWRcbiAgICB0aGlzLl9lbnZlbG9wZSA9IG51bGwgLy8gRW52ZWxvcGUgb2JqZWN0IGZvciB0cmFja2luZyB3aG8gaXMgc2VuZGluZyBtYWlsIHRvIHdob21cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gbnVsbCAvLyBTdG9yZXMgdGhlIGZ1bmN0aW9uIHRoYXQgc2hvdWxkIGJlIHJ1biBhZnRlciBhIHJlc3BvbnNlIGhhcyBiZWVuIHJlY2VpdmVkIGZyb20gdGhlIHNlcnZlclxuICAgIHRoaXMuX21heEFsbG93ZWRTaXplID0gMDsgLy8gU3RvcmVzIHRoZSBtYXggbWVzc2FnZSBzaXplIHN1cHBvcnRlZCBieSB0aGUgc2VydmVyIGFzIHJlcG9ydGVkIGluIHRoZSBncmVldGluZ1xuICAgIHRoaXMuX3NlY3VyZU1vZGUgPSAhIXRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnQgLy8gSW5kaWNhdGVzIGlmIHRoZSBjb25uZWN0aW9uIGlzIHNlY3VyZWQgb3IgcGxhaW50ZXh0XG4gICAgdGhpcy5fc29ja2V0VGltZW91dFRpbWVyID0gZmFsc2UgLy8gVGltZXIgd2FpdGluZyB0byBkZWNsYXJlIHRoZSBzb2NrZXQgZGVhZCBzdGFydGluZyBmcm9tIHRoZSBsYXN0IHdyaXRlXG4gICAgdGhpcy5fc29ja2V0VGltZW91dFN0YXJ0ID0gZmFsc2UgLy8gU3RhcnQgdGltZSBvZiBzZW5kaW5nIHRoZSBmaXJzdCBwYWNrZXQgaW4gZGF0YSBtb2RlXG4gICAgdGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCA9IGZhbHNlIC8vIFRpbWVvdXQgZm9yIHNlbmRpbmcgaW4gZGF0YSBtb2RlLCBnZXRzIGV4dGVuZGVkIHdpdGggZXZlcnkgc2VuZCgpXG5cbiAgICB0aGlzLl9wYXJzZUJsb2NrID0geyBkYXRhOiBbXSwgc3RhdHVzQ29kZTogbnVsbCB9XG4gICAgdGhpcy5fcGFyc2VSZW1haW5kZXIgPSAnJyAvLyBJZiB0aGUgY29tcGxldGUgbGluZSBpcyBub3QgcmVjZWl2ZWQgeWV0LCBjb250YWlucyB0aGUgYmVnaW5uaW5nIG9mIGl0XG5cbiAgICBjb25zdCBkdW1teUxvZ2dlciA9IFsnZXJyb3InLCAnd2FybmluZycsICdpbmZvJywgJ2RlYnVnJ10ucmVkdWNlKChvLCBsKSA9PiB7IG9bbF0gPSAoKSA9PiB7fTsgcmV0dXJuIG8gfSwge30pXG4gICAgdGhpcy5sb2dnZXIgPSBvcHRpb25zLmxvZ2dlciB8fCBkdW1teUxvZ2dlclxuXG4gICAgLy8gRXZlbnQgcGxhY2Vob2xkZXJzXG4gICAgdGhpcy5vbmVycm9yID0gKGUpID0+IHsgfSAvLyBXaWxsIGJlIHJ1biB3aGVuIGFuIGVycm9yIG9jY3Vycy4gVGhlIGBvbmNsb3NlYCBldmVudCB3aWxsIGZpcmUgc3Vic2VxdWVudGx5LlxuICAgIHRoaXMub25kcmFpbiA9ICgpID0+IHsgfSAvLyBNb3JlIGRhdGEgY2FuIGJlIGJ1ZmZlcmVkIGluIHRoZSBzb2NrZXQuXG4gICAgdGhpcy5vbmNsb3NlID0gKCkgPT4geyB9IC8vIFRoZSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXIgaGFzIGJlZW4gY2xvc2VkXG4gICAgdGhpcy5vbmlkbGUgPSAoKSA9PiB7IH0gLy8gVGhlIGNvbm5lY3Rpb24gaXMgZXN0YWJsaXNoZWQgYW5kIGlkbGUsIHlvdSBjYW4gc2VuZCBtYWlsIG5vd1xuICAgIHRoaXMub25yZWFkeSA9IChmYWlsZWRSZWNpcGllbnRzKSA9PiB7IH0gLy8gV2FpdGluZyBmb3IgbWFpbCBib2R5LCBsaXN0cyBhZGRyZXNzZXMgdGhhdCB3ZXJlIG5vdCBhY2NlcHRlZCBhcyByZWNpcGllbnRzXG4gICAgdGhpcy5vbmRvbmUgPSAoc3VjY2VzcykgPT4geyB9IC8vIFRoZSBtYWlsIGhhcyBiZWVuIHNlbnQuIFdhaXQgZm9yIGBvbmlkbGVgIG5leHQuIEluZGljYXRlcyBpZiB0aGUgbWVzc2FnZSB3YXMgcXVldWVkIGJ5IHRoZSBzZXJ2ZXIuXG4gIH1cblxuICAvKipcbiAgICogSW5pdGlhdGUgYSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXJcbiAgICovXG4gIGNvbm5lY3QgKFNvY2tldENvbnRydWN0b3IgPSBUQ1BTb2NrZXQpIHtcbiAgICB0aGlzLnNvY2tldCA9IFNvY2tldENvbnRydWN0b3Iub3Blbih0aGlzLmhvc3QsIHRoaXMucG9ydCwge1xuICAgICAgYmluYXJ5VHlwZTogJ2FycmF5YnVmZmVyJyxcbiAgICAgIHVzZVNlY3VyZVRyYW5zcG9ydDogdGhpcy5fc2VjdXJlTW9kZSxcbiAgICAgIGNhOiB0aGlzLm9wdGlvbnMuY2EsXG4gICAgICB0bHNXb3JrZXJQYXRoOiB0aGlzLm9wdGlvbnMudGxzV29ya2VyUGF0aCxcbiAgICAgIHdzOiB0aGlzLm9wdGlvbnMud3NcbiAgICB9KVxuXG4gICAgLy8gYWxsb3dzIGNlcnRpZmljYXRlIGhhbmRsaW5nIGZvciBwbGF0Zm9ybSB3L28gbmF0aXZlIHRscyBzdXBwb3J0XG4gICAgLy8gb25jZXJ0IGlzIG5vbiBzdGFuZGFyZCBzbyBzZXR0aW5nIGl0IG1pZ2h0IHRocm93IGlmIHRoZSBzb2NrZXQgb2JqZWN0IGlzIGltbXV0YWJsZVxuICAgIHRyeSB7XG4gICAgICB0aGlzLnNvY2tldC5vbmNlcnQgPSB0aGlzLm9uY2VydFxuICAgIH0gY2F0Y2ggKEUpIHsgfVxuICAgIHRoaXMuc29ja2V0Lm9uZXJyb3IgPSB0aGlzLl9vbkVycm9yLmJpbmQodGhpcylcbiAgICB0aGlzLnNvY2tldC5vbm9wZW4gPSB0aGlzLl9vbk9wZW4uYmluZCh0aGlzKVxuICB9XG5cbiAgLyoqXG4gICAqIFNlbmRzIFFVSVRcbiAgICovXG4gIHF1aXQgKCkge1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgUVVJVC4uLicpXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoJ1FVSVQnKVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLmNsb3NlXG4gIH1cblxuICAvKipcbiAgICogQ2xvc2VzIHRoZSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXJcbiAgICovXG4gIGNsb3NlICgpIHtcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdDbG9zaW5nIGNvbm5lY3Rpb24uLi4nKVxuICAgIGlmICh0aGlzLnNvY2tldCAmJiB0aGlzLnNvY2tldC5yZWFkeVN0YXRlID09PSAnb3BlbicpIHtcbiAgICAgIHRoaXMuc29ja2V0LmNsb3NlKClcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5fZGVzdHJveSgpXG4gICAgfVxuICB9XG5cbiAgLy8gTWFpbCByZWxhdGVkIG1ldGhvZHNcblxuICAvKipcbiAgICogSW5pdGlhdGVzIGEgbmV3IG1lc3NhZ2UgYnkgc3VibWl0dGluZyBlbnZlbG9wZSBkYXRhLCBzdGFydGluZyB3aXRoXG4gICAqIGBNQUlMIEZST006YCBjb21tYW5kLiBVc2UgYWZ0ZXIgYG9uaWRsZWAgZXZlbnRcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGVudmVsb3BlIEVudmVsb3BlIG9iamVjdCBpbiB0aGUgZm9ybSBvZiB7ZnJvbTpcIi4uLlwiLCB0bzpbXCIuLi5cIl19XG4gICAqL1xuICB1c2VFbnZlbG9wZSAoZW52ZWxvcGUpIHtcbiAgICB0aGlzLl9lbnZlbG9wZSA9IGVudmVsb3BlIHx8IHt9XG4gICAgdGhpcy5fZW52ZWxvcGUuZnJvbSA9IFtdLmNvbmNhdCh0aGlzLl9lbnZlbG9wZS5mcm9tIHx8ICgnYW5vbnltb3VzQCcgKyB0aGlzLm9wdGlvbnMubmFtZSkpWzBdXG4gICAgdGhpcy5fZW52ZWxvcGUudG8gPSBbXS5jb25jYXQodGhpcy5fZW52ZWxvcGUudG8gfHwgW10pXG5cbiAgICAvLyBjbG9uZSB0aGUgcmVjaXBpZW50cyBhcnJheSBmb3IgbGF0dGVyIG1hbmlwdWxhdGlvblxuICAgIHRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZSA9IFtdLmNvbmNhdCh0aGlzLl9lbnZlbG9wZS50bylcbiAgICB0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkID0gW11cbiAgICB0aGlzLl9lbnZlbG9wZS5yZXNwb25zZVF1ZXVlID0gW11cblxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25NQUlMXG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBNQUlMIEZST00uLi4nKVxuICAgIHRoaXMuX3NlbmRDb21tYW5kKCdNQUlMIEZST006PCcgKyAodGhpcy5fZW52ZWxvcGUuZnJvbSkgKyAnPicpXG4gIH1cblxuICAvKipcbiAgICogU2VuZCBBU0NJSSBkYXRhIHRvIHRoZSBzZXJ2ZXIuIFdvcmtzIG9ubHkgaW4gZGF0YSBtb2RlIChhZnRlciBgb25yZWFkeWAgZXZlbnQpLCBpZ25vcmVkXG4gICAqIG90aGVyd2lzZVxuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gY2h1bmsgQVNDSUkgc3RyaW5nIChxdW90ZWQtcHJpbnRhYmxlLCBiYXNlNjQgZXRjLikgdG8gYmUgc2VudCB0byB0aGUgc2VydmVyXG4gICAqIEByZXR1cm4ge0Jvb2xlYW59IElmIHRydWUsIGl0IGlzIHNhZmUgdG8gc2VuZCBtb3JlIGRhdGEsIGlmIGZhbHNlLCB5b3UgKnNob3VsZCogd2FpdCBmb3IgdGhlIG9uZHJhaW4gZXZlbnQgYmVmb3JlIHNlbmRpbmcgbW9yZVxuICAgKi9cbiAgc2VuZCAoY2h1bmspIHtcbiAgICAvLyB3b3JrcyBvbmx5IGluIGRhdGEgbW9kZVxuICAgIGlmICghdGhpcy5fZGF0YU1vZGUpIHtcbiAgICAgIC8vIHRoaXMgbGluZSBzaG91bGQgbmV2ZXIgYmUgcmVhY2hlZCBidXQgaWYgaXQgZG9lcyxcbiAgICAgIC8vIGFjdCBsaWtlIGV2ZXJ5dGhpbmcncyBub3JtYWwuXG4gICAgICByZXR1cm4gdHJ1ZVxuICAgIH1cblxuICAgIC8vIFRPRE86IGlmIHRoZSBjaHVuayBpcyBhbiBhcnJheWJ1ZmZlciwgdXNlIGEgc2VwYXJhdGUgZnVuY3Rpb24gdG8gc2VuZCB0aGUgZGF0YVxuICAgIHJldHVybiB0aGlzLl9zZW5kU3RyaW5nKGNodW5rKVxuICB9XG5cbiAgLyoqXG4gICAqIEluZGljYXRlcyB0aGF0IGEgZGF0YSBzdHJlYW0gZm9yIHRoZSBzb2NrZXQgaXMgZW5kZWQuIFdvcmtzIG9ubHkgaW4gZGF0YVxuICAgKiBtb2RlIChhZnRlciBgb25yZWFkeWAgZXZlbnQpLCBpZ25vcmVkIG90aGVyd2lzZS4gVXNlIGl0IHdoZW4geW91IGFyZSBkb25lXG4gICAqIHdpdGggc2VuZGluZyB0aGUgbWFpbC4gVGhpcyBtZXRob2QgZG9lcyBub3QgY2xvc2UgdGhlIHNvY2tldC4gT25jZSB0aGUgbWFpbFxuICAgKiBoYXMgYmVlbiBxdWV1ZWQgYnkgdGhlIHNlcnZlciwgYG9uZG9uZWAgYW5kIGBvbmlkbGVgIGFyZSBlbWl0dGVkLlxuICAgKlxuICAgKiBAcGFyYW0ge0J1ZmZlcn0gW2NodW5rXSBDaHVuayBvZiBkYXRhIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICAgKi9cbiAgZW5kIChjaHVuaykge1xuICAgIC8vIHdvcmtzIG9ubHkgaW4gZGF0YSBtb2RlXG4gICAgaWYgKCF0aGlzLl9kYXRhTW9kZSkge1xuICAgICAgLy8gdGhpcyBsaW5lIHNob3VsZCBuZXZlciBiZSByZWFjaGVkIGJ1dCBpZiBpdCBkb2VzLFxuICAgICAgLy8gYWN0IGxpa2UgZXZlcnl0aGluZydzIG5vcm1hbC5cbiAgICAgIHJldHVybiB0cnVlXG4gICAgfVxuXG4gICAgaWYgKGNodW5rICYmIGNodW5rLmxlbmd0aCkge1xuICAgICAgdGhpcy5zZW5kKGNodW5rKVxuICAgIH1cblxuICAgIC8vIHJlZGlyZWN0IG91dHB1dCBmcm9tIHRoZSBzZXJ2ZXIgdG8gX2FjdGlvblN0cmVhbVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25TdHJlYW1cblxuICAgIC8vIGluZGljYXRlIHRoYXQgdGhlIHN0cmVhbSBoYXMgZW5kZWQgYnkgc2VuZGluZyBhIHNpbmdsZSBkb3Qgb24gaXRzIG93biBsaW5lXG4gICAgLy8gaWYgdGhlIGNsaWVudCBhbHJlYWR5IGNsb3NlZCB0aGUgZGF0YSB3aXRoIFxcclxcbiBubyBuZWVkIHRvIGRvIGl0IGFnYWluXG4gICAgaWYgKHRoaXMuX2xhc3REYXRhQnl0ZXMgPT09ICdcXHJcXG4nKSB7XG4gICAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFVpbnQ4QXJyYXkoWzB4MkUsIDB4MEQsIDB4MEFdKS5idWZmZXIpIC8vIC5cXHJcXG5cbiAgICB9IGVsc2UgaWYgKHRoaXMuX2xhc3REYXRhQnl0ZXMuc3Vic3RyKC0xKSA9PT0gJ1xccicpIHtcbiAgICAgIHRoaXMud2FpdERyYWluID0gdGhpcy5fc2VuZChuZXcgVWludDhBcnJheShbMHgwQSwgMHgyRSwgMHgwRCwgMHgwQV0pLmJ1ZmZlcikgLy8gXFxuLlxcclxcblxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFVpbnQ4QXJyYXkoWzB4MEQsIDB4MEEsIDB4MkUsIDB4MEQsIDB4MEFdKS5idWZmZXIpIC8vIFxcclxcbi5cXHJcXG5cbiAgICB9XG5cbiAgICAvLyBlbmQgZGF0YSBtb2RlLCByZXNldCB0aGUgdmFyaWFibGVzIGZvciBleHRlbmRpbmcgdGhlIHRpbWVvdXQgaW4gZGF0YSBtb2RlXG4gICAgdGhpcy5fZGF0YU1vZGUgPSBmYWxzZVxuICAgIHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCA9IGZhbHNlXG4gICAgdGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCA9IGZhbHNlXG5cbiAgICByZXR1cm4gdGhpcy53YWl0RHJhaW5cbiAgfVxuXG4gIC8vIFBSSVZBVEUgTUVUSE9EU1xuXG4gIC8qKlxuICAgKiBRdWV1ZSBzb21lIGRhdGEgZnJvbSB0aGUgc2VydmVyIGZvciBwYXJzaW5nLlxuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gY2h1bmsgQ2h1bmsgb2YgZGF0YSByZWNlaXZlZCBmcm9tIHRoZSBzZXJ2ZXJcbiAgICovXG4gIF9wYXJzZSAoY2h1bmspIHtcbiAgICAvLyBMaW5lcyBzaG91bGQgYWx3YXlzIGVuZCB3aXRoIDxDUj48TEY+IGJ1dCB5b3UgbmV2ZXIga25vdywgbWlnaHQgYmUgb25seSA8TEY+IGFzIHdlbGxcbiAgICB2YXIgbGluZXMgPSAodGhpcy5fcGFyc2VSZW1haW5kZXIgKyAoY2h1bmsgfHwgJycpKS5zcGxpdCgvXFxyP1xcbi8pXG4gICAgdGhpcy5fcGFyc2VSZW1haW5kZXIgPSBsaW5lcy5wb3AoKSAvLyBub3Qgc3VyZSBpZiB0aGUgbGluZSBoYXMgY29tcGxldGVseSBhcnJpdmVkIHlldFxuXG4gICAgZm9yIChsZXQgaSA9IDAsIGxlbiA9IGxpbmVzLmxlbmd0aDsgaSA8IGxlbjsgaSsrKSB7XG4gICAgICBpZiAoIWxpbmVzW2ldLnRyaW0oKSkge1xuICAgICAgICAvLyBub3RoaW5nIHRvIGNoZWNrLCBlbXB0eSBsaW5lXG4gICAgICAgIGNvbnRpbnVlXG4gICAgICB9XG5cbiAgICAgIC8vIHBvc3NpYmxlIGlucHV0IHN0cmluZ3MgZm9yIHRoZSByZWdleDpcbiAgICAgIC8vIDI1MC1NVUxUSUxJTkUgUkVQTFlcbiAgICAgIC8vIDI1MCBMQVNUIExJTkUgT0YgUkVQTFlcbiAgICAgIC8vIDI1MCAxLjIuMyBNRVNTQUdFXG5cbiAgICAgIGNvbnN0IG1hdGNoID0gbGluZXNbaV0ubWF0Y2goL14oXFxkezN9KShbLSBdKSg/OihcXGQrXFwuXFxkK1xcLlxcZCspKD86ICkpPyguKikvKVxuXG4gICAgICBpZiAobWF0Y2gpIHtcbiAgICAgICAgdGhpcy5fcGFyc2VCbG9jay5kYXRhLnB1c2gobWF0Y2hbNF0pXG5cbiAgICAgICAgaWYgKG1hdGNoWzJdID09PSAnLScpIHtcbiAgICAgICAgICAvLyB0aGlzIGlzIGEgbXVsdGlsaW5lIHJlcGx5XG4gICAgICAgICAgdGhpcy5fcGFyc2VCbG9jay5zdGF0dXNDb2RlID0gdGhpcy5fcGFyc2VCbG9jay5zdGF0dXNDb2RlIHx8IE51bWJlcihtYXRjaFsxXSlcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjb25zdCBzdGF0dXNDb2RlID0gTnVtYmVyKG1hdGNoWzFdKSB8fCAwXG4gICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSB7XG4gICAgICAgICAgICBzdGF0dXNDb2RlLFxuICAgICAgICAgICAgZGF0YTogdGhpcy5fcGFyc2VCbG9jay5kYXRhLmpvaW4oJ1xcbicpLFxuICAgICAgICAgICAgc3VjY2Vzczogc3RhdHVzQ29kZSA+PSAyMDAgJiYgc3RhdHVzQ29kZSA8IDMwMFxuICAgICAgICAgIH1cblxuICAgICAgICAgIHRoaXMuX29uQ29tbWFuZChyZXNwb25zZSlcbiAgICAgICAgICB0aGlzLl9wYXJzZUJsb2NrID0ge1xuICAgICAgICAgICAgZGF0YTogW10sXG4gICAgICAgICAgICBzdGF0dXNDb2RlOiBudWxsXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLl9vbkNvbW1hbmQoe1xuICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgIHN0YXR1c0NvZGU6IHRoaXMuX3BhcnNlQmxvY2suc3RhdHVzQ29kZSB8fCBudWxsLFxuICAgICAgICAgIGRhdGE6IFtsaW5lc1tpXV0uam9pbignXFxuJylcbiAgICAgICAgfSlcbiAgICAgICAgdGhpcy5fcGFyc2VCbG9jayA9IHtcbiAgICAgICAgICBkYXRhOiBbXSxcbiAgICAgICAgICBzdGF0dXNDb2RlOiBudWxsXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBFVkVOVCBIQU5ETEVSUyBGT1IgVEhFIFNPQ0tFVFxuXG4gIC8qKlxuICAgKiBDb25uZWN0aW9uIGxpc3RlbmVyIHRoYXQgaXMgcnVuIHdoZW4gdGhlIGNvbm5lY3Rpb24gdG8gdGhlIHNlcnZlciBpcyBvcGVuZWQuXG4gICAqIFNldHMgdXAgZGlmZmVyZW50IGV2ZW50IGhhbmRsZXJzIGZvciB0aGUgb3BlbmVkIHNvY2tldFxuICAgKlxuICAgKiBAZXZlbnRcbiAgICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gTm90IHVzZWRcbiAgICovXG4gIF9vbk9wZW4gKGV2ZW50KSB7XG4gICAgaWYgKGV2ZW50ICYmIGV2ZW50LmRhdGEgJiYgZXZlbnQuZGF0YS5wcm94eUhvc3RuYW1lKSB7XG4gICAgICB0aGlzLm9wdGlvbnMubmFtZSA9IGV2ZW50LmRhdGEucHJveHlIb3N0bmFtZVxuICAgIH1cblxuICAgIHRoaXMuc29ja2V0Lm9uZGF0YSA9IHRoaXMuX29uRGF0YS5iaW5kKHRoaXMpXG5cbiAgICB0aGlzLnNvY2tldC5vbmNsb3NlID0gdGhpcy5fb25DbG9zZS5iaW5kKHRoaXMpXG4gICAgdGhpcy5zb2NrZXQub25kcmFpbiA9IHRoaXMuX29uRHJhaW4uYmluZCh0aGlzKVxuXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkdyZWV0aW5nXG4gIH1cblxuICAvKipcbiAgICogRGF0YSBsaXN0ZW5lciBmb3IgY2h1bmtzIG9mIGRhdGEgZW1pdHRlZCBieSB0aGUgc2VydmVyXG4gICAqXG4gICAqIEBldmVudFxuICAgKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBTZWUgYGV2dC5kYXRhYCBmb3IgdGhlIGNodW5rIHJlY2VpdmVkXG4gICAqL1xuICBfb25EYXRhIChldnQpIHtcbiAgICBjbGVhclRpbWVvdXQodGhpcy5fc29ja2V0VGltZW91dFRpbWVyKVxuICAgIHZhciBzdHJpbmdQYXlsb2FkID0gbmV3IFRleHREZWNvZGVyKCdVVEYtOCcpLmRlY29kZShuZXcgVWludDhBcnJheShldnQuZGF0YSkpXG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU0VSVkVSOiAnICsgc3RyaW5nUGF5bG9hZClcbiAgICB0aGlzLl9wYXJzZShzdHJpbmdQYXlsb2FkKVxuICB9XG5cbiAgLyoqXG4gICAqIE1vcmUgZGF0YSBjYW4gYmUgYnVmZmVyZWQgaW4gdGhlIHNvY2tldCwgYHdhaXREcmFpbmAgaXMgcmVzZXQgdG8gZmFsc2VcbiAgICpcbiAgICogQGV2ZW50XG4gICAqIEBwYXJhbSB7RXZlbnR9IGV2dCBFdmVudCBvYmplY3QuIE5vdCB1c2VkXG4gICAqL1xuICBfb25EcmFpbiAoKSB7XG4gICAgdGhpcy53YWl0RHJhaW4gPSBmYWxzZVxuICAgIHRoaXMub25kcmFpbigpXG4gIH1cblxuICAvKipcbiAgICogRXJyb3IgaGFuZGxlciBmb3IgdGhlIHNvY2tldFxuICAgKlxuICAgKiBAZXZlbnRcbiAgICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gU2VlIGV2dC5kYXRhIGZvciB0aGUgZXJyb3JcbiAgICovXG4gIF9vbkVycm9yIChldnQpIHtcbiAgICBpZiAoZXZ0IGluc3RhbmNlb2YgRXJyb3IgJiYgZXZ0Lm1lc3NhZ2UpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgZXZ0KVxuICAgICAgdGhpcy5vbmVycm9yKGV2dClcbiAgICB9IGVsc2UgaWYgKGV2dCAmJiBldnQuZGF0YSBpbnN0YW5jZW9mIEVycm9yKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsIGV2dC5kYXRhKVxuICAgICAgdGhpcy5vbmVycm9yKGV2dC5kYXRhKVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsIG5ldyBFcnJvcigoZXZ0ICYmIGV2dC5kYXRhICYmIGV2dC5kYXRhLm1lc3NhZ2UpIHx8IGV2dC5kYXRhIHx8IGV2dCB8fCAnRXJyb3InKSlcbiAgICAgIHRoaXMub25lcnJvcihuZXcgRXJyb3IoKGV2dCAmJiBldnQuZGF0YSAmJiBldnQuZGF0YS5tZXNzYWdlKSB8fCBldnQuZGF0YSB8fCBldnQgfHwgJ0Vycm9yJykpXG4gICAgfVxuXG4gICAgdGhpcy5jbG9zZSgpXG4gIH1cblxuICAvKipcbiAgICogSW5kaWNhdGVzIHRoYXQgdGhlIHNvY2tldCBoYXMgYmVlbiBjbG9zZWRcbiAgICpcbiAgICogQGV2ZW50XG4gICAqIEBwYXJhbSB7RXZlbnR9IGV2dCBFdmVudCBvYmplY3QuIE5vdCB1c2VkXG4gICAqL1xuICBfb25DbG9zZSAoKSB7XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU29ja2V0IGNsb3NlZC4nKVxuICAgIHRoaXMuX2Rlc3Ryb3koKVxuICB9XG5cbiAgLyoqXG4gICAqIFRoaXMgaXMgbm90IGEgc29ja2V0IGRhdGEgaGFuZGxlciBidXQgdGhlIGhhbmRsZXIgZm9yIGRhdGEgZW1pdHRlZCBieSB0aGUgcGFyc2VyLFxuICAgKiBzbyB0aGlzIGRhdGEgaXMgc2FmZSB0byB1c2UgYXMgaXQgaXMgYWx3YXlzIGNvbXBsZXRlIChzZXJ2ZXIgbWlnaHQgc2VuZCBwYXJ0aWFsIGNodW5rcylcbiAgICpcbiAgICogQGV2ZW50XG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBkYXRhXG4gICAqL1xuICBfb25Db21tYW5kIChjb21tYW5kKSB7XG4gICAgaWYgKHR5cGVvZiB0aGlzLl9jdXJyZW50QWN0aW9uID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uKGNvbW1hbmQpXG4gICAgfVxuICB9XG5cbiAgX29uVGltZW91dCAoKSB7XG4gICAgLy8gaW5mb3JtIGFib3V0IHRoZSB0aW1lb3V0IGFuZCBzaHV0IGRvd25cbiAgICB2YXIgZXJyb3IgPSBuZXcgRXJyb3IoJ1NvY2tldCB0aW1lZCBvdXQhJylcbiAgICB0aGlzLl9vbkVycm9yKGVycm9yKVxuICB9XG5cbiAgLyoqXG4gICAqIEVuc3VyZXMgdGhhdCB0aGUgY29ubmVjdGlvbiBpcyBjbG9zZWQgYW5kIHN1Y2hcbiAgICovXG4gIF9kZXN0cm95ICgpIHtcbiAgICBjbGVhclRpbWVvdXQodGhpcy5fc29ja2V0VGltZW91dFRpbWVyKVxuXG4gICAgaWYgKCF0aGlzLmRlc3Ryb3llZCkge1xuICAgICAgdGhpcy5kZXN0cm95ZWQgPSB0cnVlXG4gICAgICB0aGlzLm9uY2xvc2UoKVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBTZW5kcyBhIHN0cmluZyB0byB0aGUgc29ja2V0LlxuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gY2h1bmsgQVNDSUkgc3RyaW5nIChxdW90ZWQtcHJpbnRhYmxlLCBiYXNlNjQgZXRjLikgdG8gYmUgc2VudCB0byB0aGUgc2VydmVyXG4gICAqIEByZXR1cm4ge0Jvb2xlYW59IElmIHRydWUsIGl0IGlzIHNhZmUgdG8gc2VuZCBtb3JlIGRhdGEsIGlmIGZhbHNlLCB5b3UgKnNob3VsZCogd2FpdCBmb3IgdGhlIG9uZHJhaW4gZXZlbnQgYmVmb3JlIHNlbmRpbmcgbW9yZVxuICAgKi9cbiAgX3NlbmRTdHJpbmcgKGNodW5rKSB7XG4gICAgLy8gZXNjYXBlIGRvdHNcbiAgICBpZiAoIXRoaXMub3B0aW9ucy5kaXNhYmxlRXNjYXBpbmcpIHtcbiAgICAgIGNodW5rID0gY2h1bmsucmVwbGFjZSgvXFxuXFwuL2csICdcXG4uLicpXG4gICAgICBpZiAoKHRoaXMuX2xhc3REYXRhQnl0ZXMuc3Vic3RyKC0xKSA9PT0gJ1xcbicgfHwgIXRoaXMuX2xhc3REYXRhQnl0ZXMpICYmIGNodW5rLmNoYXJBdCgwKSA9PT0gJy4nKSB7XG4gICAgICAgIGNodW5rID0gJy4nICsgY2h1bmtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBLZWVwaW5nIGV5ZSBvbiB0aGUgbGFzdCBieXRlcyBzZW50LCB0byBzZWUgaWYgdGhlcmUgaXMgYSA8Q1I+PExGPiBzZXF1ZW5jZVxuICAgIC8vIGF0IHRoZSBlbmQgd2hpY2ggaXMgbmVlZGVkIHRvIGVuZCB0aGUgZGF0YSBzdHJlYW1cbiAgICBpZiAoY2h1bmsubGVuZ3RoID4gMikge1xuICAgICAgdGhpcy5fbGFzdERhdGFCeXRlcyA9IGNodW5rLnN1YnN0cigtMilcbiAgICB9IGVsc2UgaWYgKGNodW5rLmxlbmd0aCA9PT0gMSkge1xuICAgICAgdGhpcy5fbGFzdERhdGFCeXRlcyA9IHRoaXMuX2xhc3REYXRhQnl0ZXMuc3Vic3RyKC0xKSArIGNodW5rXG4gICAgfVxuXG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyAnICsgY2h1bmsubGVuZ3RoICsgJyBieXRlcyBvZiBwYXlsb2FkJylcblxuICAgIC8vIHBhc3MgdGhlIGNodW5rIHRvIHRoZSBzb2NrZXRcbiAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFRleHRFbmNvZGVyKCdVVEYtOCcpLmVuY29kZShjaHVuaykuYnVmZmVyKVxuICAgIHJldHVybiB0aGlzLndhaXREcmFpblxuICB9XG5cbiAgLyoqXG4gICAqIFNlbmQgYSBzdHJpbmcgY29tbWFuZCB0byB0aGUgc2VydmVyLCBhbHNvIGFwcGVuZCBcXHJcXG4gaWYgbmVlZGVkXG4gICAqXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBzdHIgU3RyaW5nIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICAgKi9cbiAgX3NlbmRDb21tYW5kIChzdHIpIHtcbiAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFRleHRFbmNvZGVyKCdVVEYtOCcpLmVuY29kZShzdHIgKyAoc3RyLnN1YnN0cigtMikgIT09ICdcXHJcXG4nID8gJ1xcclxcbicgOiAnJykpLmJ1ZmZlcilcbiAgfVxuXG4gIF9zZW5kIChidWZmZXIpIHtcbiAgICB0aGlzLl9zZXRUaW1lb3V0KGJ1ZmZlci5ieXRlTGVuZ3RoKVxuICAgIHJldHVybiB0aGlzLnNvY2tldC5zZW5kKGJ1ZmZlcilcbiAgfVxuXG4gIF9zZXRUaW1lb3V0IChieXRlTGVuZ3RoKSB7XG4gICAgdmFyIHByb2xvbmdQZXJpb2QgPSBNYXRoLmZsb29yKGJ5dGVMZW5ndGggKiB0aGlzLnRpbWVvdXRTb2NrZXRNdWx0aXBsaWVyKVxuICAgIHZhciB0aW1lb3V0XG5cbiAgICBpZiAodGhpcy5fZGF0YU1vZGUpIHtcbiAgICAgIC8vIHdlJ3JlIGluIGRhdGEgbW9kZSwgc28gd2UgY291bnQgb25seSBvbmUgdGltZW91dCB0aGF0IGdldCBleHRlbmRlZCBmb3IgZXZlcnkgc2VuZCgpLlxuICAgICAgdmFyIG5vdyA9IERhdGUubm93KClcblxuICAgICAgLy8gdGhlIG9sZCB0aW1lb3V0IHN0YXJ0IHRpbWVcbiAgICAgIHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCA9IHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCB8fCBub3dcblxuICAgICAgLy8gdGhlIG9sZCB0aW1lb3V0IHBlcmlvZCwgbm9ybWFsaXplZCB0byBhIG1pbmltdW0gb2YgVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkRcbiAgICAgIHRoaXMuX3NvY2tldFRpbWVvdXRQZXJpb2QgPSAodGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCB8fCB0aGlzLnRpbWVvdXRTb2NrZXRMb3dlckJvdW5kKSArIHByb2xvbmdQZXJpb2RcblxuICAgICAgLy8gdGhlIG5ldyB0aW1lb3V0IGlzIHRoZSBkZWx0YSBiZXR3ZWVuIHRoZSBuZXcgZmlyaW5nIHRpbWUgKD0gdGltZW91dCBwZXJpb2QgKyB0aW1lb3V0IHN0YXJ0IHRpbWUpIGFuZCBub3dcbiAgICAgIHRpbWVvdXQgPSB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgKyB0aGlzLl9zb2NrZXRUaW1lb3V0UGVyaW9kIC0gbm93XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIHNldCBuZXcgdGltb3V0XG4gICAgICB0aW1lb3V0ID0gdGhpcy50aW1lb3V0U29ja2V0TG93ZXJCb3VuZCArIHByb2xvbmdQZXJpb2RcbiAgICB9XG5cbiAgICBjbGVhclRpbWVvdXQodGhpcy5fc29ja2V0VGltZW91dFRpbWVyKSAvLyBjbGVhciBwZW5kaW5nIHRpbWVvdXRzXG4gICAgdGhpcy5fc29ja2V0VGltZW91dFRpbWVyID0gc2V0VGltZW91dCh0aGlzLl9vblRpbWVvdXQuYmluZCh0aGlzKSwgdGltZW91dCkgLy8gYXJtIHRoZSBuZXh0IHRpbWVvdXRcbiAgfVxuXG4gIC8qKlxuICAgKiBJbnRpdGlhdGUgYXV0aGVudGljYXRpb24gc2VxdWVuY2UgaWYgbmVlZGVkXG4gICAqL1xuICBfYXV0aGVudGljYXRlVXNlciAoKSB7XG4gICAgaWYgKCF0aGlzLm9wdGlvbnMuYXV0aCkge1xuICAgICAgLy8gbm8gbmVlZCB0byBhdXRoZW50aWNhdGUsIGF0IGxlYXN0IG5vIGRhdGEgZ2l2ZW5cbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgICB0aGlzLm9uaWRsZSgpIC8vIHJlYWR5IHRvIHRha2Ugb3JkZXJzXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB2YXIgYXV0aFxuXG4gICAgaWYgKCF0aGlzLm9wdGlvbnMuYXV0aE1ldGhvZCAmJiB0aGlzLm9wdGlvbnMuYXV0aC54b2F1dGgyKSB7XG4gICAgICB0aGlzLm9wdGlvbnMuYXV0aE1ldGhvZCA9ICdYT0FVVEgyJ1xuICAgIH1cblxuICAgIGlmICh0aGlzLm9wdGlvbnMuYXV0aE1ldGhvZCkge1xuICAgICAgYXV0aCA9IHRoaXMub3B0aW9ucy5hdXRoTWV0aG9kLnRvVXBwZXJDYXNlKCkudHJpbSgpXG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIHVzZSBmaXJzdCBzdXBwb3J0ZWRcbiAgICAgIGF1dGggPSAodGhpcy5fc3VwcG9ydGVkQXV0aFswXSB8fCAnUExBSU4nKS50b1VwcGVyQ2FzZSgpLnRyaW0oKVxuICAgIH1cblxuICAgIHN3aXRjaCAoYXV0aCkge1xuICAgICAgY2FzZSAnTE9HSU4nOlxuICAgICAgICAvLyBMT0dJTiBpcyBhIDMgc3RlcCBhdXRoZW50aWNhdGlvbiBwcm9jZXNzXG4gICAgICAgIC8vIEM6IEFVVEggTE9HSU5cbiAgICAgICAgLy8gQzogQkFTRTY0KFVTRVIpXG4gICAgICAgIC8vIEM6IEJBU0U2NChQQVNTKVxuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiB2aWEgQVVUSCBMT0dJTicpXG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIX0xPR0lOX1VTRVJcbiAgICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0FVVEggTE9HSU4nKVxuICAgICAgICByZXR1cm5cbiAgICAgIGNhc2UgJ1BMQUlOJzpcbiAgICAgICAgLy8gQVVUSCBQTEFJTiBpcyBhIDEgc3RlcCBhdXRoZW50aWNhdGlvbiBwcm9jZXNzXG4gICAgICAgIC8vIEM6IEFVVEggUExBSU4gQkFTRTY0KFxcMCBVU0VSIFxcMCBQQVNTKVxuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiB2aWEgQVVUSCBQTEFJTicpXG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIQ29tcGxldGVcbiAgICAgICAgdGhpcy5fc2VuZENvbW1hbmQoXG4gICAgICAgICAgLy8gY29udmVydCB0byBCQVNFNjRcbiAgICAgICAgICAnQVVUSCBQTEFJTiAnICtcbiAgICAgICAgICBlbmNvZGUoXG4gICAgICAgICAgICAvLyB0aGlzLm9wdGlvbnMuYXV0aC51c2VyKydcXHUwMDAwJytcbiAgICAgICAgICAgICdcXHUwMDAwJyArIC8vIHNraXAgYXV0aG9yaXphdGlvbiBpZGVudGl0eSBhcyBpdCBjYXVzZXMgcHJvYmxlbXMgd2l0aCBzb21lIHNlcnZlcnNcbiAgICAgICAgICAgIHRoaXMub3B0aW9ucy5hdXRoLnVzZXIgKyAnXFx1MDAwMCcgK1xuICAgICAgICAgICAgdGhpcy5vcHRpb25zLmF1dGgucGFzcylcbiAgICAgICAgKVxuICAgICAgICByZXR1cm5cbiAgICAgIGNhc2UgJ1hPQVVUSDInOlxuICAgICAgICAvLyBTZWUgaHR0cHM6Ly9kZXZlbG9wZXJzLmdvb2dsZS5jb20vZ21haWwveG9hdXRoMl9wcm90b2NvbCNzbXRwX3Byb3RvY29sX2V4Y2hhbmdlXG4gICAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0F1dGhlbnRpY2F0aW9uIHZpYSBBVVRIIFhPQVVUSDInKVxuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSF9YT0FVVEgyXG4gICAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdBVVRIIFhPQVVUSDIgJyArIHRoaXMuX2J1aWxkWE9BdXRoMlRva2VuKHRoaXMub3B0aW9ucy5hdXRoLnVzZXIsIHRoaXMub3B0aW9ucy5hdXRoLnhvYXV0aDIpKVxuICAgICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignVW5rbm93biBhdXRoZW50aWNhdGlvbiBtZXRob2QgJyArIGF1dGgpKVxuICB9XG5cbiAgLy8gQUNUSU9OUyBGT1IgUkVTUE9OU0VTIEZST00gVEhFIFNNVFAgU0VSVkVSXG5cbiAgLyoqXG4gICAqIEluaXRpYWwgcmVzcG9uc2UgZnJvbSB0aGUgc2VydmVyLCBtdXN0IGhhdmUgYSBzdGF0dXMgMjIwXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25HcmVldGluZyAoY29tbWFuZCkge1xuICAgIGlmIChjb21tYW5kLnN0YXR1c0NvZGUgIT09IDIyMCkge1xuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ0ludmFsaWQgZ3JlZXRpbmc6ICcgKyBjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgaWYgKHRoaXMub3B0aW9ucy5sbXRwKSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIExITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uTEhMT1xuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0xITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIEVITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uRUhMT1xuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0VITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBMSExPXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25MSExPIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0xITE8gbm90IHN1Y2Nlc3NmdWwnKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIC8vIFByb2Nlc3MgYXMgRUhMTyByZXNwb25zZVxuICAgIHRoaXMuX2FjdGlvbkVITE8oY29tbWFuZClcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBFSExPLiBJZiB0aGUgcmVzcG9uc2UgaXMgYW4gZXJyb3IsIHRyeSBIRUxPIGluc3RlYWRcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvbkVITE8gKGNvbW1hbmQpIHtcbiAgICB2YXIgbWF0Y2hcblxuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICBpZiAoIXRoaXMuX3NlY3VyZU1vZGUgJiYgdGhpcy5vcHRpb25zLnJlcXVpcmVUTFMpIHtcbiAgICAgICAgdmFyIGVyck1zZyA9ICdTVEFSVFRMUyBub3Qgc3VwcG9ydGVkIHdpdGhvdXQgRUhMTydcbiAgICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCBlcnJNc2cpXG4gICAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGVyck1zZykpXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuXG4gICAgICAvLyBUcnkgSEVMTyBpbnN0ZWFkXG4gICAgICB0aGlzLmxvZ2dlci53YXJuaW5nKERFQlVHX1RBRywgJ0VITE8gbm90IHN1Y2Nlc3NmdWwsIHRyeWluZyBIRUxPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25IRUxPXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnSEVMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICAvLyBEZXRlY3QgaWYgdGhlIHNlcnZlciBzdXBwb3J0cyBQTEFJTiBhdXRoXG4gICAgaWYgKGNvbW1hbmQuZGF0YS5tYXRjaCgvQVVUSCg/OlxccytbXlxcbl0qXFxzK3xcXHMrKVBMQUlOL2kpKSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZXJ2ZXIgc3VwcG9ydHMgQVVUSCBQTEFJTicpXG4gICAgICB0aGlzLl9zdXBwb3J0ZWRBdXRoLnB1c2goJ1BMQUlOJylcbiAgICB9XG5cbiAgICAvLyBEZXRlY3QgaWYgdGhlIHNlcnZlciBzdXBwb3J0cyBMT0dJTiBhdXRoXG4gICAgaWYgKGNvbW1hbmQuZGF0YS5tYXRjaCgvQVVUSCg/OlxccytbXlxcbl0qXFxzK3xcXHMrKUxPR0lOL2kpKSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZXJ2ZXIgc3VwcG9ydHMgQVVUSCBMT0dJTicpXG4gICAgICB0aGlzLl9zdXBwb3J0ZWRBdXRoLnB1c2goJ0xPR0lOJylcbiAgICB9XG5cbiAgICAvLyBEZXRlY3QgaWYgdGhlIHNlcnZlciBzdXBwb3J0cyBYT0FVVEgyIGF1dGhcbiAgICBpZiAoY29tbWFuZC5kYXRhLm1hdGNoKC9BVVRIKD86XFxzK1teXFxuXSpcXHMrfFxccyspWE9BVVRIMi9pKSkge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VydmVyIHN1cHBvcnRzIEFVVEggWE9BVVRIMicpXG4gICAgICB0aGlzLl9zdXBwb3J0ZWRBdXRoLnB1c2goJ1hPQVVUSDInKVxuICAgIH1cblxuICAgIC8vIERldGVjdCBtYXhpbXVtIGFsbG93ZWQgbWVzc2FnZSBzaXplXG4gICAgaWYgKChtYXRjaCA9IGNvbW1hbmQuZGF0YS5tYXRjaCgvU0laRSAoXFxkKykvaSkpICYmIE51bWJlcihtYXRjaFsxXSkpIHtcbiAgICAgIGNvbnN0IG1heEFsbG93ZWRTaXplID0gTnVtYmVyKG1hdGNoWzFdKVxuICAgICAgdGhpcy5fbWF4QWxsb3dlZFNpemUgPSBtYXhBbGxvd2VkU2l6ZTtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ01heGltdW0gYWxsb3dlZCBtZXNzYWdlIHNpemU6ICcgKyBtYXhBbGxvd2VkU2l6ZSlcbiAgICB9XG5cbiAgICAvLyBEZXRlY3QgaWYgdGhlIHNlcnZlciBzdXBwb3J0cyBTVEFSVFRMU1xuICAgIGlmICghdGhpcy5fc2VjdXJlTW9kZSkge1xuICAgICAgaWYgKChjb21tYW5kLmRhdGEubWF0Y2goL1NUQVJUVExTXFxzPyQvbWkpICYmICF0aGlzLm9wdGlvbnMuaWdub3JlVExTKSB8fCAhIXRoaXMub3B0aW9ucy5yZXF1aXJlVExTKSB7XG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25TVEFSVFRMU1xuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIFNUQVJUVExTJylcbiAgICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ1NUQVJUVExTJylcbiAgICAgICAgcmV0dXJuXG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5fYXV0aGVudGljYXRlVXNlcigpXG4gIH1cblxuICAvKipcbiAgICogSGFuZGxlcyBzZXJ2ZXIgcmVzcG9uc2UgZm9yIFNUQVJUVExTIGNvbW1hbmQuIElmIHRoZXJlJ3MgYW4gZXJyb3JcbiAgICogdHJ5IEhFTE8gaW5zdGVhZCwgb3RoZXJ3aXNlIGluaXRpYXRlIFRMUyB1cGdyYWRlLiBJZiB0aGUgdXBncmFkZVxuICAgKiBzdWNjZWVkZXMgcmVzdGFydCB0aGUgRUhMT1xuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gc3RyIE1lc3NhZ2UgZnJvbSB0aGUgc2VydmVyXG4gICAqL1xuICBfYWN0aW9uU1RBUlRUTFMgKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnU1RBUlRUTFMgbm90IHN1Y2Nlc3NmdWwnKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRoaXMuX3NlY3VyZU1vZGUgPSB0cnVlXG4gICAgdGhpcy5zb2NrZXQudXBncmFkZVRvU2VjdXJlKClcblxuICAgIC8vIHJlc3RhcnQgcHJvdG9jb2wgZmxvd1xuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25FSExPXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoJ0VITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIEhFTE9cbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvbkhFTE8gKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnSEVMTyBub3Qgc3VjY2Vzc2Z1bCcpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuICAgIHRoaXMuX2F1dGhlbnRpY2F0ZVVzZXIoKVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3BvbnNlIHRvIEFVVEggTE9HSU4sIGlmIHN1Y2Nlc3NmdWwgZXhwZWN0cyBiYXNlNjQgZW5jb2RlZCB1c2VybmFtZVxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uQVVUSF9MT0dJTl9VU0VSIChjb21tYW5kKSB7XG4gICAgaWYgKGNvbW1hbmQuc3RhdHVzQ29kZSAhPT0gMzM0IHx8IGNvbW1hbmQuZGF0YSAhPT0gJ1ZYTmxjbTVoYldVNicpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0FVVEggTE9HSU4gVVNFUiBub3Qgc3VjY2Vzc2Z1bDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdJbnZhbGlkIGxvZ2luIHNlcXVlbmNlIHdoaWxlIHdhaXRpbmcgZm9yIFwiMzM0IFZYTmxjbTVoYldVNiBcIjogJyArIGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQVVUSCBMT0dJTiBVU0VSIHN1Y2Nlc3NmdWwnKVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIX0xPR0lOX1BBU1NcbiAgICB0aGlzLl9zZW5kQ29tbWFuZChlbmNvZGUodGhpcy5vcHRpb25zLmF1dGgudXNlcikpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gQVVUSCBMT0dJTiB1c2VybmFtZSwgaWYgc3VjY2Vzc2Z1bCBleHBlY3RzIGJhc2U2NCBlbmNvZGVkIHBhc3N3b3JkXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25BVVRIX0xPR0lOX1BBU1MgKGNvbW1hbmQpIHtcbiAgICBpZiAoY29tbWFuZC5zdGF0dXNDb2RlICE9PSAzMzQgfHwgY29tbWFuZC5kYXRhICE9PSAnVUdGemMzZHZjbVE2Jykge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnQVVUSCBMT0dJTiBQQVNTIG5vdCBzdWNjZXNzZnVsOiAnICsgY29tbWFuZC5kYXRhKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ0ludmFsaWQgbG9naW4gc2VxdWVuY2Ugd2hpbGUgd2FpdGluZyBmb3IgXCIzMzQgVUdGemMzZHZjbVE2IFwiOiAnICsgY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBVVRIIExPR0lOIFBBU1Mgc3VjY2Vzc2Z1bCcpXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhDb21wbGV0ZVxuICAgIHRoaXMuX3NlbmRDb21tYW5kKGVuY29kZSh0aGlzLm9wdGlvbnMuYXV0aC5wYXNzKSlcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNwb25zZSB0byBBVVRIIFhPQVVUSDIgdG9rZW4sIGlmIGVycm9yIG9jY3VycyBzZW5kIGVtcHR5IHJlc3BvbnNlXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25BVVRIX1hPQVVUSDIgKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIud2FybmluZyhERUJVR19UQUcsICdFcnJvciBkdXJpbmcgQVVUSCBYT0FVVEgyLCBzZW5kaW5nIGVtcHR5IHJlc3BvbnNlJylcbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCcnKVxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhDb21wbGV0ZVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLl9hY3Rpb25BVVRIQ29tcGxldGUoY29tbWFuZClcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQ2hlY2tzIGlmIGF1dGhlbnRpY2F0aW9uIHN1Y2NlZWRlZCBvciBub3QuIElmIHN1Y2Nlc3NmdWxseSBhdXRoZW50aWNhdGVkXG4gICAqIGVtaXQgYGlkbGVgIHRvIGluZGljYXRlIHRoYXQgYW4gZS1tYWlsIGNhbiBiZSBzZW50IHVzaW5nIHRoaXMgY29ubmVjdGlvblxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uQVVUSENvbXBsZXRlIChjb21tYW5kKSB7XG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0F1dGhlbnRpY2F0aW9uIGZhaWxlZDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiBzdWNjZXNzZnVsLicpXG5cbiAgICB0aGlzLl9hdXRoZW50aWNhdGVkQXMgPSB0aGlzLm9wdGlvbnMuYXV0aC51c2VyXG5cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgIHRoaXMub25pZGxlKCkgLy8gcmVhZHkgdG8gdGFrZSBvcmRlcnNcbiAgfVxuXG4gIC8qKlxuICAgKiBVc2VkIHdoZW4gdGhlIGNvbm5lY3Rpb24gaXMgaWRsZSBhbmQgdGhlIHNlcnZlciBlbWl0cyB0aW1lb3V0XG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25JZGxlIChjb21tYW5kKSB7XG4gICAgaWYgKGNvbW1hbmQuc3RhdHVzQ29kZSA+IDMwMCkge1xuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gTUFJTCBGUk9NIGNvbW1hbmQuIFByb2NlZWQgdG8gZGVmaW5pbmcgUkNQVCBUTyBsaXN0IGlmIHN1Y2Nlc3NmdWxcbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvbk1BSUwgKGNvbW1hbmQpIHtcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnTUFJTCBGUk9NIHVuc3VjY2Vzc2Z1bDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICBpZiAoIXRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5sZW5ndGgpIHtcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdDYW5cXCd0IHNlbmQgbWFpbCAtIG5vIHJlY2lwaWVudHMgZGVmaW5lZCcpKVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdNQUlMIEZST00gc3VjY2Vzc2Z1bCwgcHJvY2VlZGluZyB3aXRoICcgKyB0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUubGVuZ3RoICsgJyByZWNpcGllbnRzJylcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0FkZGluZyByZWNpcGllbnQuLi4nKVxuICAgICAgdGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50ID0gdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLnNoaWZ0KClcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25SQ1BUXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnUkNQVCBUTzo8JyArIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudCArICc+JylcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gYSBSQ1BUIFRPIGNvbW1hbmQuIElmIHRoZSBjb21tYW5kIGlzIHVuc3VjY2Vzc2Z1bCwgdHJ5IHRoZSBuZXh0IG9uZSxcbiAgICogYXMgdGhpcyBtaWdodCBiZSByZWxhdGVkIG9ubHkgdG8gdGhlIGN1cnJlbnQgcmVjaXBpZW50LCBub3QgYSBnbG9iYWwgZXJyb3IsIHNvXG4gICAqIHRoZSBmb2xsb3dpbmcgcmVjaXBpZW50cyBtaWdodCBzdGlsbCBiZSB2YWxpZFxuICAgKlxuICAgKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGF9XG4gICAqL1xuICBfYWN0aW9uUkNQVCAoY29tbWFuZCkge1xuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICB0aGlzLmxvZ2dlci53YXJuaW5nKERFQlVHX1RBRywgJ1JDUFQgVE8gZmFpbGVkIGZvcjogJyArIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudClcbiAgICAgIC8vIHRoaXMgaXMgYSBzb2Z0IGVycm9yXG4gICAgICB0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkLnB1c2godGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50KVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLl9lbnZlbG9wZS5yZXNwb25zZVF1ZXVlLnB1c2godGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50KVxuICAgIH1cblxuICAgIGlmICghdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLmxlbmd0aCkge1xuICAgICAgaWYgKHRoaXMuX2VudmVsb3BlLnJjcHRGYWlsZWQubGVuZ3RoIDwgdGhpcy5fZW52ZWxvcGUudG8ubGVuZ3RoKSB7XG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25EQVRBXG4gICAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1JDUFQgVE8gZG9uZSwgcHJvY2VlZGluZyB3aXRoIHBheWxvYWQnKVxuICAgICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnREFUQScpXG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignQ2FuXFwndCBzZW5kIG1haWwgLSBhbGwgcmVjaXBpZW50cyB3ZXJlIHJlamVjdGVkJykpXG4gICAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0FkZGluZyByZWNpcGllbnQuLi4nKVxuICAgICAgdGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50ID0gdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLnNoaWZ0KClcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25SQ1BUXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnUkNQVCBUTzo8JyArIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudCArICc+JylcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgdG8gdGhlIERBVEEgY29tbWFuZC4gU2VydmVyIGlzIG5vdyB3YWl0aW5nIGZvciBhIG1lc3NhZ2UsIHNvIGVtaXQgYG9ucmVhZHlgXG4gICAqXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YX1cbiAgICovXG4gIF9hY3Rpb25EQVRBIChjb21tYW5kKSB7XG4gICAgLy8gcmVzcG9uc2Ugc2hvdWxkIGJlIDM1NCBidXQgYWNjb3JkaW5nIHRvIHRoaXMgaXNzdWUgaHR0cHM6Ly9naXRodWIuY29tL2VsZWl0aC9lbWFpbGpzL2lzc3Vlcy8yNFxuICAgIC8vIHNvbWUgc2VydmVycyBtaWdodCB1c2UgMjUwIGluc3RlYWRcbiAgICBpZiAoWzI1MCwgMzU0XS5pbmRleE9mKGNvbW1hbmQuc3RhdHVzQ29kZSkgPCAwKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdEQVRBIHVuc3VjY2Vzc2Z1bCAnICsgY29tbWFuZC5kYXRhKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRoaXMuX2RhdGFNb2RlID0gdHJ1ZVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgdGhpcy5vbnJlYWR5KHRoaXMuX2VudmVsb3BlLnJjcHRGYWlsZWQpXG4gIH1cblxuICAvKipcbiAgICogUmVzcG9uc2UgZnJvbSB0aGUgc2VydmVyLCBvbmNlIHRoZSBtZXNzYWdlIHN0cmVhbSBoYXMgZW5kZWQgd2l0aCA8Q1I+PExGPi48Q1I+PExGPlxuICAgKiBFbWl0cyBgb25kb25lYC5cbiAgICpcbiAgICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhfVxuICAgKi9cbiAgX2FjdGlvblN0cmVhbSAoY29tbWFuZCkge1xuICAgIHZhciByY3B0XG5cbiAgICBpZiAodGhpcy5vcHRpb25zLmxtdHApIHtcbiAgICAgIC8vIExNVFAgcmV0dXJucyBhIHJlc3BvbnNlIGNvZGUgZm9yICpldmVyeSogc3VjY2Vzc2Z1bGx5IHNldCByZWNpcGllbnRcbiAgICAgIC8vIEZvciBldmVyeSByZWNpcGllbnQgdGhlIG1lc3NhZ2UgbWlnaHQgc3VjY2VlZCBvciBmYWlsIGluZGl2aWR1YWxseVxuXG4gICAgICByY3B0ID0gdGhpcy5fZW52ZWxvcGUucmVzcG9uc2VRdWV1ZS5zaGlmdCgpXG4gICAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdMb2NhbCBkZWxpdmVyeSB0byAnICsgcmNwdCArICcgZmFpbGVkLicpXG4gICAgICAgIHRoaXMuX2VudmVsb3BlLnJjcHRGYWlsZWQucHVzaChyY3B0KVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnTG9jYWwgZGVsaXZlcnkgdG8gJyArIHJjcHQgKyAnIHN1Y2NlZWRlZC4nKVxuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy5fZW52ZWxvcGUucmVzcG9uc2VRdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvblN0cmVhbVxuICAgICAgICByZXR1cm5cbiAgICAgIH1cblxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICAgIHRoaXMub25kb25lKHRydWUpXG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEZvciBTTVRQIHRoZSBtZXNzYWdlIGVpdGhlciBmYWlscyBvciBzdWNjZWVkcywgdGhlcmUgaXMgbm8gaW5mb3JtYXRpb25cbiAgICAgIC8vIGFib3V0IGluZGl2aWR1YWwgcmVjaXBpZW50c1xuXG4gICAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdNZXNzYWdlIHNlbmRpbmcgZmFpbGVkLicpXG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdNZXNzYWdlIHNlbnQgc3VjY2Vzc2Z1bGx5LicpXG4gICAgICB9XG5cbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgICB0aGlzLm9uZG9uZSghIWNvbW1hbmQuc3VjY2VzcylcbiAgICB9XG5cbiAgICAvLyBJZiB0aGUgY2xpZW50IHdhbnRlZCB0byBkbyBzb21ldGhpbmcgZWxzZSAoZWcuIHRvIHF1aXQpLCBkbyBub3QgZm9yY2UgaWRsZVxuICAgIGlmICh0aGlzLl9jdXJyZW50QWN0aW9uID09PSB0aGlzLl9hY3Rpb25JZGxlKSB7XG4gICAgICAvLyBXYWl0aW5nIGZvciBuZXcgY29ubmVjdGlvbnNcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0lkbGluZyB3aGlsZSB3YWl0aW5nIGZvciBuZXcgY29ubmVjdGlvbnMuLi4nKVxuICAgICAgdGhpcy5vbmlkbGUoKVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBCdWlsZHMgYSBsb2dpbiB0b2tlbiBmb3IgWE9BVVRIMiBhdXRoZW50aWNhdGlvbiBjb21tYW5kXG4gICAqXG4gICAqIEBwYXJhbSB7U3RyaW5nfSB1c2VyIEUtbWFpbCBhZGRyZXNzIG9mIHRoZSB1c2VyXG4gICAqIEBwYXJhbSB7U3RyaW5nfSB0b2tlbiBWYWxpZCBhY2Nlc3MgdG9rZW4gZm9yIHRoZSB1c2VyXG4gICAqIEByZXR1cm4ge1N0cmluZ30gQmFzZTY0IGZvcm1hdHRlZCBsb2dpbiB0b2tlblxuICAgKi9cbiAgX2J1aWxkWE9BdXRoMlRva2VuICh1c2VyLCB0b2tlbikge1xuICAgIHZhciBhdXRoRGF0YSA9IFtcbiAgICAgICd1c2VyPScgKyAodXNlciB8fCAnJyksXG4gICAgICAnYXV0aD1CZWFyZXIgJyArIHRva2VuLFxuICAgICAgJycsXG4gICAgICAnJ1xuICAgIF1cbiAgICAvLyBiYXNlNjQoXCJ1c2VyPXtVc2VyfVxceDAwYXV0aD1CZWFyZXIge1Rva2VufVxceDAwXFx4MDBcIilcbiAgICByZXR1cm4gZW5jb2RlKGF1dGhEYXRhLmpvaW4oJ1xceDAxJykpXG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgU210cENsaWVudFxuIl19