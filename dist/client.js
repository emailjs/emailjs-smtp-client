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
function SmtpClient(host, port, options) {
  this._TCPSocket = _emailjsTcpSocket2.default;

  this.options = options || {};

  this.port = port || (this.options.useSecureTransport ? 465 : 25);
  this.host = host || 'localhost';

  /**
   * If set to true, start an encrypted connection instead of the plaintext one
   * (recommended if applicable). If useSecureTransport is not set but the port used is 465,
   * then ecryption is used by default.
   */
  this.options.useSecureTransport = 'useSecureTransport' in this.options ? !!this.options.useSecureTransport : this.port === 465;

  /**
   * Authentication object. If not set, authentication step will be skipped.
   */
  this.options.auth = this.options.auth || false;

  /**
   * Hostname of the client, this will be used for introducing to the server
   */
  this.options.name = this.options.name || 'localhost';

  /**
   * Downstream TCP socket to the SMTP server, created with mozTCPSocket
   */
  this.socket = false;

  /**
   * Indicates if the connection has been closed and can't be used anymore
   *
   */
  this.destroyed = false;

  /**
   * Informational value that indicates the maximum size (in bytes) for
   * a message sent to the current server. Detected from SIZE info.
   * Not available until connection has been established.
   */
  this.maxAllowedSize = 0;

  /**
   * Keeps track if the downstream socket is currently full and
   * a drain event should be waited for or not
   */
  this.waitDrain = false;

  // Private properties

  /**
   * SMTP response parser object. All data coming from the downstream server
   * is feeded to this parser
   */
  this._parser = new _parser2.default();

  /**
   * If authenticated successfully, stores the username
   */
  this._authenticatedAs = null;

  /**
   * A list of authentication mechanisms detected from the EHLO response
   * and which are compatible with this library
   */
  this._supportedAuth = [];

  /**
   * If true, accepts data from the upstream to be passed
   * directly to the downstream socket. Used after the DATA command
   */
  this._dataMode = false;

  /**
   * Keep track of the last bytes to see how the terminating dot should be placed
   */
  this._lastDataBytes = '';

  /**
   * Envelope object for tracking who is sending mail to whom
   */
  this._envelope = null;

  /**
   * Stores the function that should be run after a response has been received
   * from the server
   */
  this._currentAction = null;

  /**
   * Indicates if the connection is secured or plaintext
   */
  this._secureMode = !!this.options.useSecureTransport;

  /**
   * Timer waiting to declare the socket dead starting from the last write
   */
  this._socketTimeoutTimer = false;

  /**
   * Start time of sending the first packet in data mode
   */
  this._socketTimeoutStart = false;

  /**
   * Timeout for sending in data mode, gets extended with every send()
   */
  this._socketTimeoutPeriod = false;

  // Activate logging
  this.createLogger();
  this.logLevel = this.LOG_LEVEL_ALL;
}

//
// CONSTANTS
//

/**
 * Lower Bound for socket timeout to wait since the last data was written to a socket
 */
SmtpClient.prototype.TIMEOUT_SOCKET_LOWER_BOUND = 10000;

/**
 * Multiplier for socket timeout:
 *
 * We assume at least a GPRS connection with 115 kb/s = 14,375 kB/s tops, so 10 KB/s to be on
 * the safe side. We can timeout after a lower bound of 10s + (n KB / 10 KB/s). A 1 MB message
 * upload would be 110 seconds to wait for the timeout. 10 KB/s === 0.1 s/B
 */
