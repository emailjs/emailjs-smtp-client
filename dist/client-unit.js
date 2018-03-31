'use strict';

var _client = require('./client');

var _client2 = _interopRequireDefault(_client);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

describe('smtpclient unit tests', function () {
  var smtp;
  var host, port, options;
  var openStub, socketStub;
  var TCPSocket;

  beforeEach(function () {
    host = '127.0.0.1';
    port = 10000;
    options = {
      useSecureTransport: true,
      ca: 'WOW. SUCH CERT. MUCH TLS.'
    };

    smtp = new _client2.default(host, port, options);
    smtp.logLevel = smtp.LOG_LEVEL_NONE;
    expect(smtp).to.exist;

    TCPSocket = smtp._TCPSocket = function () {};
    TCPSocket.open = function () {};
    TCPSocket.prototype.close = function () {};
    TCPSocket.prototype.send = function () {};
    TCPSocket.prototype.suspend = function () {};
    TCPSocket.prototype.resume = function () {};
    TCPSocket.prototype.send = function () {};
    TCPSocket.prototype.upgradeToSecure = function () {};

    socketStub = sinon.createStubInstance(TCPSocket);
    openStub = sinon.stub(TCPSocket, 'open').withArgs(host, port).returns(socketStub);

    smtp.connect();

    expect(openStub.callCount).to.equal(1);
    expect(socketStub.onopen).to.exist;
    expect(socketStub.onerror).to.exist;
  });

  afterEach(function () {
    TCPSocket.open.restore();
  });

  describe('tcp-socket websocket proxy', function () {
    it('should send hostname in onopen', function () {
      socketStub.onopen({
        data: {
          proxyHostname: 'hostname.io' // hostname of the socket.io proxy in tcp-socket
        }
      });

      expect(smtp.options.name).to.equal('hostname.io');
    });
  });

  describe('#connect', function () {
    it('should not throw', function () {
      var client = new _client2.default(host, port);
      client._TCPSocket = {
        open: function open() {
          var socket = {
            onopen: function onopen() {},
            onerror: function onerror() {}
            // disallow setting new properties (eg. oncert)
          };Object.preventExtensions(socket);
          return socket;
        }
      };
      client.connect();
    });
  });

  describe('#suspend', function () {
    it('should call suspend', function () {
      socketStub.readyState = 'open';
      smtp.suspend();

      expect(socketStub.suspend.callCount).to.equal(1);
    });
  });

  describe('#resume', function () {
    it('should call resume', function () {
      socketStub.readyState = 'open';
      smtp.resume();

      expect(socketStub.resume.callCount).to.equal(1);
    });
  });

  describe('#quit', function () {
    it('should send QUIT', function () {
      var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

      smtp.quit();

      expect(_sendCommandStub.withArgs('QUIT').callCount).to.equal(1);

      _sendCommandStub.restore();
    });
  });

  describe('#reset', function () {
    it('should send RSET', function () {
      var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

      smtp.reset();

      expect(_sendCommandStub.withArgs('RSET').callCount).to.equal(1);

      _sendCommandStub.restore();
    });

    it('should use default authentication', function () {
      smtp.options.auth = {
        user: '1'
      };
      smtp.reset();

      expect(smtp.options.auth).to.deep.equal({
        user: '1'
      });
    });

    it('should store custom authentication', function () {
      var auth = {
        user: 'test'
      };
      smtp.options.auth = {
        user: '1'
      };
      smtp.reset(auth);

      expect(smtp.options.auth).to.deep.equal(auth);
    });
  });

  describe('#close', function () {
    it('should close socket', function () {
      socketStub.readyState = 'open';
      smtp.close();

      expect(socketStub.close.callCount).to.equal(1);
    });

    it('should call _destroy', function () {
      sinon.stub(smtp, '_destroy');

      socketStub.readyState = '';
      smtp.close();
      expect(smtp._destroy.callCount).to.equal(1);

      smtp._destroy.restore();
    });
  });

  describe('#useEnvelope', function () {
    it('should send MAIL FROM', function () {
      var envelope = {
        from: 'ft',
        to: ['tt']
      };
      var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

      smtp.useEnvelope(envelope);

      expect(_sendCommandStub.withArgs('MAIL FROM:<ft>').callCount).to.equal(1);
      expect(smtp._envelope.from).to.deep.equal(envelope.from);
      expect(smtp._envelope.to).to.deep.equal(envelope.to);

      _sendCommandStub.restore();
    });
  });

  describe('#send', function () {
    it('should do nothing if not data mode', function () {
      smtp._dataMode = false;
      smtp.send();

      expect(socketStub.send.callCount).to.equal(0);
    });

    it('should send data to socket', function () {
      var _sendStringStub = sinon.stub(smtp, '_sendString');

      smtp._dataMode = true;
      smtp.send('abcde');

      expect(_sendStringStub.withArgs('abcde').callCount).to.equal(1);

      _sendStringStub.restore();
    });
  });

  describe('#end', function () {
    it('should do nothing if not data mode', function () {
      smtp._dataMode = false;
      smtp.send();

      expect(socketStub.send.callCount).to.equal(0);
    });

    it('should send a dot in a separate line', function () {
      smtp._dataMode = true;
      smtp.end();

      expect(socketStub.send.callCount).to.equal(1);
      expect(socketStub.send.args[0][0]).to.deep.equal(new Uint8Array([13, 10, 46, 13, 10]).buffer); // \r\n.\r\n
    });
  });

  describe('#_onData', function () {
    it('should decode and send chunk to parser', function () {
      var _parserSendStub = sinon.stub(smtp._parser, 'send');

      smtp._onData({
        data: new Uint8Array([97, 98, 99]).buffer // abc
      });

      expect(_parserSendStub.withArgs('abc').callCount).to.equal(1);

      _parserSendStub.restore();
    });
  });

  describe('#_onDrain', function () {
    it('should emit ondrain', function () {
      var _ondrainStub = sinon.stub(smtp, 'ondrain');

      smtp._onDrain();

      expect(_ondrainStub.callCount).to.equal(1);

      _ondrainStub.restore();
    });
  });

  describe('#_onError', function () {
    it('should emit onerror and close connection', function () {
      var _onerrorStub = sinon.stub(smtp, 'onerror');
      var _closeStub = sinon.stub(smtp, 'close');
      var err = new Error('abc');

      smtp._onError({
        data: err
      });

      expect(_onerrorStub.withArgs(err).callCount).to.equal(1);
      expect(_closeStub.callCount).to.equal(1);

      _onerrorStub.restore();
      _closeStub.restore();
    });
  });

  describe('#_onClose', function () {
    it('should call _destroy', function () {
      var _destroyStub = sinon.stub(smtp, '_destroy');

      smtp._onClose();

      expect(_destroyStub.callCount).to.equal(1);

      _destroyStub.restore();
    });
  });

  describe('#_onCommand', function () {
    it('should run stored handler', function () {
      var _commandStub = sinon.stub();
      var cmd = 'abc';

      smtp._currentAction = _commandStub;
      smtp._onCommand(cmd);

      expect(_commandStub.withArgs(cmd).callCount).to.equal(1);
    });
  });

  describe('#_destroy', function () {
    it('should do nothing if already destroyed', function () {
      var _oncloseStub = sinon.stub(smtp, 'onclose');

      smtp.destroyed = true;
      smtp._destroy();

      expect(_oncloseStub.callCount).to.equal(0);

      _oncloseStub.restore();
    });

    it('should emit onclose if not destroyed yet', function () {
      var _oncloseStub = sinon.stub(smtp, 'onclose');

      smtp.destroyed = false;
      smtp._destroy();

      expect(_oncloseStub.callCount).to.equal(1);

      _oncloseStub.restore();
    });
  });

  describe('#_sendCommand', function () {
    it('should convert string to ArrayBuffer and send to socket', function () {
      smtp._sendCommand('abc');

      expect(socketStub.send.args[0][0]).to.deep.equal(new Uint8Array([97, 98, 99, 13, 10]).buffer); // abc\r\n
    });
  });

  describe('_authenticateUser', function () {
    it('should emit onidle if no auth info', function () {
      var _onidleStub = sinon.stub(smtp, 'onidle');

      smtp.options.auth = false;
      smtp._authenticateUser();

      expect(_onidleStub.callCount).to.equal(1);
      expect(smtp._currentAction).to.equal(smtp._actionIdle);

      _onidleStub.restore();
    });

    it('should use AUTH PLAIN by default', function () {
      var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

      smtp.options.auth = {
        user: 'abc',
        pass: 'def'
      };
      smtp._supportedAuth = [];
      smtp._authenticateUser();

      expect(_sendCommandStub.withArgs('AUTH PLAIN AGFiYwBkZWY=').callCount).to.equal(1);
      expect(smtp._currentAction).to.equal(smtp._actionAUTHComplete);

      _sendCommandStub.restore();
    });

    it('should use AUTH LOGIN if specified', function () {
      var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

      smtp.options.auth = {
        user: 'abc',
        pass: 'def'
      };
      smtp._supportedAuth = [];
      smtp.options.authMethod = 'LOGIN';
      smtp._authenticateUser();

      expect(_sendCommandStub.withArgs('AUTH LOGIN').callCount).to.equal(1);
      expect(smtp._currentAction).to.equal(smtp._actionAUTH_LOGIN_USER);

      _sendCommandStub.restore();
    });

    it('should use AUTH XOAUTH2 if specified', function () {
      var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

      smtp.options.auth = {
        user: 'abc',
        xoauth2: 'def'
      };
      smtp._supportedAuth = ['XOAUTH2'];
      smtp._authenticateUser();

      expect(_sendCommandStub.withArgs('AUTH XOAUTH2 dXNlcj1hYmMBYXV0aD1CZWFyZXIgZGVmAQE=').callCount).to.equal(1);
      expect(smtp._currentAction).to.equal(smtp._actionAUTH_XOAUTH2);

      _sendCommandStub.restore();
    });
  });

  describe('#_actionGreeting', function () {
    it('should fail if response is not 220', function () {
      var _onErrorStub = sinon.stub(smtp, '_onError');

      smtp._actionGreeting({
        statusCode: 500,
        data: 'test'
      });

      expect(_onErrorStub.calledOnce).to.be.true;
      expect(_onErrorStub.args[0][0].message).to.deep.equal('Invalid greeting: test');
      _onErrorStub.restore();
    });

    it('should send EHLO on greeting', function () {
      var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

      smtp.options.name = 'abc';
      smtp._actionGreeting({
        statusCode: 220,
        data: 'test'
      });

      expect(_sendCommandStub.withArgs('EHLO abc').callCount).to.equal(1);
      expect(smtp._currentAction).to.equal(smtp._actionEHLO);

      _sendCommandStub.restore();
    });

    it('should send LHLO on greeting', function () {
      var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

      smtp.options.name = 'abc';
      smtp.options.lmtp = true;
      smtp._actionGreeting({
        statusCode: 220,
        data: 'test'
      });

      expect(_sendCommandStub.withArgs('LHLO abc').callCount).to.equal(1);
      expect(smtp._currentAction).to.equal(smtp._actionLHLO);

      _sendCommandStub.restore();
    });
  });

  describe('#_actionLHLO', function () {
    it('should proceed to EHLO', function () {
      var _actionEHLOStub = sinon.stub(smtp, '_actionEHLO');

      smtp.options.name = 'abc';
      smtp._actionLHLO({
        success: true,
        line: '250-AUTH PLAIN LOGIN'
      });

      expect(_actionEHLOStub.callCount).to.equal(1);

      _actionEHLOStub.restore();
    });
  });

  describe('#_actionEHLO', function () {
    it('should fallback to HELO on error', function () {
      var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

      smtp.options.name = 'abc';
      smtp._actionEHLO({
        success: false
      });

      expect(_sendCommandStub.withArgs('HELO abc').callCount).to.equal(1);
      expect(smtp._currentAction).to.equal(smtp._actionHELO);

      _sendCommandStub.restore();
    });

    it('should proceed to authentication', function () {
      var _authenticateUserStub = sinon.stub(smtp, '_authenticateUser');

      smtp._actionEHLO({
        success: true,
        line: '250-AUTH PLAIN LOGIN'
      });

      expect(_authenticateUserStub.callCount).to.equal(1);
      expect(smtp._supportedAuth).to.deep.equal(['PLAIN', 'LOGIN']);

      _authenticateUserStub.restore();
    });

    it('should proceed to starttls', function () {
      var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

      smtp._secureMode = false;
      smtp._actionEHLO({
        success: true,
        line: '250-STARTTLS'
      });

      expect(_sendCommandStub.withArgs('STARTTLS').callCount).to.equal(1);

      expect(smtp._currentAction).to.equal(smtp._actionSTARTTLS);
      _sendCommandStub.restore();
    });
  });

  describe('#_actionHELO', function () {
    it('should proceed to authentication', function () {
      var _authenticateUserStub = sinon.stub(smtp, '_authenticateUser');

      smtp._actionHELO({
        success: true
      });

      expect(_authenticateUserStub.callCount).to.equal(1);

      _authenticateUserStub.restore();
    });
  });

  describe('#_actionSTARTTLS', function () {
    it('should upgrade connection', function () {
      var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

      smtp.options.name = 'abc';
      smtp._actionSTARTTLS({
        success: true,
        line: '220 Ready to start TLS'
      });

      expect(smtp.socket.upgradeToSecure.callCount).to.equal(1);
      expect(_sendCommandStub.withArgs('EHLO abc').callCount).to.equal(1);
      expect(smtp._currentAction).to.equal(smtp._actionEHLO);

      _sendCommandStub.restore();
    });
  });

  describe('#_actionAUTH_LOGIN_USER', function () {
    it('should emit error on invalid input', function () {
      var _onErrorStub = sinon.stub(smtp, '_onError');

      smtp._actionAUTH_LOGIN_USER({
        statusCode: 334, // valid status code
        data: 'test' // invalid value
      });

      expect(_onErrorStub.callCount).to.equal(1);
      expect(_onErrorStub.args[0][0] instanceof Error).to.be.true;

      _onErrorStub.restore();
    });

    it('should respond to server with base64 encoded username', function () {
      var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

      smtp.options.auth = {
        user: 'abc',
        pass: 'def'
      };
      smtp._actionAUTH_LOGIN_USER({
        statusCode: 334,
        data: 'VXNlcm5hbWU6'
      });

      expect(_sendCommandStub.withArgs('YWJj').callCount).to.equal(1);
      expect(smtp._currentAction).to.equal(smtp._actionAUTH_LOGIN_PASS);

      _sendCommandStub.restore();
    });
  });

  describe('#_actionAUTH_LOGIN_PASS', function () {
    it('should emit error on invalid input', function () {
      var _onErrorStub = sinon.stub(smtp, '_onError');

      smtp._actionAUTH_LOGIN_PASS({
        statusCode: 334, // valid status code
        data: 'test' // invalid value
      });

      expect(_onErrorStub.callCount).to.equal(1);
      expect(_onErrorStub.args[0][0] instanceof Error).to.be.true;

      _onErrorStub.restore();
    });

    it('should respond to server with base64 encoded password', function () {
      var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

      smtp.options.auth = {
        user: 'abc',
        pass: 'def'
      };
      smtp._actionAUTH_LOGIN_PASS({
        statusCode: 334,
        data: 'UGFzc3dvcmQ6'
      });

      expect(_sendCommandStub.withArgs('ZGVm').callCount).to.equal(1);
      expect(smtp._currentAction).to.equal(smtp._actionAUTHComplete);

      _sendCommandStub.restore();
    });
  });

  describe('#_actionAUTH_XOAUTH2', function () {
    it('should send empty response on error', function () {
      var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

      smtp._actionAUTH_XOAUTH2({
        success: false
      });

      expect(_sendCommandStub.withArgs('').callCount).to.equal(1);
      expect(smtp._currentAction).to.equal(smtp._actionAUTHComplete);

      _sendCommandStub.restore();
    });

    it('should run _actionAUTHComplete on success', function () {
      var _actionAUTHCompleteStub = sinon.stub(smtp, '_actionAUTHComplete');

      var cmd = {
        success: true
      };
      smtp._actionAUTH_XOAUTH2(cmd);

      expect(_actionAUTHCompleteStub.withArgs(cmd).callCount).to.equal(1);

      _actionAUTHCompleteStub.restore();
    });
  });

  describe('#_actionAUTHComplete', function () {
    it('should emit error on invalid auth', function () {
      var _onErrorStub = sinon.stub(smtp, '_onError');

      smtp._actionAUTHComplete({
        success: false,
        data: 'err'
      });

      expect(_onErrorStub.callCount).to.equal(1);
      expect(_onErrorStub.args[0][0] instanceof Error).to.be.true;

      _onErrorStub.restore();
    });

    it('should emit idle if auth succeeded', function () {
      var _onidleStub = sinon.stub(smtp, 'onidle');

      smtp.options.auth = {
        user: 'abc',
        pass: 'def'
      };
      smtp._actionAUTHComplete({
        success: true
      });

      expect(_onidleStub.callCount).to.equal(1);
      expect(smtp._currentAction).to.equal(smtp._actionIdle);
      expect(smtp._authenticatedAs).to.equal('abc');

      _onidleStub.restore();
    });
  });

  describe('#_actionMAIL', function () {
    it('should emit error on invalid input', function () {
      var _onErrorStub = sinon.stub(smtp, '_onError');

      smtp._actionMAIL({
        success: false,
        data: 'err'
      });

      expect(_onErrorStub.calledOnce).to.be.true;
      expect(_onErrorStub.args[0][0].message).to.equal('err');

      _onErrorStub.restore();
    });

    it('should emit error on empty recipient queue', function () {
      var _onErrorStub = sinon.stub(smtp, '_onError');

      smtp._envelope = {
        rcptQueue: []
      };
      smtp._actionMAIL({
        success: true
      });

      expect(_onErrorStub.callCount).to.equal(1);
      expect(_onErrorStub.args[0][0] instanceof Error).to.be.true;

      _onErrorStub.restore();
    });

    it('should send to the next recipient in queue', function () {
      var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

      smtp._envelope = {
        rcptQueue: ['receiver']
      };
      smtp._actionMAIL({
        success: true
      });

      expect(_sendCommandStub.withArgs('RCPT TO:<receiver>').callCount).to.equal(1);
      expect(smtp._currentAction).to.equal(smtp._actionRCPT);

      _sendCommandStub.restore();
    });
  });

  describe('#_actionRCPT', function () {
    it('should send DATA if queue is processed', function () {
      var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

      smtp._envelope = {
        to: ['abc'],
        rcptFailed: [],
        rcptQueue: [],
        responseQueue: []
      };
      smtp._actionRCPT({
        success: true
      });

      expect(_sendCommandStub.withArgs('DATA').callCount).to.equal(1);
      expect(smtp._currentAction).to.equal(smtp._actionDATA);

      _sendCommandStub.restore();
    });

    it('should send rerun RCPT if queue is not empty', function () {
      var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

      smtp._envelope = {
        rcptQueue: ['receiver'],
        responseQueue: []
      };
      smtp._actionRCPT({
        success: true
      });

      expect(_sendCommandStub.withArgs('RCPT TO:<receiver>').callCount).to.equal(1);
      expect(smtp._currentAction).to.equal(smtp._actionRCPT);

      _sendCommandStub.restore();
    });

    it('should emit error if all recipients failed', function () {
      var _onErrorStub = sinon.stub(smtp, '_onError');

      smtp._envelope = {
        to: ['abc'],
        rcptFailed: ['abc'],
        rcptQueue: [],
        responseQueue: []
      };
      smtp._actionRCPT({
        success: true
      });

      expect(_onErrorStub.callCount).to.equal(1);
      expect(_onErrorStub.args[0][0] instanceof Error).to.be.true;

      _onErrorStub.restore();
    });
  });

  describe('#_actionRSET', function () {
    it('should emit error on invalid input', function () {
      var _onErrorStub = sinon.stub(smtp, '_onError');

      smtp._actionRSET({
        success: false,
        data: 'err'
      });

      expect(_onErrorStub.calledOnce).to.be.true;
      expect(_onErrorStub.args[0][0].message).to.equal('err');

      _onErrorStub.restore();
    });

    it('should proceed to authentication', function () {
      var _authenticateUserStub = sinon.stub(smtp, '_authenticateUser');

      smtp._actionRSET({
        success: true
      });

      expect(_authenticateUserStub.callCount).to.equal(1);
      expect(smtp._authenticatedAs).to.be.null;

      _authenticateUserStub.restore();
    });
  });

  describe('#_actionDATA', function () {
    it('should emit error on invalid input', function () {
      var _onErrorStub = sinon.stub(smtp, '_onError');

      smtp._actionDATA({
        statusCode: 500,
        data: 'err'
      });

      expect(_onErrorStub.calledOnce).to.be.true;
      expect(_onErrorStub.args[0][0].message).to.equal('err');

      _onErrorStub.restore();
    });

    it('should emit onready on success', function () {
      var _onreadyStub = sinon.stub(smtp, 'onready');

      smtp._envelope = {
        to: ['abc'],
        rcptFailed: ['abc'],
        rcptQueue: []
      };
      smtp._actionDATA({
        statusCode: 250
      });

      expect(_onreadyStub.withArgs(['abc']).callCount).to.equal(1);
      expect(smtp._currentAction).to.equal(smtp._actionIdle);
      expect(smtp._dataMode).to.be.true;

      _onreadyStub.restore();
    });
  });

  describe('#_actionStream', function () {
    it('should emit ondone with argument false', function () {
      var _ondoneStub = sinon.stub(smtp, 'ondone');

      smtp._actionStream({
        success: false
      });

      expect(_ondoneStub.withArgs(false).callCount).to.equal(1);

      _ondoneStub.restore();
    });

    it('should emit ondone with argument true', function () {
      var _ondoneStub = sinon.stub(smtp, 'ondone');

      smtp._actionStream({
        success: true
      });

      expect(_ondoneStub.withArgs(true).callCount).to.equal(1);

      _ondoneStub.restore();
    });

    it('should emit onidle if required', function () {
      var _onidleStub = sinon.stub(smtp, 'onidle');

      smtp._currentAction = smtp._actionIdle;
      smtp._actionStream({
        success: true
      });

      expect(_onidleStub.callCount).to.equal(1);

      _onidleStub.restore();
    });

    it('should cancel onidle', function () {
      var _onidleStub = sinon.stub(smtp, 'onidle');

      smtp.ondone = function () {
        this._currentAction = false;
      };

      smtp._actionStream({
        success: true
      });

      expect(_onidleStub.callCount).to.equal(0);

      _onidleStub.restore();
    });

    describe('LMTP responses', function () {
      it('should receive single responses', function () {
        var _ondoneStub = sinon.stub(smtp, 'ondone');

        smtp.options.lmtp = true;
        smtp._envelope = {
          responseQueue: ['abc'],
          rcptFailed: []
        };

        smtp._actionStream({
          success: false
        });

        expect(_ondoneStub.withArgs(true).callCount).to.equal(1);
        expect(smtp._envelope.rcptFailed).to.deep.equal(['abc']);

        _ondoneStub.restore();
      });

      it('should wait for additional responses', function () {
        var _ondoneStub = sinon.stub(smtp, 'ondone');

        smtp.options.lmtp = true;
        smtp._envelope = {
          responseQueue: ['abc', 'def', 'ghi'],
          rcptFailed: []
        };

        smtp._actionStream({
          success: false
        });

        smtp._actionStream({
          success: true
        });

        smtp._actionStream({
          success: false
        });

        expect(_ondoneStub.withArgs(true).callCount).to.equal(1);
        expect(smtp._envelope.rcptFailed).to.deep.equal(['abc', 'ghi']);

        _ondoneStub.restore();
      });
    });
  });

  describe('#_buildXOAuth2Token', function () {
    it('should return base64 encoded XOAUTH2 token', function () {
      expect(smtp._buildXOAuth2Token('user@host', 'abcde')).to.equal('dXNlcj11c2VyQGhvc3QBYXV0aD1CZWFyZXIgYWJjZGUBAQ==');
    });
  });
}); /* eslint-disable no-unused-expressions */
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9jbGllbnQtdW5pdC5qcyJdLCJuYW1lcyI6WyJkZXNjcmliZSIsInNtdHAiLCJob3N0IiwicG9ydCIsIm9wdGlvbnMiLCJvcGVuU3R1YiIsInNvY2tldFN0dWIiLCJUQ1BTb2NrZXQiLCJiZWZvcmVFYWNoIiwidXNlU2VjdXJlVHJhbnNwb3J0IiwiY2EiLCJsb2dMZXZlbCIsIkxPR19MRVZFTF9OT05FIiwiZXhwZWN0IiwidG8iLCJleGlzdCIsIl9UQ1BTb2NrZXQiLCJvcGVuIiwicHJvdG90eXBlIiwiY2xvc2UiLCJzZW5kIiwic3VzcGVuZCIsInJlc3VtZSIsInVwZ3JhZGVUb1NlY3VyZSIsInNpbm9uIiwiY3JlYXRlU3R1Ykluc3RhbmNlIiwic3R1YiIsIndpdGhBcmdzIiwicmV0dXJucyIsImNvbm5lY3QiLCJjYWxsQ291bnQiLCJlcXVhbCIsIm9ub3BlbiIsIm9uZXJyb3IiLCJhZnRlckVhY2giLCJyZXN0b3JlIiwiaXQiLCJkYXRhIiwicHJveHlIb3N0bmFtZSIsIm5hbWUiLCJjbGllbnQiLCJzb2NrZXQiLCJPYmplY3QiLCJwcmV2ZW50RXh0ZW5zaW9ucyIsInJlYWR5U3RhdGUiLCJfc2VuZENvbW1hbmRTdHViIiwicXVpdCIsInJlc2V0IiwiYXV0aCIsInVzZXIiLCJkZWVwIiwiX2Rlc3Ryb3kiLCJlbnZlbG9wZSIsImZyb20iLCJ1c2VFbnZlbG9wZSIsIl9lbnZlbG9wZSIsIl9kYXRhTW9kZSIsIl9zZW5kU3RyaW5nU3R1YiIsImVuZCIsImFyZ3MiLCJVaW50OEFycmF5IiwiYnVmZmVyIiwiX3BhcnNlclNlbmRTdHViIiwiX3BhcnNlciIsIl9vbkRhdGEiLCJfb25kcmFpblN0dWIiLCJfb25EcmFpbiIsIl9vbmVycm9yU3R1YiIsIl9jbG9zZVN0dWIiLCJlcnIiLCJFcnJvciIsIl9vbkVycm9yIiwiX2Rlc3Ryb3lTdHViIiwiX29uQ2xvc2UiLCJfY29tbWFuZFN0dWIiLCJjbWQiLCJfY3VycmVudEFjdGlvbiIsIl9vbkNvbW1hbmQiLCJfb25jbG9zZVN0dWIiLCJkZXN0cm95ZWQiLCJfc2VuZENvbW1hbmQiLCJfb25pZGxlU3R1YiIsIl9hdXRoZW50aWNhdGVVc2VyIiwiX2FjdGlvbklkbGUiLCJwYXNzIiwiX3N1cHBvcnRlZEF1dGgiLCJfYWN0aW9uQVVUSENvbXBsZXRlIiwiYXV0aE1ldGhvZCIsIl9hY3Rpb25BVVRIX0xPR0lOX1VTRVIiLCJ4b2F1dGgyIiwiX2FjdGlvbkFVVEhfWE9BVVRIMiIsIl9vbkVycm9yU3R1YiIsIl9hY3Rpb25HcmVldGluZyIsInN0YXR1c0NvZGUiLCJjYWxsZWRPbmNlIiwiYmUiLCJ0cnVlIiwibWVzc2FnZSIsIl9hY3Rpb25FSExPIiwibG10cCIsIl9hY3Rpb25MSExPIiwiX2FjdGlvbkVITE9TdHViIiwic3VjY2VzcyIsImxpbmUiLCJfYWN0aW9uSEVMTyIsIl9hdXRoZW50aWNhdGVVc2VyU3R1YiIsIl9zZWN1cmVNb2RlIiwiX2FjdGlvblNUQVJUVExTIiwiX2FjdGlvbkFVVEhfTE9HSU5fUEFTUyIsIl9hY3Rpb25BVVRIQ29tcGxldGVTdHViIiwiX2F1dGhlbnRpY2F0ZWRBcyIsIl9hY3Rpb25NQUlMIiwicmNwdFF1ZXVlIiwiX2FjdGlvblJDUFQiLCJyY3B0RmFpbGVkIiwicmVzcG9uc2VRdWV1ZSIsIl9hY3Rpb25EQVRBIiwiX2FjdGlvblJTRVQiLCJudWxsIiwiX29ucmVhZHlTdHViIiwiX29uZG9uZVN0dWIiLCJfYWN0aW9uU3RyZWFtIiwib25kb25lIiwiX2J1aWxkWE9BdXRoMlRva2VuIl0sIm1hcHBpbmdzIjoiOztBQUVBOzs7Ozs7QUFFQUEsU0FBUyx1QkFBVCxFQUFrQyxZQUFZO0FBQzVDLE1BQUlDLElBQUo7QUFDQSxNQUFJQyxJQUFKLEVBQVVDLElBQVYsRUFBZ0JDLE9BQWhCO0FBQ0EsTUFBSUMsUUFBSixFQUFjQyxVQUFkO0FBQ0EsTUFBSUMsU0FBSjs7QUFFQUMsYUFBVyxZQUFZO0FBQ3JCTixXQUFPLFdBQVA7QUFDQUMsV0FBTyxLQUFQO0FBQ0FDLGNBQVU7QUFDUkssMEJB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Q0FBc0QsQ0FBdEQ7QUFDQWxCLGVBQU9aLEtBQUtzRCxTQUFMLENBQWUyRCxVQUF0QixFQUFrQ3BHLEVBQWxDLENBQXFDb0MsSUFBckMsQ0FBMENuQixLQUExQyxDQUFnRCxDQUFDLEtBQUQsRUFBUSxLQUFSLENBQWhEOztBQUVBeUYsb0JBQVlyRixPQUFaO0FBQ0QsT0F6QkQ7QUEwQkQsS0E5Q0Q7QUErQ0QsR0FyR0Q7O0FBdUdBbkMsV0FBUyxxQkFBVCxFQUFnQyxZQUFZO0FBQzFDb0MsT0FBRyw0Q0FBSCxFQUFpRCxZQUFZO0FBQzNEdkIsYUFBT1osS0FBSzBILGtCQUFMLENBQXdCLFdBQXhCLEVBQXFDLE9BQXJDLENBQVAsRUFBc0Q3RyxFQUF0RCxDQUF5RGlCLEtBQXpELENBQStELGtEQUEvRDtBQUNELEtBRkQ7QUFHRCxHQUpEO0FBS0QsQ0F6NUJELEUsQ0FKQSIsImZpbGUiOiJjbGllbnQtdW5pdC5qcyIsInNvdXJjZXNDb250ZW50IjpbIi8qIGVzbGludC1kaXNhYmxlIG5vLXVudXNlZC1leHByZXNzaW9ucyAqL1xuXG5pbXBvcnQgU210cENsaWVudCBmcm9tICcuL2NsaWVudCdcblxuZGVzY3JpYmUoJ3NtdHBjbGllbnQgdW5pdCB0ZXN0cycsIGZ1bmN0aW9uICgpIHtcbiAgdmFyIHNtdHBcbiAgdmFyIGhvc3QsIHBvcnQsIG9wdGlvbnNcbiAgdmFyIG9wZW5TdHViLCBzb2NrZXRTdHViXG4gIHZhciBUQ1BTb2NrZXRcblxuICBiZWZvcmVFYWNoKGZ1bmN0aW9uICgpIHtcbiAgICBob3N0ID0gJzEyNy4wLjAuMSdcbiAgICBwb3J0ID0gMTAwMDBcbiAgICBvcHRpb25zID0ge1xuICAgICAgdXNlU2VjdXJlVHJhbnNwb3J0OiB0cnVlLFxuICAgICAgY2E6ICdXT1cuIFNVQ0ggQ0VSVC4gTVVDSCBUTFMuJ1xuICAgIH1cblxuICAgIHNtdHAgPSBuZXcgU210cENsaWVudChob3N0LCBwb3J0LCBvcHRpb25zKVxuICAgIHNtdHAubG9nTGV2ZWwgPSBzbXRwLkxPR19MRVZFTF9OT05FXG4gICAgZXhwZWN0KHNtdHApLnRvLmV4aXN0XG5cbiAgICBUQ1BTb2NrZXQgPSBzbXRwLl9UQ1BTb2NrZXQgPSBmdW5jdGlvbiAoKSB7IH1cbiAgICBUQ1BTb2NrZXQub3BlbiA9IGZ1bmN0aW9uICgpIHsgfVxuICAgIFRDUFNvY2tldC5wcm90b3R5cGUuY2xvc2UgPSBmdW5jdGlvbiAoKSB7IH1cbiAgICBUQ1BTb2NrZXQucHJvdG90eXBlLnNlbmQgPSBmdW5jdGlvbiAoKSB7IH1cbiAgICBUQ1BTb2NrZXQucHJvdG90eXBlLnN1c3BlbmQgPSBmdW5jdGlvbiAoKSB7IH1cbiAgICBUQ1BTb2NrZXQucHJvdG90eXBlLnJlc3VtZSA9IGZ1bmN0aW9uICgpIHsgfVxuICAgIFRDUFNvY2tldC5wcm90b3R5cGUuc2VuZCA9IGZ1bmN0aW9uICgpIHsgfVxuICAgIFRDUFNvY2tldC5wcm90b3R5cGUudXBncmFkZVRvU2VjdXJlID0gZnVuY3Rpb24gKCkgeyB9XG5cbiAgICBzb2NrZXRTdHViID0gc2lub24uY3JlYXRlU3R1Ykluc3RhbmNlKFRDUFNvY2tldClcbiAgICBvcGVuU3R1YiA9IHNpbm9uLnN0dWIoVENQU29ja2V0LCAnb3BlbicpLndpdGhBcmdzKGhvc3QsIHBvcnQpLnJldHVybnMoc29ja2V0U3R1YilcblxuICAgIHNtdHAuY29ubmVjdCgpXG5cbiAgICBleHBlY3Qob3BlblN0dWIuY2FsbENvdW50KS50by5lcXVhbCgxKVxuICAgIGV4cGVjdChzb2NrZXRTdHViLm9ub3BlbikudG8uZXhpc3RcbiAgICBleHBlY3Qoc29ja2V0U3R1Yi5vbmVycm9yKS50by5leGlzdFxuICB9KVxuXG4gIGFmdGVyRWFjaChmdW5jdGlvbiAoKSB7XG4gICAgVENQU29ja2V0Lm9wZW4ucmVzdG9yZSgpXG4gIH0pXG5cbiAgZGVzY3JpYmUoJ3RjcC1zb2NrZXQgd2Vic29ja2V0IHByb3h5JywgZnVuY3Rpb24gKCkge1xuICAgIGl0KCdzaG91bGQgc2VuZCBob3N0bmFtZSBpbiBvbm9wZW4nLCBmdW5jdGlvbiAoKSB7XG4gICAgICBzb2NrZXRTdHViLm9ub3Blbih7XG4gICAgICAgIGRhdGE6IHtcbiAgICAgICAgICBwcm94eUhvc3RuYW1lOiAnaG9zdG5hbWUuaW8nIC8vIGhvc3RuYW1lIG9mIHRoZSBzb2NrZXQuaW8gcHJveHkgaW4gdGNwLXNvY2tldFxuICAgICAgICB9XG4gICAgICB9KVxuXG4gICAgICBleHBlY3Qoc210cC5vcHRpb25zLm5hbWUpLnRvLmVxdWFsKCdob3N0bmFtZS5pbycpXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZSgnI2Nvbm5lY3QnLCBmdW5jdGlvbiAoKSB7XG4gICAgaXQoJ3Nob3VsZCBub3QgdGhyb3cnLCBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgY2xpZW50ID0gbmV3IFNtdHBDbGllbnQoaG9zdCwgcG9ydClcbiAgICAgIGNsaWVudC5fVENQU29ja2V0ID0ge1xuICAgICAgICBvcGVuOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgdmFyIHNvY2tldCA9IHtcbiAgICAgICAgICAgIG9ub3BlbjogZnVuY3Rpb24gKCkgeyB9LFxuICAgICAgICAgICAgb25lcnJvcjogZnVuY3Rpb24gKCkgeyB9XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIGRpc2FsbG93IHNldHRpbmcgbmV3IHByb3BlcnRpZXMgKGVnLiBvbmNlcnQpXG4gICAgICAgICAgT2JqZWN0LnByZXZlbnRFeHRlbnNpb25zKHNvY2tldClcbiAgICAgICAgICByZXR1cm4gc29ja2V0XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGNsaWVudC5jb25uZWN0KClcbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKCcjc3VzcGVuZCcsIGZ1bmN0aW9uICgpIHtcbiAgICBpdCgnc2hvdWxkIGNhbGwgc3VzcGVuZCcsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHNvY2tldFN0dWIucmVhZHlTdGF0ZSA9ICdvcGVuJ1xuICAgICAgc210cC5zdXNwZW5kKClcblxuICAgICAgZXhwZWN0KHNvY2tldFN0dWIuc3VzcGVuZC5jYWxsQ291bnQpLnRvLmVxdWFsKDEpXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZSgnI3Jlc3VtZScsIGZ1bmN0aW9uICgpIHtcbiAgICBpdCgnc2hvdWxkIGNhbGwgcmVzdW1lJywgZnVuY3Rpb24gKCkge1xuICAgICAgc29ja2V0U3R1Yi5yZWFkeVN0YXRlID0gJ29wZW4nXG4gICAgICBzbXRwLnJlc3VtZSgpXG5cbiAgICAgIGV4cGVjdChzb2NrZXRTdHViLnJlc3VtZS5jYWxsQ291bnQpLnRvLmVxdWFsKDEpXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZSgnI3F1aXQnLCBmdW5jdGlvbiAoKSB7XG4gICAgaXQoJ3Nob3VsZCBzZW5kIFFVSVQnLCBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgX3NlbmRDb21tYW5kU3R1YiA9IHNpbm9uLnN0dWIoc210cCwgJ19zZW5kQ29tbWFuZCcpXG5cbiAgICAgIHNtdHAucXVpdCgpXG5cbiAgICAgIGV4cGVjdChfc2VuZENvbW1hbmRTdHViLndpdGhBcmdzKCdRVUlUJykuY2FsbENvdW50KS50by5lcXVhbCgxKVxuXG4gICAgICBfc2VuZENvbW1hbmRTdHViLnJlc3RvcmUoKVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoJyNyZXNldCcsIGZ1bmN0aW9uICgpIHtcbiAgICBpdCgnc2hvdWxkIHNlbmQgUlNFVCcsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBfc2VuZENvbW1hbmRTdHViID0gc2lub24uc3R1YihzbXRwLCAnX3NlbmRDb21tYW5kJylcblxuICAgICAgc210cC5yZXNldCgpXG5cbiAgICAgIGV4cGVjdChfc2VuZENvbW1hbmRTdHViLndpdGhBcmdzKCdSU0VUJykuY2FsbENvdW50KS50by5lcXVhbCgxKVxuXG4gICAgICBfc2VuZENvbW1hbmRTdHViLnJlc3RvcmUoKVxuICAgIH0pXG5cbiAgICBpdCgnc2hvdWxkIHVzZSBkZWZhdWx0IGF1dGhlbnRpY2F0aW9uJywgZnVuY3Rpb24gKCkge1xuICAgICAgc210cC5vcHRpb25zLmF1dGggPSB7XG4gICAgICAgIHVzZXI6ICcxJ1xuICAgICAgfVxuICAgICAgc210cC5yZXNldCgpXG5cbiAgICAgIGV4cGVjdChzbXRwLm9wdGlvbnMuYXV0aCkudG8uZGVlcC5lcXVhbCh7XG4gICAgICAgIHVzZXI6ICcxJ1xuICAgICAgfSlcbiAgICB9KVxuXG4gICAgaXQoJ3Nob3VsZCBzdG9yZSBjdXN0b20gYXV0aGVudGljYXRpb24nLCBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgYXV0aCA9IHtcbiAgICAgICAgdXNlcjogJ3Rlc3QnXG4gICAgICB9XG4gICAgICBzbXRwLm9wdGlvbnMuYXV0aCA9IHtcbiAgICAgICAgdXNlcjogJzEnXG4gICAgICB9XG4gICAgICBzbXRwLnJlc2V0KGF1dGgpXG5cbiAgICAgIGV4cGVjdChzbXRwLm9wdGlvbnMuYXV0aCkudG8uZGVlcC5lcXVhbChhdXRoKVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoJyNjbG9zZScsIGZ1bmN0aW9uICgpIHtcbiAgICBpdCgnc2hvdWxkIGNsb3NlIHNvY2tldCcsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHNvY2tldFN0dWIucmVhZHlTdGF0ZSA9ICdvcGVuJ1xuICAgICAgc210cC5jbG9zZSgpXG5cbiAgICAgIGV4cGVjdChzb2NrZXRTdHViLmNsb3NlLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcbiAgICB9KVxuXG4gICAgaXQoJ3Nob3VsZCBjYWxsIF9kZXN0cm95JywgZnVuY3Rpb24gKCkge1xuICAgICAgc2lub24uc3R1YihzbXRwLCAnX2Rlc3Ryb3knKVxuXG4gICAgICBzb2NrZXRTdHViLnJlYWR5U3RhdGUgPSAnJ1xuICAgICAgc210cC5jbG9zZSgpXG4gICAgICBleHBlY3Qoc210cC5fZGVzdHJveS5jYWxsQ291bnQpLnRvLmVxdWFsKDEpXG5cbiAgICAgIHNtdHAuX2Rlc3Ryb3kucmVzdG9yZSgpXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZSgnI3VzZUVudmVsb3BlJywgZnVuY3Rpb24gKCkge1xuICAgIGl0KCdzaG91bGQgc2VuZCBNQUlMIEZST00nLCBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgZW52ZWxvcGUgPSB7XG4gICAgICAgIGZyb206ICdmdCcsXG4gICAgICAgIHRvOiBbJ3R0J11cbiAgICAgIH1cbiAgICAgIHZhciBfc2VuZENvbW1hbmRTdHViID0gc2lub24uc3R1YihzbXRwLCAnX3NlbmRDb21tYW5kJylcblxuICAgICAgc210cC51c2VFbnZlbG9wZShlbnZlbG9wZSlcblxuICAgICAgZXhwZWN0KF9zZW5kQ29tbWFuZFN0dWIud2l0aEFyZ3MoJ01BSUwgRlJPTTo8ZnQ+JykuY2FsbENvdW50KS50by5lcXVhbCgxKVxuICAgICAgZXhwZWN0KHNtdHAuX2VudmVsb3BlLmZyb20pLnRvLmRlZXAuZXF1YWwoZW52ZWxvcGUuZnJvbSlcbiAgICAgIGV4cGVjdChzbXRwLl9lbnZlbG9wZS50bykudG8uZGVlcC5lcXVhbChlbnZlbG9wZS50bylcblxuICAgICAgX3NlbmRDb21tYW5kU3R1Yi5yZXN0b3JlKClcbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKCcjc2VuZCcsIGZ1bmN0aW9uICgpIHtcbiAgICBpdCgnc2hvdWxkIGRvIG5vdGhpbmcgaWYgbm90IGRhdGEgbW9kZScsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHNtdHAuX2RhdGFNb2RlID0gZmFsc2VcbiAgICAgIHNtdHAuc2VuZCgpXG5cbiAgICAgIGV4cGVjdChzb2NrZXRTdHViLnNlbmQuY2FsbENvdW50KS50by5lcXVhbCgwKVxuICAgIH0pXG5cbiAgICBpdCgnc2hvdWxkIHNlbmQgZGF0YSB0byBzb2NrZXQnLCBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgX3NlbmRTdHJpbmdTdHViID0gc2lub24uc3R1YihzbXRwLCAnX3NlbmRTdHJpbmcnKVxuXG4gICAgICBzbXRwLl9kYXRhTW9kZSA9IHRydWVcbiAgICAgIHNtdHAuc2VuZCgnYWJjZGUnKVxuXG4gICAgICBleHBlY3QoX3NlbmRTdHJpbmdTdHViLndpdGhBcmdzKCdhYmNkZScpLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcblxuICAgICAgX3NlbmRTdHJpbmdTdHViLnJlc3RvcmUoKVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoJyNlbmQnLCBmdW5jdGlvbiAoKSB7XG4gICAgaXQoJ3Nob3VsZCBkbyBub3RoaW5nIGlmIG5vdCBkYXRhIG1vZGUnLCBmdW5jdGlvbiAoKSB7XG4gICAgICBzbXRwLl9kYXRhTW9kZSA9IGZhbHNlXG4gICAgICBzbXRwLnNlbmQoKVxuXG4gICAgICBleHBlY3Qoc29ja2V0U3R1Yi5zZW5kLmNhbGxDb3VudCkudG8uZXF1YWwoMClcbiAgICB9KVxuXG4gICAgaXQoJ3Nob3VsZCBzZW5kIGEgZG90IGluIGEgc2VwYXJhdGUgbGluZScsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHNtdHAuX2RhdGFNb2RlID0gdHJ1ZVxuICAgICAgc210cC5lbmQoKVxuXG4gICAgICBleHBlY3Qoc29ja2V0U3R1Yi5zZW5kLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcbiAgICAgIGV4cGVjdChzb2NrZXRTdHViLnNlbmQuYXJnc1swXVswXSkudG8uZGVlcC5lcXVhbChcbiAgICAgICAgbmV3IFVpbnQ4QXJyYXkoWzEzLCAxMCwgNDYsIDEzLCAxMF0pLmJ1ZmZlcikgLy8gXFxyXFxuLlxcclxcblxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoJyNfb25EYXRhJywgZnVuY3Rpb24gKCkge1xuICAgIGl0KCdzaG91bGQgZGVjb2RlIGFuZCBzZW5kIGNodW5rIHRvIHBhcnNlcicsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBfcGFyc2VyU2VuZFN0dWIgPSBzaW5vbi5zdHViKHNtdHAuX3BhcnNlciwgJ3NlbmQnKVxuXG4gICAgICBzbXRwLl9vbkRhdGEoe1xuICAgICAgICBkYXRhOiBuZXcgVWludDhBcnJheShbOTcsIDk4LCA5OV0pLmJ1ZmZlciAvLyBhYmNcbiAgICAgIH0pXG5cbiAgICAgIGV4cGVjdChfcGFyc2VyU2VuZFN0dWIud2l0aEFyZ3MoJ2FiYycpLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcblxuICAgICAgX3BhcnNlclNlbmRTdHViLnJlc3RvcmUoKVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoJyNfb25EcmFpbicsIGZ1bmN0aW9uICgpIHtcbiAgICBpdCgnc2hvdWxkIGVtaXQgb25kcmFpbicsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBfb25kcmFpblN0dWIgPSBzaW5vbi5zdHViKHNtdHAsICdvbmRyYWluJylcblxuICAgICAgc210cC5fb25EcmFpbigpXG5cbiAgICAgIGV4cGVjdChfb25kcmFpblN0dWIuY2FsbENvdW50KS50by5lcXVhbCgxKVxuXG4gICAgICBfb25kcmFpblN0dWIucmVzdG9yZSgpXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZSgnI19vbkVycm9yJywgZnVuY3Rpb24gKCkge1xuICAgIGl0KCdzaG91bGQgZW1pdCBvbmVycm9yIGFuZCBjbG9zZSBjb25uZWN0aW9uJywgZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIF9vbmVycm9yU3R1YiA9IHNpbm9uLnN0dWIoc210cCwgJ29uZXJyb3InKVxuICAgICAgdmFyIF9jbG9zZVN0dWIgPSBzaW5vbi5zdHViKHNtdHAsICdjbG9zZScpXG4gICAgICB2YXIgZXJyID0gbmV3IEVycm9yKCdhYmMnKVxuXG4gICAgICBzbXRwLl9vbkVycm9yKHtcbiAgICAgICAgZGF0YTogZXJyXG4gICAgICB9KVxuXG4gICAgICBleHBlY3QoX29uZXJyb3JTdHViLndpdGhBcmdzKGVycikuY2FsbENvdW50KS50by5lcXVhbCgxKVxuICAgICAgZXhwZWN0KF9jbG9zZVN0dWIuY2FsbENvdW50KS50by5lcXVhbCgxKVxuXG4gICAgICBfb25lcnJvclN0dWIucmVzdG9yZSgpXG4gICAgICBfY2xvc2VTdHViLnJlc3RvcmUoKVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoJyNfb25DbG9zZScsIGZ1bmN0aW9uICgpIHtcbiAgICBpdCgnc2hvdWxkIGNhbGwgX2Rlc3Ryb3knLCBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgX2Rlc3Ryb3lTdHViID0gc2lub24uc3R1YihzbXRwLCAnX2Rlc3Ryb3knKVxuXG4gICAgICBzbXRwLl9vbkNsb3NlKClcblxuICAgICAgZXhwZWN0KF9kZXN0cm95U3R1Yi5jYWxsQ291bnQpLnRvLmVxdWFsKDEpXG5cbiAgICAgIF9kZXN0cm95U3R1Yi5yZXN0b3JlKClcbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKCcjX29uQ29tbWFuZCcsIGZ1bmN0aW9uICgpIHtcbiAgICBpdCgnc2hvdWxkIHJ1biBzdG9yZWQgaGFuZGxlcicsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBfY29tbWFuZFN0dWIgPSBzaW5vbi5zdHViKClcbiAgICAgIHZhciBjbWQgPSAnYWJjJ1xuXG4gICAgICBzbXRwLl9jdXJyZW50QWN0aW9uID0gX2NvbW1hbmRTdHViXG4gICAgICBzbXRwLl9vbkNvbW1hbmQoY21kKVxuXG4gICAgICBleHBlY3QoX2NvbW1hbmRTdHViLndpdGhBcmdzKGNtZCkuY2FsbENvdW50KS50by5lcXVhbCgxKVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoJyNfZGVzdHJveScsIGZ1bmN0aW9uICgpIHtcbiAgICBpdCgnc2hvdWxkIGRvIG5vdGhpbmcgaWYgYWxyZWFkeSBkZXN0cm95ZWQnLCBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgX29uY2xvc2VTdHViID0gc2lub24uc3R1YihzbXRwLCAnb25jbG9zZScpXG5cbiAgICAgIHNtdHAuZGVzdHJveWVkID0gdHJ1ZVxuICAgICAgc210cC5fZGVzdHJveSgpXG5cbiAgICAgIGV4cGVjdChfb25jbG9zZVN0dWIuY2FsbENvdW50KS50by5lcXVhbCgwKVxuXG4gICAgICBfb25jbG9zZVN0dWIucmVzdG9yZSgpXG4gICAgfSlcblxuICAgIGl0KCdzaG91bGQgZW1pdCBvbmNsb3NlIGlmIG5vdCBkZXN0cm95ZWQgeWV0JywgZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIF9vbmNsb3NlU3R1YiA9IHNpbm9uLnN0dWIoc210cCwgJ29uY2xvc2UnKVxuXG4gICAgICBzbXRwLmRlc3Ryb3llZCA9IGZhbHNlXG4gICAgICBzbXRwLl9kZXN0cm95KClcblxuICAgICAgZXhwZWN0KF9vbmNsb3NlU3R1Yi5jYWxsQ291bnQpLnRvLmVxdWFsKDEpXG5cbiAgICAgIF9vbmNsb3NlU3R1Yi5yZXN0b3JlKClcbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKCcjX3NlbmRDb21tYW5kJywgZnVuY3Rpb24gKCkge1xuICAgIGl0KCdzaG91bGQgY29udmVydCBzdHJpbmcgdG8gQXJyYXlCdWZmZXIgYW5kIHNlbmQgdG8gc29ja2V0JywgZnVuY3Rpb24gKCkge1xuICAgICAgc210cC5fc2VuZENvbW1hbmQoJ2FiYycpXG5cbiAgICAgIGV4cGVjdChzb2NrZXRTdHViLnNlbmQuYXJnc1swXVswXSkudG8uZGVlcC5lcXVhbChcbiAgICAgICAgbmV3IFVpbnQ4QXJyYXkoWzk3LCA5OCwgOTksIDEzLCAxMF0pLmJ1ZmZlcikgLy8gYWJjXFxyXFxuXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZSgnX2F1dGhlbnRpY2F0ZVVzZXInLCBmdW5jdGlvbiAoKSB7XG4gICAgaXQoJ3Nob3VsZCBlbWl0IG9uaWRsZSBpZiBubyBhdXRoIGluZm8nLCBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgX29uaWRsZVN0dWIgPSBzaW5vbi5zdHViKHNtdHAsICdvbmlkbGUnKVxuXG4gICAgICBzbXRwLm9wdGlvbnMuYXV0aCA9IGZhbHNlXG4gICAgICBzbXRwLl9hdXRoZW50aWNhdGVVc2VyKClcblxuICAgICAgZXhwZWN0KF9vbmlkbGVTdHViLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcbiAgICAgIGV4cGVjdChzbXRwLl9jdXJyZW50QWN0aW9uKS50by5lcXVhbChzbXRwLl9hY3Rpb25JZGxlKVxuXG4gICAgICBfb25pZGxlU3R1Yi5yZXN0b3JlKClcbiAgICB9KVxuXG4gICAgaXQoJ3Nob3VsZCB1c2UgQVVUSCBQTEFJTiBieSBkZWZhdWx0JywgZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIF9zZW5kQ29tbWFuZFN0dWIgPSBzaW5vbi5zdHViKHNtdHAsICdfc2VuZENvbW1hbmQnKVxuXG4gICAgICBzbXRwLm9wdGlvbnMuYXV0aCA9IHtcbiAgICAgICAgdXNlcjogJ2FiYycsXG4gICAgICAgIHBhc3M6ICdkZWYnXG4gICAgICB9XG4gICAgICBzbXRwLl9zdXBwb3J0ZWRBdXRoID0gW11cbiAgICAgIHNtdHAuX2F1dGhlbnRpY2F0ZVVzZXIoKVxuXG4gICAgICBleHBlY3QoX3NlbmRDb21tYW5kU3R1Yi53aXRoQXJncygnQVVUSCBQTEFJTiBBR0ZpWXdCa1pXWT0nKS5jYWxsQ291bnQpLnRvLmVxdWFsKDEpXG4gICAgICBleHBlY3Qoc210cC5fY3VycmVudEFjdGlvbikudG8uZXF1YWwoc210cC5fYWN0aW9uQVVUSENvbXBsZXRlKVxuXG4gICAgICBfc2VuZENvbW1hbmRTdHViLnJlc3RvcmUoKVxuICAgIH0pXG5cbiAgICBpdCgnc2hvdWxkIHVzZSBBVVRIIExPR0lOIGlmIHNwZWNpZmllZCcsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBfc2VuZENvbW1hbmRTdHViID0gc2lub24uc3R1YihzbXRwLCAnX3NlbmRDb21tYW5kJylcblxuICAgICAgc210cC5vcHRpb25zLmF1dGggPSB7XG4gICAgICAgIHVzZXI6ICdhYmMnLFxuICAgICAgICBwYXNzOiAnZGVmJ1xuICAgICAgfVxuICAgICAgc210cC5fc3VwcG9ydGVkQXV0aCA9IFtdXG4gICAgICBzbXRwLm9wdGlvbnMuYXV0aE1ldGhvZCA9ICdMT0dJTidcbiAgICAgIHNtdHAuX2F1dGhlbnRpY2F0ZVVzZXIoKVxuXG4gICAgICBleHBlY3QoX3NlbmRDb21tYW5kU3R1Yi53aXRoQXJncygnQVVUSCBMT0dJTicpLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcbiAgICAgIGV4cGVjdChzbXRwLl9jdXJyZW50QWN0aW9uKS50by5lcXVhbChzbXRwLl9hY3Rpb25BVVRIX0xPR0lOX1VTRVIpXG5cbiAgICAgIF9zZW5kQ29tbWFuZFN0dWIucmVzdG9yZSgpXG4gICAgfSlcblxuICAgIGl0KCdzaG91bGQgdXNlIEFVVEggWE9BVVRIMiBpZiBzcGVjaWZpZWQnLCBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgX3NlbmRDb21tYW5kU3R1YiA9IHNpbm9uLnN0dWIoc210cCwgJ19zZW5kQ29tbWFuZCcpXG5cbiAgICAgIHNtdHAub3B0aW9ucy5hdXRoID0ge1xuICAgICAgICB1c2VyOiAnYWJjJyxcbiAgICAgICAgeG9hdXRoMjogJ2RlZidcbiAgICAgIH1cbiAgICAgIHNtdHAuX3N1cHBvcnRlZEF1dGggPSBbJ1hPQVVUSDInXVxuICAgICAgc210cC5fYXV0aGVudGljYXRlVXNlcigpXG5cbiAgICAgIGV4cGVjdChfc2VuZENvbW1hbmRTdHViLndpdGhBcmdzKCdBVVRIIFhPQVVUSDIgZFhObGNqMWhZbU1CWVhWMGFEMUNaV0Z5WlhJZ1pHVm1BUUU9JykuY2FsbENvdW50KS50by5lcXVhbCgxKVxuICAgICAgZXhwZWN0KHNtdHAuX2N1cnJlbnRBY3Rpb24pLnRvLmVxdWFsKHNtdHAuX2FjdGlvbkFVVEhfWE9BVVRIMilcblxuICAgICAgX3NlbmRDb21tYW5kU3R1Yi5yZXN0b3JlKClcbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKCcjX2FjdGlvbkdyZWV0aW5nJywgZnVuY3Rpb24gKCkge1xuICAgIGl0KCdzaG91bGQgZmFpbCBpZiByZXNwb25zZSBpcyBub3QgMjIwJywgZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIF9vbkVycm9yU3R1YiA9IHNpbm9uLnN0dWIoc210cCwgJ19vbkVycm9yJylcblxuICAgICAgc210cC5fYWN0aW9uR3JlZXRpbmcoe1xuICAgICAgICBzdGF0dXNDb2RlOiA1MDAsXG4gICAgICAgIGRhdGE6ICd0ZXN0J1xuICAgICAgfSlcblxuICAgICAgZXhwZWN0KF9vbkVycm9yU3R1Yi5jYWxsZWRPbmNlKS50by5iZS50cnVlXG4gICAgICBleHBlY3QoX29uRXJyb3JTdHViLmFyZ3NbMF1bMF0ubWVzc2FnZSkudG8uZGVlcC5lcXVhbCgnSW52YWxpZCBncmVldGluZzogdGVzdCcpXG4gICAgICBfb25FcnJvclN0dWIucmVzdG9yZSgpXG4gICAgfSlcblxuICAgIGl0KCdzaG91bGQgc2VuZCBFSExPIG9uIGdyZWV0aW5nJywgZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIF9zZW5kQ29tbWFuZFN0dWIgPSBzaW5vbi5zdHViKHNtdHAsICdfc2VuZENvbW1hbmQnKVxuXG4gICAgICBzbXRwLm9wdGlvbnMubmFtZSA9ICdhYmMnXG4gICAgICBzbXRwLl9hY3Rpb25HcmVldGluZyh7XG4gICAgICAgIHN0YXR1c0NvZGU6IDIyMCxcbiAgICAgICAgZGF0YTogJ3Rlc3QnXG4gICAgICB9KVxuXG4gICAgICBleHBlY3QoX3NlbmRDb21tYW5kU3R1Yi53aXRoQXJncygnRUhMTyBhYmMnKS5jYWxsQ291bnQpLnRvLmVxdWFsKDEpXG4gICAgICBleHBlY3Qoc210cC5fY3VycmVudEFjdGlvbikudG8uZXF1YWwoc210cC5fYWN0aW9uRUhMTylcblxuICAgICAgX3NlbmRDb21tYW5kU3R1Yi5yZXN0b3JlKClcbiAgICB9KVxuXG4gICAgaXQoJ3Nob3VsZCBzZW5kIExITE8gb24gZ3JlZXRpbmcnLCBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgX3NlbmRDb21tYW5kU3R1YiA9IHNpbm9uLnN0dWIoc210cCwgJ19zZW5kQ29tbWFuZCcpXG5cbiAgICAgIHNtdHAub3B0aW9ucy5uYW1lID0gJ2FiYydcbiAgICAgIHNtdHAub3B0aW9ucy5sbXRwID0gdHJ1ZVxuICAgICAgc210cC5fYWN0aW9uR3JlZXRpbmcoe1xuICAgICAgICBzdGF0dXNDb2RlOiAyMjAsXG4gICAgICAgIGRhdGE6ICd0ZXN0J1xuICAgICAgfSlcblxuICAgICAgZXhwZWN0KF9zZW5kQ29tbWFuZFN0dWIud2l0aEFyZ3MoJ0xITE8gYWJjJykuY2FsbENvdW50KS50by5lcXVhbCgxKVxuICAgICAgZXhwZWN0KHNtdHAuX2N1cnJlbnRBY3Rpb24pLnRvLmVxdWFsKHNtdHAuX2FjdGlvbkxITE8pXG5cbiAgICAgIF9zZW5kQ29tbWFuZFN0dWIucmVzdG9yZSgpXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZSgnI19hY3Rpb25MSExPJywgZnVuY3Rpb24gKCkge1xuICAgIGl0KCdzaG91bGQgcHJvY2VlZCB0byBFSExPJywgZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIF9hY3Rpb25FSExPU3R1YiA9IHNpbm9uLnN0dWIoc210cCwgJ19hY3Rpb25FSExPJylcblxuICAgICAgc210cC5vcHRpb25zLm5hbWUgPSAnYWJjJ1xuICAgICAgc210cC5fYWN0aW9uTEhMTyh7XG4gICAgICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgICAgIGxpbmU6ICcyNTAtQVVUSCBQTEFJTiBMT0dJTidcbiAgICAgIH0pXG5cbiAgICAgIGV4cGVjdChfYWN0aW9uRUhMT1N0dWIuY2FsbENvdW50KS50by5lcXVhbCgxKVxuXG4gICAgICBfYWN0aW9uRUhMT1N0dWIucmVzdG9yZSgpXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZSgnI19hY3Rpb25FSExPJywgZnVuY3Rpb24gKCkge1xuICAgIGl0KCdzaG91bGQgZmFsbGJhY2sgdG8gSEVMTyBvbiBlcnJvcicsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBfc2VuZENvbW1hbmRTdHViID0gc2lub24uc3R1YihzbXRwLCAnX3NlbmRDb21tYW5kJylcblxuICAgICAgc210cC5vcHRpb25zLm5hbWUgPSAnYWJjJ1xuICAgICAgc210cC5fYWN0aW9uRUhMTyh7XG4gICAgICAgIHN1Y2Nlc3M6IGZhbHNlXG4gICAgICB9KVxuXG4gICAgICBleHBlY3QoX3NlbmRDb21tYW5kU3R1Yi53aXRoQXJncygnSEVMTyBhYmMnKS5jYWxsQ291bnQpLnRvLmVxdWFsKDEpXG4gICAgICBleHBlY3Qoc210cC5fY3VycmVudEFjdGlvbikudG8uZXF1YWwoc210cC5fYWN0aW9uSEVMTylcblxuICAgICAgX3NlbmRDb21tYW5kU3R1Yi5yZXN0b3JlKClcbiAgICB9KVxuXG4gICAgaXQoJ3Nob3VsZCBwcm9jZWVkIHRvIGF1dGhlbnRpY2F0aW9uJywgZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIF9hdXRoZW50aWNhdGVVc2VyU3R1YiA9IHNpbm9uLnN0dWIoc210cCwgJ19hdXRoZW50aWNhdGVVc2VyJylcblxuICAgICAgc210cC5fYWN0aW9uRUhMTyh7XG4gICAgICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgICAgIGxpbmU6ICcyNTAtQVVUSCBQTEFJTiBMT0dJTidcbiAgICAgIH0pXG5cbiAgICAgIGV4cGVjdChfYXV0aGVudGljYXRlVXNlclN0dWIuY2FsbENvdW50KS50by5lcXVhbCgxKVxuICAgICAgZXhwZWN0KHNtdHAuX3N1cHBvcnRlZEF1dGgpLnRvLmRlZXAuZXF1YWwoWydQTEFJTicsICdMT0dJTiddKVxuXG4gICAgICBfYXV0aGVudGljYXRlVXNlclN0dWIucmVzdG9yZSgpXG4gICAgfSlcblxuICAgIGl0KCdzaG91bGQgcHJvY2VlZCB0byBzdGFydHRscycsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBfc2VuZENvbW1hbmRTdHViID0gc2lub24uc3R1YihzbXRwLCAnX3NlbmRDb21tYW5kJylcblxuICAgICAgc210cC5fc2VjdXJlTW9kZSA9IGZhbHNlXG4gICAgICBzbXRwLl9hY3Rpb25FSExPKHtcbiAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgbGluZTogJzI1MC1TVEFSVFRMUydcbiAgICAgIH0pXG5cbiAgICAgIGV4cGVjdChfc2VuZENvbW1hbmRTdHViLndpdGhBcmdzKCdTVEFSVFRMUycpLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcblxuICAgICAgZXhwZWN0KHNtdHAuX2N1cnJlbnRBY3Rpb24pLnRvLmVxdWFsKHNtdHAuX2FjdGlvblNUQVJUVExTKVxuICAgICAgX3NlbmRDb21tYW5kU3R1Yi5yZXN0b3JlKClcbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKCcjX2FjdGlvbkhFTE8nLCBmdW5jdGlvbiAoKSB7XG4gICAgaXQoJ3Nob3VsZCBwcm9jZWVkIHRvIGF1dGhlbnRpY2F0aW9uJywgZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIF9hdXRoZW50aWNhdGVVc2VyU3R1YiA9IHNpbm9uLnN0dWIoc210cCwgJ19hdXRoZW50aWNhdGVVc2VyJylcblxuICAgICAgc210cC5fYWN0aW9uSEVMTyh7XG4gICAgICAgIHN1Y2Nlc3M6IHRydWVcbiAgICAgIH0pXG5cbiAgICAgIGV4cGVjdChfYXV0aGVudGljYXRlVXNlclN0dWIuY2FsbENvdW50KS50by5lcXVhbCgxKVxuXG4gICAgICBfYXV0aGVudGljYXRlVXNlclN0dWIucmVzdG9yZSgpXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZSgnI19hY3Rpb25TVEFSVFRMUycsIGZ1bmN0aW9uICgpIHtcbiAgICBpdCgnc2hvdWxkIHVwZ3JhZGUgY29ubmVjdGlvbicsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBfc2VuZENvbW1hbmRTdHViID0gc2lub24uc3R1YihzbXRwLCAnX3NlbmRDb21tYW5kJylcblxuICAgICAgc210cC5vcHRpb25zLm5hbWUgPSAnYWJjJ1xuICAgICAgc210cC5fYWN0aW9uU1RBUlRUTFMoe1xuICAgICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgICBsaW5lOiAnMjIwIFJlYWR5IHRvIHN0YXJ0IFRMUydcbiAgICAgIH0pXG5cbiAgICAgIGV4cGVjdChzbXRwLnNvY2tldC51cGdyYWRlVG9TZWN1cmUuY2FsbENvdW50KS50by5lcXVhbCgxKVxuICAgICAgZXhwZWN0KF9zZW5kQ29tbWFuZFN0dWIud2l0aEFyZ3MoJ0VITE8gYWJjJykuY2FsbENvdW50KS50by5lcXVhbCgxKVxuICAgICAgZXhwZWN0KHNtdHAuX2N1cnJlbnRBY3Rpb24pLnRvLmVxdWFsKHNtdHAuX2FjdGlvbkVITE8pXG5cbiAgICAgIF9zZW5kQ29tbWFuZFN0dWIucmVzdG9yZSgpXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZSgnI19hY3Rpb25BVVRIX0xPR0lOX1VTRVInLCBmdW5jdGlvbiAoKSB7XG4gICAgaXQoJ3Nob3VsZCBlbWl0IGVycm9yIG9uIGludmFsaWQgaW5wdXQnLCBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgX29uRXJyb3JTdHViID0gc2lub24uc3R1YihzbXRwLCAnX29uRXJyb3InKVxuXG4gICAgICBzbXRwLl9hY3Rpb25BVVRIX0xPR0lOX1VTRVIoe1xuICAgICAgICBzdGF0dXNDb2RlOiAzMzQsIC8vIHZhbGlkIHN0YXR1cyBjb2RlXG4gICAgICAgIGRhdGE6ICd0ZXN0JyAvLyBpbnZhbGlkIHZhbHVlXG4gICAgICB9KVxuXG4gICAgICBleHBlY3QoX29uRXJyb3JTdHViLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcbiAgICAgIGV4cGVjdChfb25FcnJvclN0dWIuYXJnc1swXVswXSBpbnN0YW5jZW9mIEVycm9yKS50by5iZS50cnVlXG5cbiAgICAgIF9vbkVycm9yU3R1Yi5yZXN0b3JlKClcbiAgICB9KVxuXG4gICAgaXQoJ3Nob3VsZCByZXNwb25kIHRvIHNlcnZlciB3aXRoIGJhc2U2NCBlbmNvZGVkIHVzZXJuYW1lJywgZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIF9zZW5kQ29tbWFuZFN0dWIgPSBzaW5vbi5zdHViKHNtdHAsICdfc2VuZENvbW1hbmQnKVxuXG4gICAgICBzbXRwLm9wdGlvbnMuYXV0aCA9IHtcbiAgICAgICAgdXNlcjogJ2FiYycsXG4gICAgICAgIHBhc3M6ICdkZWYnXG4gICAgICB9XG4gICAgICBzbXRwLl9hY3Rpb25BVVRIX0xPR0lOX1VTRVIoe1xuICAgICAgICBzdGF0dXNDb2RlOiAzMzQsXG4gICAgICAgIGRhdGE6ICdWWE5sY201aGJXVTYnXG4gICAgICB9KVxuXG4gICAgICBleHBlY3QoX3NlbmRDb21tYW5kU3R1Yi53aXRoQXJncygnWVdKaicpLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcbiAgICAgIGV4cGVjdChzbXRwLl9jdXJyZW50QWN0aW9uKS50by5lcXVhbChzbXRwLl9hY3Rpb25BVVRIX0xPR0lOX1BBU1MpXG5cbiAgICAgIF9zZW5kQ29tbWFuZFN0dWIucmVzdG9yZSgpXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZSgnI19hY3Rpb25BVVRIX0xPR0lOX1BBU1MnLCBmdW5jdGlvbiAoKSB7XG4gICAgaXQoJ3Nob3VsZCBlbWl0IGVycm9yIG9uIGludmFsaWQgaW5wdXQnLCBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgX29uRXJyb3JTdHViID0gc2lub24uc3R1YihzbXRwLCAnX29uRXJyb3InKVxuXG4gICAgICBzbXRwLl9hY3Rpb25BVVRIX0xPR0lOX1BBU1Moe1xuICAgICAgICBzdGF0dXNDb2RlOiAzMzQsIC8vIHZhbGlkIHN0YXR1cyBjb2RlXG4gICAgICAgIGRhdGE6ICd0ZXN0JyAvLyBpbnZhbGlkIHZhbHVlXG4gICAgICB9KVxuXG4gICAgICBleHBlY3QoX29uRXJyb3JTdHViLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcbiAgICAgIGV4cGVjdChfb25FcnJvclN0dWIuYXJnc1swXVswXSBpbnN0YW5jZW9mIEVycm9yKS50by5iZS50cnVlXG5cbiAgICAgIF9vbkVycm9yU3R1Yi5yZXN0b3JlKClcbiAgICB9KVxuXG4gICAgaXQoJ3Nob3VsZCByZXNwb25kIHRvIHNlcnZlciB3aXRoIGJhc2U2NCBlbmNvZGVkIHBhc3N3b3JkJywgZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIF9zZW5kQ29tbWFuZFN0dWIgPSBzaW5vbi5zdHViKHNtdHAsICdfc2VuZENvbW1hbmQnKVxuXG4gICAgICBzbXRwLm9wdGlvbnMuYXV0aCA9IHtcbiAgICAgICAgdXNlcjogJ2FiYycsXG4gICAgICAgIHBhc3M6ICdkZWYnXG4gICAgICB9XG4gICAgICBzbXRwLl9hY3Rpb25BVVRIX0xPR0lOX1BBU1Moe1xuICAgICAgICBzdGF0dXNDb2RlOiAzMzQsXG4gICAgICAgIGRhdGE6ICdVR0Z6YzNkdmNtUTYnXG4gICAgICB9KVxuXG4gICAgICBleHBlY3QoX3NlbmRDb21tYW5kU3R1Yi53aXRoQXJncygnWkdWbScpLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcbiAgICAgIGV4cGVjdChzbXRwLl9jdXJyZW50QWN0aW9uKS50by5lcXVhbChzbXRwLl9hY3Rpb25BVVRIQ29tcGxldGUpXG5cbiAgICAgIF9zZW5kQ29tbWFuZFN0dWIucmVzdG9yZSgpXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZSgnI19hY3Rpb25BVVRIX1hPQVVUSDInLCBmdW5jdGlvbiAoKSB7XG4gICAgaXQoJ3Nob3VsZCBzZW5kIGVtcHR5IHJlc3BvbnNlIG9uIGVycm9yJywgZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIF9zZW5kQ29tbWFuZFN0dWIgPSBzaW5vbi5zdHViKHNtdHAsICdfc2VuZENvbW1hbmQnKVxuXG4gICAgICBzbXRwLl9hY3Rpb25BVVRIX1hPQVVUSDIoe1xuICAgICAgICBzdWNjZXNzOiBmYWxzZVxuICAgICAgfSlcblxuICAgICAgZXhwZWN0KF9zZW5kQ29tbWFuZFN0dWIud2l0aEFyZ3MoJycpLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcbiAgICAgIGV4cGVjdChzbXRwLl9jdXJyZW50QWN0aW9uKS50by5lcXVhbChzbXRwLl9hY3Rpb25BVVRIQ29tcGxldGUpXG5cbiAgICAgIF9zZW5kQ29tbWFuZFN0dWIucmVzdG9yZSgpXG4gICAgfSlcblxuICAgIGl0KCdzaG91bGQgcnVuIF9hY3Rpb25BVVRIQ29tcGxldGUgb24gc3VjY2VzcycsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBfYWN0aW9uQVVUSENvbXBsZXRlU3R1YiA9IHNpbm9uLnN0dWIoc210cCwgJ19hY3Rpb25BVVRIQ29tcGxldGUnKVxuXG4gICAgICB2YXIgY21kID0ge1xuICAgICAgICBzdWNjZXNzOiB0cnVlXG4gICAgICB9XG4gICAgICBzbXRwLl9hY3Rpb25BVVRIX1hPQVVUSDIoY21kKVxuXG4gICAgICBleHBlY3QoX2FjdGlvbkFVVEhDb21wbGV0ZVN0dWIud2l0aEFyZ3MoY21kKS5jYWxsQ291bnQpLnRvLmVxdWFsKDEpXG5cbiAgICAgIF9hY3Rpb25BVVRIQ29tcGxldGVTdHViLnJlc3RvcmUoKVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoJyNfYWN0aW9uQVVUSENvbXBsZXRlJywgZnVuY3Rpb24gKCkge1xuICAgIGl0KCdzaG91bGQgZW1pdCBlcnJvciBvbiBpbnZhbGlkIGF1dGgnLCBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgX29uRXJyb3JTdHViID0gc2lub24uc3R1YihzbXRwLCAnX29uRXJyb3InKVxuXG4gICAgICBzbXRwLl9hY3Rpb25BVVRIQ29tcGxldGUoe1xuICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgZGF0YTogJ2VycidcbiAgICAgIH0pXG5cbiAgICAgIGV4cGVjdChfb25FcnJvclN0dWIuY2FsbENvdW50KS50by5lcXVhbCgxKVxuICAgICAgZXhwZWN0KF9vbkVycm9yU3R1Yi5hcmdzWzBdWzBdIGluc3RhbmNlb2YgRXJyb3IpLnRvLmJlLnRydWVcblxuICAgICAgX29uRXJyb3JTdHViLnJlc3RvcmUoKVxuICAgIH0pXG5cbiAgICBpdCgnc2hvdWxkIGVtaXQgaWRsZSBpZiBhdXRoIHN1Y2NlZWRlZCcsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBfb25pZGxlU3R1YiA9IHNpbm9uLnN0dWIoc210cCwgJ29uaWRsZScpXG5cbiAgICAgIHNtdHAub3B0aW9ucy5hdXRoID0ge1xuICAgICAgICB1c2VyOiAnYWJjJyxcbiAgICAgICAgcGFzczogJ2RlZidcbiAgICAgIH1cbiAgICAgIHNtdHAuX2FjdGlvbkFVVEhDb21wbGV0ZSh7XG4gICAgICAgIHN1Y2Nlc3M6IHRydWVcbiAgICAgIH0pXG5cbiAgICAgIGV4cGVjdChfb25pZGxlU3R1Yi5jYWxsQ291bnQpLnRvLmVxdWFsKDEpXG4gICAgICBleHBlY3Qoc210cC5fY3VycmVudEFjdGlvbikudG8uZXF1YWwoc210cC5fYWN0aW9uSWRsZSlcbiAgICAgIGV4cGVjdChzbXRwLl9hdXRoZW50aWNhdGVkQXMpLnRvLmVxdWFsKCdhYmMnKVxuXG4gICAgICBfb25pZGxlU3R1Yi5yZXN0b3JlKClcbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKCcjX2FjdGlvbk1BSUwnLCBmdW5jdGlvbiAoKSB7XG4gICAgaXQoJ3Nob3VsZCBlbWl0IGVycm9yIG9uIGludmFsaWQgaW5wdXQnLCBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgX29uRXJyb3JTdHViID0gc2lub24uc3R1YihzbXRwLCAnX29uRXJyb3InKVxuXG4gICAgICBzbXRwLl9hY3Rpb25NQUlMKHtcbiAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgIGRhdGE6ICdlcnInXG4gICAgICB9KVxuXG4gICAgICBleHBlY3QoX29uRXJyb3JTdHViLmNhbGxlZE9uY2UpLnRvLmJlLnRydWVcbiAgICAgIGV4cGVjdChfb25FcnJvclN0dWIuYXJnc1swXVswXS5tZXNzYWdlKS50by5lcXVhbCgnZXJyJylcblxuICAgICAgX29uRXJyb3JTdHViLnJlc3RvcmUoKVxuICAgIH0pXG5cbiAgICBpdCgnc2hvdWxkIGVtaXQgZXJyb3Igb24gZW1wdHkgcmVjaXBpZW50IHF1ZXVlJywgZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIF9vbkVycm9yU3R1YiA9IHNpbm9uLnN0dWIoc210cCwgJ19vbkVycm9yJylcblxuICAgICAgc210cC5fZW52ZWxvcGUgPSB7XG4gICAgICAgIHJjcHRRdWV1ZTogW11cbiAgICAgIH1cbiAgICAgIHNtdHAuX2FjdGlvbk1BSUwoe1xuICAgICAgICBzdWNjZXNzOiB0cnVlXG4gICAgICB9KVxuXG4gICAgICBleHBlY3QoX29uRXJyb3JTdHViLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcbiAgICAgIGV4cGVjdChfb25FcnJvclN0dWIuYXJnc1swXVswXSBpbnN0YW5jZW9mIEVycm9yKS50by5iZS50cnVlXG5cbiAgICAgIF9vbkVycm9yU3R1Yi5yZXN0b3JlKClcbiAgICB9KVxuXG4gICAgaXQoJ3Nob3VsZCBzZW5kIHRvIHRoZSBuZXh0IHJlY2lwaWVudCBpbiBxdWV1ZScsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBfc2VuZENvbW1hbmRTdHViID0gc2lub24uc3R1YihzbXRwLCAnX3NlbmRDb21tYW5kJylcblxuICAgICAgc210cC5fZW52ZWxvcGUgPSB7XG4gICAgICAgIHJjcHRRdWV1ZTogWydyZWNlaXZlciddXG4gICAgICB9XG4gICAgICBzbXRwLl9hY3Rpb25NQUlMKHtcbiAgICAgICAgc3VjY2VzczogdHJ1ZVxuICAgICAgfSlcblxuICAgICAgZXhwZWN0KF9zZW5kQ29tbWFuZFN0dWIud2l0aEFyZ3MoJ1JDUFQgVE86PHJlY2VpdmVyPicpLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcbiAgICAgIGV4cGVjdChzbXRwLl9jdXJyZW50QWN0aW9uKS50by5lcXVhbChzbXRwLl9hY3Rpb25SQ1BUKVxuXG4gICAgICBfc2VuZENvbW1hbmRTdHViLnJlc3RvcmUoKVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoJyNfYWN0aW9uUkNQVCcsIGZ1bmN0aW9uICgpIHtcbiAgICBpdCgnc2hvdWxkIHNlbmQgREFUQSBpZiBxdWV1ZSBpcyBwcm9jZXNzZWQnLCBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgX3NlbmRDb21tYW5kU3R1YiA9IHNpbm9uLnN0dWIoc210cCwgJ19zZW5kQ29tbWFuZCcpXG5cbiAgICAgIHNtdHAuX2VudmVsb3BlID0ge1xuICAgICAgICB0bzogWydhYmMnXSxcbiAgICAgICAgcmNwdEZhaWxlZDogW10sXG4gICAgICAgIHJjcHRRdWV1ZTogW10sXG4gICAgICAgIHJlc3BvbnNlUXVldWU6IFtdXG4gICAgICB9XG4gICAgICBzbXRwLl9hY3Rpb25SQ1BUKHtcbiAgICAgICAgc3VjY2VzczogdHJ1ZVxuICAgICAgfSlcblxuICAgICAgZXhwZWN0KF9zZW5kQ29tbWFuZFN0dWIud2l0aEFyZ3MoJ0RBVEEnKS5jYWxsQ291bnQpLnRvLmVxdWFsKDEpXG4gICAgICBleHBlY3Qoc210cC5fY3VycmVudEFjdGlvbikudG8uZXF1YWwoc210cC5fYWN0aW9uREFUQSlcblxuICAgICAgX3NlbmRDb21tYW5kU3R1Yi5yZXN0b3JlKClcbiAgICB9KVxuXG4gICAgaXQoJ3Nob3VsZCBzZW5kIHJlcnVuIFJDUFQgaWYgcXVldWUgaXMgbm90IGVtcHR5JywgZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIF9zZW5kQ29tbWFuZFN0dWIgPSBzaW5vbi5zdHViKHNtdHAsICdfc2VuZENvbW1hbmQnKVxuXG4gICAgICBzbXRwLl9lbnZlbG9wZSA9IHtcbiAgICAgICAgcmNwdFF1ZXVlOiBbJ3JlY2VpdmVyJ10sXG4gICAgICAgIHJlc3BvbnNlUXVldWU6IFtdXG4gICAgICB9XG4gICAgICBzbXRwLl9hY3Rpb25SQ1BUKHtcbiAgICAgICAgc3VjY2VzczogdHJ1ZVxuICAgICAgfSlcblxuICAgICAgZXhwZWN0KF9zZW5kQ29tbWFuZFN0dWIud2l0aEFyZ3MoJ1JDUFQgVE86PHJlY2VpdmVyPicpLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcbiAgICAgIGV4cGVjdChzbXRwLl9jdXJyZW50QWN0aW9uKS50by5lcXVhbChzbXRwLl9hY3Rpb25SQ1BUKVxuXG4gICAgICBfc2VuZENvbW1hbmRTdHViLnJlc3RvcmUoKVxuICAgIH0pXG5cbiAgICBpdCgnc2hvdWxkIGVtaXQgZXJyb3IgaWYgYWxsIHJlY2lwaWVudHMgZmFpbGVkJywgZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIF9vbkVycm9yU3R1YiA9IHNpbm9uLnN0dWIoc210cCwgJ19vbkVycm9yJylcblxuICAgICAgc210cC5fZW52ZWxvcGUgPSB7XG4gICAgICAgIHRvOiBbJ2FiYyddLFxuICAgICAgICByY3B0RmFpbGVkOiBbJ2FiYyddLFxuICAgICAgICByY3B0UXVldWU6IFtdLFxuICAgICAgICByZXNwb25zZVF1ZXVlOiBbXVxuICAgICAgfVxuICAgICAgc210cC5fYWN0aW9uUkNQVCh7XG4gICAgICAgIHN1Y2Nlc3M6IHRydWVcbiAgICAgIH0pXG5cbiAgICAgIGV4cGVjdChfb25FcnJvclN0dWIuY2FsbENvdW50KS50by5lcXVhbCgxKVxuICAgICAgZXhwZWN0KF9vbkVycm9yU3R1Yi5hcmdzWzBdWzBdIGluc3RhbmNlb2YgRXJyb3IpLnRvLmJlLnRydWVcblxuICAgICAgX29uRXJyb3JTdHViLnJlc3RvcmUoKVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoJyNfYWN0aW9uUlNFVCcsIGZ1bmN0aW9uICgpIHtcbiAgICBpdCgnc2hvdWxkIGVtaXQgZXJyb3Igb24gaW52YWxpZCBpbnB1dCcsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBfb25FcnJvclN0dWIgPSBzaW5vbi5zdHViKHNtdHAsICdfb25FcnJvcicpXG5cbiAgICAgIHNtdHAuX2FjdGlvblJTRVQoe1xuICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgZGF0YTogJ2VycidcbiAgICAgIH0pXG5cbiAgICAgIGV4cGVjdChfb25FcnJvclN0dWIuY2FsbGVkT25jZSkudG8uYmUudHJ1ZVxuICAgICAgZXhwZWN0KF9vbkVycm9yU3R1Yi5hcmdzWzBdWzBdLm1lc3NhZ2UpLnRvLmVxdWFsKCdlcnInKVxuXG4gICAgICBfb25FcnJvclN0dWIucmVzdG9yZSgpXG4gICAgfSlcblxuICAgIGl0KCdzaG91bGQgcHJvY2VlZCB0byBhdXRoZW50aWNhdGlvbicsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBfYXV0aGVudGljYXRlVXNlclN0dWIgPSBzaW5vbi5zdHViKHNtdHAsICdfYXV0aGVudGljYXRlVXNlcicpXG5cbiAgICAgIHNtdHAuX2FjdGlvblJTRVQoe1xuICAgICAgICBzdWNjZXNzOiB0cnVlXG4gICAgICB9KVxuXG4gICAgICBleHBlY3QoX2F1dGhlbnRpY2F0ZVVzZXJTdHViLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcbiAgICAgIGV4cGVjdChzbXRwLl9hdXRoZW50aWNhdGVkQXMpLnRvLmJlLm51bGxcblxuICAgICAgX2F1dGhlbnRpY2F0ZVVzZXJTdHViLnJlc3RvcmUoKVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoJyNfYWN0aW9uREFUQScsIGZ1bmN0aW9uICgpIHtcbiAgICBpdCgnc2hvdWxkIGVtaXQgZXJyb3Igb24gaW52YWxpZCBpbnB1dCcsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBfb25FcnJvclN0dWIgPSBzaW5vbi5zdHViKHNtdHAsICdfb25FcnJvcicpXG5cbiAgICAgIHNtdHAuX2FjdGlvbkRBVEEoe1xuICAgICAgICBzdGF0dXNDb2RlOiA1MDAsXG4gICAgICAgIGRhdGE6ICdlcnInXG4gICAgICB9KVxuXG4gICAgICBleHBlY3QoX29uRXJyb3JTdHViLmNhbGxlZE9uY2UpLnRvLmJlLnRydWVcbiAgICAgIGV4cGVjdChfb25FcnJvclN0dWIuYXJnc1swXVswXS5tZXNzYWdlKS50by5lcXVhbCgnZXJyJylcblxuICAgICAgX29uRXJyb3JTdHViLnJlc3RvcmUoKVxuICAgIH0pXG5cbiAgICBpdCgnc2hvdWxkIGVtaXQgb25yZWFkeSBvbiBzdWNjZXNzJywgZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIF9vbnJlYWR5U3R1YiA9IHNpbm9uLnN0dWIoc210cCwgJ29ucmVhZHknKVxuXG4gICAgICBzbXRwLl9lbnZlbG9wZSA9IHtcbiAgICAgICAgdG86IFsnYWJjJ10sXG4gICAgICAgIHJjcHRGYWlsZWQ6IFsnYWJjJ10sXG4gICAgICAgIHJjcHRRdWV1ZTogW11cbiAgICAgIH1cbiAgICAgIHNtdHAuX2FjdGlvbkRBVEEoe1xuICAgICAgICBzdGF0dXNDb2RlOiAyNTBcbiAgICAgIH0pXG5cbiAgICAgIGV4cGVjdChfb25yZWFkeVN0dWIud2l0aEFyZ3MoWydhYmMnXSkuY2FsbENvdW50KS50by5lcXVhbCgxKVxuICAgICAgZXhwZWN0KHNtdHAuX2N1cnJlbnRBY3Rpb24pLnRvLmVxdWFsKHNtdHAuX2FjdGlvbklkbGUpXG4gICAgICBleHBlY3Qoc210cC5fZGF0YU1vZGUpLnRvLmJlLnRydWVcblxuICAgICAgX29ucmVhZHlTdHViLnJlc3RvcmUoKVxuICAgIH0pXG4gIH0pXG5cbiAgZGVzY3JpYmUoJyNfYWN0aW9uU3RyZWFtJywgZnVuY3Rpb24gKCkge1xuICAgIGl0KCdzaG91bGQgZW1pdCBvbmRvbmUgd2l0aCBhcmd1bWVudCBmYWxzZScsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBfb25kb25lU3R1YiA9IHNpbm9uLnN0dWIoc210cCwgJ29uZG9uZScpXG5cbiAgICAgIHNtdHAuX2FjdGlvblN0cmVhbSh7XG4gICAgICAgIHN1Y2Nlc3M6IGZhbHNlXG4gICAgICB9KVxuXG4gICAgICBleHBlY3QoX29uZG9uZVN0dWIud2l0aEFyZ3MoZmFsc2UpLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcblxuICAgICAgX29uZG9uZVN0dWIucmVzdG9yZSgpXG4gICAgfSlcblxuICAgIGl0KCdzaG91bGQgZW1pdCBvbmRvbmUgd2l0aCBhcmd1bWVudCB0cnVlJywgZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIF9vbmRvbmVTdHViID0gc2lub24uc3R1YihzbXRwLCAnb25kb25lJylcblxuICAgICAgc210cC5fYWN0aW9uU3RyZWFtKHtcbiAgICAgICAgc3VjY2VzczogdHJ1ZVxuICAgICAgfSlcblxuICAgICAgZXhwZWN0KF9vbmRvbmVTdHViLndpdGhBcmdzKHRydWUpLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcblxuICAgICAgX29uZG9uZVN0dWIucmVzdG9yZSgpXG4gICAgfSlcblxuICAgIGl0KCdzaG91bGQgZW1pdCBvbmlkbGUgaWYgcmVxdWlyZWQnLCBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgX29uaWRsZVN0dWIgPSBzaW5vbi5zdHViKHNtdHAsICdvbmlkbGUnKVxuXG4gICAgICBzbXRwLl9jdXJyZW50QWN0aW9uID0gc210cC5fYWN0aW9uSWRsZVxuICAgICAgc210cC5fYWN0aW9uU3RyZWFtKHtcbiAgICAgICAgc3VjY2VzczogdHJ1ZVxuICAgICAgfSlcblxuICAgICAgZXhwZWN0KF9vbmlkbGVTdHViLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcblxuICAgICAgX29uaWRsZVN0dWIucmVzdG9yZSgpXG4gICAgfSlcblxuICAgIGl0KCdzaG91bGQgY2FuY2VsIG9uaWRsZScsIGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBfb25pZGxlU3R1YiA9IHNpbm9uLnN0dWIoc210cCwgJ29uaWRsZScpXG5cbiAgICAgIHNtdHAub25kb25lID0gZnVuY3Rpb24gKCkge1xuICAgICAgICB0aGlzLl9jdXJyZW50QWN0aW9uID0gZmFsc2VcbiAgICAgIH1cblxuICAgICAgc210cC5fYWN0aW9uU3RyZWFtKHtcbiAgICAgICAgc3VjY2VzczogdHJ1ZVxuICAgICAgfSlcblxuICAgICAgZXhwZWN0KF9vbmlkbGVTdHViLmNhbGxDb3VudCkudG8uZXF1YWwoMClcblxuICAgICAgX29uaWRsZVN0dWIucmVzdG9yZSgpXG4gICAgfSlcblxuICAgIGRlc2NyaWJlKCdMTVRQIHJlc3BvbnNlcycsIGZ1bmN0aW9uICgpIHtcbiAgICAgIGl0KCdzaG91bGQgcmVjZWl2ZSBzaW5nbGUgcmVzcG9uc2VzJywgZnVuY3Rpb24gKCkge1xuICAgICAgICB2YXIgX29uZG9uZVN0dWIgPSBzaW5vbi5zdHViKHNtdHAsICdvbmRvbmUnKVxuXG4gICAgICAgIHNtdHAub3B0aW9ucy5sbXRwID0gdHJ1ZVxuICAgICAgICBzbXRwLl9lbnZlbG9wZSA9IHtcbiAgICAgICAgICByZXNwb25zZVF1ZXVlOiBbJ2FiYyddLFxuICAgICAgICAgIHJjcHRGYWlsZWQ6IFtdXG4gICAgICAgIH1cblxuICAgICAgICBzbXRwLl9hY3Rpb25TdHJlYW0oe1xuICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlXG4gICAgICAgIH0pXG5cbiAgICAgICAgZXhwZWN0KF9vbmRvbmVTdHViLndpdGhBcmdzKHRydWUpLmNhbGxDb3VudCkudG8uZXF1YWwoMSlcbiAgICAgICAgZXhwZWN0KHNtdHAuX2VudmVsb3BlLnJjcHRGYWlsZWQpLnRvLmRlZXAuZXF1YWwoWydhYmMnXSlcblxuICAgICAgICBfb25kb25lU3R1Yi5yZXN0b3JlKClcbiAgICAgIH0pXG5cbiAgICAgIGl0KCdzaG91bGQgd2FpdCBmb3IgYWRkaXRpb25hbCByZXNwb25zZXMnLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHZhciBfb25kb25lU3R1YiA9IHNpbm9uLnN0dWIoc210cCwgJ29uZG9uZScpXG5cbiAgICAgICAgc210cC5vcHRpb25zLmxtdHAgPSB0cnVlXG4gICAgICAgIHNtdHAuX2VudmVsb3BlID0ge1xuICAgICAgICAgIHJlc3BvbnNlUXVldWU6IFsnYWJjJywgJ2RlZicsICdnaGknXSxcbiAgICAgICAgICByY3B0RmFpbGVkOiBbXVxuICAgICAgICB9XG5cbiAgICAgICAgc210cC5fYWN0aW9uU3RyZWFtKHtcbiAgICAgICAgICBzdWNjZXNzOiBmYWxzZVxuICAgICAgICB9KVxuXG4gICAgICAgIHNtdHAuX2FjdGlvblN0cmVhbSh7XG4gICAgICAgICAgc3VjY2VzczogdHJ1ZVxuICAgICAgICB9KVxuXG4gICAgICAgIHNtdHAuX2FjdGlvblN0cmVhbSh7XG4gICAgICAgICAgc3VjY2VzczogZmFsc2VcbiAgICAgICAgfSlcblxuICAgICAgICBleHBlY3QoX29uZG9uZVN0dWIud2l0aEFyZ3ModHJ1ZSkuY2FsbENvdW50KS50by5lcXVhbCgxKVxuICAgICAgICBleHBlY3Qoc210cC5fZW52ZWxvcGUucmNwdEZhaWxlZCkudG8uZGVlcC5lcXVhbChbJ2FiYycsICdnaGknXSlcblxuICAgICAgICBfb25kb25lU3R1Yi5yZXN0b3JlKClcbiAgICAgIH0pXG4gICAgfSlcbiAgfSlcblxuICBkZXNjcmliZSgnI19idWlsZFhPQXV0aDJUb2tlbicsIGZ1bmN0aW9uICgpIHtcbiAgICBpdCgnc2hvdWxkIHJldHVybiBiYXNlNjQgZW5jb2RlZCBYT0FVVEgyIHRva2VuJywgZnVuY3Rpb24gKCkge1xuICAgICAgZXhwZWN0KHNtdHAuX2J1aWxkWE9BdXRoMlRva2VuKCd1c2VyQGhvc3QnLCAnYWJjZGUnKSkudG8uZXF1YWwoJ2RYTmxjajExYzJWeVFHaHZjM1FCWVhWMGFEMUNaV0Z5WlhJZ1lXSmpaR1VCQVE9PScpXG4gICAgfSlcbiAgfSlcbn0pXG4iXX0=