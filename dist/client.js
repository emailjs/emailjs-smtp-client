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

SmtpClient.prototype.LOG_LEVEL_NONE = 1000;
SmtpClient.prototype.LOG_LEVEL_ERROR = 40;
SmtpClient.prototype.LOG_LEVEL_WARN = 30;
SmtpClient.prototype.LOG_LEVEL_INFO = 20;
SmtpClient.prototype.LOG_LEVEL_DEBUG = 10;
SmtpClient.prototype.LOG_LEVEL_ALL = 0;

SmtpClient.prototype.createLogger = function () {
  var self = this;
  var createLogger = function createLogger(tag) {
    var log = function log(level, messages) {
      var logMessage = '[' + new Date().toISOString() + '][' + tag + '][' + self.options.auth.user + '][' + self.host + '] ' + messages.join(' ');
      if (level === self.LOG_LEVEL_DEBUG) {
        console.log('[DEBUG]' + logMessage);
      } else if (level === self.LOG_LEVEL_INFO) {
        console.info('[INFO]' + logMessage);
      } else if (level === self.LOG_LEVEL_WARN) {
        console.warn('[WARN]' + logMessage);
      } else if (level === self.LOG_LEVEL_ERROR) {
        console.error('[ERROR]' + logMessage);
      }
    };

    return {
      // this could become way nicer when node supports the rest operator...
      debug: function debug(msgs) {
        log(self.LOG_LEVEL_DEBUG, msgs);
      },
      info: function info(msgs) {
        log(self.LOG_LEVEL_INFO, msgs);
      },
      warn: function warn(msgs) {
        log(self.LOG_LEVEL_WARN, msgs);
      },
      error: function error(msgs) {
        log(self.LOG_LEVEL_ERROR, msgs);
      }
    };
  };

  var logger = this.options.logger || createLogger('SmtpClient');
  this.logger = {
    // this could become way nicer when node supports the rest operator...
    debug: function () {
      if (this.LOG_LEVEL_DEBUG >= this.logLevel) {
        logger.debug(Array.prototype.slice.call(arguments));
      }
    }.bind(this),
    info: function () {
      if (this.LOG_LEVEL_INFO >= this.logLevel) {
        logger.info(Array.prototype.slice.call(arguments));
      }
    }.bind(this),
    warn: function () {
      if (this.LOG_LEVEL_WARN >= this.logLevel) {
        logger.warn(Array.prototype.slice.call(arguments));
      }
    }.bind(this),
    error: function () {
      if (this.LOG_LEVEL_ERROR >= this.logLevel) {
        logger.error(Array.prototype.slice.call(arguments));
      }
    }.bind(this)
  };
};

