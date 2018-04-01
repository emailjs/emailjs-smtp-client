'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

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
}

//
// EVENTS
//

// Event functions should be overriden, these are just placeholders

/**
 * Will be run when an error occurs. Connection to the server will be closed automatically,
 * so wait for an `onclose` event as well.
 *
 * @param {Error} err Error object
 */
SmtpClient.prototype.onerror = function () {};

/**
 * More data can be buffered in the socket. See `waitDrain` property or
 * check if `send` method returns false to see if you should be waiting
 * for the drain event. Before sending anything else.
 */
SmtpClient.prototype.ondrain = function () {};

/**
 * The connection to the server has been closed
 */
SmtpClient.prototype.onclose = function () {};

/**
 * The connection is established and idle, you can send mail now
 */
SmtpClient.prototype.onidle = function () {};

/**
 * The connection is waiting for the mail body
 *
 * @param {Array} failedRecipients List of addresses that were not accepted as recipients
 */
SmtpClient.prototype.onready = function () {};

/**
 * The mail has been sent.
 * Wait for `onidle` next.
 *
 * @param {Boolean} success Indicates if the message was queued by the server or not
 */
SmtpClient.prototype.ondone = function () {};

//
// PUBLIC METHODS
//

// Connection related methods

/**
 * Initiate a connection to the server
 */
SmtpClient.prototype.connect = function () {
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
};

/**
 * Pauses `data` events from the downstream SMTP server
 */
SmtpClient.prototype.suspend = function () {
  if (this.socket && this.socket.readyState === 'open') {
    this.socket.suspend();
  }
};

/**
 * Resumes `data` events from the downstream SMTP server. Be careful of not
 * resuming something that is not suspended - an error is thrown in this case
 */
SmtpClient.prototype.resume = function () {
  if (this.socket && this.socket.readyState === 'open') {
    this.socket.resume();
  }
};

/**
 * Sends QUIT
 */
SmtpClient.prototype.quit = function () {
  this.logger.debug(DEBUG_TAG, 'Sending QUIT...');
  this._sendCommand('QUIT');
  this._currentAction = this.close;
};

/**
 * Reset authentication
 *
 * @param {Object} [auth] Use this if you want to authenticate as another user
 */
SmtpClient.prototype.reset = function (auth) {
  this.options.auth = auth || this.options.auth;
  this.logger.debug(DEBUG_TAG, 'Sending RSET...');
  this._sendCommand('RSET');
  this._currentAction = this._actionRSET;
};

/**
 * Closes the connection to the server
 */
SmtpClient.prototype.close = function () {
  this.logger.debug(DEBUG_TAG, 'Closing connection...');
  if (this.socket && this.socket.readyState === 'open') {
    this.socket.close();
  } else {
    this._destroy();
  }
};

// Mail related methods

/**
 * Initiates a new message by submitting envelope data, starting with
 * `MAIL FROM:` command. Use after `onidle` event
 *
 * @param {Object} envelope Envelope object in the form of {from:"...", to:["..."]}
 */
SmtpClient.prototype.useEnvelope = function (envelope) {
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
};

/**
 * Send ASCII data to the server. Works only in data mode (after `onready` event), ignored
 * otherwise
 *
 * @param {String} chunk ASCII string (quoted-printable, base64 etc.) to be sent to the server
 * @return {Boolean} If true, it is safe to send more data, if false, you *should* wait for the ondrain event before sending more
 */
SmtpClient.prototype.send = function (chunk) {
  // works only in data mode
  if (!this._dataMode) {
    // this line should never be reached but if it does,
    // act like everything's normal.
    return true;
  }

  // TODO: if the chunk is an arraybuffer, use a separate function to send the data
  return this._sendString(chunk);
};

/**
 * Indicates that a data stream for the socket is ended. Works only in data
 * mode (after `onready` event), ignored otherwise. Use it when you are done
 * with sending the mail. This method does not close the socket. Once the mail
 * has been queued by the server, `ondone` and `onidle` are emitted.
 *
 * @param {Buffer} [chunk] Chunk of data to be sent to the server
 */
SmtpClient.prototype.end = function (chunk) {
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
};

// PRIVATE METHODS

// EVENT HANDLERS FOR THE SOCKET

/**
 * Connection listener that is run when the connection to the server is opened.
 * Sets up different event handlers for the opened socket
 *
 * @event
 * @param {Event} evt Event object. Not used
 */
SmtpClient.prototype._onOpen = function (event) {
  if (event && event.data && event.data.proxyHostname) {
    this.options.name = event.data.proxyHostname;
  }

  this.socket.ondata = this._onData.bind(this);

  this.socket.onclose = this._onClose.bind(this);
  this.socket.ondrain = this._onDrain.bind(this);

  this._parser.ondata = this._onCommand.bind(this);

  this._currentAction = this._actionGreeting;
};

/**
 * Data listener for chunks of data emitted by the server
 *
 * @event
 * @param {Event} evt Event object. See `evt.data` for the chunk received
 */
SmtpClient.prototype._onData = function (evt) {
  clearTimeout(this._socketTimeoutTimer);
  var stringPayload = new _textEncoding.TextDecoder('UTF-8').decode(new Uint8Array(evt.data));
  this.logger.debug(DEBUG_TAG, 'SERVER: ' + stringPayload);
  this._parser.send(stringPayload);
};

/**
 * More data can be buffered in the socket, `waitDrain` is reset to false
 *
 * @event
 * @param {Event} evt Event object. Not used
 */
SmtpClient.prototype._onDrain = function () {
  this.waitDrain = false;
  this.ondrain();
};

/**
 * Error handler for the socket
 *
 * @event
 * @param {Event} evt Event object. See evt.data for the error
 */
SmtpClient.prototype._onError = function (evt) {
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
};

/**
 * Indicates that the socket has been closed
 *
 * @event
 * @param {Event} evt Event object. Not used
 */
SmtpClient.prototype._onClose = function () {
  this.logger.debug(DEBUG_TAG, 'Socket closed.');
  this._destroy();
};

/**
 * This is not a socket data handler but the handler for data emitted by the parser,
 * so this data is safe to use as it is always complete (server might send partial chunks)
 *
 * @event
 * @param {Object} command Parsed data
 */
SmtpClient.prototype._onCommand = function (command) {
  if (typeof this._currentAction === 'function') {
    this._currentAction(command);
  }
};

SmtpClient.prototype._onTimeout = function () {
  // inform about the timeout and shut down
  var error = new Error('Socket timed out!');
  this._onError(error);
};

/**
 * Ensures that the connection is closed and such
 */
SmtpClient.prototype._destroy = function () {
  clearTimeout(this._socketTimeoutTimer);

  if (!this.destroyed) {
    this.destroyed = true;
    this.onclose();
  }
};

/**
 * Sends a string to the socket.
 *
 * @param {String} chunk ASCII string (quoted-printable, base64 etc.) to be sent to the server
 * @return {Boolean} If true, it is safe to send more data, if false, you *should* wait for the ondrain event before sending more
 */
SmtpClient.prototype._sendString = function (chunk) {
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
};

/**
 * Send a string command to the server, also append \r\n if needed
 *
 * @param {String} str String to be sent to the server
 */
SmtpClient.prototype._sendCommand = function (str) {
  this.waitDrain = this._send(new _textEncoding.TextEncoder('UTF-8').encode(str + (str.substr(-2) !== '\r\n' ? '\r\n' : '')).buffer);
};

SmtpClient.prototype._send = function (buffer) {
  this._setTimeout(buffer.byteLength);
  return this.socket.send(buffer);
};

SmtpClient.prototype._setTimeout = function (byteLength) {
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
};

/**
 * Intitiate authentication sequence if needed
 */
SmtpClient.prototype._authenticateUser = function () {
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
};

// ACTIONS FOR RESPONSES FROM THE SMTP SERVER

/**
 * Initial response from the server, must have a status 220
 *
 * @param {Object} command Parsed command from the server {statusCode, data, line}
 */
SmtpClient.prototype._actionGreeting = function (command) {
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
};

/**
 * Response to LHLO
 *
 * @param {Object} command Parsed command from the server {statusCode, data, line}
 */
SmtpClient.prototype._actionLHLO = function (command) {
  if (!command.success) {
    this.logger.error(DEBUG_TAG, 'LHLO not successful');
    this._onError(new Error(command.data));
    return;
  }

  // Process as EHLO response
  this._actionEHLO(command);
};

/**
 * Response to EHLO. If the response is an error, try HELO instead
 *
 * @param {Object} command Parsed command from the server {statusCode, data, line}
 */
SmtpClient.prototype._actionEHLO = function (command) {
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
};

/**
 * Handles server response for STARTTLS command. If there's an error
 * try HELO instead, otherwise initiate TLS upgrade. If the upgrade
 * succeedes restart the EHLO
 *
 * @param {String} str Message from the server
 */
SmtpClient.prototype._actionSTARTTLS = function (command) {
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
};

/**
 * Response to HELO
 *
 * @param {Object} command Parsed command from the server {statusCode, data, line}
 */
SmtpClient.prototype._actionHELO = function (command) {
  if (!command.success) {
    this.logger.error(DEBUG_TAG, 'HELO not successful');
    this._onError(new Error(command.data));
    return;
  }
  this._authenticateUser();
};

/**
 * Response to AUTH LOGIN, if successful expects base64 encoded username
 *
 * @param {Object} command Parsed command from the server {statusCode, data, line}
 */
SmtpClient.prototype._actionAUTH_LOGIN_USER = function (command) {
  if (command.statusCode !== 334 || command.data !== 'VXNlcm5hbWU6') {
    this.logger.error(DEBUG_TAG, 'AUTH LOGIN USER not successful: ' + command.data);
    this._onError(new Error('Invalid login sequence while waiting for "334 VXNlcm5hbWU6 ": ' + command.data));
    return;
  }
  this.logger.debug(DEBUG_TAG, 'AUTH LOGIN USER successful');
  this._currentAction = this._actionAUTH_LOGIN_PASS;
  this._sendCommand((0, _emailjsBase.encode)(this.options.auth.user));
};

/**
 * Response to AUTH LOGIN username, if successful expects base64 encoded password
 *
 * @param {Object} command Parsed command from the server {statusCode, data, line}
 */
SmtpClient.prototype._actionAUTH_LOGIN_PASS = function (command) {
  if (command.statusCode !== 334 || command.data !== 'UGFzc3dvcmQ6') {
    this.logger.error(DEBUG_TAG, 'AUTH LOGIN PASS not successful: ' + command.data);
    this._onError(new Error('Invalid login sequence while waiting for "334 UGFzc3dvcmQ6 ": ' + command.data));
    return;
  }
  this.logger.debug(DEBUG_TAG, 'AUTH LOGIN PASS successful');
  this._currentAction = this._actionAUTHComplete;
  this._sendCommand((0, _emailjsBase.encode)(this.options.auth.pass));
};

/**
 * Response to AUTH XOAUTH2 token, if error occurs send empty response
 *
 * @param {Object} command Parsed command from the server {statusCode, data, line}
 */
SmtpClient.prototype._actionAUTH_XOAUTH2 = function (command) {
  if (!command.success) {
    this.logger.warn(DEBUG_TAG, 'Error during AUTH XOAUTH2, sending empty response');
    this._sendCommand('');
    this._currentAction = this._actionAUTHComplete;
  } else {
    this._actionAUTHComplete(command);
  }
};

/**
 * Checks if authentication succeeded or not. If successfully authenticated
 * emit `idle` to indicate that an e-mail can be sent using this connection
 *
 * @param {Object} command Parsed command from the server {statusCode, data, line}
 */
SmtpClient.prototype._actionAUTHComplete = function (command) {
  if (!command.success) {
    this.logger.debug(DEBUG_TAG, 'Authentication failed: ' + command.data);
    this._onError(new Error(command.data));
    return;
  }

  this.logger.debug(DEBUG_TAG, 'Authentication successful.');

  this._authenticatedAs = this.options.auth.user;

  this._currentAction = this._actionIdle;
  this.onidle(); // ready to take orders
};

/**
 * Used when the connection is idle and the server emits timeout
 *
 * @param {Object} command Parsed command from the server {statusCode, data, line}
 */
SmtpClient.prototype._actionIdle = function (command) {
  if (command.statusCode > 300) {
    this._onError(new Error(command.line));
    return;
  }

  this._onError(new Error(command.data));
};

/**
 * Response to MAIL FROM command. Proceed to defining RCPT TO list if successful
 *
 * @param {Object} command Parsed command from the server {statusCode, data, line}
 */
SmtpClient.prototype._actionMAIL = function (command) {
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
};

/**
 * Response to a RCPT TO command. If the command is unsuccessful, try the next one,
 * as this might be related only to the current recipient, not a global error, so
 * the following recipients might still be valid
 *
 * @param {Object} command Parsed command from the server {statusCode, data, line}
 */
