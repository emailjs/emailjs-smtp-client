'use strict';

(function(factory) {
    if (typeof define === 'function' && define.amd) {
        define(['chai', 'emailjs-smtp-client'], factory.bind(null, sinon));
    } else if (typeof exports === 'object') {
        module.exports = factory(require('sinon'), require('chai'), require('../../src/emailjs-smtp-client'));
    }
}(function(sinon, chai, SmtpClient) {
    var expect = chai.expect;
    chai.config.includeStack = true;

    describe('smtpclient unit tests', function() {
        var smtp;
        var host, port, options;
        var openStub, socketStub;
        var TCPSocket;

        beforeEach(function() {
            host = '127.0.0.1',
                port = 10000,
                options = {
                    useSecureTransport: true,
                    ca: 'WOW. SUCH CERT. MUCH TLS.'
                };

            smtp = new SmtpClient(host, port, options);
            smtp.logLevel = smtp.LOG_LEVEL_NONE;
            expect(smtp).to.exist;

            TCPSocket = smtp._TCPSocket = function() {};
            TCPSocket.open = function() {};
            TCPSocket.prototype.close = function() {};
            TCPSocket.prototype.send = function() {};
            TCPSocket.prototype.suspend = function() {};
            TCPSocket.prototype.resume = function() {};
            TCPSocket.prototype.send = function() {};
            TCPSocket.prototype.upgradeToSecure = function() {};

            socketStub = sinon.createStubInstance(TCPSocket);
            openStub = sinon.stub(TCPSocket, 'open').withArgs(host, port).returns(socketStub);

            smtp.connect();

            expect(openStub.callCount).to.equal(1);
            expect(socketStub.onopen).to.exist;
            expect(socketStub.onerror).to.exist;
        });

        afterEach(function() {
            TCPSocket.open.restore();
        });

        describe('tcp-socket websocket proxy', function() {
            it('should send hostname in onopen', function() {
                socketStub.onopen({
                    data: {
                        proxyHostname: 'hostname.io' // hostname of the socket.io proxy in tcp-socket
                    }
                });

                expect(smtp.options.name).to.equal('hostname.io');
            });
        });

        describe('#connect', function() {
            it('should not throw', function() {
                var client = new SmtpClient(host, port);
                client._TCPSocket = {
                    open: function() {
                        var socket = {
                            onopen: function() {},
                            onerror: function() {}
                        };
                        // disallow setting new properties (eg. oncert)
                        Object.preventExtensions(socket);
                        return socket;
                    }
                };
                client.connect();
            });
        });

        describe('#suspend', function() {
            it('should call suspend', function() {
                socketStub.readyState = 'open';
                smtp.suspend();

                expect(socketStub.suspend.callCount).to.equal(1);
            });
        });

        describe('#resume', function() {
            it('should call resume', function() {
                socketStub.readyState = 'open';
                smtp.resume();

                expect(socketStub.resume.callCount).to.equal(1);
            });
        });

        describe('#quit', function() {
            it('should send QUIT', function() {
                var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

                smtp.quit();

                expect(_sendCommandStub.withArgs('QUIT').callCount).to.equal(1);

                _sendCommandStub.restore();
            });
        });

        describe('#reset', function() {
            it('should send RSET', function() {
                var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

                smtp.reset();

                expect(_sendCommandStub.withArgs('RSET').callCount).to.equal(1);

                _sendCommandStub.restore();
            });

            it('should use default authentication', function() {
                smtp.options.auth = {
                    user: '1'
                };
                smtp.reset();

                expect(smtp.options.auth).to.deep.equal({
                    user: '1'
                });
            });

            it('should store custom authentication', function() {
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

        describe('#close', function() {
            it('should close socket', function() {
                socketStub.readyState = 'open';
                smtp.close();

                expect(socketStub.close.callCount).to.equal(1);
            });

            it('should call _destroy', function() {
                sinon.stub(smtp, '_destroy');

                socketStub.readyState = '';
                smtp.close();
                expect(smtp._destroy.callCount).to.equal(1);

                smtp._destroy.restore();
            });
        });

        describe('#useEnvelope', function() {
            it('should send MAIL FROM', function() {
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

        describe('#send', function() {
            it('should do nothing if not data mode', function() {
                smtp._dataMode = false;
                smtp.send();

                expect(socketStub.send.callCount).to.equal(0);
            });

            it('should send data to socket', function() {
                var _sendStringStub = sinon.stub(smtp, '_sendString');

                smtp._dataMode = true;
                smtp.send('abcde');

                expect(_sendStringStub.withArgs('abcde').callCount).to.equal(1);

                _sendStringStub.restore();
            });
        });

        describe('#end', function() {
            it('should do nothing if not data mode', function() {
                smtp._dataMode = false;
                smtp.send();

                expect(socketStub.send.callCount).to.equal(0);
            });

            it('should send a dot in a separate line', function() {
                smtp._dataMode = true;
                smtp.end();

                expect(socketStub.send.callCount).to.equal(1);
                expect(socketStub.send.args[0][0]).to.deep.equal(
                    new Uint8Array([ /* \r\n.\r\n */ 13, 10, 46, 13, 10]).buffer);
            });
        });

        describe('#_onData', function() {
            it('should decode and send chunk to parser', function() {
                var _parserSendStub = sinon.stub(smtp._parser, 'send');

                smtp._onData({
                    data: new Uint8Array([ /* abc */ 97, 98, 99]).buffer
                });

                expect(_parserSendStub.withArgs('abc').callCount).to.equal(1);

                _parserSendStub.restore();
            });
        });

        describe('#_onDrain', function() {
            it('should emit ondrain', function() {
                var _ondrainStub = sinon.stub(smtp, 'ondrain');

                smtp._onDrain();

                expect(_ondrainStub.callCount).to.equal(1);

                _ondrainStub.restore();
            });
        });

        describe('#_onError', function() {
            it('should emit onerror and close connection', function() {
                var _onerrorStub = sinon.stub(smtp, 'onerror');
                var _closeStub = sinon.stub(smtp, 'close');

                smtp._onError({
                    data: new Error('abc')
                });

                expect(_onerrorStub.withArgs(new Error('abc')).callCount).to.equal(1);
                expect(_closeStub.callCount).to.equal(1);

                _onerrorStub.restore();
                _closeStub.restore();
            });
        });

        describe('#_onClose', function() {
            it('should call _destroy', function() {
                var _destroyStub = sinon.stub(smtp, '_destroy');

                smtp._onClose();

                expect(_destroyStub.callCount).to.equal(1);

                _destroyStub.restore();
            });
        });

        describe('#_onCommand', function() {
            it('should run stored handler', function() {
                var _commandStub = sinon.stub();

                smtp._currentAction = _commandStub;
                smtp._onCommand('abc');

                expect(_commandStub.withArgs('abc').callCount).to.equal(1);
            });
        });

        describe('#_destroy', function() {
            it('should do nothing if already destroyed', function() {
                var _oncloseStub = sinon.stub(smtp, 'onclose');

                smtp.destroyed = true;
                smtp._destroy();

                expect(_oncloseStub.callCount).to.equal(0);

                _oncloseStub.restore();
            });

            it('should emit onclose if not destroyed yet', function() {
                var _oncloseStub = sinon.stub(smtp, 'onclose');

                smtp.destroyed = false;
                smtp._destroy();

                expect(_oncloseStub.callCount).to.equal(1);

                _oncloseStub.restore();
            });
        });

        describe('#_sendCommand', function() {
            it('should convert string to ArrayBuffer and send to socket', function() {
                smtp._sendCommand('abc');

                expect(socketStub.send.args[0][0]).to.deep.equal(
                    new Uint8Array([ /* abc\r\n */ 97, 98, 99, 13, 10]).buffer);
            });
        });

        describe('_authenticateUser', function() {
            it('should emit onidle if no auth info', function() {
                var _onidleStub = sinon.stub(smtp, 'onidle');

                smtp.options.auth = false;
                smtp._authenticateUser();

                expect(_onidleStub.callCount).to.equal(1);
                expect(smtp._currentAction).to.equal(smtp._actionIdle);

                _onidleStub.restore();
            });

            it('should use AUTH PLAIN by default', function() {
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

            it('should use AUTH LOGIN if specified', function() {
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

            it('should use AUTH XOAUTH2 if specified', function() {
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

        describe('#_actionGreeting', function() {
            it('should fail if response is not 220', function() {
                var _onErrorStub = sinon.stub(smtp, '_onError');

                smtp._actionGreeting({
                    statusCode: 500,
                    data: 'test'
                });

                expect(_onErrorStub.withArgs(new Error('Invalid greeting: test')).callCount).to.equal(1);
                _onErrorStub.restore();
            });

            it('should send EHLO on greeting', function() {
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

            it('should send LHLO on greeting', function() {
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

        describe('#_actionLHLO', function() {
            it('should proceed to EHLO', function() {
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

        describe('#_actionEHLO', function() {
            it('should fallback to HELO on error', function() {
                var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

                smtp.options.name = 'abc';
                smtp._actionEHLO({
                    success: false
                });

                expect(_sendCommandStub.withArgs('HELO abc').callCount).to.equal(1);
                expect(smtp._currentAction).to.equal(smtp._actionHELO);

                _sendCommandStub.restore();
            });

            it('should proceed to authentication', function() {
                var _authenticateUserStub = sinon.stub(smtp, '_authenticateUser');

                smtp._actionEHLO({
                    success: true,
                    line: '250-AUTH PLAIN LOGIN'
                });

                expect(_authenticateUserStub.callCount).to.equal(1);
                expect(smtp._supportedAuth).to.deep.equal(['PLAIN', 'LOGIN']);

                _authenticateUserStub.restore();
            });

            it('should proceed to starttls', function() {
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

        describe('#_actionHELO', function() {
            it('should proceed to authentication', function() {
                var _authenticateUserStub = sinon.stub(smtp, '_authenticateUser');

                smtp._actionHELO({
                    success: true
                });

                expect(_authenticateUserStub.callCount).to.equal(1);

                _authenticateUserStub.restore();
            });
        });

        describe('#_actionSTARTTLS', function() {
            it('should upgrade connection', function() {
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

        describe('#_actionAUTH_LOGIN_USER', function() {
            it('should emit error on invalid input', function() {
                var _onErrorStub = sinon.stub(smtp, '_onError');

                smtp._actionAUTH_LOGIN_USER({
                    statusCode: 334, // valid status code
                    data: 'test' // invalid value
                });

                expect(_onErrorStub.callCount).to.equal(1);
                expect(_onErrorStub.args[0][0] instanceof Error).to.be.true;

                _onErrorStub.restore();
            });

            it('should respond to server with base64 encoded username', function() {
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

        describe('#_actionAUTH_LOGIN_PASS', function() {
            it('should emit error on invalid input', function() {
                var _onErrorStub = sinon.stub(smtp, '_onError');

                smtp._actionAUTH_LOGIN_PASS({
                    statusCode: 334, // valid status code
                    data: 'test' // invalid value
                });

                expect(_onErrorStub.callCount).to.equal(1);
                expect(_onErrorStub.args[0][0] instanceof Error).to.be.true;

                _onErrorStub.restore();
            });

            it('should respond to server with base64 encoded password', function() {
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

        describe('#_actionAUTH_XOAUTH2', function() {
            it('should send empty response on error', function() {
                var _sendCommandStub = sinon.stub(smtp, '_sendCommand');

                smtp._actionAUTH_XOAUTH2({
                    success: false
                });

                expect(_sendCommandStub.withArgs('').callCount).to.equal(1);
                expect(smtp._currentAction).to.equal(smtp._actionAUTHComplete);

                _sendCommandStub.restore();
            });

            it('should run _actionAUTHComplete on success', function() {
                var _actionAUTHCompleteStub = sinon.stub(smtp, '_actionAUTHComplete');

                var cmd = {
                    success: true
                };
                smtp._actionAUTH_XOAUTH2(cmd);

                expect(_actionAUTHCompleteStub.withArgs(cmd).callCount).to.equal(1);

                _actionAUTHCompleteStub.restore();
            });
        });

        describe('#_actionAUTHComplete', function() {
            it('should emit error on invalid auth', function() {
                var _onErrorStub = sinon.stub(smtp, '_onError');

                smtp._actionAUTHComplete({
                    success: false,
                    data: 'err'
                });

                expect(_onErrorStub.callCount).to.equal(1);
                expect(_onErrorStub.args[0][0] instanceof Error).to.be.true;

                _onErrorStub.restore();
            });

            it('should emit idle if auth succeeded', function() {
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

        describe('#_actionMAIL', function() {
            it('should emit error on invalid input', function() {
                var _onErrorStub = sinon.stub(smtp, '_onError');

                smtp._actionMAIL({
                    success: false,
                    data: 'err'
                });

                expect(_onErrorStub.withArgs(new Error('err')).callCount).to.equal(1);

                _onErrorStub.restore();
            });

            it('should emit error on empty recipient queue', function() {
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

            it('should send to the next recipient in queue', function() {
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

        describe('#_actionRCPT', function() {
            it('should send DATA if queue is processed', function() {
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

            it('should send rerun RCPT if queue is not empty', function() {
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

            it('should emit error if all recipients failed', function() {
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

        describe('#_actionRSET', function() {
            it('should emit error on invalid input', function() {
                var _onErrorStub = sinon.stub(smtp, '_onError');

                smtp._actionRSET({
                    success: false,
                    data: 'err'
                });

                expect(_onErrorStub.withArgs(new Error('err')).callCount).to.equal(1);

                _onErrorStub.restore();
            });

            it('should proceed to authentication', function() {
                var _authenticateUserStub = sinon.stub(smtp, '_authenticateUser');

                smtp._actionRSET({
                    success: true
                });

                expect(_authenticateUserStub.callCount).to.equal(1);
                expect(smtp._authenticatedAs).to.be.null;

                _authenticateUserStub.restore();
            });
        });

        describe('#_actionDATA', function() {
            it('should emit error on invalid input', function() {
                var _onErrorStub = sinon.stub(smtp, '_onError');

                smtp._actionDATA({
                    statusCode: 500,
                    data: 'err'
                });

                expect(_onErrorStub.withArgs(new Error('err')).callCount).to.equal(1);

                _onErrorStub.restore();
            });

            it('should emit onready on success', function() {
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

        describe('#_actionStream', function() {
            it('should emit ondone with argument false', function() {
                var _ondoneStub = sinon.stub(smtp, 'ondone');

                smtp._actionStream({
                    success: false
                });

                expect(_ondoneStub.withArgs(false).callCount).to.equal(1);

                _ondoneStub.restore();
            });

            it('should emit ondone with argument true', function() {
                var _ondoneStub = sinon.stub(smtp, 'ondone');

                smtp._actionStream({
                    success: true
                });

                expect(_ondoneStub.withArgs(true).callCount).to.equal(1);

                _ondoneStub.restore();
            });

            it('should emit onidle if required', function() {
                var _onidleStub = sinon.stub(smtp, 'onidle');

                smtp._currentAction = smtp._actionIdle;
                smtp._actionStream({
                    success: true
                });

                expect(_onidleStub.callCount).to.equal(1);

                _onidleStub.restore();
            });

            it('should cancel onidle', function() {
                var _onidleStub = sinon.stub(smtp, 'onidle');

                smtp.ondone = function() {
                    this._currentAction = false;
                };

                smtp._actionStream({
                    success: true
                });

                expect(_onidleStub.callCount).to.equal(0);

                _onidleStub.restore();
            });

            describe('LMTP responses', function() {
                it('should receive single responses', function() {
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

                it('should wait for additional responses', function() {
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

        describe('#_buildXOAuth2Token', function() {
            it('should return base64 encoded XOAUTH2 token', function() {
                expect(smtp._buildXOAuth2Token('user@host', 'abcde')).to.equal('dXNlcj11c2VyQGhvc3QBYXV0aD1CZWFyZXIgYWJjZGUBAQ==');
            });
        });
    });
}));