exports.default = SmtpClient;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9jbGllbnQuanMiXSwibmFtZXMiOlsiREVCVUdfVEFHIiwiU210cENsaWVudCIsImhvc3QiLCJwb3J0Iiwib3B0aW9ucyIsIl9UQ1BTb2NrZXQiLCJ1c2VTZWN1cmVUcmFuc3BvcnQiLCJhdXRoIiwibmFtZSIsInNvY2tldCIsImRlc3Ryb3llZCIsIm1heEFsbG93ZWRTaXplIiwid2FpdERyYWluIiwiX3BhcnNlciIsIl9hdXRoZW50aWNhdGVkQXMiLCJfc3VwcG9ydGVkQXV0aCIsIl9kYXRhTW9kZSIsIl9sYXN0RGF0YUJ5dGVzIiwiX2VudmVsb3BlIiwiX2N1cnJlbnRBY3Rpb24iLCJfc2VjdXJlTW9kZSIsIl9zb2NrZXRUaW1lb3V0VGltZXIiLCJfc29ja2V0VGltZW91dFN0YXJ0IiwiX3NvY2tldFRpbWVvdXRQZXJpb2QiLCJjcmVhdGVMb2dnZXIiLCJsb2dMZXZlbCIsIkxPR19MRVZFTF9BTEwiLCJwcm90b3R5cGUiLCJUSU1FT1VUX1NPQ0tFVF9MT1dFUl9CT1VORCIsIlRJTUVPVVRfU09DS0VUX01VTFRJUExJRVIiLCJvbmVycm9yIiwib25kcmFpbiIsIm9uY2xvc2UiLCJvbmlkbGUiLCJvbnJlYWR5Iiwib25kb25lIiwiY29ubmVjdCIsIm9wZW4iLCJiaW5hcnlUeXBlIiwiY2EiLCJ0bHNXb3JrZXJQYXRoIiwid3MiLCJvbmNlcnQiLCJFIiwiX29uRXJyb3IiLCJiaW5kIiwib25vcGVuIiwiX29uT3BlbiIsInN1c3BlbmQiLCJyZWFkeVN0YXRlIiwicmVzdW1lIiwicXVpdCIsImxvZ2dlciIsImRlYnVnIiwiX3NlbmRDb21tYW5kIiwiY2xvc2UiLCJyZXNldCIsIl9hY3Rpb25SU0VUIiwiX2Rlc3Ryb3kiLCJ1c2VFbnZlbG9wZSIsImVudmVsb3BlIiwiZnJvbSIsImNvbmNhdCIsInRvIiwicmNwdFF1ZXVlIiwicmNwdEZhaWxlZCIsInJlc3BvbnNlUXVldWUiLCJfYWN0aW9uTUFJTCIsInNlbmQiLCJjaHVuayIsIl9zZW5kU3RyaW5nIiwiZW5kIiwibGVuZ3RoIiwiX2FjdGlvblN0cmVhbSIsIl9zZW5kIiwiVWludDhBcnJheSIsImJ1ZmZlciIsInN1YnN0ciIsImV2ZW50IiwiZGF0YSIsInByb3h5SG9zdG5hbWUiLCJvbmRhdGEiLCJfb25EYXRhIiwiX29uQ2xvc2UiLCJfb25EcmFpbiIsIl9vbkNvbW1hbmQiLCJfYWN0aW9uR3JlZXRpbmciLCJldnQiLCJjbGVhclRpbWVvdXQiLCJzdHJpbmdQYXlsb2FkIiwiZGVjb2RlIiwiRXJyb3IiLCJtZXNzYWdlIiwiZXJyb3IiLCJjb21tYW5kIiwiX29uVGltZW91dCIsImRpc2FibGVFc2NhcGluZyIsInJlcGxhY2UiLCJjaGFyQXQiLCJlbmNvZGUiLCJzdHIiLCJfc2V0VGltZW91dCIsImJ5dGVMZW5ndGgiLCJwcm9sb25nUGVyaW9kIiwiTWF0aCIsImZsb29yIiwidGltZW91dCIsIm5vdyIsIkRhdGUiLCJzZXRUaW1lb3V0IiwiX2F1dGhlbnRpY2F0ZVVzZXIiLCJfYWN0aW9uSWRsZSIsImF1dGhNZXRob2QiLCJ4b2F1dGgyIiwidG9VcHBlckNhc2UiLCJ0cmltIiwiX2FjdGlvbkFVVEhfTE9HSU5fVVNFUiIsIl9hY3Rpb25BVVRIQ29tcGxldGUiLCJ1c2VyIiwicGFzcyIsIl9hY3Rpb25BVVRIX1hPQVVUSDIiLCJfYnVpbGRYT0F1dGgyVG9rZW4iLCJzdGF0dXNDb2RlIiwibG10cCIsIl9hY3Rpb25MSExPIiwiX2FjdGlvbkVITE8iLCJzdWNjZXNzIiwibWF0Y2giLCJyZXF1aXJlVExTIiwiZXJyTXNnIiwid2FybiIsIl9hY3Rpb25IRUxPIiwibGluZSIsInB1c2giLCJOdW1iZXIiLCJfbWF4QWxsb3dlZFNpemUiLCJpZ25vcmVUTFMiLCJfYWN0aW9uU1RBUlRUTFMiLCJ1cGdyYWRlVG9TZWN1cmUiLCJfYWN0aW9uQVVUSF9MT0dJTl9QQVNTIiwiY3VyUmVjaXBpZW50Iiwic2hpZnQiLCJfYWN0aW9uUkNQVCIsIl9hY3Rpb25EQVRBIiwiaW5kZXhPZiIsInJjcHQiLCJ0b2tlbiIsImF1dGhEYXRhIiwiam9pbiIsIkxPR19MRVZFTF9OT05FIiwiTE9HX0xFVkVMX0VSUk9SIiwiTE9HX0xFVkVMX1dBUk4iLCJMT0dfTEVWRUxfSU5GTyIsIkxPR19MRVZFTF9ERUJVRyIsInNlbGYiLCJ0YWciLCJsb2ciLCJsZXZlbCIsIm1lc3NhZ2VzIiwibG9nTWVzc2FnZSIsInRvSVNPU3RyaW5nIiwiY29uc29sZSIsImluZm8iLCJtc2dzIiwiQXJyYXkiLCJzbGljZSIsImNhbGwiLCJhcmd1bWVudHMiXSwibWFwcGluZ3MiOiI7Ozs7OztBQUFBOztBQUNBOzs7O0FBQ0E7O0FBQ0E7Ozs7OztBQUVBLElBQUlBLFlBQVksYUFBaEI7O0FBRUE7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQWtCQSxTQUFTQyxVQUFULENBQXFCQyxJQUFyQixFQUEyQkMsSUFBM0IsRUFBaUNDLE9BQWpDLEVBQTBDO0FBQ3hDLE9BQUtDLFVBQUw7O0FBRUEsT0FBS0QsT0FBTCxHQUFlQSxXQUFXLEVBQTFCOztBQUVBLE9BQUtELElBQUwsR0FBWUEsU0FBUyxLQUFLQyxPQUFMLENBQWFFLGtCQUFiLEdBQWtDLEdBQWxDLEdBQXdDLEVBQWpELENBQVo7QUFDQSxPQUFLSixJQUFMLEdBQVlBLFFBQVEsV0FBcEI7O0FBRUE7Ozs7O0FBS0EsT0FBS0UsT0FBTCxDQUFhRSxrQkFBYixHQUFrQyx3QkFBd0IsS0FBS0YsT0FBN0IsR0FBdUMsQ0FBQyxDQUFDLEtBQUtBLE9BQUwsQ0FBYUUsa0JBQXRELEdBQTJFLEtBQUtILElBQUwsS0FBYyxHQUEzSDs7QUFFQTs7O0FBR0EsT0FBS0MsT0FBTCxDQUFhRyxJQUFiLEdBQW9CLEtBQUtILE9BQUwsQ0FBYUcsSUFBYixJQUFxQixLQUF6Qzs7QUFFQTs7O0FBR0EsT0FBS0gsT0FBTCxDQUFhSSxJQUFiLEdBQW9CLEtBQUtKLE9BQUwsQ0FBYUksSUFBYixJQUFxQixXQUF6Qzs7QUFFQTs7O0FBR0EsT0FBS0MsTUFBTCxHQUFjLEtBQWQ7O0FBRUE7Ozs7QUFJQSxPQUFLQyxTQUFMLEdBQWlCLEtBQWpCOztB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WUFBWTtBQUNqQixVQUFJLEtBQUt5RCxlQUFMLElBQXdCLEtBQUs3SCxRQUFqQyxFQUEyQztBQUN6QzJCLGVBQU95QyxLQUFQLENBQWF1RSxNQUFNekksU0FBTixDQUFnQjBJLEtBQWhCLENBQXNCQyxJQUF0QixDQUEyQkMsU0FBM0IsQ0FBYjtBQUNEO0FBQ0YsS0FKTSxDQUlMMUgsSUFKSyxDQUlBLElBSkE7QUFqQkssR0FBZDtBQXVCRCxDQWxERDs7a0JBb0RlNUMsVSIsImZpbGUiOiJjbGllbnQuanMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBlbmNvZGUgfSBmcm9tICdlbWFpbGpzLWJhc2U2NCdcbmltcG9ydCBUQ1BTb2NrZXQgZnJvbSAnZW1haWxqcy10Y3Atc29ja2V0J1xuaW1wb3J0IHsgVGV4dERlY29kZXIsIFRleHRFbmNvZGVyIH0gZnJvbSAndGV4dC1lbmNvZGluZydcbmltcG9ydCBTbXRwQ2xpZW50UmVzcG9uc2VQYXJzZXIgZnJvbSAnLi9wYXJzZXInXG5cbnZhciBERUJVR19UQUcgPSAnU01UUCBDbGllbnQnXG5cbi8qKlxuICogQ3JlYXRlcyBhIGNvbm5lY3Rpb24gb2JqZWN0IHRvIGEgU01UUCBzZXJ2ZXIgYW5kIGFsbG93cyB0byBzZW5kIG1haWwgdGhyb3VnaCBpdC5cbiAqIENhbGwgYGNvbm5lY3RgIG1ldGhvZCB0byBpbml0aXRhdGUgdGhlIGFjdHVhbCBjb25uZWN0aW9uLCB0aGUgY29uc3RydWN0b3Igb25seVxuICogZGVmaW5lcyB0aGUgcHJvcGVydGllcyBidXQgZG9lcyBub3QgYWN0dWFsbHkgY29ubmVjdC5cbiAqXG4gKiBOQiEgVGhlIHBhcmFtZXRlciBvcmRlciAoaG9zdCwgcG9ydCkgZGlmZmVycyBmcm9tIG5vZGUuanMgXCJ3YXlcIiAocG9ydCwgaG9zdClcbiAqXG4gKiBAY29uc3RydWN0b3JcbiAqXG4gKiBAcGFyYW0ge1N0cmluZ30gW2hvc3Q9XCJsb2NhbGhvc3RcIl0gSG9zdG5hbWUgdG8gY29uZW5jdCB0b1xuICogQHBhcmFtIHtOdW1iZXJ9IFtwb3J0PTI1XSBQb3J0IG51bWJlciB0byBjb25uZWN0IHRvXG4gKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdIE9wdGlvbmFsIG9wdGlvbnMgb2JqZWN0XG4gKiBAcGFyYW0ge0Jvb2xlYW59IFtvcHRpb25zLnVzZVNlY3VyZVRyYW5zcG9ydF0gU2V0IHRvIHRydWUsIHRvIHVzZSBlbmNyeXB0ZWQgY29ubmVjdGlvblxuICogQHBhcmFtIHtTdHJpbmd9IFtvcHRpb25zLm5hbWVdIENsaWVudCBob3N0bmFtZSBmb3IgaW50cm9kdWNpbmcgaXRzZWxmIHRvIHRoZSBzZXJ2ZXJcbiAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9ucy5hdXRoXSBBdXRoZW50aWNhdGlvbiBvcHRpb25zLiBEZXBlbmRzIG9uIHRoZSBwcmVmZXJyZWQgYXV0aGVudGljYXRpb24gbWV0aG9kLiBVc3VhbGx5IHt1c2VyLCBwYXNzfVxuICogQHBhcmFtIHtTdHJpbmd9IFtvcHRpb25zLmF1dGhNZXRob2RdIEZvcmNlIHNwZWNpZmljIGF1dGhlbnRpY2F0aW9uIG1ldGhvZFxuICogQHBhcmFtIHtCb29sZWFufSBbb3B0aW9ucy5kaXNhYmxlRXNjYXBpbmddIElmIHNldCB0byB0cnVlLCBkbyBub3QgZXNjYXBlIGRvdHMgb24gdGhlIGJlZ2lubmluZyBvZiB0aGUgbGluZXNcbiAqL1xuZnVuY3Rpb24gU210cENsaWVudCAoaG9zdCwgcG9ydCwgb3B0aW9ucykge1xuICB0aGlzLl9UQ1BTb2NrZXQgPSBUQ1BTb2NrZXRcblxuICB0aGlzLm9wdGlvbnMgPSBvcHRpb25zIHx8IHt9XG5cbiAgdGhpcy5wb3J0ID0gcG9ydCB8fCAodGhpcy5vcHRpb25zLnVzZVNlY3VyZVRyYW5zcG9ydCA/IDQ2NSA6IDI1KVxuICB0aGlzLmhvc3QgPSBob3N0IHx8ICdsb2NhbGhvc3QnXG5cbiAgLyoqXG4gICAqIElmIHNldCB0byB0cnVlLCBzdGFydCBhbiBlbmNyeXB0ZWQgY29ubmVjdGlvbiBpbnN0ZWFkIG9mIHRoZSBwbGFpbnRleHQgb25lXG4gICAqIChyZWNvbW1lbmRlZCBpZiBhcHBsaWNhYmxlKS4gSWYgdXNlU2VjdXJlVHJhbnNwb3J0IGlzIG5vdCBzZXQgYnV0IHRoZSBwb3J0IHVzZWQgaXMgNDY1LFxuICAgKiB0aGVuIGVjcnlwdGlvbiBpcyB1c2VkIGJ5IGRlZmF1bHQuXG4gICAqL1xuICB0aGlzLm9wdGlvbnMudXNlU2VjdXJlVHJhbnNwb3J0ID0gJ3VzZVNlY3VyZVRyYW5zcG9ydCcgaW4gdGhpcy5vcHRpb25zID8gISF0aGlzLm9wdGlvbnMudXNlU2VjdXJlVHJhbnNwb3J0IDogdGhpcy5wb3J0ID09PSA0NjVcblxuICAvKipcbiAgICogQXV0aGVudGljYXRpb24gb2JqZWN0LiBJZiBub3Qgc2V0LCBhdXRoZW50aWNhdGlvbiBzdGVwIHdpbGwgYmUgc2tpcHBlZC5cbiAgICovXG4gIHRoaXMub3B0aW9ucy5hdXRoID0gdGhpcy5vcHRpb25zLmF1dGggfHwgZmFsc2VcblxuICAvKipcbiAgICogSG9zdG5hbWUgb2YgdGhlIGNsaWVudCwgdGhpcyB3aWxsIGJlIHVzZWQgZm9yIGludHJvZHVjaW5nIHRvIHRoZSBzZXJ2ZXJcbiAgICovXG4gIHRoaXMub3B0aW9ucy5uYW1lID0gdGhpcy5vcHRpb25zLm5hbWUgfHwgJ2xvY2FsaG9zdCdcblxuICAvKipcbiAgICogRG93bnN0cmVhbSBUQ1Agc29ja2V0IHRvIHRoZSBTTVRQIHNlcnZlciwgY3JlYXRlZCB3aXRoIG1velRDUFNvY2tldFxuICAgKi9cbiAgdGhpcy5zb2NrZXQgPSBmYWxzZVxuXG4gIC8qKlxuICAgKiBJbmRpY2F0ZXMgaWYgdGhlIGNvbm5lY3Rpb24gaGFzIGJlZW4gY2xvc2VkIGFuZCBjYW4ndCBiZSB1c2VkIGFueW1vcmVcbiAgICpcbiAgICovXG4gIHRoaXMuZGVzdHJveWVkID0gZmFsc2VcblxuICAvKipcbiAgICogSW5mb3JtYXRpb25hbCB2YWx1ZSB0aGF0IGluZGljYXRlcyB0aGUgbWF4aW11bSBzaXplIChpbiBieXRlcykgZm9yXG4gICAqIGEgbWVzc2FnZSBzZW50IHRvIHRoZSBjdXJyZW50IHNlcnZlci4gRGV0ZWN0ZWQgZnJvbSBTSVpFIGluZm8uXG4gICAqIE5vdCBhdmFpbGFibGUgdW50aWwgY29ubmVjdGlvbiBoYXMgYmVlbiBlc3RhYmxpc2hlZC5cbiAgICovXG4gIHRoaXMubWF4QWxsb3dlZFNpemUgPSAwXG5cbiAgLyoqXG4gICAqIEtlZXBzIHRyYWNrIGlmIHRoZSBkb3duc3RyZWFtIHNvY2tldCBpcyBjdXJyZW50bHkgZnVsbCBhbmRcbiAgICogYSBkcmFpbiBldmVudCBzaG91bGQgYmUgd2FpdGVkIGZvciBvciBub3RcbiAgICovXG4gIHRoaXMud2FpdERyYWluID0gZmFsc2VcblxuICAvLyBQcml2YXRlIHByb3BlcnRpZXNcblxuICAvKipcbiAgICogU01UUCByZXNwb25zZSBwYXJzZXIgb2JqZWN0LiBBbGwgZGF0YSBjb21pbmcgZnJvbSB0aGUgZG93bnN0cmVhbSBzZXJ2ZXJcbiAgICogaXMgZmVlZGVkIHRvIHRoaXMgcGFyc2VyXG4gICAqL1xuICB0aGlzLl9wYXJzZXIgPSBuZXcgU210cENsaWVudFJlc3BvbnNlUGFyc2VyKClcblxuICAvKipcbiAgICogSWYgYXV0aGVudGljYXRlZCBzdWNjZXNzZnVsbHksIHN0b3JlcyB0aGUgdXNlcm5hbWVcbiAgICovXG4gIHRoaXMuX2F1dGhlbnRpY2F0ZWRBcyA9IG51bGxcblxuICAvKipcbiAgICogQSBsaXN0IG9mIGF1dGhlbnRpY2F0aW9uIG1lY2hhbmlzbXMgZGV0ZWN0ZWQgZnJvbSB0aGUgRUhMTyByZXNwb25zZVxuICAgKiBhbmQgd2hpY2ggYXJlIGNvbXBhdGlibGUgd2l0aCB0aGlzIGxpYnJhcnlcbiAgICovXG4gIHRoaXMuX3N1cHBvcnRlZEF1dGggPSBbXVxuXG4gIC8qKlxuICAgKiBJZiB0cnVlLCBhY2NlcHRzIGRhdGEgZnJvbSB0aGUgdXBzdHJlYW0gdG8gYmUgcGFzc2VkXG4gICAqIGRpcmVjdGx5IHRvIHRoZSBkb3duc3RyZWFtIHNvY2tldC4gVXNlZCBhZnRlciB0aGUgREFUQSBjb21tYW5kXG4gICAqL1xuICB0aGlzLl9kYXRhTW9kZSA9IGZhbHNlXG5cbiAgLyoqXG4gICAqIEtlZXAgdHJhY2sgb2YgdGhlIGxhc3QgYnl0ZXMgdG8gc2VlIGhvdyB0aGUgdGVybWluYXRpbmcgZG90IHNob3VsZCBiZSBwbGFjZWRcbiAgICovXG4gIHRoaXMuX2xhc3REYXRhQnl0ZXMgPSAnJ1xuXG4gIC8qKlxuICAgKiBFbnZlbG9wZSBvYmplY3QgZm9yIHRyYWNraW5nIHdobyBpcyBzZW5kaW5nIG1haWwgdG8gd2hvbVxuICAgKi9cbiAgdGhpcy5fZW52ZWxvcGUgPSBudWxsXG5cbiAgLyoqXG4gICAqIFN0b3JlcyB0aGUgZnVuY3Rpb24gdGhhdCBzaG91bGQgYmUgcnVuIGFmdGVyIGEgcmVzcG9uc2UgaGFzIGJlZW4gcmVjZWl2ZWRcbiAgICogZnJvbSB0aGUgc2VydmVyXG4gICAqL1xuICB0aGlzLl9jdXJyZW50QWN0aW9uID0gbnVsbFxuXG4gIC8qKlxuICAgKiBJbmRpY2F0ZXMgaWYgdGhlIGNvbm5lY3Rpb24gaXMgc2VjdXJlZCBvciBwbGFpbnRleHRcbiAgICovXG4gIHRoaXMuX3NlY3VyZU1vZGUgPSAhIXRoaXMub3B0aW9ucy51c2VTZWN1cmVUcmFuc3BvcnRcblxuICAvKipcbiAgICogVGltZXIgd2FpdGluZyB0byBkZWNsYXJlIHRoZSBzb2NrZXQgZGVhZCBzdGFydGluZyBmcm9tIHRoZSBsYXN0IHdyaXRlXG4gICAqL1xuICB0aGlzLl9zb2NrZXRUaW1lb3V0VGltZXIgPSBmYWxzZVxuXG4gIC8qKlxuICAgKiBTdGFydCB0aW1lIG9mIHNlbmRpbmcgdGhlIGZpcnN0IHBhY2tldCBpbiBkYXRhIG1vZGVcbiAgICovXG4gIHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCA9IGZhbHNlXG5cbiAgLyoqXG4gICAqIFRpbWVvdXQgZm9yIHNlbmRpbmcgaW4gZGF0YSBtb2RlLCBnZXRzIGV4dGVuZGVkIHdpdGggZXZlcnkgc2VuZCgpXG4gICAqL1xuICB0aGlzLl9zb2NrZXRUaW1lb3V0UGVyaW9kID0gZmFsc2VcblxuICAvLyBBY3RpdmF0ZSBsb2dnaW5nXG4gIHRoaXMuY3JlYXRlTG9nZ2VyKClcbiAgdGhpcy5sb2dMZXZlbCA9IHRoaXMuTE9HX0xFVkVMX0FMTFxufVxuXG4vL1xuLy8gQ09OU1RBTlRTXG4vL1xuXG4vKipcbiAqIExvd2VyIEJvdW5kIGZvciBzb2NrZXQgdGltZW91dCB0byB3YWl0IHNpbmNlIHRoZSBsYXN0IGRhdGEgd2FzIHdyaXR0ZW4gdG8gYSBzb2NrZXRcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkQgPSAxMDAwMFxuXG4vKipcbiAqIE11bHRpcGxpZXIgZm9yIHNvY2tldCB0aW1lb3V0OlxuICpcbiAqIFdlIGFzc3VtZSBhdCBsZWFzdCBhIEdQUlMgY29ubmVjdGlvbiB3aXRoIDExNSBrYi9zID0gMTQsMzc1IGtCL3MgdG9wcywgc28gMTAgS0IvcyB0byBiZSBvblxuICogdGhlIHNhZmUgc2lkZS4gV2UgY2FuIHRpbWVvdXQgYWZ0ZXIgYSBsb3dlciBib3VuZCBvZiAxMHMgKyAobiBLQiAvIDEwIEtCL3MpLiBBIDEgTUIgbWVzc2FnZVxuICogdXBsb2FkIHdvdWxkIGJlIDExMCBzZWNvbmRzIHRvIHdhaXQgZm9yIHRoZSB0aW1lb3V0LiAxMCBLQi9zID09PSAwLjEgcy9CXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLlRJTUVPVVRfU09DS0VUX01VTFRJUExJRVIgPSAwLjFcblxuLy9cbi8vIEVWRU5UU1xuLy9cblxuLy8gRXZlbnQgZnVuY3Rpb25zIHNob3VsZCBiZSBvdmVycmlkZW4sIHRoZXNlIGFyZSBqdXN0IHBsYWNlaG9sZGVyc1xuXG4vKipcbiAqIFdpbGwgYmUgcnVuIHdoZW4gYW4gZXJyb3Igb2NjdXJzLiBDb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXIgd2lsbCBiZSBjbG9zZWQgYXV0b21hdGljYWxseSxcbiAqIHNvIHdhaXQgZm9yIGFuIGBvbmNsb3NlYCBldmVudCBhcyB3ZWxsLlxuICpcbiAqIEBwYXJhbSB7RXJyb3J9IGVyciBFcnJvciBvYmplY3RcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUub25lcnJvciA9IGZ1bmN0aW9uICgpIHsgfVxuXG4vKipcbiAqIE1vcmUgZGF0YSBjYW4gYmUgYnVmZmVyZWQgaW4gdGhlIHNvY2tldC4gU2VlIGB3YWl0RHJhaW5gIHByb3BlcnR5IG9yXG4gKiBjaGVjayBpZiBgc2VuZGAgbWV0aG9kIHJldHVybnMgZmFsc2UgdG8gc2VlIGlmIHlvdSBzaG91bGQgYmUgd2FpdGluZ1xuICogZm9yIHRoZSBkcmFpbiBldmVudC4gQmVmb3JlIHNlbmRpbmcgYW55dGhpbmcgZWxzZS5cbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUub25kcmFpbiA9IGZ1bmN0aW9uICgpIHsgfVxuXG4vKipcbiAqIFRoZSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXIgaGFzIGJlZW4gY2xvc2VkXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLm9uY2xvc2UgPSBmdW5jdGlvbiAoKSB7IH1cblxuLyoqXG4gKiBUaGUgY29ubmVjdGlvbiBpcyBlc3RhYmxpc2hlZCBhbmQgaWRsZSwgeW91IGNhbiBzZW5kIG1haWwgbm93XG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLm9uaWRsZSA9IGZ1bmN0aW9uICgpIHsgfVxuXG4vKipcbiAqIFRoZSBjb25uZWN0aW9uIGlzIHdhaXRpbmcgZm9yIHRoZSBtYWlsIGJvZHlcbiAqXG4gKiBAcGFyYW0ge0FycmF5fSBmYWlsZWRSZWNpcGllbnRzIExpc3Qgb2YgYWRkcmVzc2VzIHRoYXQgd2VyZSBub3QgYWNjZXB0ZWQgYXMgcmVjaXBpZW50c1xuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5vbnJlYWR5ID0gZnVuY3Rpb24gKCkgeyB9XG5cbi8qKlxuICogVGhlIG1haWwgaGFzIGJlZW4gc2VudC5cbiAqIFdhaXQgZm9yIGBvbmlkbGVgIG5leHQuXG4gKlxuICogQHBhcmFtIHtCb29sZWFufSBzdWNjZXNzIEluZGljYXRlcyBpZiB0aGUgbWVzc2FnZSB3YXMgcXVldWVkIGJ5IHRoZSBzZXJ2ZXIgb3Igbm90XG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLm9uZG9uZSA9IGZ1bmN0aW9uICgpIHsgfVxuXG4vL1xuLy8gUFVCTElDIE1FVEhPRFNcbi8vXG5cbi8vIENvbm5lY3Rpb24gcmVsYXRlZCBtZXRob2RzXG5cbi8qKlxuICogSW5pdGlhdGUgYSBjb25uZWN0aW9uIHRvIHRoZSBzZXJ2ZXJcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuY29ubmVjdCA9IGZ1bmN0aW9uICgpIHtcbiAgdGhpcy5zb2NrZXQgPSB0aGlzLl9UQ1BTb2NrZXQub3Blbih0aGlzLmhvc3QsIHRoaXMucG9ydCwge1xuICAgIGJpbmFyeVR5cGU6ICdhcnJheWJ1ZmZlcicsXG4gICAgdXNlU2VjdXJlVHJhbnNwb3J0OiB0aGlzLl9zZWN1cmVNb2RlLFxuICAgIGNhOiB0aGlzLm9wdGlvbnMuY2EsXG4gICAgdGxzV29ya2VyUGF0aDogdGhpcy5vcHRpb25zLnRsc1dvcmtlclBhdGgsXG4gICAgd3M6IHRoaXMub3B0aW9ucy53c1xuICB9KVxuXG4gIC8vIGFsbG93cyBjZXJ0aWZpY2F0ZSBoYW5kbGluZyBmb3IgcGxhdGZvcm0gdy9vIG5hdGl2ZSB0bHMgc3VwcG9ydFxuICAvLyBvbmNlcnQgaXMgbm9uIHN0YW5kYXJkIHNvIHNldHRpbmcgaXQgbWlnaHQgdGhyb3cgaWYgdGhlIHNvY2tldCBvYmplY3QgaXMgaW1tdXRhYmxlXG4gIHRyeSB7XG4gICAgdGhpcy5zb2NrZXQub25jZXJ0ID0gdGhpcy5vbmNlcnRcbiAgfSBjYXRjaCAoRSkgeyB9XG4gIHRoaXMuc29ja2V0Lm9uZXJyb3IgPSB0aGlzLl9vbkVycm9yLmJpbmQodGhpcylcbiAgdGhpcy5zb2NrZXQub25vcGVuID0gdGhpcy5fb25PcGVuLmJpbmQodGhpcylcbn1cblxuLyoqXG4gKiBQYXVzZXMgYGRhdGFgIGV2ZW50cyBmcm9tIHRoZSBkb3duc3RyZWFtIFNNVFAgc2VydmVyXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLnN1c3BlbmQgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnNvY2tldCAmJiB0aGlzLnNvY2tldC5yZWFkeVN0YXRlID09PSAnb3BlbicpIHtcbiAgICB0aGlzLnNvY2tldC5zdXNwZW5kKClcbiAgfVxufVxuXG4vKipcbiAqIFJlc3VtZXMgYGRhdGFgIGV2ZW50cyBmcm9tIHRoZSBkb3duc3RyZWFtIFNNVFAgc2VydmVyLiBCZSBjYXJlZnVsIG9mIG5vdFxuICogcmVzdW1pbmcgc29tZXRoaW5nIHRoYXQgaXMgbm90IHN1c3BlbmRlZCAtIGFuIGVycm9yIGlzIHRocm93biBpbiB0aGlzIGNhc2VcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUucmVzdW1lID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5zb2NrZXQgJiYgdGhpcy5zb2NrZXQucmVhZHlTdGF0ZSA9PT0gJ29wZW4nKSB7XG4gICAgdGhpcy5zb2NrZXQucmVzdW1lKClcbiAgfVxufVxuXG4vKipcbiAqIFNlbmRzIFFVSVRcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUucXVpdCA9IGZ1bmN0aW9uICgpIHtcbiAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBRVUlULi4uJylcbiAgdGhpcy5fc2VuZENvbW1hbmQoJ1FVSVQnKVxuICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5jbG9zZVxufVxuXG4vKipcbiAqIFJlc2V0IGF1dGhlbnRpY2F0aW9uXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IFthdXRoXSBVc2UgdGhpcyBpZiB5b3Ugd2FudCB0byBhdXRoZW50aWNhdGUgYXMgYW5vdGhlciB1c2VyXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLnJlc2V0ID0gZnVuY3Rpb24gKGF1dGgpIHtcbiAgdGhpcy5vcHRpb25zLmF1dGggPSBhdXRoIHx8IHRoaXMub3B0aW9ucy5hdXRoXG4gIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NlbmRpbmcgUlNFVC4uLicpXG4gIHRoaXMuX3NlbmRDb21tYW5kKCdSU0VUJylcbiAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvblJTRVRcbn1cblxuLyoqXG4gKiBDbG9zZXMgdGhlIGNvbm5lY3Rpb24gdG8gdGhlIHNlcnZlclxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5jbG9zZSA9IGZ1bmN0aW9uICgpIHtcbiAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQ2xvc2luZyBjb25uZWN0aW9uLi4uJylcbiAgaWYgKHRoaXMuc29ja2V0ICYmIHRoaXMuc29ja2V0LnJlYWR5U3RhdGUgPT09ICdvcGVuJykge1xuICAgIHRoaXMuc29ja2V0LmNsb3NlKClcbiAgfSBlbHNlIHtcbiAgICB0aGlzLl9kZXN0cm95KClcbiAgfVxufVxuXG4vLyBNYWlsIHJlbGF0ZWQgbWV0aG9kc1xuXG4vKipcbiAqIEluaXRpYXRlcyBhIG5ldyBtZXNzYWdlIGJ5IHN1Ym1pdHRpbmcgZW52ZWxvcGUgZGF0YSwgc3RhcnRpbmcgd2l0aFxuICogYE1BSUwgRlJPTTpgIGNvbW1hbmQuIFVzZSBhZnRlciBgb25pZGxlYCBldmVudFxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBlbnZlbG9wZSBFbnZlbG9wZSBvYmplY3QgaW4gdGhlIGZvcm0gb2Yge2Zyb206XCIuLi5cIiwgdG86W1wiLi4uXCJdfVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS51c2VFbnZlbG9wZSA9IGZ1bmN0aW9uIChlbnZlbG9wZSkge1xuICB0aGlzLl9lbnZlbG9wZSA9IGVudmVsb3BlIHx8IHt9XG4gIHRoaXMuX2VudmVsb3BlLmZyb20gPSBbXS5jb25jYXQodGhpcy5fZW52ZWxvcGUuZnJvbSB8fCAoJ2Fub255bW91c0AnICsgdGhpcy5vcHRpb25zLm5hbWUpKVswXVxuICB0aGlzLl9lbnZlbG9wZS50byA9IFtdLmNvbmNhdCh0aGlzLl9lbnZlbG9wZS50byB8fCBbXSlcblxuICAvLyBjbG9uZSB0aGUgcmVjaXBpZW50cyBhcnJheSBmb3IgbGF0dGVyIG1hbmlwdWxhdGlvblxuICB0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUgPSBbXS5jb25jYXQodGhpcy5fZW52ZWxvcGUudG8pXG4gIHRoaXMuX2VudmVsb3BlLnJjcHRGYWlsZWQgPSBbXVxuICB0aGlzLl9lbnZlbG9wZS5yZXNwb25zZVF1ZXVlID0gW11cblxuICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uTUFJTFxuICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIE1BSUwgRlJPTS4uLicpXG4gIHRoaXMuX3NlbmRDb21tYW5kKCdNQUlMIEZST006PCcgKyAodGhpcy5fZW52ZWxvcGUuZnJvbSkgKyAnPicpXG59XG5cbi8qKlxuICogU2VuZCBBU0NJSSBkYXRhIHRvIHRoZSBzZXJ2ZXIuIFdvcmtzIG9ubHkgaW4gZGF0YSBtb2RlIChhZnRlciBgb25yZWFkeWAgZXZlbnQpLCBpZ25vcmVkXG4gKiBvdGhlcndpc2VcbiAqXG4gKiBAcGFyYW0ge1N0cmluZ30gY2h1bmsgQVNDSUkgc3RyaW5nIChxdW90ZWQtcHJpbnRhYmxlLCBiYXNlNjQgZXRjLikgdG8gYmUgc2VudCB0byB0aGUgc2VydmVyXG4gKiBAcmV0dXJuIHtCb29sZWFufSBJZiB0cnVlLCBpdCBpcyBzYWZlIHRvIHNlbmQgbW9yZSBkYXRhLCBpZiBmYWxzZSwgeW91ICpzaG91bGQqIHdhaXQgZm9yIHRoZSBvbmRyYWluIGV2ZW50IGJlZm9yZSBzZW5kaW5nIG1vcmVcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuc2VuZCA9IGZ1bmN0aW9uIChjaHVuaykge1xuICAvLyB3b3JrcyBvbmx5IGluIGRhdGEgbW9kZVxuICBpZiAoIXRoaXMuX2RhdGFNb2RlKSB7XG4gICAgLy8gdGhpcyBsaW5lIHNob3VsZCBuZXZlciBiZSByZWFjaGVkIGJ1dCBpZiBpdCBkb2VzLFxuICAgIC8vIGFjdCBsaWtlIGV2ZXJ5dGhpbmcncyBub3JtYWwuXG4gICAgcmV0dXJuIHRydWVcbiAgfVxuXG4gIC8vIFRPRE86IGlmIHRoZSBjaHVuayBpcyBhbiBhcnJheWJ1ZmZlciwgdXNlIGEgc2VwYXJhdGUgZnVuY3Rpb24gdG8gc2VuZCB0aGUgZGF0YVxuICByZXR1cm4gdGhpcy5fc2VuZFN0cmluZyhjaHVuaylcbn1cblxuLyoqXG4gKiBJbmRpY2F0ZXMgdGhhdCBhIGRhdGEgc3RyZWFtIGZvciB0aGUgc29ja2V0IGlzIGVuZGVkLiBXb3JrcyBvbmx5IGluIGRhdGFcbiAqIG1vZGUgKGFmdGVyIGBvbnJlYWR5YCBldmVudCksIGlnbm9yZWQgb3RoZXJ3aXNlLiBVc2UgaXQgd2hlbiB5b3UgYXJlIGRvbmVcbiAqIHdpdGggc2VuZGluZyB0aGUgbWFpbC4gVGhpcyBtZXRob2QgZG9lcyBub3QgY2xvc2UgdGhlIHNvY2tldC4gT25jZSB0aGUgbWFpbFxuICogaGFzIGJlZW4gcXVldWVkIGJ5IHRoZSBzZXJ2ZXIsIGBvbmRvbmVgIGFuZCBgb25pZGxlYCBhcmUgZW1pdHRlZC5cbiAqXG4gKiBAcGFyYW0ge0J1ZmZlcn0gW2NodW5rXSBDaHVuayBvZiBkYXRhIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5lbmQgPSBmdW5jdGlvbiAoY2h1bmspIHtcbiAgLy8gd29ya3Mgb25seSBpbiBkYXRhIG1vZGVcbiAgaWYgKCF0aGlzLl9kYXRhTW9kZSkge1xuICAgIC8vIHRoaXMgbGluZSBzaG91bGQgbmV2ZXIgYmUgcmVhY2hlZCBidXQgaWYgaXQgZG9lcyxcbiAgICAvLyBhY3QgbGlrZSBldmVyeXRoaW5nJ3Mgbm9ybWFsLlxuICAgIHJldHVybiB0cnVlXG4gIH1cblxuICBpZiAoY2h1bmsgJiYgY2h1bmsubGVuZ3RoKSB7XG4gICAgdGhpcy5zZW5kKGNodW5rKVxuICB9XG5cbiAgLy8gcmVkaXJlY3Qgb3V0cHV0IGZyb20gdGhlIHNlcnZlciB0byBfYWN0aW9uU3RyZWFtXG4gIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25TdHJlYW1cblxuICAvLyBpbmRpY2F0ZSB0aGF0IHRoZSBzdHJlYW0gaGFzIGVuZGVkIGJ5IHNlbmRpbmcgYSBzaW5nbGUgZG90IG9uIGl0cyBvd24gbGluZVxuICAvLyBpZiB0aGUgY2xpZW50IGFscmVhZHkgY2xvc2VkIHRoZSBkYXRhIHdpdGggXFxyXFxuIG5vIG5lZWQgdG8gZG8gaXQgYWdhaW5cbiAgaWYgKHRoaXMuX2xhc3REYXRhQnl0ZXMgPT09ICdcXHJcXG4nKSB7XG4gICAgdGhpcy53YWl0RHJhaW4gPSB0aGlzLl9zZW5kKG5ldyBVaW50OEFycmF5KFsweDJFLCAweDBELCAweDBBXSkuYnVmZmVyKSAvLyAuXFxyXFxuXG4gIH0gZWxzZSBpZiAodGhpcy5fbGFzdERhdGFCeXRlcy5zdWJzdHIoLTEpID09PSAnXFxyJykge1xuICAgIHRoaXMud2FpdERyYWluID0gdGhpcy5fc2VuZChuZXcgVWludDhBcnJheShbMHgwQSwgMHgyRSwgMHgwRCwgMHgwQV0pLmJ1ZmZlcikgLy8gXFxuLlxcclxcblxuICB9IGVsc2Uge1xuICAgIHRoaXMud2FpdERyYWluID0gdGhpcy5fc2VuZChuZXcgVWludDhBcnJheShbMHgwRCwgMHgwQSwgMHgyRSwgMHgwRCwgMHgwQV0pLmJ1ZmZlcikgLy8gXFxyXFxuLlxcclxcblxuICB9XG5cbiAgLy8gZW5kIGRhdGEgbW9kZSwgcmVzZXQgdGhlIHZhcmlhYmxlcyBmb3IgZXh0ZW5kaW5nIHRoZSB0aW1lb3V0IGluIGRhdGEgbW9kZVxuICB0aGlzLl9kYXRhTW9kZSA9IGZhbHNlXG4gIHRoaXMuX3NvY2tldFRpbWVvdXRTdGFydCA9IGZhbHNlXG4gIHRoaXMuX3NvY2tldFRpbWVvdXRQZXJpb2QgPSBmYWxzZVxuXG4gIHJldHVybiB0aGlzLndhaXREcmFpblxufVxuXG4vLyBQUklWQVRFIE1FVEhPRFNcblxuLy8gRVZFTlQgSEFORExFUlMgRk9SIFRIRSBTT0NLRVRcblxuLyoqXG4gKiBDb25uZWN0aW9uIGxpc3RlbmVyIHRoYXQgaXMgcnVuIHdoZW4gdGhlIGNvbm5lY3Rpb24gdG8gdGhlIHNlcnZlciBpcyBvcGVuZWQuXG4gKiBTZXRzIHVwIGRpZmZlcmVudCBldmVudCBoYW5kbGVycyBmb3IgdGhlIG9wZW5lZCBzb2NrZXRcbiAqXG4gKiBAZXZlbnRcbiAqIEBwYXJhbSB7RXZlbnR9IGV2dCBFdmVudCBvYmplY3QuIE5vdCB1c2VkXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9vbk9wZW4gPSBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgaWYgKGV2ZW50ICYmIGV2ZW50LmRhdGEgJiYgZXZlbnQuZGF0YS5wcm94eUhvc3RuYW1lKSB7XG4gICAgdGhpcy5vcHRpb25zLm5hbWUgPSBldmVudC5kYXRhLnByb3h5SG9zdG5hbWVcbiAgfVxuXG4gIHRoaXMuc29ja2V0Lm9uZGF0YSA9IHRoaXMuX29uRGF0YS5iaW5kKHRoaXMpXG5cbiAgdGhpcy5zb2NrZXQub25jbG9zZSA9IHRoaXMuX29uQ2xvc2UuYmluZCh0aGlzKVxuICB0aGlzLnNvY2tldC5vbmRyYWluID0gdGhpcy5fb25EcmFpbi5iaW5kKHRoaXMpXG5cbiAgdGhpcy5fcGFyc2VyLm9uZGF0YSA9IHRoaXMuX29uQ29tbWFuZC5iaW5kKHRoaXMpXG5cbiAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkdyZWV0aW5nXG59XG5cbi8qKlxuICogRGF0YSBsaXN0ZW5lciBmb3IgY2h1bmtzIG9mIGRhdGEgZW1pdHRlZCBieSB0aGUgc2VydmVyXG4gKlxuICogQGV2ZW50XG4gKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBTZWUgYGV2dC5kYXRhYCBmb3IgdGhlIGNodW5rIHJlY2VpdmVkXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9vbkRhdGEgPSBmdW5jdGlvbiAoZXZ0KSB7XG4gIGNsZWFyVGltZW91dCh0aGlzLl9zb2NrZXRUaW1lb3V0VGltZXIpXG4gIHZhciBzdHJpbmdQYXlsb2FkID0gbmV3IFRleHREZWNvZGVyKCdVVEYtOCcpLmRlY29kZShuZXcgVWludDhBcnJheShldnQuZGF0YSkpXG4gIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NFUlZFUjogJyArIHN0cmluZ1BheWxvYWQpXG4gIHRoaXMuX3BhcnNlci5zZW5kKHN0cmluZ1BheWxvYWQpXG59XG5cbi8qKlxuICogTW9yZSBkYXRhIGNhbiBiZSBidWZmZXJlZCBpbiB0aGUgc29ja2V0LCBgd2FpdERyYWluYCBpcyByZXNldCB0byBmYWxzZVxuICpcbiAqIEBldmVudFxuICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gTm90IHVzZWRcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX29uRHJhaW4gPSBmdW5jdGlvbiAoKSB7XG4gIHRoaXMud2FpdERyYWluID0gZmFsc2VcbiAgdGhpcy5vbmRyYWluKClcbn1cblxuLyoqXG4gKiBFcnJvciBoYW5kbGVyIGZvciB0aGUgc29ja2V0XG4gKlxuICogQGV2ZW50XG4gKiBAcGFyYW0ge0V2ZW50fSBldnQgRXZlbnQgb2JqZWN0LiBTZWUgZXZ0LmRhdGEgZm9yIHRoZSBlcnJvclxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fb25FcnJvciA9IGZ1bmN0aW9uIChldnQpIHtcbiAgaWYgKGV2dCBpbnN0YW5jZW9mIEVycm9yICYmIGV2dC5tZXNzYWdlKSB7XG4gICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCBldnQpXG4gICAgdGhpcy5vbmVycm9yKGV2dClcbiAgfSBlbHNlIGlmIChldnQgJiYgZXZ0LmRhdGEgaW5zdGFuY2VvZiBFcnJvcikge1xuICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgZXZ0LmRhdGEpXG4gICAgdGhpcy5vbmVycm9yKGV2dC5kYXRhKVxuICB9IGVsc2Uge1xuICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgbmV3IEVycm9yKChldnQgJiYgZXZ0LmRhdGEgJiYgZXZ0LmRhdGEubWVzc2FnZSkgfHwgZXZ0LmRhdGEgfHwgZXZ0IHx8ICdFcnJvcicpKVxuICAgIHRoaXMub25lcnJvcihuZXcgRXJyb3IoKGV2dCAmJiBldnQuZGF0YSAmJiBldnQuZGF0YS5tZXNzYWdlKSB8fCBldnQuZGF0YSB8fCBldnQgfHwgJ0Vycm9yJykpXG4gIH1cblxuICB0aGlzLmNsb3NlKClcbn1cblxuLyoqXG4gKiBJbmRpY2F0ZXMgdGhhdCB0aGUgc29ja2V0IGhhcyBiZWVuIGNsb3NlZFxuICpcbiAqIEBldmVudFxuICogQHBhcmFtIHtFdmVudH0gZXZ0IEV2ZW50IG9iamVjdC4gTm90IHVzZWRcbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX29uQ2xvc2UgPSBmdW5jdGlvbiAoKSB7XG4gIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ1NvY2tldCBjbG9zZWQuJylcbiAgdGhpcy5fZGVzdHJveSgpXG59XG5cbi8qKlxuICogVGhpcyBpcyBub3QgYSBzb2NrZXQgZGF0YSBoYW5kbGVyIGJ1dCB0aGUgaGFuZGxlciBmb3IgZGF0YSBlbWl0dGVkIGJ5IHRoZSBwYXJzZXIsXG4gKiBzbyB0aGlzIGRhdGEgaXMgc2FmZSB0byB1c2UgYXMgaXQgaXMgYWx3YXlzIGNvbXBsZXRlIChzZXJ2ZXIgbWlnaHQgc2VuZCBwYXJ0aWFsIGNodW5rcylcbiAqXG4gKiBAZXZlbnRcbiAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBkYXRhXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9vbkNvbW1hbmQgPSBmdW5jdGlvbiAoY29tbWFuZCkge1xuICBpZiAodHlwZW9mIHRoaXMuX2N1cnJlbnRBY3Rpb24gPT09ICdmdW5jdGlvbicpIHtcbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uKGNvbW1hbmQpXG4gIH1cbn1cblxuU210cENsaWVudC5wcm90b3R5cGUuX29uVGltZW91dCA9IGZ1bmN0aW9uICgpIHtcbiAgLy8gaW5mb3JtIGFib3V0IHRoZSB0aW1lb3V0IGFuZCBzaHV0IGRvd25cbiAgdmFyIGVycm9yID0gbmV3IEVycm9yKCdTb2NrZXQgdGltZWQgb3V0IScpXG4gIHRoaXMuX29uRXJyb3IoZXJyb3IpXG59XG5cbi8qKlxuICogRW5zdXJlcyB0aGF0IHRoZSBjb25uZWN0aW9uIGlzIGNsb3NlZCBhbmQgc3VjaFxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fZGVzdHJveSA9IGZ1bmN0aW9uICgpIHtcbiAgY2xlYXJUaW1lb3V0KHRoaXMuX3NvY2tldFRpbWVvdXRUaW1lcilcblxuICBpZiAoIXRoaXMuZGVzdHJveWVkKSB7XG4gICAgdGhpcy5kZXN0cm95ZWQgPSB0cnVlXG4gICAgdGhpcy5vbmNsb3NlKClcbiAgfVxufVxuXG4vKipcbiAqIFNlbmRzIGEgc3RyaW5nIHRvIHRoZSBzb2NrZXQuXG4gKlxuICogQHBhcmFtIHtTdHJpbmd9IGNodW5rIEFTQ0lJIHN0cmluZyAocXVvdGVkLXByaW50YWJsZSwgYmFzZTY0IGV0Yy4pIHRvIGJlIHNlbnQgdG8gdGhlIHNlcnZlclxuICogQHJldHVybiB7Qm9vbGVhbn0gSWYgdHJ1ZSwgaXQgaXMgc2FmZSB0byBzZW5kIG1vcmUgZGF0YSwgaWYgZmFsc2UsIHlvdSAqc2hvdWxkKiB3YWl0IGZvciB0aGUgb25kcmFpbiBldmVudCBiZWZvcmUgc2VuZGluZyBtb3JlXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9zZW5kU3RyaW5nID0gZnVuY3Rpb24gKGNodW5rKSB7XG4gIC8vIGVzY2FwZSBkb3RzXG4gIGlmICghdGhpcy5vcHRpb25zLmRpc2FibGVFc2NhcGluZykge1xuICAgIGNodW5rID0gY2h1bmsucmVwbGFjZSgvXFxuXFwuL2csICdcXG4uLicpXG4gICAgaWYgKCh0aGlzLl9sYXN0RGF0YUJ5dGVzLnN1YnN0cigtMSkgPT09ICdcXG4nIHx8ICF0aGlzLl9sYXN0RGF0YUJ5dGVzKSAmJiBjaHVuay5jaGFyQXQoMCkgPT09ICcuJykge1xuICAgICAgY2h1bmsgPSAnLicgKyBjaHVua1xuICAgIH1cbiAgfVxuXG4gIC8vIEtlZXBpbmcgZXllIG9uIHRoZSBsYXN0IGJ5dGVzIHNlbnQsIHRvIHNlZSBpZiB0aGVyZSBpcyBhIDxDUj48TEY+IHNlcXVlbmNlXG4gIC8vIGF0IHRoZSBlbmQgd2hpY2ggaXMgbmVlZGVkIHRvIGVuZCB0aGUgZGF0YSBzdHJlYW1cbiAgaWYgKGNodW5rLmxlbmd0aCA+IDIpIHtcbiAgICB0aGlzLl9sYXN0RGF0YUJ5dGVzID0gY2h1bmsuc3Vic3RyKC0yKVxuICB9IGVsc2UgaWYgKGNodW5rLmxlbmd0aCA9PT0gMSkge1xuICAgIHRoaXMuX2xhc3REYXRhQnl0ZXMgPSB0aGlzLl9sYXN0RGF0YUJ5dGVzLnN1YnN0cigtMSkgKyBjaHVua1xuICB9XG5cbiAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyAnICsgY2h1bmsubGVuZ3RoICsgJyBieXRlcyBvZiBwYXlsb2FkJylcblxuICAvLyBwYXNzIHRoZSBjaHVuayB0byB0aGUgc29ja2V0XG4gIHRoaXMud2FpdERyYWluID0gdGhpcy5fc2VuZChuZXcgVGV4dEVuY29kZXIoJ1VURi04JykuZW5jb2RlKGNodW5rKS5idWZmZXIpXG4gIHJldHVybiB0aGlzLndhaXREcmFpblxufVxuXG4vKipcbiAqIFNlbmQgYSBzdHJpbmcgY29tbWFuZCB0byB0aGUgc2VydmVyLCBhbHNvIGFwcGVuZCBcXHJcXG4gaWYgbmVlZGVkXG4gKlxuICogQHBhcmFtIHtTdHJpbmd9IHN0ciBTdHJpbmcgdG8gYmUgc2VudCB0byB0aGUgc2VydmVyXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9zZW5kQ29tbWFuZCA9IGZ1bmN0aW9uIChzdHIpIHtcbiAgdGhpcy53YWl0RHJhaW4gPSB0aGlzLl9zZW5kKG5ldyBUZXh0RW5jb2RlcignVVRGLTgnKS5lbmNvZGUoc3RyICsgKHN0ci5zdWJzdHIoLTIpICE9PSAnXFxyXFxuJyA/ICdcXHJcXG4nIDogJycpKS5idWZmZXIpXG59XG5cblNtdHBDbGllbnQucHJvdG90eXBlLl9zZW5kID0gZnVuY3Rpb24gKGJ1ZmZlcikge1xuICB0aGlzLl9zZXRUaW1lb3V0KGJ1ZmZlci5ieXRlTGVuZ3RoKVxuICByZXR1cm4gdGhpcy5zb2NrZXQuc2VuZChidWZmZXIpXG59XG5cblNtdHBDbGllbnQucHJvdG90eXBlLl9zZXRUaW1lb3V0ID0gZnVuY3Rpb24gKGJ5dGVMZW5ndGgpIHtcbiAgdmFyIHByb2xvbmdQZXJpb2QgPSBNYXRoLmZsb29yKGJ5dGVMZW5ndGggKiB0aGlzLlRJTUVPVVRfU09DS0VUX01VTFRJUExJRVIpXG4gIHZhciB0aW1lb3V0XG5cbiAgaWYgKHRoaXMuX2RhdGFNb2RlKSB7XG4gICAgLy8gd2UncmUgaW4gZGF0YSBtb2RlLCBzbyB3ZSBjb3VudCBvbmx5IG9uZSB0aW1lb3V0IHRoYXQgZ2V0IGV4dGVuZGVkIGZvciBldmVyeSBzZW5kKCkuXG4gICAgdmFyIG5vdyA9IERhdGUubm93KClcblxuICAgIC8vIHRoZSBvbGQgdGltZW91dCBzdGFydCB0aW1lXG4gICAgdGhpcy5fc29ja2V0VGltZW91dFN0YXJ0ID0gdGhpcy5fc29ja2V0VGltZW91dFN0YXJ0IHx8IG5vd1xuXG4gICAgLy8gdGhlIG9sZCB0aW1lb3V0IHBlcmlvZCwgbm9ybWFsaXplZCB0byBhIG1pbmltdW0gb2YgVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkRcbiAgICB0aGlzLl9zb2NrZXRUaW1lb3V0UGVyaW9kID0gKHRoaXMuX3NvY2tldFRpbWVvdXRQZXJpb2QgfHwgdGhpcy5USU1FT1VUX1NPQ0tFVF9MT1dFUl9CT1VORCkgKyBwcm9sb25nUGVyaW9kXG5cbiAgICAvLyB0aGUgbmV3IHRpbWVvdXQgaXMgdGhlIGRlbHRhIGJldHdlZW4gdGhlIG5ldyBmaXJpbmcgdGltZSAoPSB0aW1lb3V0IHBlcmlvZCArIHRpbWVvdXQgc3RhcnQgdGltZSkgYW5kIG5vd1xuICAgIHRpbWVvdXQgPSB0aGlzLl9zb2NrZXRUaW1lb3V0U3RhcnQgKyB0aGlzLl9zb2NrZXRUaW1lb3V0UGVyaW9kIC0gbm93XG4gIH0gZWxzZSB7XG4gICAgLy8gc2V0IG5ldyB0aW1vdXRcbiAgICB0aW1lb3V0ID0gdGhpcy5USU1FT1VUX1NPQ0tFVF9MT1dFUl9CT1VORCArIHByb2xvbmdQZXJpb2RcbiAgfVxuXG4gIGNsZWFyVGltZW91dCh0aGlzLl9zb2NrZXRUaW1lb3V0VGltZXIpIC8vIGNsZWFyIHBlbmRpbmcgdGltZW91dHNcbiAgdGhpcy5fc29ja2V0VGltZW91dFRpbWVyID0gc2V0VGltZW91dCh0aGlzLl9vblRpbWVvdXQuYmluZCh0aGlzKSwgdGltZW91dCkgLy8gYXJtIHRoZSBuZXh0IHRpbWVvdXRcbn1cblxuLyoqXG4gKiBJbnRpdGlhdGUgYXV0aGVudGljYXRpb24gc2VxdWVuY2UgaWYgbmVlZGVkXG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9hdXRoZW50aWNhdGVVc2VyID0gZnVuY3Rpb24gKCkge1xuICBpZiAoIXRoaXMub3B0aW9ucy5hdXRoKSB7XG4gICAgLy8gbm8gbmVlZCB0byBhdXRoZW50aWNhdGUsIGF0IGxlYXN0IG5vIGRhdGEgZ2l2ZW5cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgIHRoaXMub25pZGxlKCkgLy8gcmVhZHkgdG8gdGFrZSBvcmRlcnNcbiAgICByZXR1cm5cbiAgfVxuXG4gIHZhciBhdXRoXG5cbiAgaWYgKCF0aGlzLm9wdGlvbnMuYXV0aE1ldGhvZCAmJiB0aGlzLm9wdGlvbnMuYXV0aC54b2F1dGgyKSB7XG4gICAgdGhpcy5vcHRpb25zLmF1dGhNZXRob2QgPSAnWE9BVVRIMidcbiAgfVxuXG4gIGlmICh0aGlzLm9wdGlvbnMuYXV0aE1ldGhvZCkge1xuICAgIGF1dGggPSB0aGlzLm9wdGlvbnMuYXV0aE1ldGhvZC50b1VwcGVyQ2FzZSgpLnRyaW0oKVxuICB9IGVsc2Uge1xuICAgIC8vIHVzZSBmaXJzdCBzdXBwb3J0ZWRcbiAgICBhdXRoID0gKHRoaXMuX3N1cHBvcnRlZEF1dGhbMF0gfHwgJ1BMQUlOJykudG9VcHBlckNhc2UoKS50cmltKClcbiAgfVxuXG4gIHN3aXRjaCAoYXV0aCkge1xuICAgIGNhc2UgJ0xPR0lOJzpcbiAgICAgIC8vIExPR0lOIGlzIGEgMyBzdGVwIGF1dGhlbnRpY2F0aW9uIHByb2Nlc3NcbiAgICAgIC8vIEM6IEFVVEggTE9HSU5cbiAgICAgIC8vIEM6IEJBU0U2NChVU0VSKVxuICAgICAgLy8gQzogQkFTRTY0KFBBU1MpXG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiB2aWEgQVVUSCBMT0dJTicpXG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSF9MT0dJTl9VU0VSXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnQVVUSCBMT0dJTicpXG4gICAgICByZXR1cm5cbiAgICBjYXNlICdQTEFJTic6XG4gICAgICAvLyBBVVRIIFBMQUlOIGlzIGEgMSBzdGVwIGF1dGhlbnRpY2F0aW9uIHByb2Nlc3NcbiAgICAgIC8vIEM6IEFVVEggUExBSU4gQkFTRTY0KFxcMCBVU0VSIFxcMCBQQVNTKVxuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQXV0aGVudGljYXRpb24gdmlhIEFVVEggUExBSU4nKVxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhDb21wbGV0ZVxuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoXG4gICAgICAgIC8vIGNvbnZlcnQgdG8gQkFTRTY0XG4gICAgICAgICdBVVRIIFBMQUlOICcgK1xuICAgICAgICBlbmNvZGUoXG4gICAgICAgICAgLy8gdGhpcy5vcHRpb25zLmF1dGgudXNlcisnXFx1MDAwMCcrXG4gICAgICAgICAgJ1xcdTAwMDAnICsgLy8gc2tpcCBhdXRob3JpemF0aW9uIGlkZW50aXR5IGFzIGl0IGNhdXNlcyBwcm9ibGVtcyB3aXRoIHNvbWUgc2VydmVyc1xuICAgICAgICAgIHRoaXMub3B0aW9ucy5hdXRoLnVzZXIgKyAnXFx1MDAwMCcgK1xuICAgICAgICAgIHRoaXMub3B0aW9ucy5hdXRoLnBhc3MpXG4gICAgICApXG4gICAgICByZXR1cm5cbiAgICBjYXNlICdYT0FVVEgyJzpcbiAgICAgIC8vIFNlZSBodHRwczovL2RldmVsb3BlcnMuZ29vZ2xlLmNvbS9nbWFpbC94b2F1dGgyX3Byb3RvY29sI3NtdHBfcHJvdG9jb2xfZXhjaGFuZ2VcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0F1dGhlbnRpY2F0aW9uIHZpYSBBVVRIIFhPQVVUSDInKVxuICAgICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhfWE9BVVRIMlxuICAgICAgdGhpcy5fc2VuZENvbW1hbmQoJ0FVVEggWE9BVVRIMiAnICsgdGhpcy5fYnVpbGRYT0F1dGgyVG9rZW4odGhpcy5vcHRpb25zLmF1dGgudXNlciwgdGhpcy5vcHRpb25zLmF1dGgueG9hdXRoMikpXG4gICAgICByZXR1cm5cbiAgfVxuXG4gIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdVbmtub3duIGF1dGhlbnRpY2F0aW9uIG1ldGhvZCAnICsgYXV0aCkpXG59XG5cbi8vIEFDVElPTlMgRk9SIFJFU1BPTlNFUyBGUk9NIFRIRSBTTVRQIFNFUlZFUlxuXG4vKipcbiAqIEluaXRpYWwgcmVzcG9uc2UgZnJvbSB0aGUgc2VydmVyLCBtdXN0IGhhdmUgYSBzdGF0dXMgMjIwXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fYWN0aW9uR3JlZXRpbmcgPSBmdW5jdGlvbiAoY29tbWFuZCkge1xuICBpZiAoY29tbWFuZC5zdGF0dXNDb2RlICE9PSAyMjApIHtcbiAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignSW52YWxpZCBncmVldGluZzogJyArIGNvbW1hbmQuZGF0YSkpXG4gICAgcmV0dXJuXG4gIH1cblxuICBpZiAodGhpcy5vcHRpb25zLmxtdHApIHtcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZW5kaW5nIExITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkxITE9cbiAgICB0aGlzLl9zZW5kQ29tbWFuZCgnTEhMTyAnICsgdGhpcy5vcHRpb25zLm5hbWUpXG4gIH0gZWxzZSB7XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBFSExPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcblxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25FSExPXG4gICAgdGhpcy5fc2VuZENvbW1hbmQoJ0VITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxuICB9XG59XG5cbi8qKlxuICogUmVzcG9uc2UgdG8gTEhMT1xuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2FjdGlvbkxITE8gPSBmdW5jdGlvbiAoY29tbWFuZCkge1xuICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0xITE8gbm90IHN1Y2Nlc3NmdWwnKVxuICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgcmV0dXJuXG4gIH1cblxuICAvLyBQcm9jZXNzIGFzIEVITE8gcmVzcG9uc2VcbiAgdGhpcy5fYWN0aW9uRUhMTyhjb21tYW5kKVxufVxuXG4vKipcbiAqIFJlc3BvbnNlIHRvIEVITE8uIElmIHRoZSByZXNwb25zZSBpcyBhbiBlcnJvciwgdHJ5IEhFTE8gaW5zdGVhZFxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2FjdGlvbkVITE8gPSBmdW5jdGlvbiAoY29tbWFuZCkge1xuICB2YXIgbWF0Y2hcblxuICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgIGlmICghdGhpcy5fc2VjdXJlTW9kZSAmJiB0aGlzLm9wdGlvbnMucmVxdWlyZVRMUykge1xuICAgICAgdmFyIGVyck1zZyA9ICdTVEFSVFRMUyBub3Qgc3VwcG9ydGVkIHdpdGhvdXQgRUhMTydcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgZXJyTXNnKVxuICAgICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoZXJyTXNnKSlcbiAgICAgIHJldHVyblxuICAgIH1cblxuICAgIC8vIFRyeSBIRUxPIGluc3RlYWRcbiAgICB0aGlzLmxvZ2dlci53YXJuKERFQlVHX1RBRywgJ0VITE8gbm90IHN1Y2Nlc3NmdWwsIHRyeWluZyBIRUxPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSEVMT1xuICAgIHRoaXMuX3NlbmRDb21tYW5kKCdIRUxPICcgKyB0aGlzLm9wdGlvbnMubmFtZSlcbiAgICByZXR1cm5cbiAgfVxuXG4gIC8vIERldGVjdCBpZiB0aGUgc2VydmVyIHN1cHBvcnRzIFBMQUlOIGF1dGhcbiAgaWYgKGNvbW1hbmQubGluZS5tYXRjaCgvQVVUSCg/OlxccytbXlxcbl0qXFxzK3xcXHMrKVBMQUlOL2kpKSB7XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VydmVyIHN1cHBvcnRzIEFVVEggUExBSU4nKVxuICAgIHRoaXMuX3N1cHBvcnRlZEF1dGgucHVzaCgnUExBSU4nKVxuICB9XG5cbiAgLy8gRGV0ZWN0IGlmIHRoZSBzZXJ2ZXIgc3VwcG9ydHMgTE9HSU4gYXV0aFxuICBpZiAoY29tbWFuZC5saW5lLm1hdGNoKC9BVVRIKD86XFxzK1teXFxuXSpcXHMrfFxccyspTE9HSU4vaSkpIHtcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZXJ2ZXIgc3VwcG9ydHMgQVVUSCBMT0dJTicpXG4gICAgdGhpcy5fc3VwcG9ydGVkQXV0aC5wdXNoKCdMT0dJTicpXG4gIH1cblxuICAvLyBEZXRlY3QgaWYgdGhlIHNlcnZlciBzdXBwb3J0cyBYT0FVVEgyIGF1dGhcbiAgaWYgKGNvbW1hbmQubGluZS5tYXRjaCgvQVVUSCg/OlxccytbXlxcbl0qXFxzK3xcXHMrKVhPQVVUSDIvaSkpIHtcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdTZXJ2ZXIgc3VwcG9ydHMgQVVUSCBYT0FVVEgyJylcbiAgICB0aGlzLl9zdXBwb3J0ZWRBdXRoLnB1c2goJ1hPQVVUSDInKVxuICB9XG5cbiAgLy8gRGV0ZWN0IG1heGltdW0gYWxsb3dlZCBtZXNzYWdlIHNpemVcbiAgaWYgKChtYXRjaCA9IGNvbW1hbmQubGluZS5tYXRjaCgvU0laRSAoXFxkKykvaSkpICYmIE51bWJlcihtYXRjaFsxXSkpIHtcbiAgICB0aGlzLl9tYXhBbGxvd2VkU2l6ZSA9IE51bWJlcihtYXRjaFsxXSlcbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdNYXhpbXVtIGFsbG93ZCBtZXNzYWdlIHNpemU6ICcgKyB0aGlzLl9tYXhBbGxvd2VkU2l6ZSlcbiAgfVxuXG4gIC8vIERldGVjdCBpZiB0aGUgc2VydmVyIHN1cHBvcnRzIFNUQVJUVExTXG4gIGlmICghdGhpcy5fc2VjdXJlTW9kZSkge1xuICAgIGlmICgoY29tbWFuZC5saW5lLm1hdGNoKC9bIC1dU1RBUlRUTFNcXHM/JC9taSkgJiYgIXRoaXMub3B0aW9ucy5pZ25vcmVUTFMpIHx8ICEhdGhpcy5vcHRpb25zLnJlcXVpcmVUTFMpIHtcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25TVEFSVFRMU1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnU2VuZGluZyBTVEFSVFRMUycpXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnU1RBUlRUTFMnKVxuICAgICAgcmV0dXJuXG4gICAgfVxuICB9XG5cbiAgdGhpcy5fYXV0aGVudGljYXRlVXNlcigpXG59XG5cbi8qKlxuICogSGFuZGxlcyBzZXJ2ZXIgcmVzcG9uc2UgZm9yIFNUQVJUVExTIGNvbW1hbmQuIElmIHRoZXJlJ3MgYW4gZXJyb3JcbiAqIHRyeSBIRUxPIGluc3RlYWQsIG90aGVyd2lzZSBpbml0aWF0ZSBUTFMgdXBncmFkZS4gSWYgdGhlIHVwZ3JhZGVcbiAqIHN1Y2NlZWRlcyByZXN0YXJ0IHRoZSBFSExPXG4gKlxuICogQHBhcmFtIHtTdHJpbmd9IHN0ciBNZXNzYWdlIGZyb20gdGhlIHNlcnZlclxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fYWN0aW9uU1RBUlRUTFMgPSBmdW5jdGlvbiAoY29tbWFuZCkge1xuICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ1NUQVJUVExTIG5vdCBzdWNjZXNzZnVsJylcbiAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgIHJldHVyblxuICB9XG5cbiAgdGhpcy5fc2VjdXJlTW9kZSA9IHRydWVcbiAgdGhpcy5zb2NrZXQudXBncmFkZVRvU2VjdXJlKClcblxuICAvLyByZXN0YXJ0IHByb3RvY29sIGZsb3dcbiAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkVITE9cbiAgdGhpcy5fc2VuZENvbW1hbmQoJ0VITE8gJyArIHRoaXMub3B0aW9ucy5uYW1lKVxufVxuXG4vKipcbiAqIFJlc3BvbnNlIHRvIEhFTE9cbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9hY3Rpb25IRUxPID0gZnVuY3Rpb24gKGNvbW1hbmQpIHtcbiAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdIRUxPIG5vdCBzdWNjZXNzZnVsJylcbiAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgIHJldHVyblxuICB9XG4gIHRoaXMuX2F1dGhlbnRpY2F0ZVVzZXIoKVxufVxuXG4vKipcbiAqIFJlc3BvbnNlIHRvIEFVVEggTE9HSU4sIGlmIHN1Y2Nlc3NmdWwgZXhwZWN0cyBiYXNlNjQgZW5jb2RlZCB1c2VybmFtZVxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2FjdGlvbkFVVEhfTE9HSU5fVVNFUiA9IGZ1bmN0aW9uIChjb21tYW5kKSB7XG4gIGlmIChjb21tYW5kLnN0YXR1c0NvZGUgIT09IDMzNCB8fCBjb21tYW5kLmRhdGEgIT09ICdWWE5sY201aGJXVTYnKSB7XG4gICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnQVVUSCBMT0dJTiBVU0VSIG5vdCBzdWNjZXNzZnVsOiAnICsgY29tbWFuZC5kYXRhKVxuICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdJbnZhbGlkIGxvZ2luIHNlcXVlbmNlIHdoaWxlIHdhaXRpbmcgZm9yIFwiMzM0IFZYTmxjbTVoYldVNiBcIjogJyArIGNvbW1hbmQuZGF0YSkpXG4gICAgcmV0dXJuXG4gIH1cbiAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQVVUSCBMT0dJTiBVU0VSIHN1Y2Nlc3NmdWwnKVxuICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSF9MT0dJTl9QQVNTXG4gIHRoaXMuX3NlbmRDb21tYW5kKGVuY29kZSh0aGlzLm9wdGlvbnMuYXV0aC51c2VyKSlcbn1cblxuLyoqXG4gKiBSZXNwb25zZSB0byBBVVRIIExPR0lOIHVzZXJuYW1lLCBpZiBzdWNjZXNzZnVsIGV4cGVjdHMgYmFzZTY0IGVuY29kZWQgcGFzc3dvcmRcbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9hY3Rpb25BVVRIX0xPR0lOX1BBU1MgPSBmdW5jdGlvbiAoY29tbWFuZCkge1xuICBpZiAoY29tbWFuZC5zdGF0dXNDb2RlICE9PSAzMzQgfHwgY29tbWFuZC5kYXRhICE9PSAnVUdGemMzZHZjbVE2Jykge1xuICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0FVVEggTE9HSU4gUEFTUyBub3Qgc3VjY2Vzc2Z1bDogJyArIGNvbW1hbmQuZGF0YSlcbiAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcignSW52YWxpZCBsb2dpbiBzZXF1ZW5jZSB3aGlsZSB3YWl0aW5nIGZvciBcIjMzNCBVR0Z6YzNkdmNtUTYgXCI6ICcgKyBjb21tYW5kLmRhdGEpKVxuICAgIHJldHVyblxuICB9XG4gIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0FVVEggTE9HSU4gUEFTUyBzdWNjZXNzZnVsJylcbiAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbkFVVEhDb21wbGV0ZVxuICB0aGlzLl9zZW5kQ29tbWFuZChlbmNvZGUodGhpcy5vcHRpb25zLmF1dGgucGFzcykpXG59XG5cbi8qKlxuICogUmVzcG9uc2UgdG8gQVVUSCBYT0FVVEgyIHRva2VuLCBpZiBlcnJvciBvY2N1cnMgc2VuZCBlbXB0eSByZXNwb25zZVxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2FjdGlvbkFVVEhfWE9BVVRIMiA9IGZ1bmN0aW9uIChjb21tYW5kKSB7XG4gIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgdGhpcy5sb2dnZXIud2FybihERUJVR19UQUcsICdFcnJvciBkdXJpbmcgQVVUSCBYT0FVVEgyLCBzZW5kaW5nIGVtcHR5IHJlc3BvbnNlJylcbiAgICB0aGlzLl9zZW5kQ29tbWFuZCgnJylcbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uQVVUSENvbXBsZXRlXG4gIH0gZWxzZSB7XG4gICAgdGhpcy5fYWN0aW9uQVVUSENvbXBsZXRlKGNvbW1hbmQpXG4gIH1cbn1cblxuLyoqXG4gKiBDaGVja3MgaWYgYXV0aGVudGljYXRpb24gc3VjY2VlZGVkIG9yIG5vdC4gSWYgc3VjY2Vzc2Z1bGx5IGF1dGhlbnRpY2F0ZWRcbiAqIGVtaXQgYGlkbGVgIHRvIGluZGljYXRlIHRoYXQgYW4gZS1tYWlsIGNhbiBiZSBzZW50IHVzaW5nIHRoaXMgY29ubmVjdGlvblxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2FjdGlvbkFVVEhDb21wbGV0ZSA9IGZ1bmN0aW9uIChjb21tYW5kKSB7XG4gIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnQXV0aGVudGljYXRpb24gZmFpbGVkOiAnICsgY29tbWFuZC5kYXRhKVxuICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgcmV0dXJuXG4gIH1cblxuICB0aGlzLmxvZ2dlci5kZWJ1ZyhERUJVR19UQUcsICdBdXRoZW50aWNhdGlvbiBzdWNjZXNzZnVsLicpXG5cbiAgdGhpcy5fYXV0aGVudGljYXRlZEFzID0gdGhpcy5vcHRpb25zLmF1dGgudXNlclxuXG4gIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gIHRoaXMub25pZGxlKCkgLy8gcmVhZHkgdG8gdGFrZSBvcmRlcnNcbn1cblxuLyoqXG4gKiBVc2VkIHdoZW4gdGhlIGNvbm5lY3Rpb24gaXMgaWRsZSBhbmQgdGhlIHNlcnZlciBlbWl0cyB0aW1lb3V0XG4gKlxuICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fYWN0aW9uSWRsZSA9IGZ1bmN0aW9uIChjb21tYW5kKSB7XG4gIGlmIChjb21tYW5kLnN0YXR1c0NvZGUgPiAzMDApIHtcbiAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmxpbmUpKVxuICAgIHJldHVyblxuICB9XG5cbiAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbn1cblxuLyoqXG4gKiBSZXNwb25zZSB0byBNQUlMIEZST00gY29tbWFuZC4gUHJvY2VlZCB0byBkZWZpbmluZyBSQ1BUIFRPIGxpc3QgaWYgc3VjY2Vzc2Z1bFxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2FjdGlvbk1BSUwgPSBmdW5jdGlvbiAoY29tbWFuZCkge1xuICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ01BSUwgRlJPTSB1bnN1Y2Nlc3NmdWw6ICcgKyBjb21tYW5kLmRhdGEpXG4gICAgdGhpcy5fb25FcnJvcihuZXcgRXJyb3IoY29tbWFuZC5kYXRhKSlcbiAgICByZXR1cm5cbiAgfVxuXG4gIGlmICghdGhpcy5fZW52ZWxvcGUucmNwdFF1ZXVlLmxlbmd0aCkge1xuICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdDYW5cXCd0IHNlbmQgbWFpbCAtIG5vIHJlY2lwaWVudHMgZGVmaW5lZCcpKVxuICB9IGVsc2Uge1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ01BSUwgRlJPTSBzdWNjZXNzZnVsLCBwcm9jZWVkaW5nIHdpdGggJyArIHRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5sZW5ndGggKyAnIHJlY2lwaWVudHMnKVxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0FkZGluZyByZWNpcGllbnQuLi4nKVxuICAgIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudCA9IHRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5zaGlmdCgpXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvblJDUFRcbiAgICB0aGlzLl9zZW5kQ29tbWFuZCgnUkNQVCBUTzo8JyArIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudCArICc+JylcbiAgfVxufVxuXG4vKipcbiAqIFJlc3BvbnNlIHRvIGEgUkNQVCBUTyBjb21tYW5kLiBJZiB0aGUgY29tbWFuZCBpcyB1bnN1Y2Nlc3NmdWwsIHRyeSB0aGUgbmV4dCBvbmUsXG4gKiBhcyB0aGlzIG1pZ2h0IGJlIHJlbGF0ZWQgb25seSB0byB0aGUgY3VycmVudCByZWNpcGllbnQsIG5vdCBhIGdsb2JhbCBlcnJvciwgc29cbiAqIHRoZSBmb2xsb3dpbmcgcmVjaXBpZW50cyBtaWdodCBzdGlsbCBiZSB2YWxpZFxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBjb21tYW5kIFBhcnNlZCBjb21tYW5kIGZyb20gdGhlIHNlcnZlciB7c3RhdHVzQ29kZSwgZGF0YSwgbGluZX1cbiAqL1xuU210cENsaWVudC5wcm90b3R5cGUuX2FjdGlvblJDUFQgPSBmdW5jdGlvbiAoY29tbWFuZCkge1xuICBpZiAoIWNvbW1hbmQuc3VjY2Vzcykge1xuICAgIHRoaXMubG9nZ2VyLndhcm4oREVCVUdfVEFHLCAnUkNQVCBUTyBmYWlsZWQgZm9yOiAnICsgdGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50KVxuICAgIC8vIHRoaXMgaXMgYSBzb2Z0IGVycm9yXG4gICAgdGhpcy5fZW52ZWxvcGUucmNwdEZhaWxlZC5wdXNoKHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudClcbiAgfSBlbHNlIHtcbiAgICB0aGlzLl9lbnZlbG9wZS5yZXNwb25zZVF1ZXVlLnB1c2godGhpcy5fZW52ZWxvcGUuY3VyUmVjaXBpZW50KVxuICB9XG5cbiAgaWYgKCF0aGlzLl9lbnZlbG9wZS5yY3B0UXVldWUubGVuZ3RoKSB7XG4gICAgaWYgKHRoaXMuX2VudmVsb3BlLnJjcHRGYWlsZWQubGVuZ3RoIDwgdGhpcy5fZW52ZWxvcGUudG8ubGVuZ3RoKSB7XG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uREFUQVxuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnUkNQVCBUTyBkb25lLCBwcm9jZWVkaW5nIHdpdGggcGF5bG9hZCcpXG4gICAgICB0aGlzLl9zZW5kQ29tbWFuZCgnREFUQScpXG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKCdDYW5cXCd0IHNlbmQgbWFpbCAtIGFsbCByZWNpcGllbnRzIHdlcmUgcmVqZWN0ZWQnKSlcbiAgICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0FkZGluZyByZWNpcGllbnQuLi4nKVxuICAgIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudCA9IHRoaXMuX2VudmVsb3BlLnJjcHRRdWV1ZS5zaGlmdCgpXG4gICAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvblJDUFRcbiAgICB0aGlzLl9zZW5kQ29tbWFuZCgnUkNQVCBUTzo8JyArIHRoaXMuX2VudmVsb3BlLmN1clJlY2lwaWVudCArICc+JylcbiAgfVxufVxuXG4vKipcbiAqIFJlc3BvbnNlIHRvIHRoZSBSU0VUIGNvbW1hbmQuIElmIHN1Y2Nlc3NmdWwsIGNsZWFyIHRoZSBjdXJyZW50IGF1dGhlbnRpY2F0aW9uXG4gKiBpbmZvcm1hdGlvbiBhbmQgcmVhdXRoZW50aWNhdGUuXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fYWN0aW9uUlNFVCA9IGZ1bmN0aW9uIChjb21tYW5kKSB7XG4gIGlmICghY29tbWFuZC5zdWNjZXNzKSB7XG4gICAgdGhpcy5sb2dnZXIuZXJyb3IoREVCVUdfVEFHLCAnUlNFVCB1bnN1Y2Nlc3NmdWwgJyArIGNvbW1hbmQuZGF0YSlcbiAgICB0aGlzLl9vbkVycm9yKG5ldyBFcnJvcihjb21tYW5kLmRhdGEpKVxuICAgIHJldHVyblxuICB9XG5cbiAgdGhpcy5fYXV0aGVudGljYXRlZEFzID0gbnVsbFxuICB0aGlzLl9hdXRoZW50aWNhdGVVc2VyKClcbn1cblxuLyoqXG4gKiBSZXNwb25zZSB0byB0aGUgREFUQSBjb21tYW5kLiBTZXJ2ZXIgaXMgbm93IHdhaXRpbmcgZm9yIGEgbWVzc2FnZSwgc28gZW1pdCBgb25yZWFkeWBcbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gY29tbWFuZCBQYXJzZWQgY29tbWFuZCBmcm9tIHRoZSBzZXJ2ZXIge3N0YXR1c0NvZGUsIGRhdGEsIGxpbmV9XG4gKi9cblNtdHBDbGllbnQucHJvdG90eXBlLl9hY3Rpb25EQVRBID0gZnVuY3Rpb24gKGNvbW1hbmQpIHtcbiAgLy8gcmVzcG9uc2Ugc2hvdWxkIGJlIDM1NCBidXQgYWNjb3JkaW5nIHRvIHRoaXMgaXNzdWUgaHR0cHM6Ly9naXRodWIuY29tL2VsZWl0aC9lbWFpbGpzL2lzc3Vlcy8yNFxuICAvLyBzb21lIHNlcnZlcnMgbWlnaHQgdXNlIDI1MCBpbnN0ZWFkXG4gIGlmIChbMjUwLCAzNTRdLmluZGV4T2YoY29tbWFuZC5zdGF0dXNDb2RlKSA8IDApIHtcbiAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdEQVRBIHVuc3VjY2Vzc2Z1bCAnICsgY29tbWFuZC5kYXRhKVxuICAgIHRoaXMuX29uRXJyb3IobmV3IEVycm9yKGNvbW1hbmQuZGF0YSkpXG4gICAgcmV0dXJuXG4gIH1cblxuICB0aGlzLl9kYXRhTW9kZSA9IHRydWVcbiAgdGhpcy5fY3VycmVudEFjdGlvbiA9IHRoaXMuX2FjdGlvbklkbGVcbiAgdGhpcy5vbnJlYWR5KHRoaXMuX2VudmVsb3BlLnJjcHRGYWlsZWQpXG59XG5cbi8qKlxuICogUmVzcG9uc2UgZnJvbSB0aGUgc2VydmVyLCBvbmNlIHRoZSBtZXNzYWdlIHN0cmVhbSBoYXMgZW5kZWQgd2l0aCA8Q1I+PExGPi48Q1I+PExGPlxuICogRW1pdHMgYG9uZG9uZWAuXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IGNvbW1hbmQgUGFyc2VkIGNvbW1hbmQgZnJvbSB0aGUgc2VydmVyIHtzdGF0dXNDb2RlLCBkYXRhLCBsaW5lfVxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fYWN0aW9uU3RyZWFtID0gZnVuY3Rpb24gKGNvbW1hbmQpIHtcbiAgdmFyIHJjcHRcblxuICBpZiAodGhpcy5vcHRpb25zLmxtdHApIHtcbiAgICAvLyBMTVRQIHJldHVybnMgYSByZXNwb25zZSBjb2RlIGZvciAqZXZlcnkqIHN1Y2Nlc3NmdWxseSBzZXQgcmVjaXBpZW50XG4gICAgLy8gRm9yIGV2ZXJ5IHJlY2lwaWVudCB0aGUgbWVzc2FnZSBtaWdodCBzdWNjZWVkIG9yIGZhaWwgaW5kaXZpZHVhbGx5XG5cbiAgICByY3B0ID0gdGhpcy5fZW52ZWxvcGUucmVzcG9uc2VRdWV1ZS5zaGlmdCgpXG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ0xvY2FsIGRlbGl2ZXJ5IHRvICcgKyByY3B0ICsgJyBmYWlsZWQuJylcbiAgICAgIHRoaXMuX2VudmVsb3BlLnJjcHRGYWlsZWQucHVzaChyY3B0KVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihERUJVR19UQUcsICdMb2NhbCBkZWxpdmVyeSB0byAnICsgcmNwdCArICcgc3VjY2VlZGVkLicpXG4gICAgfVxuXG4gICAgaWYgKHRoaXMuX2VudmVsb3BlLnJlc3BvbnNlUXVldWUubGVuZ3RoKSB7XG4gICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uU3RyZWFtXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gdGhpcy5fYWN0aW9uSWRsZVxuICAgIHRoaXMub25kb25lKHRydWUpXG4gIH0gZWxzZSB7XG4gICAgLy8gRm9yIFNNVFAgdGhlIG1lc3NhZ2UgZWl0aGVyIGZhaWxzIG9yIHN1Y2NlZWRzLCB0aGVyZSBpcyBubyBpbmZvcm1hdGlvblxuICAgIC8vIGFib3V0IGluZGl2aWR1YWwgcmVjaXBpZW50c1xuXG4gICAgaWYgKCFjb21tYW5kLnN1Y2Nlc3MpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKERFQlVHX1RBRywgJ01lc3NhZ2Ugc2VuZGluZyBmYWlsZWQuJylcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoREVCVUdfVEFHLCAnTWVzc2FnZSBzZW50IHN1Y2Nlc3NmdWxseS4nKVxuICAgIH1cblxuICAgIHRoaXMuX2N1cnJlbnRBY3Rpb24gPSB0aGlzLl9hY3Rpb25JZGxlXG4gICAgdGhpcy5vbmRvbmUoISFjb21tYW5kLnN1Y2Nlc3MpXG4gIH1cblxuICAvLyBJZiB0aGUgY2xpZW50IHdhbnRlZCB0byBkbyBzb21ldGhpbmcgZWxzZSAoZWcuIHRvIHF1aXQpLCBkbyBub3QgZm9yY2UgaWRsZVxuICBpZiAodGhpcy5fY3VycmVudEFjdGlvbiA9PT0gdGhpcy5fYWN0aW9uSWRsZSkge1xuICAgIC8vIFdhaXRpbmcgZm9yIG5ldyBjb25uZWN0aW9uc1xuICAgIHRoaXMubG9nZ2VyLmRlYnVnKERFQlVHX1RBRywgJ0lkbGluZyB3aGlsZSB3YWl0aW5nIGZvciBuZXcgY29ubmVjdGlvbnMuLi4nKVxuICAgIHRoaXMub25pZGxlKClcbiAgfVxufVxuXG4vKipcbiAqIEJ1aWxkcyBhIGxvZ2luIHRva2VuIGZvciBYT0FVVEgyIGF1dGhlbnRpY2F0aW9uIGNvbW1hbmRcbiAqXG4gKiBAcGFyYW0ge1N0cmluZ30gdXNlciBFLW1haWwgYWRkcmVzcyBvZiB0aGUgdXNlclxuICogQHBhcmFtIHtTdHJpbmd9IHRva2VuIFZhbGlkIGFjY2VzcyB0b2tlbiBmb3IgdGhlIHVzZXJcbiAqIEByZXR1cm4ge1N0cmluZ30gQmFzZTY0IGZvcm1hdHRlZCBsb2dpbiB0b2tlblxuICovXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5fYnVpbGRYT0F1dGgyVG9rZW4gPSBmdW5jdGlvbiAodXNlciwgdG9rZW4pIHtcbiAgdmFyIGF1dGhEYXRhID0gW1xuICAgICd1c2VyPScgKyAodXNlciB8fCAnJyksXG4gICAgJ2F1dGg9QmVhcmVyICcgKyB0b2tlbixcbiAgICAnJyxcbiAgICAnJ1xuICBdXG4gIC8vIGJhc2U2NChcInVzZXI9e1VzZXJ9XFx4MDBhdXRoPUJlYXJlciB7VG9rZW59XFx4MDBcXHgwMFwiKVxuICByZXR1cm4gZW5jb2RlKGF1dGhEYXRhLmpvaW4oJ1xceDAxJykpXG59XG5cblNtdHBDbGllbnQucHJvdG90eXBlLkxPR19MRVZFTF9OT05FID0gMTAwMFxuU210cENsaWVudC5wcm90b3R5cGUuTE9HX0xFVkVMX0VSUk9SID0gNDBcblNtdHBDbGllbnQucHJvdG90eXBlLkxPR19MRVZFTF9XQVJOID0gMzBcblNtdHBDbGllbnQucHJvdG90eXBlLkxPR19MRVZFTF9JTkZPID0gMjBcblNtdHBDbGllbnQucHJvdG90eXBlLkxPR19MRVZFTF9ERUJVRyA9IDEwXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5MT0dfTEVWRUxfQUxMID0gMFxuXG5TbXRwQ2xpZW50LnByb3RvdHlwZS5jcmVhdGVMb2dnZXIgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBzZWxmID0gdGhpc1xuICB2YXIgY3JlYXRlTG9nZ2VyID0gZnVuY3Rpb24gKHRhZykge1xuICAgIHZhciBsb2cgPSBmdW5jdGlvbiAobGV2ZWwsIG1lc3NhZ2VzKSB7XG4gICAgICB2YXIgbG9nTWVzc2FnZSA9ICdbJyArIG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSArICddWycgKyB0YWcgKyAnXVsnICtcbiAgICAgICAgc2VsZi5vcHRpb25zLmF1dGgudXNlciArICddWycgKyBzZWxmLmhvc3QgKyAnXSAnICsgbWVzc2FnZXMuam9pbignICcpXG4gICAgICBpZiAobGV2ZWwgPT09IHNlbGYuTE9HX0xFVkVMX0RFQlVHKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKCdbREVCVUddJyArIGxvZ01lc3NhZ2UpXG4gICAgICB9IGVsc2UgaWYgKGxldmVsID09PSBzZWxmLkxPR19MRVZFTF9JTkZPKSB7XG4gICAgICAgIGNvbnNvbGUuaW5mbygnW0lORk9dJyArIGxvZ01lc3NhZ2UpXG4gICAgICB9IGVsc2UgaWYgKGxldmVsID09PSBzZWxmLkxPR19MRVZFTF9XQVJOKSB7XG4gICAgICAgIGNvbnNvbGUud2FybignW1dBUk5dJyArIGxvZ01lc3NhZ2UpXG4gICAgICB9IGVsc2UgaWYgKGxldmVsID09PSBzZWxmLkxPR19MRVZFTF9FUlJPUikge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdbRVJST1JdJyArIGxvZ01lc3NhZ2UpXG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIC8vIHRoaXMgY291bGQgYmVjb21lIHdheSBuaWNlciB3aGVuIG5vZGUgc3VwcG9ydHMgdGhlIHJlc3Qgb3BlcmF0b3IuLi5cbiAgICAgIGRlYnVnOiBmdW5jdGlvbiAobXNncykgeyBsb2coc2VsZi5MT0dfTEVWRUxfREVCVUcsIG1zZ3MpIH0sXG4gICAgICBpbmZvOiBmdW5jdGlvbiAobXNncykgeyBsb2coc2VsZi5MT0dfTEVWRUxfSU5GTywgbXNncykgfSxcbiAgICAgIHdhcm46IGZ1bmN0aW9uIChtc2dzKSB7IGxvZyhzZWxmLkxPR19MRVZFTF9XQVJOLCBtc2dzKSB9LFxuICAgICAgZXJyb3I6IGZ1bmN0aW9uIChtc2dzKSB7IGxvZyhzZWxmLkxPR19MRVZFTF9FUlJPUiwgbXNncykgfVxuICAgIH1cbiAgfVxuXG4gIHZhciBsb2dnZXIgPSB0aGlzLm9wdGlvbnMubG9nZ2VyIHx8IGNyZWF0ZUxvZ2dlcignU210cENsaWVudCcpXG4gIHRoaXMubG9nZ2VyID0ge1xuICAgIC8vIHRoaXMgY291bGQgYmVjb21lIHdheSBuaWNlciB3aGVuIG5vZGUgc3VwcG9ydHMgdGhlIHJlc3Qgb3BlcmF0b3IuLi5cbiAgICBkZWJ1ZzogZnVuY3Rpb24gKCkge1xuICAgICAgaWYgKHRoaXMuTE9HX0xFVkVMX0RFQlVHID49IHRoaXMubG9nTGV2ZWwpIHtcbiAgICAgICAgbG9nZ2VyLmRlYnVnKEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cykpXG4gICAgICB9XG4gICAgfS5iaW5kKHRoaXMpLFxuICAgIGluZm86IGZ1bmN0aW9uICgpIHtcbiAgICAgIGlmICh0aGlzLkxPR19MRVZFTF9JTkZPID49IHRoaXMubG9nTGV2ZWwpIHtcbiAgICAgICAgbG9nZ2VyLmluZm8oQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJndW1lbnRzKSlcbiAgICAgIH1cbiAgICB9LmJpbmQodGhpcyksXG4gICAgd2FybjogZnVuY3Rpb24gKCkge1xuICAgICAgaWYgKHRoaXMuTE9HX0xFVkVMX1dBUk4gPj0gdGhpcy5sb2dMZXZlbCkge1xuICAgICAgICBsb2dnZXIud2FybihBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChhcmd1bWVudHMpKVxuICAgICAgfVxuICAgIH0uYmluZCh0aGlzKSxcbiAgICBlcnJvcjogZnVuY3Rpb24gKCkge1xuICAgICAgaWYgKHRoaXMuTE9HX0xFVkVMX0VSUk9SID49IHRoaXMubG9nTGV2ZWwpIHtcbiAgICAgICAgbG9nZ2VyLmVycm9yKEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cykpXG4gICAgICB9XG4gICAgfS5iaW5kKHRoaXMpXG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgU210cENsaWVudFxuIl19