SmtpClient.prototype._actionRCPT = function (command) {
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
};

/**
 * Response to the RSET command. If successful, clear the current authentication
 * information and reauthenticate.
 *
 * @param {Object} command Parsed command from the server {statusCode, data, line}
 */
SmtpClient.prototype._actionRSET = function (command) {
  if (!command.success) {
    this.logger.error(DEBUG_TAG, 'RSET unsuccessful ' + command.data);
    this._onError(new Error(command.data));
    return;
  }

  this._authenticatedAs = null;
  this._authenticateUser();
};

/**
 * Response to the DATA command. Server is now waiting for a message, so emit `onready`
 *
 * @param {Object} command Parsed command from the server {statusCode, data, line}
 */
SmtpClient.prototype._actionDATA = function (command) {
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
};

/**
 * Response from the server, once the message stream has ended with <CR><LF>.<CR><LF>
 * Emits `ondone`.
 *
 * @param {Object} command Parsed command from the server {statusCode, data, line}
 */
SmtpClient.prototype._actionStream = function (command) {
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
};

/**
 * Builds a login token for XOAUTH2 authentication command
 *
 * @param {String} user E-mail address of the user
 * @param {String} token Valid access token for the user
 * @return {String} Base64 formatted login token
 */
SmtpClient.prototype._buildXOAuth2Token = function (user, token) {
  var authData = ['user=' + (user || ''), 'auth=Bearer ' + token, '', ''];
  // base64("user={User}\x00auth=Bearer {Token}\x00\x00")
  return (0, _emailjsBase.encode)(authData.join('\x01'));
};

SmtpClient.prototype.createLogger = function () {
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
};