SmtpClient.prototype.TIMEOUT_SOCKET_MULTIPLIER = 0.1;

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
  this.socket = this._TCPSocket.open(this.host, this.port, {
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
  var prolongPeriod = Math.floor(byteLength * this.TIMEOUT_SOCKET_MULTIPLIER);
  var timeout;

  if (this._dataMode) {
    // we're in data mode, so we count only one timeout that get extended for every send().
    var now = Date.now();

    // the old timeout start time
    this._socketTimeoutStart = this._socketTimeoutStart || now;

    // the old timeout period, normalized to a minimum of TIMEOUT_SOCKET_LOWER_BOUND
    this._socketTimeoutPeriod = (this._socketTimeoutPeriod || this.TIMEOUT_SOCKET_LOWER_BOUND) + prolongPeriod;

    // the new timeout is the delta between the new firing time (= timeout period + timeout start time) and now
    timeout = this._socketTimeoutStart + this._socketTimeoutPeriod - now;
  } else {
    // set new timout
    timeout = this.TIMEOUT_SOCKET_LOWER_BOUND + prolongPeriod;
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
    this._maxAllowedSize = Number(match[1]);
    this.logger.debug(DEBUG_TAG, 'Maximum allowd message size: ' + this._maxAllowedSize);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9jbGllbnQuanMiXSwibmFtZXMiOlsiREVCVUdfVEFHIiwiU210cENsaWVudCIsImhvc3QiLCJwb3J0Iiwib3B0aW9ucyIsIl9UQ1BTb2NrZXQiLCJ1c2VTZWN1cmVUcmFuc3BvcnQiLCJhdXRoIiwibmFtZSIsInNvY2tldCIsImRlc3Ryb3llZCIsIm1heEFsbG93ZWRTaXplIiwid2FpdERyYWluIiwiX3BhcnNlciIsIl9hdXRoZW50aWNhdGVkQXMiLCJfc3VwcG9ydGVkQXV0aCIsIl9kYXRhTW9kZSIsIl9sYXN0RGF0YUJ5dGVzIiwiX2VudmVsb3BlIiwiX2N1cnJlbnRBY3Rpb24iLCJfc2VjdXJlTW9kZSIsIl9zb2NrZXRUaW1lb3V0VGltZXIiLCJfc29ja2V0VGltZW91dFN0YXJ0IiwiX3NvY2tldFRpbWVvdXRQZXJpb2QiLCJjcmVhdGVMb2dnZXIiLCJsb2dMZXZlbCIsIkxPR19MRVZFTF9BTEwiLCJwcm90b3R5cGUiLCJUSU1FT1VUX1NPQ0tFVF9MT1dFUl9CT1VORCIsIlRJTUVPVVRfU09DS0VUX01VTFRJUExJRVIiLCJvbmVycm9yIiwib25kcmFpbiIsIm9uY2xvc2UiLCJvbmlkbGUiLCJvbnJlYWR5Iiwib25kb25lIiwiY29ubmVjdCIsIm9wZW4iLCJiaW5hcnlUeXBlIiwiY2EiLCJ0bHNXb3JrZXJQYXRoIiwid3MiLCJvbmNlcnQiLCJFIiwiX29uRXJyb3IiLCJiaW5kIiwib25vcGVuIiwiX29uT3BlbiIsInN1c3BlbmQiLCJyZWFkeVN0YXRlIiwicmVzdW1lIiwicXVpdCIsImxvZ2dlciIsImRlYnVnIiwiX3NlbmRDb21tYW5kIiwiY2xvc2UiLCJyZXNldCIsIl9hY3Rpb25SU0VUIiwiX2Rlc3Ryb3kiLCJ1c2VFbnZlbG9wZSIsImVudmVsb3BlIiwiZnJvbSIsImNvbmNhdCIsInRvIiwicmNwdFF1ZXVlIiwicmNwdEZhaWxlZCIsInJlc3BvbnNlUXVldWUiLCJfYWN0aW9uTUFJTCIsInNlbmQiLCJjaHVuayIsIl9zZW5kU3RyaW5nIiwiZW5kIiwibGVuZ3RoIiwiX2FjdGlvblN0cmVhbSIsIl9zZW5kIiwiVWludDhBcnJheSIsImJ1ZmZlciIsInN1YnN0ciIsImV2ZW50IiwiZGF0YSIsInByb3h5SG9zdG5hbWUiLCJvbmRhdGEiLCJfb25EYXRhIiwiX29uQ2xvc2UiLCJfb25EcmFpbiIsIl9vbkNvbW1hbmQiLCJfYWN0aW9uR3JlZXRpbmciLCJldnQiLCJjbGVhclRpbWVvdXQiLCJzdHJpbmdQYXlsb2FkIiwiZGVjb2RlIiwiRXJyb3IiLCJtZXNzYWdlIiwiZXJyb3IiLCJjb21tYW5kIiwiX29uVGltZW91dCIsImRpc2FibGVFc2NhcGluZyIsInJlcGxhY2UiLCJjaGFyQXQiLCJlbmNvZGUiLCJzdHIiLCJfc2V0VGltZW91dCIsImJ5dGVMZW5ndGgiLCJwcm9sb25nUGVyaW9kIiwiTWF0aCIsImZsb29yIiwidGltZW91dCIsIm5vdyIsIkRhdGUiLCJzZXRUaW1lb3V0IiwiX2F1dGhlbnRpY2F0ZVVzZXIiLCJfYWN0aW9uSWRsZSIsImF1dGhNZXRob2QiLCJ4b2F1dGgyIiwidG9VcHBlckNhc2UiLCJ0cmltIiwiX2FjdGlvbkFVVEhfTE9HSU5fVVNFUiIsIl9hY3Rpb25BVVRIQ29tcGxldGUiLCJ1c2VyIiwicGFzcyIsIl9hY3Rpb25BVVRIX1hPQVVUSDIiLCJfYnVpbGRYT0F1dGgyVG9rZW4iLCJzdGF0dXNDb2RlIiwibG10cCIsIl9hY3Rpb25MSExPIiwiX2FjdGlvbkVITE8iLCJzdWNjZXNzIiwibWF0Y2giLCJyZXF1aXJlVExTIiwiZXJyTXNnIiwid2FybiIsIl9hY3Rpb25IRUxPIiwibGluZSIsInB1c2giLCJOdW1iZXIiLCJfbWF4QWxsb3dlZFNpemUiLCJpZ25vcmVUTFMiLCJfYWN0aW9uU1RBUlRUTFMiLCJ1cGdyYWRlVG9TZWN1cmUiLCJfYWN0aW9uQVVUSF9MT0dJTl9QQVNTIiwiY3VyUmVjaXBpZW50Iiwic2hpZnQiLCJfYWN0aW9uUkNQVCIsIl9hY3Rpb25EQVRBIiwiaW5kZXhPZiIsInJjcHQiLCJ0b2tlbiIsImF1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SUFBUztBQUFUQSxZQUFTO0FBQUE7O0FBQUUsVUFBSSwwQkFBa0IsTUFBSzdILFFBQTNCLEVBQXFDO0FBQUUyQixlQUFPbUcsSUFBUCxDQUFZRCxJQUFaO0FBQW1CO0FBQUUsS0FGckU7QUFHWnBCLFVBQU0sZ0JBQWE7QUFBQSx5Q0FBVG9CLElBQVM7QUFBVEEsWUFBUztBQUFBOztBQUFFLFVBQUksMEJBQWtCLE1BQUs3SCxRQUEzQixFQUFxQztBQUFFMkIsZUFBTzhFLElBQVAsQ0FBWW9CLElBQVo7QUFBbUI7QUFBRSxLQUhyRTtBQUlaekQsV0FBTyxpQkFBYTtBQUFBLHlDQUFUeUQsSUFBUztBQUFUQSxZQUFTO0FBQUE7O0FBQUUsVUFBSSwyQkFBbUIsTUFBSzdILFFBQTVCLEVBQXNDO0FBQUUyQixlQUFPeUMsS0FBUCxDQUFheUQsSUFBYjtBQUFvQjtBQUFFO0FBSnhFLEdBQWQ7QUFNRCxDQVJEOztrQkFVZXJKLFUiLCJmaWxlIjoiY2xpZW50LmpzIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgZW5jb2RlIH0gZnJvbSAnZW1haWxqcy1iYXNlNjQnXG5pbXBvcnQgVENQU29ja2V0IGZyb20gJ2VtYWlsanMtdGNwLXNvY2tldCdcbmltcG9ydCB7IFRleHREZWNvZGVyLCBUZXh0RW5jb2RlciB9IGZyb20gJ3RleHQtZW5jb2RpbmcnXG5pbXBvcnQgU210cENsaWVudFJlc3BvbnNlUGFyc2VyIGZyb20gJy4vcGFyc2VyJ1xuaW1wb3J0IGNyZWF0ZURlZmF1bHRMb2dnZXIgZnJvbSAnLi9sb2dnZXInXG5pbXBvcnQge1xuICBMT0dfTEVWRUxfRVJST1IsXG4gIExPR19MRVZFTF9XQVJOLFxuICBMT0dfTEVWRUxfSU5GTyxcbiAgTE9HX0xFVkVMX0RFQlVHXG59IGZyb20gJy4vY29tbW9uJ1xuXG52YXIgREVCVUdfVEFHID0gJ1NNVFAgQ2xpZW50J1xuXG4vKipcbiAqIENyZWF0ZXMgYSBjb25uZWN0aW9uIG9iamVjdCB0byBhIFNNVFAgc2VydmVyIGFuZCBhbGxvd3MgdG8gc2VuZCBtYWlsIHRocm91Z2ggaXQuXG4gKiBDYWxsIGBjb25uZWN0YCBtZXRob2QgdG8gaW5pdGl0YXRlIHRoZSBhY3R1YWwgY29ubmVjdGlvbiwgdGhlIGNvbnN0cnVjdG9yIG9ubHlcbiAqIGRlZmluZXMgdGhlIHByb3BlcnRpZXMgYnV0IGRvZXMgbm90IGFjdHVhbGx5IGNvbm5lY3QuXG4gKlxuICogTkIhIFRoZSBwYXJhbWV0ZXIgb3JkZXIgKGhvc3QsIHBvcnQpIGRpZmZlcnMgZnJvbSBub2RlLmpzIFwid2F5XCIgKHBvcnQsIGhvc3QpXG4gKlxuICogQGNvbnN0cnVjdG9yXG4gKlxuICogQHBhcmFtIHtTdHJpbmd9IFtob3N0PVwibG9jYWxob3N0XCJdIEhvc3RuYW1lIHRvIGNvbmVuY3QgdG9cbiAqIEBwYXJhbSB7TnVtYmVyfSBbcG9ydD0yNV0gUG9ydCBudW1iZXIgdG8gY29ubmVjdCB0b1xuICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXSBPcHRpb25hbCBvcHRpb25zIG9iamVjdFxuICogQHBhcmFtIHtCb29sZWFufSBbb3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnRdIFNldCB0byB0cnVlLCB0byB1c2UgZW5jcnlwdGVkIGNvbm5lY3Rpb25cbiAqIEBwYXJhbSB7U3RyaW5nfSBbb3B0aW9ucy5uYW1lXSBDbGllbnQgaG9zdG5hbWUgZm9yIGludHJvZHVjaW5nIGl0c2VsZiB0byB0aGUgc2VydmVyXG4gKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnMuYXV0aF0gQXV0aGVudGljYXRpb24gb3B0aW9ucy4gRGVwZW5kcyBvbiB0aGUgcHJlZmVycmVkIGF1dGhlbnRpY2F0aW9uIG1ldGhvZC4gVXN1YWxseSB7dXNlciwgcGFzc31cbiAqIEBwYXJhbSB7U3RyaW5nfSBbb3B0aW9ucy5hdXRoTWV0aG9kXSBGb3JjZSBzcGVjaWZpYyBhdXRoZW50aWNhdGlvbiBtZXRob2RcbiAqIEBwYXJhbSB7Qm9vbGVhbn0gW29wdGlvbnMuZGlzYWJsZUVzY2FwaW5nXSBJZiBzZXQgdG8gdHJ1ZSwgZG8gbm90IGVzY2FwZSBkb3RzIG9uIHRoZSBiZWdpbm5pbmcgb2YgdGhlIGxpbmVzXG4gKi9cbmZ1bmN0aW9uIFNtdHBDbGllbnQgKGhvc3QsIHBvcnQsIG9wdGlvbnMpIHtcbiAgdGhpcy5fVENQU29ja2V0ID0gVENQU29ja2V0XG5cbiAgdGhpcy5vcHRpb25zID0gb3B0aW9ucyB8fCB7fVxuXG4gIHRoaXMucG9ydCA9IHBvcnQgfHwgKHRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnQgPyA0NjUgOiAyNSlcbiAgdGhpcy5ob3N0ID0gaG9zdCB8fCAnbG9jYWxob3N0J1xuXG4gIC8qKlxuICAgKiBJZiBzZXQgdG8gdHJ1ZSwgc3RhcnQgYW4gZW5jcnlwdGVkIGNvbm5lY3Rpb24gaW5zdGVhZCBvZiB0aGUgcGxhaW50ZXh0IG9uZVxuICAgKiAocmVjb21tZW5kZWQgaWYgYXBwbGljYWJsZSkuIElmIHVzZVNlY3VyZVRyYW5zcG9ydCBpcyBub3Qgc2V0IGJ1dCB0aGUgcG9ydCB1c2VkIGlzIDQ2NSxcbiAgICogdGhlbiBlY3J5cHRpb24gaXMgdXNlZCBieSBkZWZhdWx0LlxuICAgKi9cbiAgdGhpcy5vcHRpb25zLnVzZVNlY3VyZVRyYW5zcG9ydCA9ICd1c2VTZWN1cmVUcmFuc3BvcnQnIGluIHRoaXMub3B0aW9ucyA/ICEhdGhpcy5vcHRpb25zLnVzZVNlY3VyZVRyYW5zcG9ydCA6IHRoaXMucG9ydCA9PT0gNDY1XG5cbiAgLyoqXG4gICAqIEF1dGhlbnRpY2F0aW9uIG9iamVjdC4gSWYgbm90IHNldCwgYXV0aGVudGljYXRpb24gc3RlcCB3aWxsIGJlIHNraXBwZWQuXG4gICAqL1xuICB0aGlzLm9wdGlvbnMuYXV0aCA9IHRoaXMub3B0aW9ucy5hdXRoIHx8IGZhbHNlXG5cbiAgLyoqXG4gICAqIEhvc3RuYW1lIG9mIHRoZSBjbGllbnQsIHRoaXMgd2lsbCBiZSB1c2VkIGZvciBpbnRyb2R1Y2luZyB0byB0aGUgc2VydmVyXG4gICAqL1xuICB0aGlzLm9wdGlvbnMubmFtZSA9IHRoaXMub3B0aW9ucy5uYW1lIHx8ICdsb2NhbGhvc3QnXG5cbiAgLyoqXG4gICAqIERvd25zdHJlYW0gVENQIHNvY2tldCB0byB0aGUgU01UUCBzZXJ2ZXIsIGNyZWF0ZWQgd2l0aCBtb3pUQ1BTb2NrZXRcbiAgICovXG4gIHRoaXMuc29ja2V0ID0gZmFsc2VcblxuICAvKipcbiAgICogSW5kaWNhdGVzIGlmIHRoZSBjb25uZWN0aW9uIGhhcyBiZWVuIGNsb3NlZCBhbmQgY2FuJ3QgYmUgdXNlZCBhbnltb3JlXG4gICAqXG4gICAqL1xuICB0aGlzLmRlc3Ryb3llZCA9IGZhbHNlXG5cbiAgLyoqXG4gICAqIEluZm9ybWF0aW9uYWwgdmFsdWUgdGhhdCBpbmRpY2F0ZXMgdGhlIG1heGltdW0gc2l6ZSAoaW4gYnl0ZXMpIGZvclxuICAgKiBhIG1lc3NhZ2Ugc2VudCB0byB0aGUgY3VycmVudCBzZXJ2ZXIuIERldGVjdGVkIGZyb20gU0laRSBpbmZvLlxuICAgKiBOb3QgYXZhaWxhYmxlIHVudGlsIGNvbm5lY3Rpb24gaGFzIGJlZW4gZXN0YWJsaXNoZWQuXG4gICAqL1xuICB0aGlzLm1heEFsbG93ZWRTaXplID0gMFxuXG4gIC8qKlxuICAgKiBLZWVwcyB0cmFjayBpZiB0aGUgZG93bnN0cmVhbSBzb2NrZXQgaXMgY3VycmVudGx5IGZ1bGwgYW5kXG4gICAqIGEgZHJhaW4gZXZlbnQgc2hvdWxkIGJlIHdhaXRlZCBmb3Igb3Igbm90XG4gICAqL1xuICB0aGlzLndhaXREcmFpbiA9IGZhbHNlXG5cbiAgLy8gUHJpdmF0ZSBwcm9wZXJ0aWVzXG5cbiAgLyoqXG4gICAqIFNNVFAgcmVzcG9uc2UgcGFyc2VyIG9iamVjdC4gQWxsIGRhdGEgY29taW5nIGZyb20gdGhlIGRvd25zdHJlYW0gc2VydmVyXG4gICAqIGlzIGZlZWRlZCB0byB0aGlzIHBhcnNlclxuICAgKi9cbiAgdGhpcy5fcGFyc2VyID0gbmV3IFNtdHBDbGllbnRSZXNwb25zZVBhcnNlcigpXG5cbiAgLyoqXG4gICAqIElmIGF1dGhlbnRpY2F0ZWQgc3VjY2Vzc2Z1bGx5LCBzdG9yZXMgdGhlIHVzZXJuYW1lXG4gICAqL1xuICB0aGlzLl9hdXRoZW50aWNhdGVkQXMgPSBudWxsXG5cbiAgLyoqXG4gICAqIEEgbGlzdCBvZiBhdXRoZW50aWNhdGlvbiBtZWNoYW5pc21zIGRldGVjdGVkIGZyb20gdGhlIEVITE8gcmVzcG9uc2VcbiAgICogYW5kIHdoaWNoIGFyZSBjb21wYXRpYmxlIHdpdGggdGhpcyBsaWJyYXJ5XG4gICAqL1xuICB0aGlzLl9zdXBwb3J0ZWRBdXRoID0gW11cblxuICAvKipcbiAgICogSWYgdHJ1ZSwgYWNjZXB0cyBkYXRhIGZyb20gdGhlIHVwc3RyZWFtIHRvIGJlIHBhc3NlZFxuICAgKiBkaXJlY3RseSB0byB0aGUgZG93bnN0cmVhbSBzb2NrZXQuIFVzZWQgYWZ0ZXIgdGhlIERBVEEgY29tbWFuZFxuICAgKi9cbiAgdGhpcy5fZGF0YU1vZGUgPSBmYWxzZVxuXG4gIC8qKlxuICAgKiBLZWVwIHRyYWNrIG9mIHRoZSBsYXN0IGJ5dGVzIHRvIHNlZSBob3cgdGhlIHRlcm1pbmF0aW5nIGRvdCBzaG91bGQgYmUgcGxhY2VkXG4gICAqL1xuICB0aGlzLl9sYXN0RGF0YUJ5dGVzID0gJydcblxuICAvKipcbiAgICogRW52ZWxvcGUgb2JqZWN0IGZvciB0cmFja2luZyB3aG8gaXMgc2VuZGluZyBtYWlsIHRvIHdob21cbiAgICovXG4gIHRoaXMuX2VudmVsb3BlID0gbnVsbFxuXG4gIC8qKlxuICAgKiBTdG9yZXMgdGhlIGZ1bmN0aW9uIHRoYXQgc2hvdWxkIGJlIHJ1biBhZnRlciBhIHJlc3BvbnNlIGhhcyBiZWVuIHJlY2VpdmVkXG4gICAqIGZyb20gdGhlIHNlcnZlclxuICAgKi9cbiAgdGhpcy5fY3VycmVudEFjdGlvbiA9IG51bGxcblxuICAvKipcbiAgICogSW5kaWNhdGVzIGlmIHRoZSBjb25uZWN0aW9uIGlzIHNlY3VyZWQgb3IgcGxhaW50ZXh0XG4gICAqL1xuICB0aGlzLl9zZWN1cmVNb2RlID0gISF0aGlzLm9wdGlvbnMudXNlU2VjdXJlVHJhbnNwb3J0XG5cbiAgLyoqXG4gICAqIFRpbWVyIHdhaXRpbmcgdG8gZGVjbGFyZSB0aGUgc29ja2V0IGRlYWQgc3RhcnRpbmcgZnJvbSB0aGUgbGFzdCB3cml0ZVxuICAgKi9cbiAgdGhpcy5fc29ja2V0VGltZW91dFRpbWVyID0gZmFsc2VcblxuICAvKipcbiAgICogU3RhcnQgdGltZSBvZiBzZW5kaW5nIHRoZSBmaXJzdCBwYWNrZXQgaW4gZGF0YSBtb2RlXG4gICAqL1xuICB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgPSBmYWxzZVxuXG4gIC8qKlxuICAgKiBUaW1lb3V0IGZvciBzZW5kaW5nIGluIGRhdGEgbW9kZSwgZ2V0cyBleHRlbmRlZCB3aXRoIGV2ZXJ5IHNlbmQoKVxuICAgKi9cbiAgdGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCA9IGZhbHNlXG5cbiAgLy8gQWN0aXZhdGUgbG9nZ2luZ1xuICB0aGlzLmNyZWF0ZUxvZ2dlcigpXG4gIHRoaXMubG9nTGV2ZWwgPSB0aGlzLkxPR19MRVZFTF9BTExcbn1cblxuLy9cbi8vIENPTlNUQU5UU1xuLy9cblxuLyoqXG4gKiBMb3dlciBCb3VuZCBmb3Igc29ja2V0IHRpbWVvdXQgdG8gd2FpdCBzaW5jZSB0aGUgbGFzdCBkYXRhIHdhcyB3cml0dGVuIHRvIGEgc29ja2V0XG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLlRJTUVPVVRfU09DS0VUX0xPV0VSX0JPVU5EID0gMTAwMDBcblxuLyoqXG4gKiBNdWx0aXBsaWVyIGZvciBzb2NrZXQgdGltZW91dDpcbiAqXG4gKiBXZSBhc3N1bWUgYXQgbGVhc3QgYSBHUFJTIGNvbm5lY3Rpb24gd2l0aCAxMTUga2IvcyA9IDE0LDM3NSBrQi9zIHRvcHMsIHNvIDEwIEtCL3MgdG8gYmUgb25cbiAqIHRoZSBzYWZlIHNpZGUuIFdlIGNhbiB0aW1lb3V0IGFmdGVyIGEgbG93ZXIgYm91bmQgb2YgMTBzICsgKG4gS0IgLyAxMCBLQi9zKS4gQSAxIE1CIG1lc3NhZ2VcbiAqIHVwbG9hZCB3b3VsZCBiZSAxMTAgc2Vjb25kcyB0byB3YWl0IGZvciB0aGUgdGltZW91dC4gMTAgS0IvcyA9PT0gMC4xIHMvQlxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5USU1FT1VUX1NPQ0tFVF9NVUxUSVBMSUVSID0gMC4xXG5cbi8vXG4vLyBFVkVOVFNcbi8vXG5cbi8vIEV2ZW50IGZ1bmN0aW9ucyBzaG91bGQgYmUgb3ZlcnJpZGVuLCB0aGVzZSBhcmUganVzdCBwbGFjZWhvbGRlcnNcblxuLyoqXG4gKiBXaWxsIGJlIHJ1biB3aGVuIGFuIGVycm9yIG9jY3Vycy4gQ29ubmVjdGlvbiB0byB0aGUgc2VydmVyIHdpbGwgYmUgY2xvc2VkIGF1dG9tYXRpY2FsbHksXG4gKiBzbyB3YWl0IGZvciBhbiBgb25jbG9zZWAgZXZlbnQgYXMgd2VsbC5cbiAqXG4gKiBAcGFyYW0ge0Vycm9yfSBlcnIgRXJyb3Igb2JqZWN0XG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLm9uZXJyb3IgPSBmdW5jdGlvbiAoKSB7IH1cblxuLyoqXG4gKiBNb3JlIGRhdGEgY2FuIGJlIGJ1ZmZlcmVkIGluIHRoZSBzb2NrZXQuIFNlZSBgd2FpdERyYWluYCBwcm9wZXJ0eSBvclxuICogY2hlY2sgaWYgYHNlbmRgIG1ldGhvZCByZXR1cm5zIGZhbHNlIHRvIHNlZSBpZiB5b3Ugc2hvdWxkIGJlIHdhaXRpbmdcbiAqIGZvciB0aGUgZHJhaW4gZXZlbnQuIEJlZm9yZSBzZW5kaW5nIGFueXRoaW5nIGVsc2UuXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLm9uZHJhaW4gPSBmdW5jdGlvbiAoKSB7IH1cblxuLyoqXG4gKiBUaGUgY29ubmVjdGlvbiB0byB0aGUgc2VydmVyIGhhcyBiZWVuIGNsb3NlZFxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5vbmNsb3NlID0gZnVuY3Rpb24gKCkgeyB9XG5cbi8qKlxuICogVGhlIGNvbm5lY3Rpb24gaXMgZXN0YWJsaXNoZWQgYW5kIGlkbGUsIHlvdSBjYW4gc2VuZCBtYWlsIG5vd1xuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5vbmlkbGUgPSBmdW5jdGlvbiAoKSB7IH1cblxuLyoqXG4gKiBUaGUgY29ubmVjdGlvbiBpcyB3YWl0aW5nIGZvciB0aGUgbWFpbCBib2R5XG4gKlxuICogQHBhcmFtIHtBcnJheX0gZmFpbGVkUmVjaXBpZW50cyBMaXN0IG9mIGFkZHJlc3NlcyB0aGF0IHdlcmUgbm90IGFjY2VwdGVkIGFzIHJlY2lwaWVudHNcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUub25yZWFkeSA9IGZ1bmN0aW9uICgpIHsgfVxuXG4vKipcbiAqIFRoZSBtYWlsIGhhcyBiZWVuIHNlbnQuXG4gKiBXYWl0IGZvciBgb25pZGxlYCBuZXh0LlxuICpcbiAqIEBwYXJhbSB7Qm9vbGVhbn0gc3VjY2VzcyBJbmRpY2F0ZXMgaWYgdGhlIG1lc3NhZ2Ugd2FzIHF1ZXVlZCBieSB0aGUgc2VydmVyIG9yIG5vdFxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5vbmRvbmUgPSBmdW5jdGlvbiAoKSB7IH1cblxuLy9cbi8vIFBVQkxJQyBNRVRIT0RTXG4vL1xuXG4vLyBDb25uZWN0aW9uIHJlbGF0ZWQgbWV0aG9kc1xuXG4vKipcbiAqIEluaXRpYXRlIGEgY29ubmVjdGlvbiB0byB0aGUgc2VydmVyXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLmNvbm5lY3QgPSBmdW5jdGlvbiAoKSB7XG4gIHRoaXMuc29ja2V0ID0gdGhpcy5fVENQU29ja2V0Lm9wZW4odGhpcy5ob3N0LCB0aGlzLnBvcnQsIHtcbiAgICBiaW5hcnlUeXBlOiAnYXJyYXlidWZmZXInLFxuICAgIHVzZVNlY3VyZVRyYW5zcG9ydDogdGhpcy5fc2VjdXJlTW9kZSxcbiAgICBjYTogdGhpcy5vcHRpb25zLmNhLFxuICAgIHRsc1dvcmtlclBhdGg6IHRoaXMub3B0aW9ucy50bHNXb3JrZXJQYXRoLFxuICAgIHdzOiB0aGlzLm9wdGlvbnMud3NcbiAgfSlcblxuICAvLyBhbGxvd3MgY2VydGlmaWNhdGUgaGFuZGxpbmcgZm9yIHBsYXRmb3JtIHcvbyBuYXRpdmUgdGxzIHN1cHBvcnRcbiAgLy8gb25jZXJ0IGlzIG5vbiBzdGFuZGFyZCBzbyBzZXR0aW5nIGl0IG1pZ2h0IHRocm93IGlmIHRoZSBzb2NrZXQgb2JqZWN0IGlzIGltbXV0YWJsZVxuICB0cnkge1xuICAgIHRoaXMuc29ja2V0Lm9uY2VydCA9IHRoaXMub25jZXJ0XG4gIH0gY2F0Y2ggKEUpIHsgfVxuICB0aGlzLnNvY2tldC5vbmVycm9yID0gdGhpcy5fb25FcnJvci5iaW5kKHRoaXMpXG4gIHRoaXMuc29ja2V0Lm9ub3BlbiA9IHRoaXMuX29uT3Blbi5iaW5kKHRoaXMpXG59XG5cbi8qKlxuICogUGF1c2VzIGBkYXRhYCBldmVudHMgZnJvbSB0aGUgZG93bnN0cmVhbSBTTVRQIHNlcnZlclxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5zdXNwZW5kID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5zb2NrZXQgJiYgdGhpcy5zb2NrZXQucmVhZHlTdGF0ZSA9PT0gJ29wZW4nKSB7XG4gICAgdGhpcy5zb2NrZXQuc3VzcGVuZCgpXG4gIH1cbn1cblxuLyoqXG4gKiBSZXN1bWVzIGBkYXRhYCBldmVudHMgZnJvbSB0aGUgZG93bnN0cmVhbSBTTVRQIHNlcnZlci4gQmUgY2FyZWZ1bCBvZiBub3RcbiAqIHJlc3VtaW5nIHNvbWV0aGluZyB0aGF0IGlzIG5vdCBzdXNwZW5kZWQgLSBhbiBlcnJvciBpcyB0aHJvd24gaW4gdGhpcyBjYXNlXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLnJlc3VtZSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuc29ja2V0ICYmIHRoaXMuc29ja2V0LnJlYWR5U3RhdGUgPT09ICdvcGVuJykge1xuICAgIHRoaXMuc29ja2V0LnJlc3VtZSgpXG4gIH1cbn1cblxuLyoqXG4gKiBTZW5kcyBRVUlUXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLnF1aXQgPSBmdW5jdGlvbiAoKSB7XG4gIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgUVVJVC4uLicpXG4gIHRoaXMuX3NlbmRDb21tYW5kKCdRVUlUJylcbiAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuY2xvc2Vcbn1cblxuLyoqXG4gKiBSZXNldCBhdXRoZW50aWNhdGlvblxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBbYXV0aF0gVXNlIHRoaXMgaWYgeW91IHdhbnQgdG8gYXV0aGVudGljYXRlIGFzIGFub3RoZXIgdXNlclxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5yZXNldCA9IGZ1bmN0aW9uIChhdXRoKSB7XG4gIHRoaXMub3B0aW9ucy5hdXRoID0gYXV0aCB8fCB0aGlzLm9wdGlvbnMuYXV0aFxuICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIFJTRVQuLi4nKVxuICB0aGlzLl9zZW5kQ29tbWFuZCgnUlNFVCcpXG4gIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25SU0VUXG59XG5cbi8qKlxuICogQ2xvc2VzIHRoZSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXJcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuY2xvc2UgPSBmdW5jdGlvbiAoKSB7XG4gIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0Nsb3NpbmcgY29ubmVjdGlvbi4uLicpXG4gIGlmICh0aGlzLnNvY2tldCAmJiB0aGlzLnNvY2tldC5yZWFkeVN0YXRlID09PSAnb3BlbicpIHtcbiAgICB0aGlzLnNvY2tldC5jbG9zZSgpXG4gIH0gZWxzZSB7XG4gICAgdGhpcy5fZGVzdHJveSgpXG4gIH1cbn1cblxuLy8gTWFpbCByZWxhdGVkIG1ldGhvZHNcblxuLyoqXG4gKiBJbml0aWF0ZXMgYSBuZXcgbWVzc2FnZSBieSBzdWJtaXR0aW5nIGVudmVsb3BlIGRhdGEsIHN0YXJ0aW5nIHdpdGhcbiAqIGBNQUlMIEZST006YCBjb21tYW5kLiBVc2UgYWZ0ZXIgYG9uaWRsZWAgZXZlbnRcbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gZW52ZWxvcGUgRW52ZWxvcGUgb2JqZWN0IGluIHRoZSBmb3JtIG9mIHtmcm9tOlwiLi4uXCIsIHRvOltcIi4uLlwiXX1cbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUudXNlRW52ZWxvcGUgPSBmdW5jdGlvbiAoZW52ZWxvcGUpIHtcbiAgdGhpcy5fZW52ZWxvcGUgPSBlbnZlbG9wZSB8fCB7fVxuICB0aGlzLl9lbnZlbG9wZS5mcm9tID0gW10uY29uY2F0KHRoaXMuX2VudmVsb3BlLmZyb20gfHwgKCdhbm9ueW1vdXNAJyArIHRoaXMub3B0aW9ucy5uYW1lKSlbMF1cbiAgdGhpcy5fZW52ZWxvcGUudG8gPSBbXS5jb25jYXQodGhpcy5fZW52ZWxvcGUudG8gfHwgW10pXG5cbiAgLy8gY2xvbmUgdGhlIHJlY2lwaWVudHMgYXJyYXkgZm9yIGxhdHRlciBtYW5pcHVsYXRpb25cbiAgdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlID0gW10uY29uY2F0KHRoaXMuX2VudmVsb3BlLnRvKVxuICB0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkID0gW11cbiAgdGhpcy5fZW52ZWxvcGUucmVzcG9uc2VRdWV1ZSA9IFtdXG5cbiAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbk1BSUxcbiAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBNQUlMIEZST00uLi4nKVxuICB0aGlzLl9zZW5kQ29tbWFuZCgnTUFJTCBGUk9NOjwnICsgKHRoaXMuX2VudmVsb3BlLmZyb20pICsgJz4nKVxufVxuXG4vKipcbiAqIFNlbmQgQVNDSUkgZGF0YSB0byB0aGUgc2VydmVyLiBXb3JrcyBvbmx5IGluIGRhdGEgbW9kZSAoYWZ0ZXIgYG9ucmVhZHlgIGV2ZW50KSwgaWdub3JlZFxuICogb3RoZXJ3aXNlXG4gKlxuICogQHBhcmFtIHtTdHJpbmd9IGNodW5rIEFTQ0lJIHN0cmluZyAocXVvdGVkLXByaW50YWJsZSwgYmFzZTY0IGV0Yy4pIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICogQHJldHVybiB7Qm9vbGVhbn0gSWYgdHJ1ZSwgaXQgaXMgc2FmZSB0byBzZW5kIG1vcmUgZGF0YSwgaWYgZmFsc2UsIHlvdSAqc2hvdWxkKiB3YWl0IGZvciB0aGUgb25kcmFpbiBldmVudCBiZWZvcmUgc2VuZGluZyBtb3JlXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLnNlbmQgPSBmdW5jdGlvbiAoY2h1bmspIHtcbiAgLy8gd29ya3Mgb25seSBpbiBkYXRhIG1vZGVcbiAgaWYgKCF0aGlzLl9kYXRhTW9kZSkge1xuICAgIC8vIHRoaXMgbGluZSBzaG91bGQgbmV2ZXIgYmUgcmVhY2hlZCBidXQgaWYgaXQgZG9lcyxcbiAgICAvLyBhY3QgbGlrZSBldmVyeXRoaW5nJ3Mgbm9ybWFsLlxuICAgIHJldHVybiB0cnVlXG4gIH1cblxuICAvLyBUT0RPOiBpZiB0aGUgY2h1bmsgaXMgYW4gYXJyYXlidWZmZXIsIHVzZSBhIHNlcGFyYXRlIGZ1bmN0aW9uIHRvIHNlbmQgdGhlIGRhdGFcbiAgcmV0dXJuIHRoaXMuX3NlbmRTdHJpbmcoY2h1bmspXG59XG5cbi8qKlxuICogSW5kaWNhdGVzIHRoYXQgYSBkYXRhIHN0cmVhbSBmb3IgdGhlIHNvY2tldCBpcyBlbmRlZC4gV29ya3Mgb25seSBpbiBkYXRhXG4gKiBtb2RlIChhZnRlciBgb25yZWFkeWAgZXZlbnQpLCBpZ25vcmVkIG90aGVyd2lzZS4gVXNlIGl0IHdoZW4geW91IGFyZSBkb25lXG4gKiB3aXRoIHNlbmRpbmcgdGhlIG1haWwuIFRoaXMgbWV0aG9kIGRvZXMgbm90IGNsb3NlIHRoZSBzb2NrZXQuIE9uY2UgdGhlIG1haWxcbiAqIGhhcyBiZWVuIHF1ZXVlZCBieSB0aGUgc2VydmVyLCBgb25kb25lYCBhbmQgYG9uaWRsZWAgYXJlIGVtaXR0ZWQuXG4gKlxuICogQHBhcmFtIHtCdWZmZXJ9IFtjaHVua10gQ2h1bmsgb2YgZGF0YSB0byBiZSBzZW50IHRvIHRoZSBzZXJ2ZXJcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuZW5kID0gZnVuY3Rpb24gKGNodW5rKSB7XG4gIC8vIHdvcmtzIG9ubHkgaW4gZGF0YSBtb2RlXG4gIGlmICghdGhpcy5fZGF0YU1vZGUpIHtcbiAgICAvLyB0aGlzIGxpbmUgc2hvdWxkIG5ldmVyIGJlIHJlYWNoZWQgYnV0IGlmIGl0IGRvZXMsXG4gICAgLy8gYWN0IGxpa2UgZXZlcnl0aGluZydzIG5vcm1hbC5cbiAgICByZXR1cm4gdHJ1ZVxuICB9XG5cbiAgaWYgKGNodW5rICYmIGNodW5rLmxlbmd0aCkge1xuICAgIHRoaXMuc2VuZChjaHVuaylcbiAgfVxuXG4gIC8vIHJlZGlyZWN0IG91dHB1dCBmcm9tIHRoZSBzZXJ2ZXIgdG8gX2FjdGlvblN0cmVhbVxuICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uU3RyZWFtXG5cbiAgLy8gaW5kaWNhdGUgdGhhdCB0aGUgc3RyZWFtIGhhcyBlbmRlZCBieSBzZW5kaW5nIGEgc2luZ2xlIGRvdCBvbiBpdHMgb3duIGxpbmVcbiAgLy8gaWYgdGhlIGNsaWVudCBhbHJlYWR5IGNsb3NlZCB0aGUgZGF0YSB3aXRoIFxcclxcbiBubyBuZWVkIHRvIGRvIGl0IGFnYWluXG4gIGlmICh0aGlzLl9sYXN0RGF0YUJ5dGVzID09PSAnXFxyXFxuJykge1xuICAgIHRoaXMud2FpdERyYWluID0gdGhpcy5fc2VuZChuZXcgVWludDhBcnJheShbMHgyRSwgMHgwRCwgMHgwQV0pLmJ1ZmZlcikgLy8gLlxcclxcblxuICB9IGVsc2UgaWYgKHRoaXMuX2xhc3REYXRhQnl0ZXMuc3Vic3RyKC0xKSA9PT0gJ1xccicpIHtcbiAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFVpbnQ4QXJyYXkoWzB4MEEsIDB4MkUsIDB4MEQsIDB4MEFdKS5idWZmZXIpIC8vIFxcbi5cXHJcXG5cbiAgfSBlbHNlIHtcbiAgICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFVpbnQ4QXJyYXkoWzB4MEQsIDB4MEEsIDB4MkUsIDB4MEQsIDB4MEFdKS5idWZmZXIpIC8vIFxcclxcbi5cXHJcXG5cbiAgfVxuXG4gIC8vIGVuZCBkYXRhIG1vZGUsIHJlc2V0IHRoZSB2YXJpYWJsZXMgZm9yIGV4dGVuZGluZyB0aGUgdGltZW91dCBpbiBkYXRhIG1vZGVcbiAgdGhpcy5fZGF0YU1vZGUgPSBmYWxzZVxuICB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgPSBmYWxzZVxuICB0aGlzLl9zb2NrZXRUaW1lb3V0UGVyaW9kID0gZmFsc2VcblxuICByZXR1cm4gdGhpcy53YWl0RHJhaW5cbn1cblxuLy8gUFJJVkFURSBNRVRIT0RTXG5cbi8vIEVWRU5UIEhBTkRMRVJTIEZPUiBUSEUgU09DS0VUXG5cbi8qKlxuICogQ29ubmVjdGlvbiBsaXN0ZW5lciB0aGF0IGlzIHJ1biB3aGVuIHRoZSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXIgaXMgb3BlbmVkLlxuICogU2V0cyB1cCBkaWZmZXJlbnQgZXZlbnQgaGFuZGxlcnMgZm9yIHRoZSBvcGVuZWQgc29ja2V0XG4gKlxuICogQGV2ZW50XG4gKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBOb3QgdXNlZFxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fb25PcGVuID0gZnVuY3Rpb24gKGV2ZW50KSB7XG4gIGlmIChldmVudCAmJiBldmVudC5kYXRhICYmIGV2ZW50LmRhdGEucHJveHlIb3N0bmFtZSkge1xuICAgIHRoaXMub3B0aW9ucy5uYW1lID0gZXZlbnQuZGF0YS5wcm94eUhvc3RuYW1lXG4gIH1cblxuICB0aGlzLnNvY2tldC5vbmRhdGEgPSB0aGlzLl9vbkRhdGEuYmluZCh0aGlzKVxuXG4gIHRoaXMuc29ja2V0Lm9uY2xvc2UgPSB0aGlzLl9vbkNsb3NlLmJpbmQodGhpcylcbiAgdGhpcy5zb2NrZXQub25kcmFpbiA9IHRoaXMuX29uRHJhaW4uYmluZCh0aGlzKVxuXG4gIHRoaXMuX3BhcnNlci5vbmRhdGEgPSB0aGlzLl9vbkNvbW1hbmQuYmluZCh0aGlzKVxuXG4gIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25HcmVldGluZ1xufVxuXG4vKipcbiAqIERhdGEgbGlzdGVuZXIgZm9yIGNodW5rcyBvZiBkYXRhIGVtaXR0ZWQgYnkgdGhlIHNlcnZlclxuICpcbiAqIEBldmVudFxuICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gU2VlIGBldnQuZGF0YWAgZm9yIHRoZSBjaHVuayByZWNlaXZlZFxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fb25EYXRhID0gZnVuY3Rpb24gKGV2dCkge1xuICBjbGVhclRpbWVvdXQodGhpcy5fc29ja2V0VGltZW91dFRpbWVyKVxuICB2YXIgc3RyaW5nUGF5bG9hZCA9IG5ldyBUZXh0RGVjb2RlcignVVRGLTgnKS5kZWNvZGUobmV3IFVpbnQ4QXJyYXkoZXZ0LmRhdGEpKVxuICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTRVJWRVI6ICcgKyBzdHJpbmdQYXlsb2FkKVxuICB0aGlzLl9wYXJzZXIuc2VuZChzdHJpbmdQYXlsb2FkKVxufVxuXG4vKipcbiAqIE1vcmUgZGF0YSBjYW4gYmUgYnVmZmVyZWQgaW4gdGhlIHNvY2tldCwgYHdhaXREcmFpbmAgaXMgcmVzZXQgdG8gZmFsc2VcbiAqXG4gKiBAZXZlbnRcbiAqIEBwYXJhbSB7RXZlbnR9IGV2dCBFdmVudCBvYmplY3QuIE5vdCB1c2VkXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9vbkRyYWluID0gZnVuY3Rpb24gKCkge1xuICB0aGlzLndhaXREcmFpbiA9IGZhbHNlXG4gIHRoaXMub25kcmFpbigpXG59XG5cbi8qKlxuICogRXJyb3IgaGFuZGxlciBmb3IgdGhlIHNvY2tldFxuICpcbiAqIEBldmVudFxuICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gU2VlIGV2dC5kYXRhIGZvciB0aGUgZXJyb3JcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX29uRXJyb3IgPSBmdW5jdGlvbiAoZXZ0KSB7XG4gIGlmIChldnQgaW5zdGFuY2VvZiBFcnJvciAmJiBldnQubWVzc2FnZSkge1xuICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgZXZ0KVxuICAgIHRoaXMub25lcnJvcihldnQpXG4gIH0gZWxzZSBpZiAoZXZ0ICYmIGV2dC5kYXRhIGluc3RhbmNlb2YgRXJyb3IpIHtcbiAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsIGV2dC5kYXRhKVxuICAgIHRoaXMub25lcnJvcihldnQuZGF0YSlcbiAgfSBlbHNlIHtcbiAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsIG5ldyBFcnJvcigoZXZ0ICYmIGV2dC5kYXRhICYmIGV2dC5kYXRhLm1lc3NhZ2UpIHx8IGV2dC5kYXRhIHx8IGV2dCB8fCAnRXJyb3InKSlcbiAgICB0aGlzLm9uZXJyb3IobmV3IEVycm9yKChldnQgJiYgZXZ0LmRhdGEgJiYgZXZ0LmRhdGEubWVzc2FnZSkgfHwgZXZ0LmRhdGEgfHwgZXZ0IHx8ICdFcnJvcicpKVxuICB9XG5cbiAgdGhpcy5jbG9zZSgpXG59XG5cbi8qKlxuICogSW5kaWNhdGVzIHRoYXQgdGhlIHNvY2tldCBoYXMgYmVlbiBjbG9zZWRcbiAqXG4gKiBAZXZlbnRcbiAqIEBwYXJhbSB7RXZlbnR9IGV2dCBFdmVudCBvYmplY3QuIE5vdCB1c2VkXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9vbkNsb3NlID0gZnVuY3Rpb24gKCkge1xuICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTb2NrZXQgY2xvc2VkLicpXG4gIHRoaXMuX2Rlc3Ryb3koKVxufVxuXG4vKipcbiAqIFRoaXMgaXMgbm90IGEgc29ja2V0IGRhdGEgaGFuZGxlciBidXQgdGhlIGhhbmRsZXIgZm9yIGRhdGEgZW1pdHRlZCBieSB0aGUgcGFyc2VyLFxuICogc28gdGhpcyBkYXRhIGlzIHNhZmUgdG8gdXNlIGFzIGl0IGlzIGFsd2F5cyBjb21wbGV0ZSAoc2VydmVyIG1pZ2h0IHNlbmQgcGFydGlhbCBjaHVua3MpXG4gKlxuICogQGV2ZW50XG4gKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgZGF0YVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fb25Db21tYW5kID0gZnVuY3Rpb24gKGNvbW1hbmQpIHtcbiAgaWYgKHR5cGVvZiB0aGlzLl9jdXJyZW50QWN0aW9uID09PSAnZnVuY3Rpb24nKSB7XG4gICAgdGhpcy5fY3VycmVudEFjdGlvbihjb21tYW5kKVxuICB9XG59XG5cblNtdHBDbGllbnQucHJvdG90eXBlLl9vblRpbWVvdXQgPSBmdW5jdGlvbiAoKSB7XG4gIC8vIGluZm9ybSBhYm91dCB0aGUgdGltZW91dCBhbmQgc2h1dCBkb3duXG4gIHZhciBlcnJvciA9IG5ldyBFcnJvcignU29ja2V0IHRpbWVkIG91dCEnKVxuICB0aGlzLl9vbkVycm9yKGVycm9yKVxufVxuXG4vKipcbiAqIEVuc3VyZXMgdGhhdCB0aGUgY29ubmVjdGlvbiBpcyBjbG9zZWQgYW5kIHN1Y2hcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2Rlc3Ryb3kgPSBmdW5jdGlvbiAoKSB7XG4gIGNsZWFyVGltZW91dCh0aGlzLl9zb2NrZXRUaW1lb3V0VGltZXIpXG5cbiAgaWYgKCF0aGlzLmRlc3Ryb3llZCkge1xuICAgIHRoaXMuZGVzdHJveWVkID0gdHJ1ZVxuICAgIHRoaXMub25jbG9zZSgpXG4gIH1cbn1cblxuLyoqXG4gKiBTZW5kcyBhIHN0cmluZyB0byB0aGUgc29ja2V0LlxuICpcbiAqIEBwYXJhbSB7U3RyaW5nfSBjaHVuayBBU0NJSSBzdHJpbmcgKHF1b3RlZC1wcmludGFibGUsIGJhc2U2NCBldGMuKSB0byBiZSBzZW50IHRvIHRoZSBzZXJ2ZXJcbiAqIEByZXR1cm4ge0Jvb2xlYW59IElmIHRydWUsIGl0IGlzIHNhZmUgdG8gc2VuZCBtb3JlIGRhdGEsIGlmIGZhbHNlLCB5b3UgKnNob3VsZCogd2FpdCBmb3IgdGhlIG9uZHJhaW4gZXZlbnQgYmVmb3JlIHNlbmRpbmcgbW9yZVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fc2VuZFN0cmluZyA9IGZ1bmN0aW9uIChjaHVuaykge1xuICAvLyBlc2NhcGUgZG90c1xuICBpZiAoIXRoaXMub3B0aW9ucy5kaXNhYmxlRXNjYXBpbmcpIHtcbiAgICBjaHVuayA9IGNodW5rLnJlcGxhY2UoL1xcblxcLi9nLCAnXFxuLi4nKVxuICAgIGlmICgodGhpcy5fbGFzdERhdGFCeXRlcy5zdWJzdHIoLTEpID09PSAnXFxuJyB8fCAhdGhpcy5fbGFzdERhdGFCeXRlcykgJiYgY2h1bmsuY2hhckF0KDApID09PSAnLicpIHtcbiAgICAgIGNodW5rID0gJy4nICsgY2h1bmtcbiAgICB9XG4gIH1cblxuICAvLyBLZWVwaW5nIGV5ZSBvbiB0aGUgbGFzdCBieXRlcyBzZW50LCB0byBzZWUgaWYgdGhlcmUgaXMgYSA8Q1I+PExGPiBzZXF1ZW5jZVxuICAvLyBhdCB0aGUgZW5kIHdoaWNoIGlzIG5lZWRlZCB0byBlbmQgdGhlIGRhdGEgc3RyZWFtXG4gIGlmIChjaHVuay5sZW5ndGggPiAyKSB7XG4gICAgdGhpcy5fbGFzdERhdGFCeXRlcyA9IGNodW5rLnN1YnN0cigtMilcbiAgfSBlbHNlIGlmIChjaHVuay5sZW5ndGggPT09IDEpIHtcbiAgICB0aGlzLl9sYXN0RGF0YUJ5dGVzID0gdGhpcy5fbGFzdERhdGFCeXRlcy5zdWJzdHIoLTEpICsgY2h1bmtcbiAgfVxuXG4gIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgJyArIGNodW5rLmxlbmd0aCArICcgYnl0ZXMgb2YgcGF5bG9hZCcpXG5cbiAgLy8gcGFzcyB0aGUgY2h1bmsgdG8gdGhlIHNvY2tldFxuICB0aGlzLndhaXREcmFpbiA9IHRoaXMuX3NlbmQobmV3IFRleHRFbmNvZGVyKCdVVEYtOCcpLmVuY29kZShjaHVuaykuYnVmZmVyKVxuICByZXR1cm4gdGhpcy53YWl0RHJhaW5cbn1cblxuLyoqXG4gKiBTZW5kIGEgc3RyaW5nIGNvbW1hbmQgdG8gdGhlIHNlcnZlciwgYWxzbyBhcHBlbmQgXFxyXFxuIGlmIG5lZWRlZFxuICpcbiAqIEBwYXJhbSB7U3RyaW5nfSBzdHIgU3RyaW5nIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fc2VuZENvbW1hbmQgPSBmdW5jdGlvbiAoc3RyKSB7XG4gIHRoaXMud2FpdERyYWluID0gdGhpcy5fc2VuZChuZXcgVGV4dEVuY29kZXIoJ1VURi04JykuZW5jb2RlKHN0ciArIChzdHIuc3Vic3RyKC0yKSAhPT0gJ1xcclxcbicgPyAnXFxyXFxuJyA6ICcnKSkuYnVmZmVyKVxufVxuXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fc2VuZCA9IGZ1bmN0aW9uIChidWZmZXIpIHtcbiAgdGhpcy5fc2V0VGltZW91dChidWZmZXIuYnl0ZUxlbmd0aClcbiAgcmV0dXJuIHRoaXMuc29ja2V0LnNlbmQoYnVmZmVyKVxufVxuXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fc2V0VGltZW91dCA9IGZ1bmN0aW9uIChieXRlTGVuZ3RoKSB7XG4gIHZhciBwcm9sb25nUGVyaW9kID0gTWF0aC5mbG9vcihieXRlTGVuZ3RoICogdGhpcy5USU1FT1VUX1NPQ0tFVF9NVUxUSVBMSUVSKVxuICB2YXIgdGltZW91dFxuXG4gIGlmICh0aGlzLl9kYXRhTW9kZSkge1xuICAgIC8vIHdlJ3JlIGluIGRhdGEgbW9kZSwgc28gd2UgY291bnQgb25seSBvbmUgdGltZW91dCB0aGF0IGdldCBleHRlbmRlZCBmb3IgZXZlcnkgc2VuZCgpLlxuICAgIHZhciBub3cgPSBEYXRlLm5vdygpXG5cbiAgICAvLyB0aGUgb2xkIHRpbWVvdXQgc3RhcnQgdGltZVxuICAgIHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCA9IHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCB8fCBub3dcblxuICAgIC8vIHRoZSBvbGQgdGltZW91dCBwZXJpb2QsIG5vcm1hbGl6ZWQgdG8gYSBtaW5pbXVtIG9mIFRJTUVPVVRfU09DS0VUX0xPV0VSX0JPVU5EXG4gICAgdGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCA9ICh0aGlzLl9zb2NrZXRUaW1lb3V0UGVyaW9kIHx8IHRoaXMuVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkQpICsgcHJvbG9uZ1BlcmlvZFxuXG4gICAgLy8gdGhlIG5ldyB0aW1lb3V0IGlzIHRoZSBkZWx0YSBiZXR3ZWVuIHRoZSBuZXcgZmlyaW5nIHRpbWUgKD0gdGltZW91dCBwZXJpb2QgKyB0aW1lb3V0IHN0YXJ0IHRpbWUpIGFuZCBub3dcbiAgICB0aW1lb3V0ID0gdGhpcy5fc29ja2V0VGltZW91dFN0YXJ0ICsgdGhpcy5fc29ja2V0VGltZW91dFBlcmlvZCAtIG5vd1xuICB9IGVsc2Uge1xuICAgIC8vIHNldCBuZXcgdGltb3V0XG4gICAgdGltZW91dCA9IHRoaXMuVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkQgKyBwcm9sb25nUGVyaW9kXG4gIH1cblxuICBjbGVhclRpbWVvdXQodGhpcy5fc29ja2V0VGltZW91dFRpbWVyKSAvLyBjbGVhciBwZW5kaW5nIHRpbWVvdXRzXG4gIHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lciA9IHNldFRpbWVvdXQodGhpcy5fb25UaW1lb3V0LmJpbmQodGhpcyksIHRpbWVvdXQpIC8vIGFybSB0aGUgbmV4dCB0aW1lb3V0XG59XG5cbi8qKlxuICogSW50aXRpYXRlIGF1dGhlbnRpY2F0aW9uIHNlcXVlbmNlIGlmIG5lZWRlZFxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fYXV0aGVudGljYXRlVXNlciA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLm9wdGlvbnMuYXV0aCkge1xuICAgIC8vIG5vIG5lZWQgdG8gYXV0aGVudGljYXRlLCBhdCBsZWFzdCBubyBkYXRhIGdpdmVuXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICB0aGlzLm9uaWRsZSgpIC8vIHJlYWR5IHRvIHRha2Ugb3JkZXJzXG4gICAgcmV0dXJuXG4gIH1cblxuICB2YXIgYXV0aFxuXG4gIGlmICghdGhpcy5vcHRpb25zLmF1dGhNZXRob2QgJiYgdGhpcy5vcHRpb25zLmF1dGgueG9hdXRoMikge1xuICAgIHRoaXMub3B0aW9ucy5hdXRoTWV0aG9kID0gJ1hPQVVUSDInXG4gIH1cblxuICBpZiAodGhpcy5vcHRpb25zLmF1dGhNZXRob2QpIHtcbiAgICBhdXRoID0gdGhpcy5vcHRpb25zLmF1dGhNZXRob2QudG9VcHBlckNhc2UoKS50cmltKClcbiAgfSBlbHNlIHtcbiAgICAvLyB1c2UgZmlyc3Qgc3VwcG9ydGVkXG4gICAgYXV0aCA9ICh0aGlzLl9zdXBwb3J0ZWRBdXRoWzBdIHx8ICdQTEFJTicpLnRvVXBwZXJDYXNlKCkudHJpbSgpXG4gIH1cblxuICBzd2l0Y2ggKGF1dGgpIHtcbiAgICBjYXNlICdMT0dJTic6XG4gICAgICAvLyBMT0dJTiBpcyBhIDMgc3RlcCBhdXRoZW50aWNhdGlvbiBwcm9jZXNzXG4gICAgICAvLyBDOiBBVVRIIExPR0lOXG4gICAgICAvLyBDOiBCQVNFNjQoVVNFUilcbiAgICAgIC8vIEM6IEJBU0U2NChQQVNTKVxuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQXV0aGVudGljYXRpb24gdmlhIEFVVEggTE9HSU4nKVxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhfTE9HSU5fVVNFUlxuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0FVVEggTE9HSU4nKVxuICAgICAgcmV0dXJuXG4gICAgY2FzZSAnUExBSU4nOlxuICAgICAgLy8gQVVUSCBQTEFJTiBpcyBhIDEgc3RlcCBhdXRoZW50aWNhdGlvbiBwcm9jZXNzXG4gICAgICAvLyBDOiBBVVRIIFBMQUlOIEJBU0U2NChcXDAgVVNFUiBcXDAgUEFTUylcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0F1dGhlbnRpY2F0aW9uIHZpYSBBVVRIIFBMQUlOJylcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIQ29tcGxldGVcbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKFxuICAgICAgICAvLyBjb252ZXJ0IHRvIEJBU0U2NFxuICAgICAgICAnQVVUSCBQTEFJTiAnICtcbiAgICAgICAgZW5jb2RlKFxuICAgICAgICAgIC8vIHRoaXMub3B0aW9ucy5hdXRoLnVzZXIrJ1xcdTAwMDAnK1xuICAgICAgICAgICdcXHUwMDAwJyArIC8vIHNraXAgYXV0aG9yaXphdGlvbiBpZGVudGl0eSBhcyBpdCBjYXVzZXMgcHJvYmxlbXMgd2l0aCBzb21lIHNlcnZlcnNcbiAgICAgICAgICB0aGlzLm9wdGlvbnMuYXV0aC51c2VyICsgJ1xcdTAwMDAnICtcbiAgICAgICAgICB0aGlzLm9wdGlvbnMuYXV0aC5wYXNzKVxuICAgICAgKVxuICAgICAgcmV0dXJuXG4gICAgY2FzZSAnWE9BVVRIMic6XG4gICAgICAvLyBTZWUgaHR0cHM6Ly9kZXZlbG9wZXJzLmdvb2dsZS5jb20vZ21haWwveG9hdXRoMl9wcm90b2NvbCNzbXRwX3Byb3RvY29sX2V4Y2hhbmdlXG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiB2aWEgQVVUSCBYT0FVVEgyJylcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIX1hPQVVUSDJcbiAgICAgIHRoaXMuX3NlbmRDb21tYW5kKCdBVVRIIFhPQVVUSDIgJyArIHRoaXMuX2J1aWxkWE9BdXRoMlRva2VuKHRoaXMub3B0aW9ucy5hdXRoLnVzZXIsIHRoaXMub3B0aW9ucy5hdXRoLnhvYXV0aDIpKVxuICAgICAgcmV0dXJuXG4gIH1cblxuICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignVW5rbm93biBhdXRoZW50aWNhdGlvbiBtZXRob2QgJyArIGF1dGgpKVxufVxuXG4vLyBBQ1RJT05TIEZPUiBSRVNQT05TRVMgRlJPTSBUSEUgU01UUCBTRVJWRVJcblxuLyoqXG4gKiBJbml0aWFsIHJlc3BvbnNlIGZyb20gdGhlIHNlcnZlciwgbXVzdCBoYXZlIGEgc3RhdHVzIDIyMFxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2FjdGlvbkdyZWV0aW5nID0gZnVuY3Rpb24gKGNvbW1hbmQpIHtcbiAgaWYgKGNvbW1hbmQuc3RhdHVzQ29kZSAhPT0gMjIwKSB7XG4gICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ0ludmFsaWQgZ3JlZXRpbmc6ICcgKyBjb21tYW5kLmRhdGEpKVxuICAgIHJldHVyblxuICB9XG5cbiAgaWYgKHRoaXMub3B0aW9ucy5sbXRwKSB7XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBMSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcblxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25MSExPXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoJ0xITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICB9IGVsc2Uge1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgRUhMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG5cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uRUhMT1xuICAgIHRoaXMuX3NlbmRDb21tYW5kKCdFSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbiAgfVxufVxuXG4vKipcbiAqIFJlc3BvbnNlIHRvIExITE9cbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9hY3Rpb25MSExPID0gZnVuY3Rpb24gKGNvbW1hbmQpIHtcbiAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdMSExPIG5vdCBzdWNjZXNzZnVsJylcbiAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgIHJldHVyblxuICB9XG5cbiAgLy8gUHJvY2VzcyBhcyBFSExPIHJlc3BvbnNlXG4gIHRoaXMuX2FjdGlvbkVITE8oY29tbWFuZClcbn1cblxuLyoqXG4gKiBSZXNwb25zZSB0byBFSExPLiBJZiB0aGUgcmVzcG9uc2UgaXMgYW4gZXJyb3IsIHRyeSBIRUxPIGluc3RlYWRcbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9hY3Rpb25FSExPID0gZnVuY3Rpb24gKGNvbW1hbmQpIHtcbiAgdmFyIG1hdGNoXG5cbiAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICBpZiAoIXRoaXMuX3NlY3VyZU1vZGUgJiYgdGhpcy5vcHRpb25zLnJlcXVpcmVUTFMpIHtcbiAgICAgIHZhciBlcnJNc2cgPSAnU1RBUlRUTFMgbm90IHN1cHBvcnRlZCB3aXRob3V0IEVITE8nXG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsIGVyck1zZylcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGVyck1zZykpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICAvLyBUcnkgSEVMTyBpbnN0ZWFkXG4gICAgdGhpcy5sb2dnZXIud2FybihERUJVR19UQUcsICdFSExPIG5vdCBzdWNjZXNzZnVsLCB0cnlpbmcgSEVMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkhFTE9cbiAgICB0aGlzLl9zZW5kQ29tbWFuZCgnSEVMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG4gICAgcmV0dXJuXG4gIH1cblxuICAvLyBEZXRlY3QgaWYgdGhlIHNlcnZlciBzdXBwb3J0cyBQTEFJTiBhdXRoXG4gIGlmIChjb21tYW5kLmxpbmUubWF0Y2goL0FVVEgoPzpcXHMrW15cXG5dKlxccyt8XFxzKylQTEFJTi9pKSkge1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlcnZlciBzdXBwb3J0cyBBVVRIIFBMQUlOJylcbiAgICB0aGlzLl9zdXBwb3J0ZWRBdXRoLnB1c2goJ1BMQUlOJylcbiAgfVxuXG4gIC8vIERldGVjdCBpZiB0aGUgc2VydmVyIHN1cHBvcnRzIExPR0lOIGF1dGhcbiAgaWYgKGNvbW1hbmQubGluZS5tYXRjaCgvQVVUSCg/OlxccytbXlxcbl0qXFxzK3xcXHMrKUxPR0lOL2kpKSB7XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VydmVyIHN1cHBvcnRzIEFVVEggTE9HSU4nKVxuICAgIHRoaXMuX3N1cHBvcnRlZEF1dGgucHVzaCgnTE9HSU4nKVxuICB9XG5cbiAgLy8gRGV0ZWN0IGlmIHRoZSBzZXJ2ZXIgc3VwcG9ydHMgWE9BVVRIMiBhdXRoXG4gIGlmIChjb21tYW5kLmxpbmUubWF0Y2goL0FVVEgoPzpcXHMrW15cXG5dKlxccyt8XFxzKylYT0FVVEgyL2kpKSB7XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VydmVyIHN1cHBvcnRzIEFVVEggWE9BVVRIMicpXG4gICAgdGhpcy5fc3VwcG9ydGVkQXV0aC5wdXNoKCdYT0FVVEgyJylcbiAgfVxuXG4gIC8vIERldGVjdCBtYXhpbXVtIGFsbG93ZWQgbWVzc2FnZSBzaXplXG4gIGlmICgobWF0Y2ggPSBjb21tYW5kLmxpbmUubWF0Y2goL1NJWkUgKFxcZCspL2kpKSAmJiBOdW1iZXIobWF0Y2hbMV0pKSB7XG4gICAgdGhpcy5fbWF4QWxsb3dlZFNpemUgPSBOdW1iZXIobWF0Y2hbMV0pXG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnTWF4aW11bSBhbGxvd2QgbWVzc2FnZSBzaXplOiAnICsgdGhpcy5fbWF4QWxsb3dlZFNpemUpXG4gIH1cblxuICAvLyBEZXRlY3QgaWYgdGhlIHNlcnZlciBzdXBwb3J0cyBTVEFSVFRMU1xuICBpZiAoIXRoaXMuX3NlY3VyZU1vZGUpIHtcbiAgICBpZiAoKGNvbW1hbmQubGluZS5tYXRjaCgvWyAtXVNUQVJUVExTXFxzPyQvbWkpICYmICF0aGlzLm9wdGlvbnMuaWdub3JlVExTKSB8fCAhIXRoaXMub3B0aW9ucy5yZXF1aXJlVExTKSB7XG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uU1RBUlRUTFNcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgU1RBUlRUTFMnKVxuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ1NUQVJUVExTJylcbiAgICAgIHJldHVyblxuICAgIH1cbiAgfVxuXG4gIHRoaXMuX2F1dGhlbnRpY2F0ZVVzZXIoKVxufVxuXG4vKipcbiAqIEhhbmRsZXMgc2VydmVyIHJlc3BvbnNlIGZvciBTVEFSVFRMUyBjb21tYW5kLiBJZiB0aGVyZSdzIGFuIGVycm9yXG4gKiB0cnkgSEVMTyBpbnN0ZWFkLCBvdGhlcndpc2UgaW5pdGlhdGUgVExTIHVwZ3JhZGUuIElmIHRoZSB1cGdyYWRlXG4gKiBzdWNjZWVkZXMgcmVzdGFydCB0aGUgRUhMT1xuICpcbiAqIEBwYXJhbSB7U3RyaW5nfSBzdHIgTWVzc2FnZSBmcm9tIHRoZSBzZXJ2ZXJcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2FjdGlvblNUQVJUVExTID0gZnVuY3Rpb24gKGNvbW1hbmQpIHtcbiAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdTVEFSVFRMUyBub3Qgc3VjY2Vzc2Z1bCcpXG4gICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICByZXR1cm5cbiAgfVxuXG4gIHRoaXMuX3NlY3VyZU1vZGUgPSB0cnVlXG4gIHRoaXMuc29ja2V0LnVwZ3JhZGVUb1NlY3VyZSgpXG5cbiAgLy8gcmVzdGFydCBwcm90b2NvbCBmbG93XG4gIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25FSExPXG4gIHRoaXMuX3NlbmRDb21tYW5kKCdFSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbn1cblxuLyoqXG4gKiBSZXNwb25zZSB0byBIRUxPXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fYWN0aW9uSEVMTyA9IGZ1bmN0aW9uIChjb21tYW5kKSB7XG4gIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnSEVMTyBub3Qgc3VjY2Vzc2Z1bCcpXG4gICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICByZXR1cm5cbiAgfVxuICB0aGlzLl9hdXRoZW50aWNhdGVVc2VyKClcbn1cblxuLyoqXG4gKiBSZXNwb25zZSB0byBBVVRIIExPR0lOLCBpZiBzdWNjZXNzZnVsIGV4cGVjdHMgYmFzZTY0IGVuY29kZWQgdXNlcm5hbWVcbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9hY3Rpb25BVVRIX0xPR0lOX1VTRVIgPSBmdW5jdGlvbiAoY29tbWFuZCkge1xuICBpZiAoY29tbWFuZC5zdGF0dXNDb2RlICE9PSAzMzQgfHwgY29tbWFuZC5kYXRhICE9PSAnVlhObGNtNWhiV1U2Jykge1xuICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0FVVEggTE9HSU4gVVNFUiBub3Qgc3VjY2Vzc2Z1bDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignSW52YWxpZCBsb2dpbiBzZXF1ZW5jZSB3aGlsZSB3YWl0aW5nIGZvciBcIjMzNCBWWE5sY201aGJXVTYgXCI6ICcgKyBjb21tYW5kLmRhdGEpKVxuICAgIHJldHVyblxuICB9XG4gIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0FVVEggTE9HSU4gVVNFUiBzdWNjZXNzZnVsJylcbiAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhfTE9HSU5fUEFTU1xuICB0aGlzLl9zZW5kQ29tbWFuZChlbmNvZGUodGhpcy5vcHRpb25zLmF1dGgudXNlcikpXG59XG5cbi8qKlxuICogUmVzcG9uc2UgdG8gQVVUSCBMT0dJTiB1c2VybmFtZSwgaWYgc3VjY2Vzc2Z1bCBleHBlY3RzIGJhc2U2NCBlbmNvZGVkIHBhc3N3b3JkXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fYWN0aW9uQVVUSF9MT0dJTl9QQVNTID0gZnVuY3Rpb24gKGNvbW1hbmQpIHtcbiAgaWYgKGNvbW1hbmQuc3RhdHVzQ29kZSAhPT0gMzM0IHx8IGNvbW1hbmQuZGF0YSAhPT0gJ1VHRnpjM2R2Y21RNicpIHtcbiAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdBVVRIIExPR0lOIFBBU1Mgbm90IHN1Y2Nlc3NmdWw6ICcgKyBjb21tYW5kLmRhdGEpXG4gICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoJ0ludmFsaWQgbG9naW4gc2VxdWVuY2Ugd2hpbGUgd2FpdGluZyBmb3IgXCIzMzQgVUdGemMzZHZjbVE2IFwiOiAnICsgY29tbWFuZC5kYXRhKSlcbiAgICByZXR1cm5cbiAgfVxuICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBVVRIIExPR0lOIFBBU1Mgc3VjY2Vzc2Z1bCcpXG4gIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25BVVRIQ29tcGxldGVcbiAgdGhpcy5fc2VuZENvbW1hbmQoZW5jb2RlKHRoaXMub3B0aW9ucy5hdXRoLnBhc3MpKVxufVxuXG4vKipcbiAqIFJlc3BvbnNlIHRvIEFVVEggWE9BVVRIMiB0b2tlbiwgaWYgZXJyb3Igb2NjdXJzIHNlbmQgZW1wdHkgcmVzcG9uc2VcbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9hY3Rpb25BVVRIX1hPQVVUSDIgPSBmdW5jdGlvbiAoY29tbWFuZCkge1xuICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgIHRoaXMubG9nZ2VyLndhcm4oREVCVUdfVEFHLCAnRXJyb3IgZHVyaW5nIEFVVEggWE9BVVRIMiwgc2VuZGluZyBlbXB0eSByZXNwb25zZScpXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoJycpXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhDb21wbGV0ZVxuICB9IGVsc2Uge1xuICAgIHRoaXMuX2FjdGlvbkFVVEhDb21wbGV0ZShjb21tYW5kKVxuICB9XG59XG5cbi8qKlxuICogQ2hlY2tzIGlmIGF1dGhlbnRpY2F0aW9uIHN1Y2NlZWRlZCBvciBub3QuIElmIHN1Y2Nlc3NmdWxseSBhdXRoZW50aWNhdGVkXG4gKiBlbWl0IGBpZGxlYCB0byBpbmRpY2F0ZSB0aGF0IGFuIGUtbWFpbCBjYW4gYmUgc2VudCB1c2luZyB0aGlzIGNvbm5lY3Rpb25cbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9hY3Rpb25BVVRIQ29tcGxldGUgPSBmdW5jdGlvbiAoY29tbWFuZCkge1xuICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0F1dGhlbnRpY2F0aW9uIGZhaWxlZDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgIHJldHVyblxuICB9XG5cbiAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQXV0aGVudGljYXRpb24gc3VjY2Vzc2Z1bC4nKVxuXG4gIHRoaXMuX2F1dGhlbnRpY2F0ZWRBcyA9IHRoaXMub3B0aW9ucy5hdXRoLnVzZXJcblxuICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICB0aGlzLm9uaWRsZSgpIC8vIHJlYWR5IHRvIHRha2Ugb3JkZXJzXG59XG5cbi8qKlxuICogVXNlZCB3aGVuIHRoZSBjb25uZWN0aW9uIGlzIGlkbGUgYW5kIHRoZSBzZXJ2ZXIgZW1pdHMgdGltZW91dFxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2FjdGlvbklkbGUgPSBmdW5jdGlvbiAoY29tbWFuZCkge1xuICBpZiAoY29tbWFuZC5zdGF0dXNDb2RlID4gMzAwKSB7XG4gICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5saW5lKSlcbiAgICByZXR1cm5cbiAgfVxuXG4gIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG59XG5cbi8qKlxuICogUmVzcG9uc2UgdG8gTUFJTCBGUk9NIGNvbW1hbmQuIFByb2NlZWQgdG8gZGVmaW5pbmcgUkNQVCBUTyBsaXN0IGlmIHN1Y2Nlc3NmdWxcbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9hY3Rpb25NQUlMID0gZnVuY3Rpb24gKGNvbW1hbmQpIHtcbiAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdNQUlMIEZST00gdW5zdWNjZXNzZnVsOiAnICsgY29tbWFuZC5kYXRhKVxuICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgcmV0dXJuXG4gIH1cblxuICBpZiAoIXRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5sZW5ndGgpIHtcbiAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignQ2FuXFwndCBzZW5kIG1haWwgLSBubyByZWNpcGllbnRzIGRlZmluZWQnKSlcbiAgfSBlbHNlIHtcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdNQUlMIEZST00gc3VjY2Vzc2Z1bCwgcHJvY2VlZGluZyB3aXRoICcgKyB0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUubGVuZ3RoICsgJyByZWNpcGllbnRzJylcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBZGRpbmcgcmVjaXBpZW50Li4uJylcbiAgICB0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQgPSB0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUuc2hpZnQoKVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25SQ1BUXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoJ1JDUFQgVE86PCcgKyB0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQgKyAnPicpXG4gIH1cbn1cblxuLyoqXG4gKiBSZXNwb25zZSB0byBhIFJDUFQgVE8gY29tbWFuZC4gSWYgdGhlIGNvbW1hbmQgaXMgdW5zdWNjZXNzZnVsLCB0cnkgdGhlIG5leHQgb25lLFxuICogYXMgdGhpcyBtaWdodCBiZSByZWxhdGVkIG9ubHkgdG8gdGhlIGN1cnJlbnQgcmVjaXBpZW50LCBub3QgYSBnbG9iYWwgZXJyb3IsIHNvXG4gKiB0aGUgZm9sbG93aW5nIHJlY2lwaWVudHMgbWlnaHQgc3RpbGwgYmUgdmFsaWRcbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9hY3Rpb25SQ1BUID0gZnVuY3Rpb24gKGNvbW1hbmQpIHtcbiAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICB0aGlzLmxvZ2dlci53YXJuKERFQlVHX1RBRywgJ1JDUFQgVE8gZmFpbGVkIGZvcjogJyArIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudClcbiAgICAvLyB0aGlzIGlzIGEgc29mdCBlcnJvclxuICAgIHRoaXMuX2VudmVsb3BlLnJjcHRGYWlsZWQucHVzaCh0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQpXG4gIH0gZWxzZSB7XG4gICAgdGhpcy5fZW52ZWxvcGUucmVzcG9uc2VRdWV1ZS5wdXNoKHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudClcbiAgfVxuXG4gIGlmICghdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLmxlbmd0aCkge1xuICAgIGlmICh0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkLmxlbmd0aCA8IHRoaXMuX2VudmVsb3BlLnRvLmxlbmd0aCkge1xuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkRBVEFcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1JDUFQgVE8gZG9uZSwgcHJvY2VlZGluZyB3aXRoIHBheWxvYWQnKVxuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0RBVEEnKVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignQ2FuXFwndCBzZW5kIG1haWwgLSBhbGwgcmVjaXBpZW50cyB3ZXJlIHJlamVjdGVkJykpXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBZGRpbmcgcmVjaXBpZW50Li4uJylcbiAgICB0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQgPSB0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUuc2hpZnQoKVxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25SQ1BUXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoJ1JDUFQgVE86PCcgKyB0aGlzLl9lbnZlbG9wZS5jdXJSZWNpcGllbnQgKyAnPicpXG4gIH1cbn1cblxuLyoqXG4gKiBSZXNwb25zZSB0byB0aGUgUlNFVCBjb21tYW5kLiBJZiBzdWNjZXNzZnVsLCBjbGVhciB0aGUgY3VycmVudCBhdXRoZW50aWNhdGlvblxuICogaW5mb3JtYXRpb24gYW5kIHJlYXV0aGVudGljYXRlLlxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2FjdGlvblJTRVQgPSBmdW5jdGlvbiAoY29tbWFuZCkge1xuICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ1JTRVQgdW5zdWNjZXNzZnVsICcgKyBjb21tYW5kLmRhdGEpXG4gICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICByZXR1cm5cbiAgfVxuXG4gIHRoaXMuX2F1dGhlbnRpY2F0ZWRBcyA9IG51bGxcbiAgdGhpcy5fYXV0aGVudGljYXRlVXNlcigpXG59XG5cbi8qKlxuICogUmVzcG9uc2UgdG8gdGhlIERBVEEgY29tbWFuZC4gU2VydmVyIGlzIG5vdyB3YWl0aW5nIGZvciBhIG1lc3NhZ2UsIHNvIGVtaXQgYG9ucmVhZHlgXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fYWN0aW9uREFUQSA9IGZ1bmN0aW9uIChjb21tYW5kKSB7XG4gIC8vIHJlc3BvbnNlIHNob3VsZCBiZSAzNTQgYnV0IGFjY29yZGluZyB0byB0aGlzIGlzc3VlIGh0dHBzOi8vZ2l0aHViLmNvbS9lbGVpdGgvZW1haWxqcy9pc3N1ZXMvMjRcbiAgLy8gc29tZSBzZXJ2ZXJzIG1pZ2h0IHVzZSAyNTAgaW5zdGVhZFxuICBpZiAoWzI1MCwgMzU0XS5pbmRleE9mKGNvbW1hbmQuc3RhdHVzQ29kZSkgPCAwKSB7XG4gICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnREFUQSB1bnN1Y2Nlc3NmdWwgJyArIGNvbW1hbmQuZGF0YSlcbiAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgIHJldHVyblxuICB9XG5cbiAgdGhpcy5fZGF0YU1vZGUgPSB0cnVlXG4gIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gIHRoaXMub25yZWFkeSh0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkKVxufVxuXG4vKipcbiAqIFJlc3BvbnNlIGZyb20gdGhlIHNlcnZlciwgb25jZSB0aGUgbWVzc2FnZSBzdHJlYW0gaGFzIGVuZGVkIHdpdGggPENSPjxMRj4uPENSPjxMRj5cbiAqIEVtaXRzIGBvbmRvbmVgLlxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2FjdGlvblN0cmVhbSA9IGZ1bmN0aW9uIChjb21tYW5kKSB7XG4gIHZhciByY3B0XG5cbiAgaWYgKHRoaXMub3B0aW9ucy5sbXRwKSB7XG4gICAgLy8gTE1UUCByZXR1cm5zIGEgcmVzcG9uc2UgY29kZSBmb3IgKmV2ZXJ5KiBzdWNjZXNzZnVsbHkgc2V0IHJlY2lwaWVudFxuICAgIC8vIEZvciBldmVyeSByZWNpcGllbnQgdGhlIG1lc3NhZ2UgbWlnaHQgc3VjY2VlZCBvciBmYWlsIGluZGl2aWR1YWxseVxuXG4gICAgcmNwdCA9IHRoaXMuX2VudmVsb3BlLnJlc3BvbnNlUXVldWUuc2hpZnQoKVxuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdMb2NhbCBkZWxpdmVyeSB0byAnICsgcmNwdCArICcgZmFpbGVkLicpXG4gICAgICB0aGlzLl9lbnZlbG9wZS5yY3B0RmFpbGVkLnB1c2gocmNwdClcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnTG9jYWwgZGVsaXZlcnkgdG8gJyArIHJjcHQgKyAnIHN1Y2NlZWRlZC4nKVxuICAgIH1cblxuICAgIGlmICh0aGlzLl9lbnZlbG9wZS5yZXNwb25zZVF1ZXVlLmxlbmd0aCkge1xuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvblN0cmVhbVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgICB0aGlzLm9uZG9uZSh0cnVlKVxuICB9IGVsc2Uge1xuICAgIC8vIEZvciBTTVRQIHRoZSBtZXNzYWdlIGVpdGhlciBmYWlscyBvciBzdWNjZWVkcywgdGhlcmUgaXMgbm8gaW5mb3JtYXRpb25cbiAgICAvLyBhYm91dCBpbmRpdmlkdWFsIHJlY2lwaWVudHNcblxuICAgIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdNZXNzYWdlIHNlbmRpbmcgZmFpbGVkLicpXG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ01lc3NhZ2Ugc2VudCBzdWNjZXNzZnVsbHkuJylcbiAgICB9XG5cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgIHRoaXMub25kb25lKCEhY29tbWFuZC5zdWNjZXNzKVxuICB9XG5cbiAgLy8gSWYgdGhlIGNsaWVudCB3YW50ZWQgdG8gZG8gc29tZXRoaW5nIGVsc2UgKGVnLiB0byBxdWl0KSwgZG8gbm90IGZvcmNlIGlkbGVcbiAgaWYgKHRoaXMuX2N1cnJlbnRBY3Rpb24gPT09IHRoaXMuX2FjdGlvbklkbGUpIHtcbiAgICAvLyBXYWl0aW5nIGZvciBuZXcgY29ubmVjdGlvbnNcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdJZGxpbmcgd2hpbGUgd2FpdGluZyBmb3IgbmV3IGNvbm5lY3Rpb25zLi4uJylcbiAgICB0aGlzLm9uaWRsZSgpXG4gIH1cbn1cblxuLyoqXG4gKiBCdWlsZHMgYSBsb2dpbiB0b2tlbiBmb3IgWE9BVVRIMiBhdXRoZW50aWNhdGlvbiBjb21tYW5kXG4gKlxuICogQHBhcmFtIHtTdHJpbmd9IHVzZXIgRS1tYWlsIGFkZHJlc3Mgb2YgdGhlIHVzZXJcbiAqIEBwYXJhbSB7U3RyaW5nfSB0b2tlbiBWYWxpZCBhY2Nlc3MgdG9rZW4gZm9yIHRoZSB1c2VyXG4gKiBAcmV0dXJuIHtTdHJpbmd9IEJhc2U2NCBmb3JtYXR0ZWQgbG9naW4gdG9rZW5cbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2J1aWxkWE9BdXRoMlRva2VuID0gZnVuY3Rpb24gKHVzZXIsIHRva2VuKSB7XG4gIHZhciBhdXRoRGF0YSA9IFtcbiAgICAndXNlcj0nICsgKHVzZXIgfHwgJycpLFxuICAgICdhdXRoPUJlYXJlciAnICsgdG9rZW4sXG4gICAgJycsXG4gICAgJydcbiAgXVxuICAvLyBiYXNlNjQoXCJ1c2VyPXtVc2VyfVxceDAwYXV0aD1CZWFyZXIge1Rva2VufVxceDAwXFx4MDBcIilcbiAgcmV0dXJuIGVuY29kZShhdXRoRGF0YS5qb2luKCdcXHgwMScpKVxufVxuXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5jcmVhdGVMb2dnZXIgPSBmdW5jdGlvbiAoY3JlYXRvciA9IGNyZWF0ZURlZmF1bHRMb2dnZXIpIHtcbiAgY29uc3QgbG9nZ2VyID0gY3JlYXRvcigodGhpcy5vcHRpb25zLmF1dGggfHwge30pLnVzZXIgfHwgJycsIHRoaXMuaG9zdClcbiAgdGhpcy5sb2dnZXIgPSB7XG4gICAgZGVidWc6ICguLi5tc2dzKSA9PiB7IGlmIChMT0dfTEVWRUxfREVCVUcgPj0gdGhpcy5sb2dMZXZlbCkgeyBsb2dnZXIuZGVidWcobXNncykgfSB9LFxuICAgIGluZm86ICguLi5tc2dzKSA9PiB7IGlmIChMT0dfTEVWRUxfSU5GTyA+PSB0aGlzLmxvZ0xldmVsKSB7IGxvZ2dlci5pbmZvKG1zZ3MpIH0gfSxcbiAgICB3YXJuOiAoLi4ubXNncykgPT4geyBpZiAoTE9HX0xFVkVMX1dBUk4gPj0gdGhpcy5sb2dMZXZlbCkgeyBsb2dnZXIud2Fybihtc2dzKSB9IH0sXG4gICAgZXJyb3I6ICguLi5tc2dzKSA9PiB7IGlmIChMT0dfTEVWRUxfRVJST1IgPj0gdGhpcy5sb2dMZXZlbCkgeyBsb2dnZXIuZXJyb3IobXNncykgfSB9XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgU210cENsaWVudFxuIl19