exports.default = SmtpClient;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9jbGllbnQuanMiXSwibmFtZXMiOlsiREVCVUdfVEFHIiwiVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkQiLCJUSU1FT1VUX1NPQ0tFVF9NVUxUSVBMSUVSIiwiU210cENsaWVudCIsImhvc3QiLCJwb3J0Iiwib3B0aW9ucyIsInRpbWVvdXRTb2NrZXRMb3dlckJvdW5kIiwidGltZW91dFNvY2tldE11bHRpcGxpZXIiLCJ1c2VTZWN1cmVUcmFuc3BvcnQiLCJhdXRoIiwibmFtZSIsInNvY2tldCIsImRlc3Ryb3llZCIsIndhaXREcmFpbiIsIl9wYXJzZXIiLCJfYXV0aGVudGljYXRlZEFzIiwiX3N1cHBvcnRlZEF1dGgiLCJfZGF0YU1vZGUiLCJfbGFzdERhdGFCeXRlcyIsIl9lbnZlbG9wZSIsIl9jdXJyZW50QWN0aW9uIiwiX3NlY3VyZU1vZGUiLCJfc29ja2V0VGltZW91dFRpbWVyIiwiX3NvY2tldFRpbWVvdXRTdGFydCIsIl9zb2NrZXRUaW1lb3V0UGVyaW9kIiwiY3JlYXRlTG9nZ2VyIiwicHJvdG90eXBlIiwib25lcnJvciIsIm9uZHJhaW4iLCJvbmNsb3NlIiwib25pZGxlIiwib25yZWFkeSIsIm9uZG9uZSIsImNvbm5lY3QiLCJTb2NrZXRDb250cnVjdG9yIiwib3BlbiIsImJpbmFyeVR5cGUiLCJjYSIsInRsc1dvcmtlclBhdGgiLCJ3cyIsIm9uY2VydCIsIkUiLCJfb25FcnJvciIsImJpbmQiLCJvbm9wZW4iLCJfb25PcGVuIiwic3VzcGVuZCIsInJlYWR5U3RhdGUiLCJyZXN1bWUiLCJxdWl0IiwibG9nZ2VyIiwiZGVidWciLCJfc2VuZENvbW1hbmQiLCJjbG9zZSIsInJlc2V0IiwiX2FjdGlvblJTRVQiLCJfZGVzdHJveSIsInVzZUVudmVsb3BlIiwiZW52ZWxvcGUiLCJmcm9tIiwiY29uY2F0IiwidG8iLCJyY3B0UXVldWUiLCJyY3B0RmFpbGVkIiwicmVzcG9uc2VRdWV1ZSIsIl9hY3Rpb25NQUlMIiwic2VuZCIsImNodW5rIiwiX3NlbmRTdHJpbmciLCJlbmQiLCJsZW5ndGgiLCJfYWN0aW9uU3RyZWFtIiwiX3NlbmQiLCJVaW50OEFycmF5IiwiYnVmZmVyIiwic3Vic3RyIiwiZXZlbnQiLCJkYXRhIiwicHJveHlIb3N0bmFtZSIsIm9uZGF0YSIsIl9vbkRhdGEiLCJfb25DbG9zZSIsIl9vbkRyYWluIiwiX29uQ29tbWFuZCIsIl9hY3Rpb25HcmVldGluZyIsImV2dCIsImNsZWFyVGltZW91dCIsInN0cmluZ1BheWxvYWQiLCJkZWNvZGUiLCJFcnJvciIsIm1lc3NhZ2UiLCJlcnJvciIsImNvbW1hbmQiLCJfb25UaW1lb3V0IiwiZGlzYWJsZUVzY2FwaW5nIiwicmVwbGFjZSIsImNoYXJBdCIsImVuY29kZSIsInN0ciIsIl9zZXRUaW1lb3V0IiwiYnl0ZUxlbmd0aCIsInByb2xvbmdQZXJpb2QiLCJNYXRoIiwiZmxvb3IiLCJ0aW1lb3V0Iiwibm93IiwiRGF0ZSIsInNldFRpbWVvdXQiLCJfYXV0aGVudGljYXRlVXNlciIsIl9hY3Rpb25JZGxlIiwiYXV0aE1ldGhvZCIsInhvYXV0aDIiLCJ0b1VwcGVyQ2FzZSIsInRyaW0iLCJfYWN0aW9uQVVUSF9MT0dJTl9VU0VSIiwiX2FjdGlvbkFVVEhDb21wbGV0ZSIsInVzZXIiLCJwYXNzIiwiX2FjdGlvbkFVVEhfWE9BVVRIMiIsIl9idWlsZFhPQXV0aDJUb2tlbiIsInN0YXR1c0NvZGUiLCJsbXRwIiwiX2FjdGlvbkxITE8iLCJfYWN0aW9uRUhMTyIsInN1Y2Nlc3MiLCJtYXRjaCIsInJlcXVpcmVUTFMiLCJlcnJNc2ciLCJ3YXJuIiwiX2FjdGlvbkhFTE8iLCJsaW5lIiwicHVzaCIsIk51bWJlciIsIm1heEFsbG93ZWRTaXplIiwiaWdub3JlVExTIiwiX2FjdGlvblNUQVJUVExTIiwidXBncmFkZVRvU2VjdXJlIiwiX2FjdGlvbkFVVEhfTE9HSU5fUEFTUyIsImN1clJlY2lwaWVudCIsInNoaWZ0IiwiX2FjdGlvblJDUFQiLCJfYWN0aW9uREFUQSIsImluZGV4T2YiLCJyY3B0IiwidG9rZW4iLCJhdXRoRGF0YSIsImpvaW4iLCJjcmVhdG9yIiwibG9nTGV2ZWwiLCJMT0dfTEVWRUxfQUxMIiwibXNncyIsImluZm8iXSwibWFwcGluZ3MiOiI7Ozs7OztBQUFBOztBQUNBOzs7O0FBQ0E7O0FBQ0E7Ozs7QUFDQTs7OztBQUNBOzs7O0FBT0EsSUFBSUEsWUFBWSxhQUFoQjs7QUFFQTs7O0FBR0EsSUFBTUMsNkJBQTZCLEtBQW5DOztBQUVBOzs7Ozs7O0FBT0EsSUFBTUMsNEJBQTRCLEdBQWxDOztBQUVBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFrQkEsU0FBU0MsVUFBVCxDQUFxQkMsSUFBckIsRUFBMkJDLElBQTNCLEVBQStDO0FBQUEsTUFBZEMsT0FBYyx1RUFBSixFQUFJOztBQUM3QyxPQUFLQyx1QkFBTCxHQUErQk4sMEJBQS9CO0FBQ0EsT0FBS08sdUJBQUwsR0FBK0JOLHlCQUEvQjs7QUFFQSxPQUFLRyxJQUFMLEdBQVlBLFNBQVMsS0FBS0MsT0FBTCxDQUFhRyxrQkFBYixHQUFrQyxHQUFsQyxHQUF3QyxFQUFqRCxDQUFaO0FBQ0EsT0FBS0wsSUFBTCxHQUFZQSxRQUFRLFdBQXBCOztBQUVBLE9BQUtFLE9BQUwsR0FBZUEsT0FBZjtBQUNBOzs7OztBQUtBLE9BQUtBLE9BQUwsQ0FBYUcsa0JBQWIsR0FBa0Msd0JBQXdCLEtBQUtILE9BQTdCLEdBQXVDLENBQUMsQ0FBQyxLQUFLQSxPQUFMLENBQWFHLGtCQUF0RCxHQUEyRSxLQUFLSixJQUFMLEtBQWMsR0FBM0g7O0FBRUEsT0FBS0MsT0FBTCxDQUFhSSxJQUFiLEdBQW9CLEtBQUtKLE9BQUwsQ0FBYUksSUFBYixJQUFxQixLQUF6QyxDQWY2QyxDQWVFO0FBQy9DLE9BQUtKLE9BQUwsQ0FBYUssSUFBYixHQUFvQixLQUFLTCxPQUFMLENBQWFLLElBQWIsSUFBcUIsV0FBekMsQ0FoQjZDLENBZ0JRO0FBQ3JELE9BQUtDLE1BQUwsR0FBYyxLQUFkLENBakI2QyxDQWlCekI7QUFDcEIsT0FBS0MsU0FBTCxHQUFpQixLQUFqQixDQWxC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SSwyQkFBbUIsTUFBS0YsUUFBNUIsRUFBc0M7QUFBRWxHLGVBQU9DLEtBQVAsQ0FBYW1HLElBQWI7QUFBb0I7QUFBRSxLQUR4RTtBQUVaQyxVQUFNLGdCQUFhO0FBQUEseUNBQVRELElBQVM7QUFBVEEsWUFBUztBQUFBOztBQUFFLFVBQUksMEJBQWtCLE1BQUtGLFFBQTNCLEVBQXFDO0FBQUVsRyxlQUFPcUcsSUFBUCxDQUFZRCxJQUFaO0FBQW1CO0FBQUUsS0FGckU7QUFHWnRCLFVBQU0sZ0JBQWE7QUFBQSx5Q0FBVHNCLElBQVM7QUFBVEEsWUFBUztBQUFBOztBQUFFLFVBQUksMEJBQWtCLE1BQUtGLFFBQTNCLEVBQXFDO0FBQUVsRyxlQUFPOEUsSUFBUCxDQUFZc0IsSUFBWjtBQUFtQjtBQUFFLEtBSHJFO0FBSVozRCxXQUFPLGlCQUFhO0FBQUEseUNBQVQyRCxJQUFTO0FBQVRBLFlBQVM7QUFBQTs7QUFBRSxVQUFJLDJCQUFtQixNQUFLRixRQUE1QixFQUFzQztBQUFFbEcsZUFBT3lDLEtBQVAsQ0FBYTJELElBQWI7QUFBb0I7QUFBRTtBQUp4RSxHQUFkO0FBTUQsQ0FURDs7a0JBV2VwSixVIiwiZmlsZSI6ImNsaWVudC5qcyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGVuY29kZSB9IGZyb20gJ2VtYWlsanMtYmFzZTY0J1xuaW1wb3J0IFRDUFNvY2tldCBmcm9tICdlbWFpbGpzLXRjcC1zb2NrZXQnXG5pbXBvcnQgeyBUZXh0RGVjb2RlciwgVGV4dEVuY29kZXIgfSBmcm9tICd0ZXh0LWVuY29kaW5nJ1xuaW1wb3J0IFNtdHBDbGllbnRSZXNwb25zZVBhcnNlciBmcm9tICcuL3BhcnNlcidcbmltcG9ydCBjcmVhdGVEZWZhdWx0TG9nZ2VyIGZyb20gJy4vbG9nZ2VyJ1xuaW1wb3J0IHtcbiAgTE9HX0xFVkVMX0VSUk9SLFxuICBMT0dfTEVWRUxfV0FSTixcbiAgTE9HX0xFVkVMX0lORk8sXG4gIExPR19MRVZFTF9ERUJVR1xufSBmcm9tICcuL2NvbW1vbidcblxudmFyIERFQlVHX1RBRyA9ICdTTVRQIENsaWVudCdcblxuLyoqXG4gKiBMb3dlciBCb3VuZCBmb3Igc29ja2V0IHRpbWVvdXQgdG8gd2FpdCBzaW5jZSB0aGUgbGFzdCBkYXRhIHdhcyB3cml0dGVuIHRvIGEgc29ja2V0XG4gKi9cbmNvbnN0IFRJTUVPVVRfU09DS0VUX0xPV0VSX0JPVU5EID0gMTAwMDBcblxuLyoqXG4gKiBNdWx0aXBsaWVyIGZvciBzb2NrZXQgdGltZW91dDpcbiAqXG4gKiBXZSBhc3N1bWUgYXQgbGVhc3QgYSBHUFJTIGNvbm5lY3Rpb24gd2l0aCAxMTUga2IvcyA9IDE0LDM3NSBrQi9zIHRvcHMsIHNvIDEwIEtCL3MgdG8gYmUgb25cbiAqIHRoZSBzYWZlIHNpZGUuIFdlIGNhbiB0aW1lb3V0IGFmdGVyIGEgbG93ZXIgYm91bmQgb2YgMTBzICsgKG4gS0IgLyAxMCBLQi9zKS4gQSAxIE1CIG1lc3NhZ2VcbiAqIHVwbG9hZCB3b3VsZCBiZSAxMTAgc2Vjb25kcyB0byB3YWl0IGZvciB0aGUgdGltZW91dC4gMTAgS0IvcyA9PT0gMC4xIHMvQlxuICovXG5jb25zdCBUSU1FT1VUX1NPQ0tFVF9NVUxUSVBMSUVSID0gMC4xXG5cbi8qKlxuICogQ3JlYXRlcyBhIGNvbm5lY3Rpb24gb2JqZWN0IHRvIGEgU01UUCBzZXJ2ZXIgYW5kIGFsbG93cyB0byBzZW5kIG1haWwgdGhyb3VnaCBpdC5cbiAqIENhbGwgYGNvbm5lY3RgIG1ldGhvZCB0byBpbml0aXRhdGUgdGhlIGFjdHVhbCBjb25uZWN0aW9uLCB0aGUgY29uc3RydWN0b3Igb25seVxuICogZGVmaW5lcyB0aGUgcHJvcGVydGllcyBidXQgZG9lcyBub3QgYWN0dWFsbHkgY29ubmVjdC5cbiAqXG4gKiBOQiEgVGhlIHBhcmFtZXRlciBvcmRlciAoaG9zdCwgcG9ydCkgZGlmZmVycyBmcm9tIG5vZGUuanMgXCJ3YXlcIiAocG9ydCwgaG9zdClcbiAqXG4gKiBAY29uc3RydWN0b3JcbiAqXG4gKiBAcGFyYW0ge1N0cmluZ30gW2hvc3Q9XCJsb2NhbGhvc3RcIl0gSG9zdG5hbWUgdG8gY29uZW5jdCB0b1xuICogQHBhcmFtIHtOdW1iZXJ9IFtwb3J0PTI1XSBQb3J0IG51bWJlciB0byBjb25uZWN0IHRvXG4gKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdIE9wdGlvbmFsIG9wdGlvbnMgb2JqZWN0XG4gKiBAcGFyYW0ge0Jvb2xlYW59IFtvcHRpb25zLnVzZVNlY3VyZVRyYW5zcG9ydF0gU2V0IHRvIHRydWUsIHRvIHVzZSBlbmNyeXB0ZWQgY29ubmVjdGlvblxuICogQHBhcmFtIHtTdHJpbmd9IFtvcHRpb25zLm5hbWVdIENsaWVudCBob3N0bmFtZSBmb3IgaW50cm9kdWNpbmcgaXRzZWxmIHRvIHRoZSBzZXJ2ZXJcbiAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9ucy5hdXRoXSBBdXRoZW50aWNhdGlvbiBvcHRpb25zLiBEZXBlbmRzIG9uIHRoZSBwcmVmZXJyZWQgYXV0aGVudGljYXRpb24gbWV0aG9kLiBVc3VhbGx5IHt1c2VyLCBwYXNzfVxuICogQHBhcmFtIHtTdHJpbmd9IFtvcHRpb25zLmF1dGhNZXRob2RdIEZvcmNlIHNwZWNpZmljIGF1dGhlbnRpY2F0aW9uIG1ldGhvZFxuICogQHBhcmFtIHtCb29sZWFufSBbb3B0aW9ucy5kaXNhYmxlRXNjYXBpbmddIElmIHNldCB0byB0cnVlLCBkbyBub3QgZXNjYXBlIGRvdHMgb24gdGhlIGJlZ2lubmluZyBvZiB0aGUgbGluZXNcbiAqL1xuZnVuY3Rpb24gU210cENsaWVudCAoaG9zdCwgcG9ydCwgb3B0aW9ucyA9IHt9KSB7XG4gIHRoaXMudGltZW91dFNvY2tldExvd2VyQm91bmQgPSBUSU1FT1VUX1NPQ0tFVF9MT1dFUl9CT1VORFxuICB0aGlzLnRpbWVvdXRTb2NrZXRNdWx0aXBsaWVyID0gVElNRU9VVF9TT0NLRVRfTVVMVElQTElFUlxuXG4gIHRoaXMucG9ydCA9IHBvcnQgfHwgKHRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnQgPyA0NjUgOiAyNSlcbiAgdGhpcy5ob3N0ID0gaG9zdCB8fCAnbG9jYWxob3N0J1xuXG4gIHRoaXMub3B0aW9ucyA9IG9wdGlvbnNcbiAgLyoqXG4gICAqIElmIHNldCB0byB0cnVlLCBzdGFydCBhbiBlbmNyeXB0ZWQgY29ubmVjdGlvbiBpbnN0ZWFkIG9mIHRoZSBwbGFpbnRleHQgb25lXG4gICAqIChyZWNvbW1lbmRlZCBpZiBhcHBsaWNhYmxlKS4gSWYgdXNlU2VjdXJlVHJhbnNwb3J0IGlzIG5vdCBzZXQgYnV0IHRoZSBwb3J0IHVzZWQgaXMgNDY1LFxuICAgKiB0aGVuIGVjcnlwdGlvbiBpcyB1c2VkIGJ5IGRlZmF1bHQuXG4gICAqL1xuICB0aGlzLm9wdGlvbnMudXNlU2VjdXJlVHJhbnNwb3J0ID0gJ3VzZVNlY3VyZVRyYW5zcG9ydCcgaW4gdGhpcy5vcHRpb25zID8gISF0aGlzLm9wdGlvbnMudXNlU2VjdXJlVHJhbnNwb3J0IDogdGhpcy5wb3J0ID09PSA0NjVcblxuICB0aGlzLm9wdGlvbnMuYXV0aCA9IHRoaXMub3B0aW9ucy5hdXRoIHx8IGZhbHNlIC8vIEF1dGhlbnRpY2F0aW9uIG9iamVjdC4gSWYgbm90IHNldCwgYXV0aGVudGljYXRpb24gc3RlcCB3aWxsIGJlIHNraXBwZWQuXG4gIHRoaXMub3B0aW9ucy5uYW1lID0gdGhpcy5vcHRpb25zLm5hbWUgfHwgJ2xvY2FsaG9zdCcgLy8gSG9zdG5hbWUgb2YgdGhlIGNsaWVudCwgdGhpcyB3aWxsIGJlIHVzZWQgZm9yIGludHJvZHVjaW5nIHRvIHRoZSBzZXJ2ZXJcbiAgdGhpcy5zb2NrZXQgPSBmYWxzZSAvLyBEb3duc3RyZWFtIFRDUCBzb2NrZXQgdG8gdGhlIFNNVFAgc2VydmVyLCBjcmVhdGVkIHdpdGggbW96VENQU29ja2V0XG4gIHRoaXMuZGVzdHJveWVkID0gZmFsc2UgLy8gSW5kaWNhdGVzIGlmIHRoZSBjb25uZWN0aW9uIGhhcyBiZWVuIGNsb3NlZCBhbmQgY2FuJ3QgYmUgdXNlZCBhbnltb3JlXG4gIHRoaXMud2FpdERyYWluID0gZmFsc2UgLy8gS2VlcHMgdHJhY2sgaWYgdGhlIGRvd25zdHJlYW0gc29ja2V0IGlzIGN1cnJlbnRseSBmdWxsIGFuZCBhIGRyYWluIGV2ZW50IHNob3VsZCBiZSB3YWl0ZWQgZm9yIG9yIG5vdFxuXG4gIC8vIFByaXZhdGUgcHJvcGVydGllc1xuXG4gIHRoaXMuX3BhcnNlciA9IG5ldyBTbXRwQ2xpZW50UmVzcG9uc2VQYXJzZXIoKSAvLyBTTVRQIHJlc3BvbnNlIHBhcnNlciBvYmplY3QuIEFsbCBkYXRhIGNvbWluZyBmcm9tIHRoZSBkb3duc3RyZWFtIHNlcnZlciBpcyBmZWVkZWQgdG8gdGhpcyBwYXJzZXJcbiAgdGhpcy5fYXV0aGVudGljYXRlZEFzID0gbnVsbCAvLyBJZiBhdXRoZW50aWNhdGVkIHN1Y2Nlc3NmdWxseSwgc3RvcmVzIHRoZSB1c2VybmFtZVxuICB0aGlzLl9zdXBwb3J0ZWRBdXRoID0gW10gLy8gQSBsaXN0IG9mIGF1dGhlbnRpY2F0aW9uIG1lY2hhbmlzbXMgZGV0ZWN0ZWQgZnJvbSB0aGUgRUhMTyByZXNwb25zZSBhbmQgd2hpY2ggYXJlIGNvbXBhdGlibGUgd2l0aCB0aGlzIGxpYnJhcnlcbiAgdGhpcy5fZGF0YU1vZGUgPSBmYWxzZSAvLyBJZiB0cnVlLCBhY2NlcHRzIGRhdGEgZnJvbSB0aGUgdXBzdHJlYW0gdG8gYmUgcGFzc2VkIGRpcmVjdGx5IHRvIHRoZSBkb3duc3RyZWFtIHNvY2tldC4gVXNlZCBhZnRlciB0aGUgREFUQSBjb21tYW5kXG4gIHRoaXMuX2xhc3REYXRhQnl0ZXMgPSAnJyAvLyBLZWVwIHRyYWNrIG9mIHRoZSBsYXN0IGJ5dGVzIHRvIHNlZSBob3cgdGhlIHRlcm1pbmF0aW5nIGRvdCBzaG91bGQgYmUgcGxhY2VkXG4gIHRoaXMuX2VudmVsb3BlID0gbnVsbCAvLyBFbnZlbG9wZSBvYmplY3QgZm9yIHRyYWNraW5nIHdobyBpcyBzZW5kaW5nIG1haWwgdG8gd2hvbVxuICB0aGlzLl9jdXJyZW50QWN0aW9uID0gbnVsbCAvLyBTdG9yZXMgdGhlIGZ1bmN0aW9uIHRoYXQgc2hvdWxkIGJlIHJ1biBhZnRlciBhIHJlc3BvbnNlIGhhcyBiZWVuIHJlY2VpdmVkIGZyb20gdGhlIHNlcnZlclxuICB0aGlzLl9zZWN1cmVNb2RlID0gISF0aGlzLm9wdGlvbnMudXNlU2VjdXJlVHJhbnNwb3J0IC8vIEluZGljYXRlcyBpZiB0aGUgY29ubmVjdGlvbiBpcyBzZWN1cmVkIG9yIHBsYWludGV4dFxuICB0aGlzLl9zb2NrZXRUaW1lb3V0VGltZXIgPSBmYWxzZSAvLyBUaW1lciB3YWl0aW5nIHRvIGRlY2xhcmUgdGhlIHNvY2tldCBkZWFkIHN0YXJ0aW5nIGZyb20gdGhlIGxhc3Qgd3JpdGVcbiAgdGhpcy5fc29ja2V0VGltZW91dFN0YXJ0ID0gZmFsc2UgLy8gU3RhcnQgdGltZSBvZiBzZW5kaW5nIHRoZSBmaXJzdCBwYWNrZXQgaW4gZGF0YSBtb2RlXG4gIHRoaXMuX3NvY2tldFRpbWVvdXRQZXJpb2QgPSBmYWxzZSAvLyBUaW1lb3V0IGZvciBzZW5kaW5nIGluIGRhdGEgbW9kZSwgZ2V0cyBleHRlbmRlZCB3aXRoIGV2ZXJ5IHNlbmQoKVxuXG4gIC8vIEFjdGl2YXRlIGxvZ2dpbmdcbiAgdGhpcy5jcmVhdGVMb2dnZXIoKVxufVxuXG4vL1xuLy8gRVZFTlRTXG4vL1xuXG4vLyBFdmVudCBmdW5jdGlvbnMgc2hvdWxkIGJlIG92ZXJyaWRlbiwgdGhlc2UgYXJlIGp1c3QgcGxhY2Vob2xkZXJzXG5cbi8qKlxuICogV2lsbCBiZSBydW4gd2hlbiBhbiBlcnJvciBvY2N1cnMuIENvbm5lY3Rpb24gdG8gdGhlIHNlcnZlciB3aWxsIGJlIGNsb3NlZCBhdXRvbWF0aWNhbGx5LFxuICogc28gd2FpdCBmb3IgYW4gYG9uY2xvc2VgIGV2ZW50IGFzIHdlbGwuXG4gKlxuICogQHBhcmFtIHtFcnJvcn0gZXJyIEVycm9yIG9iamVjdFxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5vbmVycm9yID0gZnVuY3Rpb24gKCkgeyB9XG5cbi8qKlxuICogTW9yZSBkYXRhIGNhbiBiZSBidWZmZXJlZCBpbiB0aGUgc29ja2V0LiBTZWUgYHdhaXREcmFpbmAgcHJvcGVydHkgb3JcbiAqIGNoZWNrIGlmIGBzZW5kYCBtZXRob2QgcmV0dXJucyBmYWxzZSB0byBzZWUgaWYgeW91IHNob3VsZCBiZSB3YWl0aW5nXG4gKiBmb3IgdGhlIGRyYWluIGV2ZW50LiBCZWZvcmUgc2VuZGluZyBhbnl0aGluZyBlbHNlLlxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5vbmRyYWluID0gZnVuY3Rpb24gKCkgeyB9XG5cbi8qKlxuICogVGhlIGNvbm5lY3Rpb24gdG8gdGhlIHNlcnZlciBoYXMgYmVlbiBjbG9zZWRcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUub25jbG9zZSA9IGZ1bmN0aW9uICgpIHsgfVxuXG4vKipcbiAqIFRoZSBjb25uZWN0aW9uIGlzIGVzdGFibGlzaGVkIGFuZCBpZGxlLCB5b3UgY2FuIHNlbmQgbWFpbCBub3dcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUub25pZGxlID0gZnVuY3Rpb24gKCkgeyB9XG5cbi8qKlxuICogVGhlIGNvbm5lY3Rpb24gaXMgd2FpdGluZyBmb3IgdGhlIG1haWwgYm9keVxuICpcbiAqIEBwYXJhbSB7QXJyYXl9IGZhaWxlZFJlY2lwaWVudHMgTGlzdCBvZiBhZGRyZXNzZXMgdGhhdCB3ZXJlIG5vdCBhY2NlcHRlZCBhcyByZWNpcGllbnRzXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLm9ucmVhZHkgPSBmdW5jdGlvbiAoKSB7IH1cblxuLyoqXG4gKiBUaGUgbWFpbCBoYXMgYmVlbiBzZW50LlxuICogV2FpdCBmb3IgYG9uaWRsZWAgbmV4dC5cbiAqXG4gKiBAcGFyYW0ge0Jvb2xlYW59IHN1Y2Nlc3MgSW5kaWNhdGVzIGlmIHRoZSBtZXNzYWdlIHdhcyBxdWV1ZWQgYnkgdGhlIHNlcnZlciBvciBub3RcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUub25kb25lID0gZnVuY3Rpb24gKCkgeyB9XG5cbi8vXG4vLyBQVUJMSUMgTUVUSE9EU1xuLy9cblxuLy8gQ29ubmVjdGlvbiByZWxhdGVkIG1ldGhvZHNcblxuLyoqXG4gKiBJbml0aWF0ZSBhIGNvbm5lY3Rpb24gdG8gdGhlIHNlcnZlclxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5jb25uZWN0ID0gZnVuY3Rpb24gKFNvY2tldENvbnRydWN0b3IgPSBUQ1BTb2NrZXQpIHtcbiAgdGhpcy5zb2NrZXQgPSBTb2NrZXRDb250cnVjdG9yLm9wZW4odGhpcy5ob3N0LCB0aGlzLnBvcnQsIHtcbiAgICBiaW5hcnlUeXBlOiAnYXJyYXlidWZmZXInLFxuICAgIHVzZVNlY3VyZVRyYW5zcG9ydDogdGhpcy5fc2VjdXJlTW9kZSxcbiAgICBjYTogdGhpcy5vcHRpb25zLmNhLFxuICAgIHRsc1dvcmtlclBhdGg6IHRoaXMub3B0aW9ucy50bHNXb3JrZXJQYXRoLFxuICAgIHdzOiB0aGlzLm9wdGlvbnMud3NcbiAgfSlcblxuICAvLyBhbGxvd3MgY2VydGlmaWNhdGUgaGFuZGxpbmcgZm9yIHBsYXRmb3JtIHcvbyBuYXRpdmUgdGxzIHN1cHBvcnRcbiAgLy8gb25jZXJ0IGlzIG5vbiBzdGFuZGFyZCBzbyBzZXR0aW5nIGl0IG1pZ2h0IHRocm93IGlmIHRoZSBzb2NrZXQgb2JqZWN0IGlzIGltbXV0YWJsZVxuICB0cnkge1xuICAgIHRoaXMuc29ja2V0Lm9uY2VydCA9IHRoaXMub25jZXJ0XG4gIH0gY2F0Y2ggKEUpIHsgfVxuICB0aGlzLnNvY2tldC5vbmVycm9yID0gdGhpcy5fb25FcnJvci5iaW5kKHRoaXMpXG4gIHRoaXMuc29ja2V0Lm9ub3BlbiA9IHRoaXMuX29uT3Blbi5iaW5kKHRoaXMpXG59XG5cbi8qKlxuICogUGF1c2VzIGBkYXRhYCBldmVudHMgZnJvbSB0aGUgZG93bnN0cmVhbSBTTVRQIHNlcnZlclxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5zdXNwZW5kID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5zb2NrZXQgJiYgdGhpcy5zb2NrZXQucmVhZHlTdGF0ZSA9PT0gJ29wZW4nKSB7XG4gICAgdGhpcy5zb2NrZXQuc3VzcGVuZCgpXG4gIH1cbn1cblxuLyoqXG4gKiBSZXN1bWVzIGBkYXRhYCBldmVudHMgZnJvbSB0aGUgZG93bnN0cmVhbSBTTVRQIHNlcnZlci4gQmUgY2FyZWZ1bCBvZiBub3RcbiAqIHJlc3VtaW5nIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBzdXNwZW5kZWQgLSBhbiBlcnJvciBpcyB0aHJvd24gaW4gdGhpcyBjYXNlXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLnJlc3VtZSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuc29ja2V0ICYmIHRoaXMuc29ja2V0LnJlYWR5U3RhdGUgPT09ICdvcGVuJykge1xuICAgIHRoaXMuc29ja2V0LnJlc3VtZSgpXG4gIH1cbn1cblxuLyoqXG4gKiBTZW5kcyBRVUlUXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLnF1aXQgPSBmdW5jdGlvbiAoKSB7XG4gIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgUVVJVC4uLicpXG4gIHRoaXMuX3NlbmRDb21tYW5kKCdRVUlUJylcbiAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuY2xvc2Vcbn1cblxuLyoqXG4gKiBSZXNldCBhdXRoZW50aWNhdGlvblxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBbYXV0aF0gVXNlIHRoaXMgaWYgeW91IHdhbnQgdG8gYXV0aGVudGljYXRlIGFzIGFub3RoZXIgdXNlclxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5yZXNldCA9IGZ1bmN0aW9uIChhdXRoKSB7XG4gIHRoaXMub3B0aW9ucy5hdXRoID0gYXV0aCB8fCB0aGlzLm9wdGlvbnMuYXV0aFxuICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIFJTRVQuLi4nKVxuICB0aGlzLl9zZW5kQ29tbWFuZCgnUlNFVCcpXG4gIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25SU0VUXG59XG5cbi8qKlxuICogQ2xvc2VzIHRoZSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXJcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuY2xvc2UgPSBmdW5jdGlvbiAoKSB7XG4gIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0Nsb3NpbmcgY29ubmVjdGlvbi4uLicpXG4gIGlmICh0aGlzLnNvY2tldCAmJiB0aGlzLnNvY2tldC5yZWFkeVN0YXRlID09PSAnb3BlbicpIHtcbiAgICB0aGlzLnNvY2tldC5jbG9zZSgpXG4gIH0gZWxzZSB7XG4gICAgdGhpcy5fZGVzdHJveSgpXG4gIH1cbn1cblxuLy8gTWFpbCByZWxhdGVkIG1ldGhvZHNcblxuLyoqXG4gKiBJbml0aWF0ZXMgYSBuZXcgbWVzc2FnZSBieSBzdWJtaXR0aW5nIGVudmVsb3BlIGRhdGEsIHN0YXJ0aW5nIHdpdGhcbiAqIGBNQUlMIEZST006YCBjb21tYW5kLiBVc2UgYWZ0ZXIgYG9uaWRsZWAgZXZlbnRcbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gZW52ZWxvcGUgRW52ZWxvcGUgb2JqZWN0IGluIHRoZSBmb3JtIG9mIHtmcm9tOlwiLi4uXCIsIHRvOltcIi4uLlwiXX1cbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUudXNlRW52ZWxvcGUgPSBmdW5jdGlvbiAoZW52ZWxvcGUpIHtcbiAgdGhpcy5fZW52ZWxvcGUgPSBlbnZlbG9wZSB8fCB7fVxuICB0aGlzLl9lbnZlbG9wZS5mcm9tID0gW10uY29uY2F0KHRoaXMuX2VudmVsb3BlLmZyb20gfHwgKCdhbm9ueW1vdXNAJyArIHRoaXMub3B0aW9ucy5uYW1lKSlbMF1cbiAgdGhpcy5fZW52ZWxvcGUudG8gPSBbXS5jb25jYXQodGhpcy5fZW52ZWxvcGUudG8gfHwgW10pXG5cbiAgLy8gY2xvbmUgdGhlIHJlY2lwaWVudHMgYXJyYXkgZm9yIGxhdHRlciBtYW5pcHVsYXRpb25cbiAgdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlID0gW10uY29uY2F0KHRoaXMuX2VudmVsb3BlLnRvKVxuICB0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkID0gW11cbiAgdGhpcy5fZW52ZWxvcGUucmVzcG9uc2VRdWV1ZSA9IFtdXG5cbiAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbk1BSUxcbiAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBNQUlMIEZST00uLi4nKVxuICB0aGlzLl9zZW5kQ29tbWFuZCgnTUFJTCBGUk9NOjwnICsgKHRoaXMuX2VudmVsb3BlLmZyb20pICsgJz4nKVxufVxuXG4vKipcbiAqIFNlbmQgQVNDSUkgZGF0YSB0byB0aGUgc2VydmVyLiBXb3JrcyBvbmx5IGluIGRhdGEgbW9kZSAoYWZ0ZXIgYG9ucmVhZHlgIGV2ZW50KSwgaWdub3JlZFxuICogb3RoZXJ3aXNlXG4gKlxuICogQHBhcmFtIHtTdHJpbmd9IGNodW5rIEFTQ0lJIHN0cmluZyAocXVvdGVkLXByaW50YWJsZSwgYmFzZTY0IGV0Yy4pIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICogQHJldHVybiB7Qm9vbGVhbn0gSWYgdHJ1ZSwgaXQgaXMgc2FmZSB0byBzZW5kIG1vcmUgZGF0YSwgaWYgZmFsc2UsIHlvdSAqc2hvdWxkKiB3YWl0IGZvciB0aGUgb25kcmFpbiBldmVudCBiZWZvcmUgc2VuZGluZyBtb3JlXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLnNlbmQgPSBmdW5jdGlvbiAoY2h1bmspIHtcbiAgLy8gd29ya3Mgb25seSBpbiBkYXRhIG1vZGVcbiAgaWYgKCF0aGlzLl9kYXRhTW9kZSkge1xuICAgIC8vIHRoaXMgbGluZSBzaG91bGQgbmV2ZXIgYmUgcmVhY2hlZCBidXQgaWYgaXQgZG9lcyxcbiAgICAvLyBhY3QgbGlrZSBldmVyeXRoaW5nJ3Mgbm9ybWFsLlxuICAgIHJldHVybiB0cnVlXG4gIH1cblxuICAvLyBUT0RPOiBpZiB0aGUgY2h1bmsgaXMgYW4gYXJyYXlidWZmZXIsIHVzZSBhIHNlcGFyYXRlIGZ1bmN0aW9uIHRvIHNlbmQgdGhlIGRhdGFcbiAgcmV0dXJuIHRoaXMuX3NlbmRTdHJpbmcoY2h1bmspXG59XG5cbi8qKlxuICogSW5kaWNhdGVzIHRoYXQgYSBkYXRhIHN0cmVhbSBmb3IgdGhlIHNvY2tldCBpcyBlbmRlZC4gV29ya3Mgb25seSBpbiBkYXRhXG4gKiBtb2RlIChhZnRlciBgb25yZWFkeWAgZXZlbnQpLCBpZ25vcmVkIG90aGVyd2lzZS4gVXNlIGl0IHdoZW4geW91IGFyZSBkb25lXG4gKiB3aXRoIHNlbmRpbmcgdGhlIG1haWwuIFRoaXMgbWV0aG9kIGRvZXMgbm90IGNsb3NlIHRoZSBzb2NrZXQuIE9uY2UgdGhlIG1haWxcbiAqIGhhcyBiZWVuIHF1ZXVlZCBieSB0aGUgc2VydmVyLCBgb25kb25lYCBhbmQgYG9uaWRsZWAgYXJlIGVtaXR0ZWQuXG4gKlxuICogQHBhcmFtIHtCdWZmZXJ9IFtjaHVua10gQ2h1bmsgb2YgZGF0YSB0byBiZSBzZW50IHRvIHRoZSBzZXJ2ZXJcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuZW5kID0gZnVuY3Rpb24gKGNodW5rKSB7XG4gIC8vIHdvcmtzIG9ubHkgaW4gZGF0YSBtb2RlXG4gIGlmICghdGhpcy5fZGF0YU1vZGUpIHtcbiAgICAvLyB0aGlzIGxpbmUgc2hvdWxkIG5ldmVyIGJlIHJlYWNoZWQgYnV0IGlmIGl0IGRvZXMsXG4gICAgLy8gYWN0IGxpa2UgZXZlcnl0aGluZydzIG5vcm1hbC5cbiAgICByZXR1cm4gdHJ1ZVxuICB9XG5cbiAgaWYgKGNodW5rICYmIGNodW5rLmxlbmd0aCkge1xuICAgIHRoaXMuc2VuZChjaHVuaylcbiAgfVxuXG4gIC8vIHJlZGlyZWN0IG91dHB1dCBmcm9tIHRoZSBzZXJ2ZXIgdG8gX2FjdGlvblN0cmVhbVxuICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uU3RyZWFtXG5cbiAgLy8gaW5kaWNhdGUgdGhhdCB0aGUgc3RyZWFtIGhhcyBlbmRlZCBieSBzZW5kaW5nIGEgc2luZ2xlIGRvdCBvbiBpdHMgb3duIGxpbmVcbiAgLy8gaWYgdGhlIGNsaWVudCBhbHJlYWR5IGNsb3NlZCB0aGUgZGF0YSB3aXRoIFxcclxcbiBubyBuZWVkIHRvIGRvIGl0IGFnYWluXG4gIGlmICh0aGlzLl9sYXN0RGF0YUJ5dGVzID09PSAnXFxyXFxuJykge1xuICAgIHRoaXMud2FpdERyYWluID0gdGhpcy5fc2VuZChuZXcgVWludDhBcnJheShbMHgyRSwgMHgwRCwgMHgwQV0pLmJ1ZmZlcikgLy8gLlxcclxcblxuICB9IGVsc2UgaWYgKHRoaXMuX2xhc3REYXRhQnl0ZXMuc3Vic3RyKC0xKSA9PT0gJ1xccicpIHtcbiAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFVpbnQ4QXJyYXkoWzB4MEEsIDB4MkUsIDB4MEQsIDB4MEFdKS5idWZmZXIpIC8vIFxcbi5cXHJcXG5cbiAgfSBlbHNlIHtcbiAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFVpbnQ4QXJyYXkoWzB4MEQsIDB4MEEsIDB4MkUsIDB4MEQsIDB4MEFdKS5idWZmZXIpIC8vIFxcclxcbi5cXHJcXG5cbiAgfVxuXG4gIC8vIGVuZCBkYXRhIG1vZGUsIHJlc2V0IHRoZSB2YXJpYWJsZXMgZm9yIGV4dGVuZGluZyB0aGUgdGltZW91dCBpbiBkYXRhIG1vZGVcbiAgdGhpcy5fZGF0YU1vZGUgPSBmYWxzZVxuICB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgPSBmYWxzZVxuICB0aGlzLl9zb2NrZXRUaW1lb3V0UGVyaW9kID0gZmFsc2VcblxuICByZXR1cm4gdGhpcy53YWl0RHJhaW5cbn1cblxuLy8gUFJJVkFURSBNRVRIT0RTXG5cbi8vIEVWRU5UIEhBTkRMRVJTIEZPUiBUSEUgU09DS0VUXG5cbi8qKlxuICogQ29ubmVjdGlvbiBsaXN0ZW5lciB0aGF0IGlzIHJ1biB3aGVuIHRoZSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXIgaXMgb3BlbmVkLlxuICogU2V0cyB1cCBkaWZmZXJlbnQgZXZlbnQgaGFuZGxlcnMgZm9yIHRoZSBvcGVuZWQgc29ja2V0XG4gKlxuICogQGV2ZW50XG4gKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBOb3QgdXNlZFxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fb25PcGVuID0gZnVuY3Rpb24gKGV2ZW50KSB7XG4gIGlmIChldmVudCAmJiBldmVudC5kYXRhICYmIGV2ZW50LmRhdGEucHJveHlIb3N0bmFtZSkge1xuICAgIHRoaXMub3B0aW9ucy5uYW1lID0gZXZlbnQuZGF0YS5wcm94eUhvc3RuYW1lXG4gIH1cblxuICB0aGlzLnNvY2tldC5vbmRhdGEgPSB0aGlzLl9vbkRhdGEuYmluZCh0aGlzKVxuXG4gIHRoaXMuc29ja2V0Lm9uY2xvc2UgPSB0aGlzLl9vbkNsb3NlLmJpbmQodGhpcylcbiAgdGhpcy5zb2NrZXQub25kcmFpbiA9IHRoaXMuX29uRHJhaW4uYmluZCh0aGlzKVxuXG4gIHRoaXMuX3BhcnNlci5vbmRhdGEgPSB0aGlzLl9vbkNvbW1hbmQuYmluZCh0aGlzKVxuXG4gIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25HcmVldGluZ1xufVxuXG4vKipcbiAqIERhdGEgbGlzdGVuZXIgZm9yIGNodW5rcyBvZiBkYXRhIGVtaXR0ZWQgYnkgdGhlIHNlcnZlclxuICpcbiAqIEBldmVudFxuICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gU2VlIGBldnQuZGF0YWAgZm9yIHRoZSBjaHVuayByZWNlaXZlZFxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fb25EYXRhID0gZnVuY3Rpb24gKGV2dCkge1xuICBjbGVhclRpbWVvdXQodGhpcy5fc29ja2V0VGltZW91dFRpbWVyKVxuICB2YXIgc3RyaW5nUGF5bG9hZCA9IG5ldyBUZXh0RGVjb2RlcignVVRGLTgnKS5kZWNvZGUobmV3IFVpbnQ4QXJyYXkoZXZ0LmRhdGEpKVxuICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTRVJWRVI6ICcgKyBzdHJpbmdQYXlsb2FkKVxuICB0aGlzLl9wYXJzZXIuc2VuZChzdHJpbmdQYXlsb2FkKVxufVxuXG4vKipcbiAqIE1vcmUgZGF0YSBjYW4gYmUgYnVmZmVyZWQgaW4gdGhlIHNvY2tldCwgYHdhaXREcmFpbmAgaXMgcmVzZXQgdG8gZmFsc2VcbiAqXG4gKiBAZXZlbnRcbiAqIEBwYXJhbSB7RXZlbnR9IGV2dCBFdmVudCBvYmplY3QuIE5vdCB1c2VkXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9vbkRyYWluID0gZnVuY3Rpb24gKCkge1xuICB0aGlzLndhaXREcmFpbiA9IGZhbHNlXG4gIHRoaXMub25kcmFpbigpXG59XG5cbi8qKlxuICogRXJyb3IgaGFuZGxlciBmb3IgdGhlIHNvY2tldFxuICpcbiAqIEBldmVudFxuICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gU2VlIGV2dC5kYXRhIGZvciB0aGUgZXJyb3JcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX29uRXJyb3IgPSBmdW5jdGlvbiAoZXZ0KSB7XG4gIGlmIChldnQgaW5zdGFuY2VvZiBFcnJvciAmJiBldnQubWVzc2FnZSkge1xuICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgZXZ0KVxuICAgIHRoaXMub25lcnJvcihldnQpXG4gIH0gZWxzZSBpZiAoZXZ0ICYmIGV2dC5kYXRhIGluc3RhbmNlb2YgRXJyb3IpIHtcbiAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsIGV2dC5kYXRhKVxuICAgIHRoaXMub25lcnJvcihldnQuZGF0YSlcbiAgfSBlbHNlIHtcbiAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsIG5ldyBFcnJvcigoZXZ0ICYmIGV2dC5kYXRhICYmIGV2dC5kYXRhLm1lc3NhZ2UpIHx8IGV2dC5kYXRhIHx8IGV2dCB8fCAnRXJyb3InKSlcbiAgICB0aGlzLm9uZXJyb3IobmV3IEVycm9yKChldnQgJiYgZXZ0LmRhdGEgJiYgZXZ0LmRhdGEubWVzc2FnZSkgfHwgZXZ0LmRhdGEgfHwgZXZ0IHx8ICdFcnJvcicpKVxuICB9XG5cbiAgdGhpcy5jbG9zZSgpXG59XG5cbi8qKlxuICogSW5kaWNhdGVzIHRoYXQgdGhlIHNvY2tldCBoYXMgYmVlbiBjbG9zZWRcbiAqXG4gKiBAZXZlbnRcbiAqIEBwYXJhbSB7RXZlbnR9IGV2dCBFdmVudCBvYmplY3QuIE5vdCB1c2VkXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9vbkNsb3NlID0gZnVuY3Rpb24gKCkge1xuICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTb2NrZXQgY2xvc2VkLicpXG4gIHRoaXMuX2Rlc3Ryb3koKVxufVxuXG4vKipcbiAqIFRoaXMgaXMgbm90IGEgc29ja2V0IGRhdGEgaGFuZGxlciBidXQgdGhlIGhhbmRsZXIgZm9yIGRhdGEgZW1pdHRlZCBieSB0aGUgcGFyc2VyLFxuICogc28gdGhpcyBkYXRhIGlzIHNhZmUgdG8gdXNlIGFzIGl0IGlzIGFsd2F5cyBjb21wbGV0ZSAoc2VydmVyIG1pZ2h0IHNlbmQgcGFydGlhbCBjaHVua3MpXG4gKlxuICogQGV2ZW50XG4gKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgZGF0YVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fb25Db21tYW5kID0gZnVuY3Rpb24gKGNvbW1hbmQpIHtcbiAgaWYgKHR5cGVvZiB0aGlzLl9jdXJyZW50QWN0aW9uID09PSAnZnVuY3Rpb24nKSB7XG4gICAgdGhpcy5fY3VycmVudEFjdGlvbihjb21tYW5kKVxuICB9XG59XG5cblNtdHBDbGllbnQucHJvdG90eXBlLl9vblRpbWVvdXQgPSBmdW5jdGlvbiAoKSB7XG4gIC8vIGluZm9ybSBhYm91dCB0aGUgdGltZW91dCBhbmQgc2h1dCBkb3duXG4gIHZhciBlcnJvciA9IG5ldyBFcnJvcignU29ja2V0IHRpbWVkIG91dCEnKVxuICB0aGlzLl9vbkVycm9yKGVycm9yKVxufVxuXG4vKipcbiAqIEVuc3VyZXMgdGhhdCB0aGUgY29ubmVjdGlvbiBpcyBjbG9zZWQgYW5kIHN1Y2hcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2Rlc3Ryb3kgPSBmdW5jdGlvbiAoKSB7XG4gIGNsZWFyVGltZW91dCh0aGlzLl9zb2NrZXRUaW1lb3V0VGltZXIpXG5cbiAgaWYgKCF0aGlzLmRlc3Ryb3llZCkge1xuICAgIHRoaXMuZGVzdHJveWVkID0gdHJ1ZVxuICAgIHRoaXMub25jbG9zZSgpXG4gIH1cbn1cblxuLyoqXG4gKiBTZW5kcyBhIHN0cmluZyB0byB0aGUgc29ja2V0LlxuICpcbiAqIEBwYXJhbSB7U3RyaW5nfSBjaHVuayBBU0NJSSBzdHJpbmcgKHF1b3RlZC1wcmludGFibGUsIGJhc2U2NCBldGMuKSB0byBiZSBzZW50IHRvIHRoZSBzZXJ2ZXJcbiAqIEByZXR1cm4ge0Jvb2xlYW59IElmIHRydWUsIGl0IGlzIHNhZmUgdG8gc2VuZCBtb3JlIGRhdGEsIGlmIGZhbHNlLCB5b3UgKnNob3VsZCogd2FpdCBmb3IgdGhlIG9uZHJhaW4gZXZlbnQgYmVmb3JlIHNlbmRpbmcgbW9yZVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fc2VuZFN0cmluZyA9IGZ1bmN0aW9uIChjaHVuaykge1xuICAvLyBlc2NhcGUgZG90c1xuICBpZiAoIXRoaXMub3B0aW9ucy5kaXNhYmxlRXNjYXBpbmcpIHtcbiAgICBjaHVuayA9IGNodW5rLnJlcGxhY2UoL1xcblxcLi9nLCAnXFxuLi4nKVxuICAgIGlmICgodGhpcy5fbGFzdERhdGFCeXRlcy5zdWJzdHIoLTEpID09PSAnXFxuJyB8fCAhdGhpcy5fbGFzdERhdGFCeXRlcykgJiYgY2h1bmsuY2hhckF0KDApID09PSAnLicpIHtcbiAgICAgIGNodW5rID0gJy4nICsgY2h1bmtcbiAgICB9XG4gIH1cblxuICAvLyBLZWVwaW5nIGV5ZSBvbiB0aGUgbGFzdCBieXRlcyBzZW50LCB0byBzZWUgaWYgdGhlcmUgaXMgYSA8Q1I+PExGPiBzZXF1ZW5jZVxuICAvLyBhdCB0aGUgZW5kIHdoaWNoIGlzIG5lZWRlZCB0byBlbmQgdGhlIGRhdGEgc3RyZWFtXG4gIGlmIChjaHVuay5sZW5ndGggPiAyKSB7XG4gICAgdGhpcy5fbGFzdERhdGFCeXRlcyA9IGNodW5rLnN1YnN0cigtMilcbiAgfSBlbHNlIGlmIChjaHVuay5sZW5ndGggPT09IDEpIHtcbiAgICB0aGlzLl9sYXN0RGF0YUJ5dGVzID0gdGhpcy5fbGFzdERhdGFCeXRlcy5zdWJzdHIoLTEpICsgY2h1bmtcbiAgfVxuXG4gIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgJyArIGNodW5rLmxlbmd0aCArICcgYnl0ZXMgb2YgcGF5bG9hZCcpXG5cbiAgLy8gcGFzcyB0aGUgY2h1bmsgdG8gdGhlIHNvY2tldFxuICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFRleHRFbmNvZGVyKCdVVEYtOCcpLmVuY29kZShjaHVuaykuYnVmZmVyKVxuICByZXR1cm4gdGhpcy53YWl0RHJhaW5cbn1cblxuLyoqXG4gKiBTZW5kIGEgc3RyaW5nIGNvbW1hbmQgdG8gdGhlIHNlcnZlciwgYWxzbyBhcHBlbmQgXFxyXFxuIGlmIG5lZWRlZFxuICpcbiAqIEBwYXJhbSB7U3RyaW5nfSBzdHIgU3RyaW5nIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fc2VuZENvbW1hbmQgPSBmdW5jdGlvbiAoc3RyKSB7XG4gIHRoaXMud2FpdERyYWluID0gdGhpcy5fc2VuZChuZXcgVGV4dEVuY29kZXIoJ1VURi04JykuZW5jb2RlKHN0ciArIChzdHIuc3Vic3RyKC0yKSAhPT0gJ1xcclxcbicgPyAnXFxyXFxuJyA6ICcnKSkuYnVmZmVyKVxufVxuXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fc2VuZCA9IGZ1bmN0aW9uIChidWZmZXIpIHtcbiAgdGhpcy5fc2V0VGltZW91dChidWZmZXIuYnl0ZUxlbmd0aClcbiAgcmV0dXJuIHRoaXMuc29ja2V0LnNlbmQoYnVmZmVyKVxufVxuXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fc2V0VGltZW91dCA9IGZ1bmN0aW9uIChieXRlTGVuZ3RoKSB7XG4gIHZhciBwcm9sb25nUGVyaW9kID0gTWF0aC5mbG9vcihieXRlTGVuZ3RoICogdGhpcy50aW1lb3V0U29ja2V0TXVsdGlwbGllcilcbiAgdmFyIHRpbWVvdXRcblxuICBpZiAodGhpcy5fZGF0YU1vZGUpIHtcbiAgICAvLyB3ZSdyZSBpbiBkYXRhIG1vZGUsIHNvIHdlIGNvdW50IG9ubHkgb25lIHRpbWVvdXQgdGhhdCBnZXQgZXh0ZW5kZWQgZm9yIGV2ZXJ5IHNlbmQoKS5cbiAgICB2YXIgbm93ID0gRGF0ZS5ub3coKVxuXG4gICAgLy8gdGhlIG9sZCB0aW1lb3V0IHN0YXJ0IHRpbWVcbiAgICB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgPSB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgfHwgbm93XG5cbiAgICAvLyB0aGUgb2xkIHRpbWVvdXQgcGVyaW9kLCBub3JtYWxpemVkIHRvIGEgbWluaW11bSBvZiBUSU1FT1VUX1NPQ0tFVF9MT1dFUl9CT1VORFxuICAgIHRoaXMuX3NvY2tldFRpbWVvdXRQZXJpb2QgPSAodGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCB8fCB0aGlzLnRpbWVvdXRTb2NrZXRMb3dlckJvdW5kKSArIHByb2xvbmdQZXJpb2RcblxuICAgIC8vIHRoZSBuZXcgdGltZW91dCBpcyB0aGUgZGVsdGEgYmV0d2VlbiB0aGUgbmV3IGZpcmluZyB0aW1lICg9IHRpbWVvdXQgcGVyaW9kICsgdGltZW91dCBzdGFydCB0aW1lKSBhbmQgbm93XG4gICAgdGltZW91dCA9IHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCArIHRoaXMuX3NvY2tldFRpbWVvdXRQZXJpb2QgLSBub3dcbiAgfSBlbHNlIHtcbiAgICAvLyBzZXQgbmV3IHRpbW91dFxuICAgIHRpbWVvdXQgPSB0aGlzLnRpbWVvdXRTb2NrZXRMb3dlckJvdW5kICsgcHJvbG9uZ1BlcmlvZFxuICB9XG5cbiAgY2xlYXJUaW1lb3V0KHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lcikgLy8gY2xlYXIgcGVuZGluZyB0aW1lb3V0c1xuICB0aGlzLl9zb2NrZXRUaW1lb3V0VGltZXIgPSBzZXRUaW1lb3V0KHRoaXMuX29uVGltZW91dC5iaW5kKHRoaXMpLCB0aW1lb3V0KSAvLyBhcm0gdGhlIG5leHQgdGltZW91dFxufVxuXG4vKipcbiAqIEludGl0aWF0ZSBhdXRoZW50aWNhdGlvbiBzZXF1ZW5jZSBpZiBuZWVkZWRcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2F1dGhlbnRpY2F0ZVVzZXIgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICghdGhpcy5vcHRpb25zLmF1dGgpIHtcbiAgICAvLyBubyBuZWVkIHRvIGF1dGhlbnRpY2F0ZSwgYXQgbGVhc3Qgbm8gZGF0YSBnaXZlblxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgdGhpcy5vbmlkbGUoKSAvLyByZWFkeSB0byB0YWtlIG9yZGVyc1xuICAgIHJldHVyblxuICB9XG5cbiAgdmFyIGF1dGhcblxuICBpZiAoIXRoaXMub3B0aW9ucy5hdXRoTWV0aG9kICYmIHRoaXMub3B0aW9ucy5hdXRoLnhvYXV0aDIpIHtcbiAgICB0aGlzLm9wdGlvbnMuYXV0aE1ldGhvZCA9ICdYT0FVVEgyJ1xuICB9XG5cbiAgaWYgKHRoaXMub3B0aW9ucy5hdXRoTWV0aG9kKSB7XG4gICAgYXV0aCA9IHRoaXMub3B0aW9ucy5hdXRoTWV0aG9kLnRvVXBwZXJDYXNlKCkudHJpbSgpXG4gIH0gZWxzZSB7XG4gICAgLy8gdXNlIGZpcnN0IHN1cHBvcnRlZFxuICAgIGF1dGggPSAodGhpcy5fc3VwcG9ydGVkQXV0aFswXSB8fCAnUExBSU4nKS50b1VwcGVyQ2FzZSgpLnRyaW0oKVxuICB9XG5cbiAgc3dpdGNoIChhdXRoKSB7XG4gICAgY2FzZSAnTE9HSU4nOlxuICAgICAgLy8gTE9HSU4gaXMgYSAzIHN0ZXAgYXV0aGVudGljYXRpb24gcHJvY2Vzc1xuICAgICAgLy8gQzogQVVUSCBMT0dJTlxuICAgICAgLy8gQzogQkFTRTY0KFVTRVIpXG4gICAgICAvLyBDOiBCQVNFNjQoUEFTUylcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0F1dGhlbnRpY2F0aW9uIHZpYSBBVVRIIExPR0lOJylcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIX0xPR0lOX1VTRVJcbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdBVVRIIExPR0lOJylcbiAgICAgIHJldHVyblxuICAgIGNhc2UgJ1BMQUlOJzpcbiAgICAgIC8vIEFVVEggUExBSU4gaXMgYSAxIHN0ZXAgYXV0aGVudGljYXRpb24gcHJvY2Vzc1xuICAgICAgLy8gQzogQVVUSCBQTEFJTiBCQVNFNjQoXFwwIFVTRVIgXFwwIFBBU1MpXG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiB2aWEgQVVUSCBQTEFJTicpXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSENvbXBsZXRlXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZChcbiAgICAgICAgLy8gY29udmVydCB0byBCQVNFNjRcbiAgICAgICAgJ0FVVEggUExBSU4gJyArXG4gICAgICAgIGVuY29kZShcbiAgICAgICAgICAvLyB0aGlzLm9wdGlvbnMuYXV0aC51c2VyKydcXHUwMDAwJytcbiAgICAgICAgICAnXFx1MDAwMCcgKyAvLyBza2lwIGF1dGhvcml6YXRpb24gaWRlbnRpdHkgYXMgaXQgY2F1c2VzIHByb2JsZW1zIHdpdGggc29tZSBzZXJ2ZXJzXG4gICAgICAgICAgdGhpcy5vcHRpb25zLmF1dGgudXNlciArICdcXHUwMDAwJyArXG4gICAgICAgICAgdGhpcy5vcHRpb25zLmF1dGgucGFzcylcbiAgICAgIClcbiAgICAgIHJldHVyblxuICAgIGNhc2UgJ1hPQVVUSDInOlxuICAgICAgLy8gU2VlIGh0dHBzOi8vZGV2ZWxvcGVycy5nb29nbGUuY29tL2dtYWlsL3hvYXV0aDJfcHJvdG9jb2wjc210cF9wcm90b2NvbF9leGNoYW5nZVxuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQXV0aGVudGljYXRpb24gdmlhIEFVVEggWE9BVVRIMicpXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSF9YT0FVVEgyXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnQVVUSCBYT0FVVEgyICcgKyB0aGlzLl9idWlsZFhPQXV0aDJUb2tlbih0aGlzLm9wdGlvbnMuYXV0aC51c2VyLCB0aGlzLm9wdGlvbnMuYXV0aC54b2F1dGgyKSlcbiAgICAgIHJldHVyblxuICB9XG5cbiAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ1Vua25vd24gYXV0aGVudGljYXRpb24gbWV0aG9kICcgKyBhdXRoKSlcbn1cblxuLy8gQUNUSU9OUyBGT1IgUkVTUE9OU0VTIEZST00gVEhFIFNNVFAgU0VSVkVSXG5cbi8qKlxuICogSW5pdGlhbCByZXNwb25zZSBmcm9tIHRoZSBzZXJ2ZXIsIG11c3QgaGF2ZSBhIHN0YXR1cyAyMjBcbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9hY3Rpb25HcmVldGluZyA9IGZ1bmN0aW9uIChjb21tYW5kKSB7XG4gIGlmIChjb21tYW5kLnN0YXR1c0NvZGUgIT09IDIyMCkge1xuICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdJbnZhbGlkIGdyZWV0aW5nOiAnICsgY29tbWFuZC5kYXRhKSlcbiAgICByZXR1cm5cbiAgfVxuXG4gIGlmICh0aGlzLm9wdGlvbnMubG10cCkge1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgTEhMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG5cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uTEhMT1xuICAgIHRoaXMuX3NlbmRDb21tYW5kKCdMSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbiAgfSBlbHNlIHtcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIEVITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkVITE9cbiAgICB0aGlzLl9zZW5kQ29tbWFuZCgnRUhMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG4gIH1cbn1cblxuLyoqXG4gKiBSZXNwb25zZSB0byBMSExPXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fYWN0aW9uTEhMTyA9IGZ1bmN0aW9uIChjb21tYW5kKSB7XG4gIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnTEhMTyBub3Qgc3VjY2Vzc2Z1bCcpXG4gICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICByZXR1cm5cbiAgfVxuXG4gIC8vIFByb2Nlc3MgYXMgRUhMTyByZXNwb25zZVxuICB0aGlzLl9hY3Rpb25FSExPKGNvbW1hbmQpXG59XG5cbi8qKlxuICogUmVzcG9uc2UgdG8gRUhMTy4gSWYgdGhlIHJlc3BvbnNlIGlzIGFuIGVycm9yLCB0cnkgSEVMTyBpbnN0ZWFkXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fYWN0aW9uRUhMTyA9IGZ1bmN0aW9uIChjb21tYW5kKSB7XG4gIHZhciBtYXRjaFxuXG4gIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgaWYgKCF0aGlzLl9zZWN1cmVNb2RlICYmIHRoaXMub3B0aW9ucy5yZXF1aXJlVExTKSB7XG4gICAgICB2YXIgZXJyTXNnID0gJ1NUQVJUVExTIG5vdCBzdXBwb3J0ZWQgd2l0aG91dCBFSExPJ1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCBlcnJNc2cpXG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihlcnJNc2cpKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gVHJ5IEhFTE8gaW5zdGVhZFxuICAgIHRoaXMubG9nZ2VyLndhcm4oREVCVUdfVEFHLCAnRUhMTyBub3Qgc3VjY2Vzc2Z1bCwgdHJ5aW5nIEhFTE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25IRUxPXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoJ0hFTE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICAgIHJldHVyblxuICB9XG5cbiAgLy8gRGV0ZWN0IGlmIHRoZSBzZXJ2ZXIgc3VwcG9ydHMgUExBSU4gYXV0aFxuICBpZiAoY29tbWFuZC5saW5lLm1hdGNoKC9BVVRIKD86XFxzK1teXFxuXSpcXHMrfFxccyspUExBSU4vaSkpIHtcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZXJ2ZXIgc3VwcG9ydHMgQVVUSCBQTEFJTicpXG4gICAgdGhpcy5fc3VwcG9ydGVkQXV0aC5wdXNoKCdQTEFJTicpXG4gIH1cblxuICAvLyBEZXRlY3QgaWYgdGhlIHNlcnZlciBzdXBwb3J0cyBMT0dJTiBhdXRoXG4gIGlmIChjb21tYW5kLmxpbmUubWF0Y2goL0FVVEgoPzpcXHMrW15cXG5dKlxccyt8XFxzKylMT0dJTi9pKSkge1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlcnZlciBzdXBwb3J0cyBBVVRIIExPR0lOJylcbiAgICB0aGlzLl9zdXBwb3J0ZWRBdXRoLnB1c2goJ0xPR0lOJylcbiAgfVxuXG4gIC8vIERldGVjdCBpZiB0aGUgc2VydmVyIHN1cHBvcnRzIFhPQVVUSDIgYXV0aFxuICBpZiAoY29tbWFuZC5saW5lLm1hdGNoKC9BVVRIKD86XFxzK1teXFxuXSpcXHMrfFxccyspWE9BVVRIMi9pKSkge1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlcnZlciBzdXBwb3J0cyBBVVRIIFhPQVVUSDInKVxuICAgIHRoaXMuX3N1cHBvcnRlZEF1dGgucHVzaCgnWE9BVVRIMicpXG4gIH1cblxuICAvLyBEZXRlY3QgbWF4aW11bSBhbGxvd2VkIG1lc3NhZ2Ugc2l6ZVxuICBpZiAoKG1hdGNoID0gY29tbWFuZC5saW5lLm1hdGNoKC9TSVpFIChcXGQrKS9pKSkgJiYgTnVtYmVyKG1hdGNoWzFdKSkge1xuICAgIGNvbnN0IG1heEFsbG93ZWRTaXplID0gTnVtYmVyKG1hdGNoWzFdKVxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ01heGltdW0gYWxsb3dkIG1lc3NhZ2Ugc2l6ZTogJyArIG1heEFsbG93ZWRTaXplKVxuICB9XG5cbiAgLy8gRGV0ZWN0IGlmIHRoZSBzZXJ2ZXIgc3VwcG9ydHMgU1RBUlRUTFNcbiAgaWYgKCF0aGlzLl9zZWN1cmVNb2RlKSB7XG4gICAgaWYgKChjb21tYW5kLmxpbmUubWF0Y2goL1sgLV1TVEFSVFRMU1xccz8kL21pKSAmJiAhdGhpcy5vcHRpb25zLmlnbm9yZVRMUykgfHwgISF0aGlzLm9wdGlvbnMucmVxdWlyZVRMUykge1xuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvblNUQVJUVExTXG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIFNUQVJUVExTJylcbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdTVEFSVFRMUycpXG4gICAgICByZXR1cm5cbiAgICB9XG4gIH1cblxuICB0aGlzLl9hdXRoZW50aWNhdGVVc2VyKClcbn1cblxuLyoqXG4gKiBIYW5kbGVzIHNlcnZlciByZXNwb25zZSBmb3IgU1RBUlRUTFMgY29tbWFuZC4gSWYgdGhlcmUncyBhbiBlcnJvclxuICogdHJ5IEhFTE8gaW5zdGVhZCwgb3RoZXJ3aXNlIGluaXRpYXRlIFRMUyB1cGdyYWRlLiBJZiB0aGUgdXBncmFkZVxuICogc3VjY2VlZGVzIHJlc3RhcnQgdGhlIEVITE9cbiAqXG4gKiBAcGFyYW0ge1N0cmluZ30gc3RyIE1lc3NhZ2UgZnJvbSB0aGUgc2VydmVyXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9hY3Rpb25TVEFSVFRMUyA9IGZ1bmN0aW9uIChjb21tYW5kKSB7XG4gIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnU1RBUlRUTFMgbm90IHN1Y2Nlc3NmdWwnKVxuICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgcmV0dXJuXG4gIH1cblxuICB0aGlzLl9zZWN1cmVNb2RlID0gdHJ1ZVxuICB0aGlzLnNvY2tldC51cGdyYWRlVG9TZWN1cmUoKVxuXG4gIC8vIHJlc3RhcnQgcHJvdG9jb2wgZmxvd1xuICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uRUhMT1xuICB0aGlzLl9zZW5kQ29tbWFuZCgnRUhMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG59XG5cbi8qKlxuICogUmVzcG9uc2UgdG8gSEVMT1xuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2FjdGlvbkhFTE8gPSBmdW5jdGlvbiAoY29tbWFuZCkge1xuICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0hFTE8gbm90IHN1Y2Nlc3NmdWwnKVxuICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgcmV0dXJuXG4gIH1cbiAgdGhpcy5fYXV0aGVudGljYXRlVXNlcigpXG59XG5cbi8qKlxuICogUmVzcG9uc2UgdG8gQVVUSCBMT0dJTiwgaWYgc3VjY2Vzc2Z1bCBleHBlY3RzIGJhc2U2NCBlbmNvZGVkIHVzZXJuYW1lXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fYWN0aW9uQVVUSF9MT0dJTl9VU0VSID0gZnVuY3Rpb24gKGNvbW1hbmQpIHtcbiAgaWYgKGNvbW1hbmQuc3RhdHVzQ29kZSAhPT0gMzM0IHx8IGNvbW1hbmQuZGF0YSAhPT0gJ1ZYTmxjbTVoYldVNicpIHtcbiAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdBVVRIIExPR0lOIFVTRVIgbm90IHN1Y2Nlc3NmdWw6ICcgKyBjb21tYW5kLmRhdGEpXG4gICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ0ludmFsaWQgbG9naW4gc2VxdWVuY2Ugd2hpbGUgd2FpdGluZyBmb3IgXCIzMzQgVlhObGNtNWhiV1U2IFwiOiAnICsgY29tbWFuZC5kYXRhKSlcbiAgICByZXR1cm5cbiAgfVxuICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBVVRIIExPR0lOIFVTRVIgc3VjY2Vzc2Z1bCcpXG4gIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIX0xPR0lOX1BBU1NcbiAgdGhpcy5fc2VuZENvbW1hbmQoZW5jb2RlKHRoaXMub3B0aW9ucy5hdXRoLnVzZXIpKVxufVxuXG4vKipcbiAqIFJlc3BvbnNlIHRvIEFVVEggTE9HSU4gdXNlcm5hbWUsIGlmIHN1Y2Nlc3NmdWwgZXhwZWN0cyBiYXNlNjQgZW5jb2RlZCBwYXNzd29yZFxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2FjdGlvbkFVVEhfTE9HSU5fUEFTUyA9IGZ1bmN0aW9uIChjb21tYW5kKSB7XG4gIGlmIChjb21tYW5kLnN0YXR1c0NvZGUgIT09IDMzNCB8fCBjb21tYW5kLmRhdGEgIT09ICdVR0Z6YzNkdmNtUTYnKSB7XG4gICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnQVVUSCBMT0dJTiBQQVNTIG5vdCBzdWNjZXNzZnVsOiAnICsgY29tbWFuZC5kYXRhKVxuICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdJbnZhbGlkIGxvZ2luIHNlcXVlbmNlIHdoaWxlIHdhaXRpbmcgZm9yIFwiMzM0IFVHRnpjM2R2Y21RNiBcIjogJyArIGNvbW1hbmQuZGF0YSkpXG4gICAgcmV0dXJuXG4gIH1cbiAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQVVUSCBMT0dJTiBQQVNTIHN1Y2Nlc3NmdWwnKVxuICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSENvbXBsZXRlXG4gIHRoaXMuX3NlbmRDb21tYW5kKGVuY29kZSh0aGlzLm9wdGlvbnMuYXV0aC5wYXNzKSlcbn1cblxuLyoqXG4gKiBSZXNwb25zZSB0byBBVVRIIFhPQVVUSDIgdG9rZW4sIGlmIGVycm9yIG9jY3VycyBzZW5kIGVtcHR5IHJlc3BvbnNlXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fYWN0aW9uQVVUSF9YT0FVVEgyID0gZnVuY3Rpb24gKGNvbW1hbmQpIHtcbiAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICB0aGlzLmxvZ2dlci53YXJuKERFQlVHX1RBRywgJ0Vycm9yIGR1cmluZyBBVVRIIFhPQVVUSDIsIHNlbmRpbmcgZW1wdHkgcmVzcG9uc2UnKVxuICAgIHRoaXMuX3NlbmRDb21tYW5kKCcnKVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIQ29tcGxldGVcbiAgfSBlbHNlIHtcbiAgICB0aGlzLl9hY3Rpb25BVVRIQ29tcGxldGUoY29tbWFuZClcbiAgfVxufVxuXG4vKipcbiAqIENoZWNrcyBpZiBhdXRoZW50aWNhdGlvbiBzdWNjZWVkZWQgb3Igbm90LiBJZiBzdWNjZXNzZnVsbHkgYXV0aGVudGljYXRlZFxuICogZW1pdCBgaWRsZWAgdG8gaW5kaWNhdGUgdGhhdCBhbiBlLW1haWwgY2FuIGJlIHNlbnQgdXNpbmcgdGhpcyBjb25uZWN0aW9uXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fYWN0aW9uQVVUSENvbXBsZXRlID0gZnVuY3Rpb24gKGNvbW1hbmQpIHtcbiAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiBmYWlsZWQ6ICcgKyBjb21tYW5kLmRhdGEpXG4gICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICByZXR1cm5cbiAgfVxuXG4gIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0F1dGhlbnRpY2F0aW9uIHN1Y2Nlc3NmdWwuJylcblxuICB0aGlzLl9hdXRoZW50aWNhdGVkQXMgPSB0aGlzLm9wdGlvbnMuYXV0aC51c2VyXG5cbiAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgdGhpcy5vbmlkbGUoKSAvLyByZWFkeSB0byB0YWtlIG9yZGVyc1xufVxuXG4vKipcbiAqIFVzZWQgd2hlbiB0aGUgY29ubmVjdGlvbiBpcyBpZGxlIGFuZCB0aGUgc2VydmVyIGVtaXRzIHRpbWVvdXRcbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9hY3Rpb25JZGxlID0gZnVuY3Rpb24gKGNvbW1hbmQpIHtcbiAgaWYgKGNvbW1hbmQuc3RhdHVzQ29kZSA+IDMwMCkge1xuICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQubGluZSkpXG4gICAgcmV0dXJuXG4gIH1cblxuICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxufVxuXG4vKipcbiAqIFJlc3BvbnNlIHRvIE1BSUwgRlJPTSBjb21tYW5kLiBQcm9jZWVkIHRvIGRlZmluaW5nIFJDUFQgVE8gbGlzdCBpZiBzdWNjZXNzZnVsXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fYWN0aW9uTUFJTCA9IGZ1bmN0aW9uIChjb21tYW5kKSB7XG4gIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnTUFJTCBGUk9NIHVuc3VjY2Vzc2Z1bDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgIHJldHVyblxuICB9XG5cbiAgaWYgKCF0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUubGVuZ3RoKSB7XG4gICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ0NhblxcJ3Qgc2VuZCBtYWlsIC0gbm8gcmVjaXBpZW50cyBkZWZpbmVkJykpXG4gIH0gZWxzZSB7XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnTUFJTCBGUk9NIHN1Y2Nlc3NmdWwsIHByb2NlZWRpbmcgd2l0aCAnICsgdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLmxlbmd0aCArICcgcmVjaXBpZW50cycpXG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQWRkaW5nIHJlY2lwaWVudC4uLicpXG4gICAgdGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50ID0gdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLnNoaWZ0KClcbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uUkNQVFxuICAgIHRoaXMuX3NlbmRDb21tYW5kKCdSQ1BUIFRPOjwnICsgdGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50ICsgJz4nKVxuICB9XG59XG5cbi8qKlxuICogUmVzcG9uc2UgdG8gYSBSQ1BUIFRPIGNvbW1hbmQuIElmIHRoZSBjb21tYW5kIGlzIHVuc3VjY2Vzc2Z1bCwgdHJ5IHRoZSBuZXh0IG9uZSxcbiAqIGFzIHRoaXMgbWlnaHQgYmUgcmVsYXRlZCBvbmx5IHRvIHRoZSBjdXJyZW50IHJlY2lwaWVudCwgbm90IGEgZ2xvYmFsIGVycm9yLCBzb1xuICogdGhlIGZvbGxvd2luZyByZWNpcGllbnRzIG1pZ2h0IHN0aWxsIGJlIHZhbGlkXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fYWN0aW9uUkNQVCA9IGZ1bmN0aW9uIChjb21tYW5kKSB7XG4gIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgdGhpcy5sb2dnZXIud2FybihERUJVR19UQUcsICdSQ1BUIFRPIGZhaWxlZCBmb3I6ICcgKyB0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQpXG4gICAgLy8gdGhpcyBpcyBhIHNvZnQgZXJyb3JcbiAgICB0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkLnB1c2godGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50KVxuICB9IGVsc2Uge1xuICAgIHRoaXMuX2VudmVsb3BlLnJlc3BvbnNlUXVldWUucHVzaCh0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQpXG4gIH1cblxuICBpZiAoIXRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5sZW5ndGgpIHtcbiAgICBpZiAodGhpcy5fZW52ZWxvcGUucmNwdEZhaWxlZC5sZW5ndGggPCB0aGlzLl9lbnZlbG9wZS50by5sZW5ndGgpIHtcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25EQVRBXG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdSQ1BUIFRPIGRvbmUsIHByb2NlZWRpbmcgd2l0aCBwYXlsb2FkJylcbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdEQVRBJylcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ0NhblxcJ3Qgc2VuZCBtYWlsIC0gYWxsIHJlY2lwaWVudHMgd2VyZSByZWplY3RlZCcpKVxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQWRkaW5nIHJlY2lwaWVudC4uLicpXG4gICAgdGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50ID0gdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLnNoaWZ0KClcbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uUkNQVFxuICAgIHRoaXMuX3NlbmRDb21tYW5kKCdSQ1BUIFRPOjwnICsgdGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50ICsgJz4nKVxuICB9XG59XG5cbi8qKlxuICogUmVzcG9uc2UgdG8gdGhlIFJTRVQgY29tbWFuZC4gSWYgc3VjY2Vzc2Z1bCwgY2xlYXIgdGhlIGN1cnJlbnQgYXV0aGVudGljYXRpb25cbiAqIGluZm9ybWF0aW9uIGFuZCByZWF1dGhlbnRpY2F0ZS5cbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9hY3Rpb25SU0VUID0gZnVuY3Rpb24gKGNvbW1hbmQpIHtcbiAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdSU0VUIHVuc3VjY2Vzc2Z1bCAnICsgY29tbWFuZC5kYXRhKVxuICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgcmV0dXJuXG4gIH1cblxuICB0aGlzLl9hdXRoZW50aWNhdGVkQXMgPSBudWxsXG4gIHRoaXMuX2F1dGhlbnRpY2F0ZVVzZXIoKVxufVxuXG4vKipcbiAqIFJlc3BvbnNlIHRvIHRoZSBEQVRBIGNvbW1hbmQuIFNlcnZlciBpcyBub3cgd2FpdGluZyBmb3IgYSBtZXNzYWdlLCBzbyBlbWl0IGBvbnJlYWR5YFxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2FjdGlvbkRBVEEgPSBmdW5jdGlvbiAoY29tbWFuZCkge1xuICAvLyByZXNwb25zZSBzaG91bGQgYmUgMzU0IGJ1dCBhY2NvcmRpbmcgdG8gdGhpcyBpc3N1ZSBodHRwczovL2dpdGh1Yi5jb20vZWxlaXRoL2VtYWlsanMvaXNzdWVzLzI0XG4gIC8vIHNvbWUgc2VydmVycyBtaWdodCB1c2UgMjUwIGluc3RlYWRcbiAgaWYgKFsyNTAsIDM1NF0uaW5kZXhPZihjb21tYW5kLnN0YXR1c0NvZGUpIDwgMCkge1xuICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0RBVEEgdW5zdWNjZXNzZnVsICcgKyBjb21tYW5kLmRhdGEpXG4gICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICByZXR1cm5cbiAgfVxuXG4gIHRoaXMuX2RhdGFNb2RlID0gdHJ1ZVxuICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICB0aGlzLm9ucmVhZHkodGhpcy5fZW52ZWxvcGUucmNwdEZhaWxlZClcbn1cblxuLyoqXG4gKiBSZXNwb25zZSBmcm9tIHRoZSBzZXJ2ZXIsIG9uY2UgdGhlIG1lc3NhZ2Ugc3RyZWFtIGhhcyBlbmRlZCB3aXRoIDxDUj48TEY+LjxDUj48TEY+XG4gKiBFbWl0cyBgb25kb25lYC5cbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9hY3Rpb25TdHJlYW0gPSBmdW5jdGlvbiAoY29tbWFuZCkge1xuICB2YXIgcmNwdFxuXG4gIGlmICh0aGlzLm9wdGlvbnMubG10cCkge1xuICAgIC8vIExNVFAgcmV0dXJucyBhIHJlc3BvbnNlIGNvZGUgZm9yICpldmVyeSogc3VjY2Vzc2Z1bGx5IHNldCByZWNpcGllbnRcbiAgICAvLyBGb3IgZXZlcnkgcmVjaXBpZW50IHRoZSBtZXNzYWdlIG1pZ2h0IHN1Y2NlZWQgb3IgZmFpbCBpbmRpdmlkdWFsbHlcblxuICAgIHJjcHQgPSB0aGlzLl9lbnZlbG9wZS5yZXNwb25zZVF1ZXVlLnNoaWZ0KClcbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnTG9jYWwgZGVsaXZlcnkgdG8gJyArIHJjcHQgKyAnIGZhaWxlZC4nKVxuICAgICAgdGhpcy5fZW52ZWxvcGUucmNwdEZhaWxlZC5wdXNoKHJjcHQpXG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0xvY2FsIGRlbGl2ZXJ5IHRvICcgKyByY3B0ICsgJyBzdWNjZWVkZWQuJylcbiAgICB9XG5cbiAgICBpZiAodGhpcy5fZW52ZWxvcGUucmVzcG9uc2VRdWV1ZS5sZW5ndGgpIHtcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25TdHJlYW1cbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgdGhpcy5vbmRvbmUodHJ1ZSlcbiAgfSBlbHNlIHtcbiAgICAvLyBGb3IgU01UUCB0aGUgbWVzc2FnZSBlaXRoZXIgZmFpbHMgb3Igc3VjY2VlZHMsIHRoZXJlIGlzIG5vIGluZm9ybWF0aW9uXG4gICAgLy8gYWJvdXQgaW5kaXZpZHVhbCByZWNpcGllbnRzXG5cbiAgICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnTWVzc2FnZSBzZW5kaW5nIGZhaWxlZC4nKVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdNZXNzYWdlIHNlbnQgc3VjY2Vzc2Z1bGx5LicpXG4gICAgfVxuXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICB0aGlzLm9uZG9uZSghIWNvbW1hbmQuc3VjY2VzcylcbiAgfVxuXG4gIC8vIElmIHRoZSBjbGllbnQgd2FudGVkIHRvIGRvIHNvbWV0aGluZyBlbHNlIChlZy4gdG8gcXVpdCksIGRvIG5vdCBmb3JjZSBpZGxlXG4gIGlmICh0aGlzLl9jdXJyZW50QWN0aW9uID09PSB0aGlzLl9hY3Rpb25JZGxlKSB7XG4gICAgLy8gV2FpdGluZyBmb3IgbmV3IGNvbm5lY3Rpb25zXG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnSWRsaW5nIHdoaWxlIHdhaXRpbmcgZm9yIG5ldyBjb25uZWN0aW9ucy4uLicpXG4gICAgdGhpcy5vbmlkbGUoKVxuICB9XG59XG5cbi8qKlxuICogQnVpbGRzIGEgbG9naW4gdG9rZW4gZm9yIFhPQVVUSDIgYXV0aGVudGljYXRpb24gY29tbWFuZFxuICpcbiAqIEBwYXJhbSB7U3RyaW5nfSB1c2VyIEUtbWFpbCBhZGRyZXNzIG9mIHRoZSB1c2VyXG4gKiBAcGFyYW0ge1N0cmluZ30gdG9rZW4gVmFsaWQgYWNjZXNzIHRva2VuIGZvciB0aGUgdXNlclxuICogQHJldHVybiB7U3RyaW5nfSBCYXNlNjQgZm9ybWF0dGVkIGxvZ2luIHRva2VuXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9idWlsZFhPQXV0aDJUb2tlbiA9IGZ1bmN0aW9uICh1c2VyLCB0b2tlbikge1xuICB2YXIgYXV0aERhdGEgPSBbXG4gICAgJ3VzZXI9JyArICh1c2VyIHx8ICcnKSxcbiAgICAnYXV0aD1CZWFyZXIgJyArIHRva2VuLFxuICAgICcnLFxuICAgICcnXG4gIF1cbiAgLy8gYmFzZTY0KFwidXNlcj17VXNlcn1cXHgwMGF1dGg9QmVhcmVyIHtUb2tlbn1cXHgwMFxceDAwXCIpXG4gIHJldHVybiBlbmNvZGUoYXV0aERhdGEuam9pbignXFx4MDEnKSlcbn1cblxuU210cENsaWVudC5wcm90b3R5cGUuY3JlYXRlTG9nZ2VyID0gZnVuY3Rpb24gKGNyZWF0b3IgPSBjcmVhdGVEZWZhdWx0TG9nZ2VyKSB7XG4gIGNvbnN0IGxvZ2dlciA9IGNyZWF0b3IoKHRoaXMub3B0aW9ucy5hdXRoIHx8IHt9KS51c2VyIHx8ICcnLCB0aGlzLmhvc3QpXG4gIHRoaXMubG9nTGV2ZWwgPSB0aGlzLkxPR19MRVZFTF9BTExcbiAgdGhpcy5sb2dnZXIgPSB7XG4gICAgZGVidWc6ICguLi5tc2dzKSA9PiB7IGlmIChMT0dfTEVWRUxfREVCVUcgPj0gdGhpcy5sb2dMZXZlbCkgeyBsb2dnZXIuZGVidWcobXNncykgfSB9LFxuICAgIGluZm86ICguLi5tc2dzKSA9PiB7IGlmIChMT0dfTEVWRUxfSU5GTyA+PSB0aGlzLmxvZ0xldmVsKSB7IGxvZ2dlci5pbmZvKG1zZ3MpIH0gfSxcbiAgICB3YXJuOiAoLi4ubXNncykgPT4geyBpZiAoTE9HX0xFVkVMX1dBUk4gPj0gdGhpcy5sb2dMZXZlbCkgeyBsb2dnZXIud2Fybihtc2dzKSB9IH0sXG4gICAgZXJyb3I6ICguLi5tc2dzKSA9PiB7IGlmIChMT0dfTEVWRUxfRVJST1IgPj0gdGhpcy5sb2dMZXZlbCkgeyBsb2dnZXIuZXJyb3IobXNncykgfSB9XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgU210cENsaWVudFxuIl19