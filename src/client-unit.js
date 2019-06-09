/* eslint-disable no-unused-expressions */

import SmtpClient from './client'

describe('smtpclient unit tests', function () {
  let smtp
  let host, port, options
  let openStub, socketStub
  let TCPSocket

  beforeEach(function () {
    host = '127.0.0.1'
    port = 10000
    options = {
      useSecureTransport: true,
      ca: 'WOW. SUCH CERT. MUCH TLS.'
    }

    smtp = new SmtpClient(host, port, options)
    expect(smtp).to.exist

    TCPSocket = function () { }
    TCPSocket.open = function () { }
    TCPSocket.prototype.close = function () { }
    TCPSocket.prototype.send = function () { }
    TCPSocket.prototype.suspend = function () { }
    TCPSocket.prototype.resume = function () { }
    TCPSocket.prototype.send = function () { }
    TCPSocket.prototype.upgradeToSecure = function () { }

    socketStub = sinon.createStubInstance(TCPSocket)
    openStub = sinon.stub(TCPSocket, 'open').withArgs(host, port).returns(socketStub)

    smtp.connect(TCPSocket)

    expect(openStub.callCount).to.equal(1)
    expect(socketStub.onopen).to.exist
    expect(socketStub.onerror).to.exist
  })

  describe('tcp-socket websocket proxy', function () {
    it('should send hostname in onopen', function () {
      socketStub.onopen({
        data: {
          proxyHostname: 'hostname.io' // hostname of the socket.io proxy in tcp-socket
        }
      })

      expect(smtp.options.name).to.equal('hostname.io')
    })
  })

  describe('#connect', function () {
    it('should not throw', function () {
      let client = new SmtpClient(host, port)
      TCPSocket = {
        open: function () {
          let socket = {
            onopen: function () { },
            onerror: function () { }
          }
          // disallow setting new properties (eg. oncert)
          Object.preventExtensions(socket)
          return socket
        }
      }
      client.connect(TCPSocket)
    })
  })

  describe('#quit', function () {
    it('should send QUIT', function () {
      let _sendCommandStub = sinon.stub(smtp, '_sendCommand')

      smtp.quit()

      expect(_sendCommandStub.withArgs('QUIT').callCount).to.equal(1)
    })
  })

  describe('#close', function () {
    it('should close socket', function () {
      socketStub.readyState = 'open'
      smtp.close()

      expect(socketStub.close.callCount).to.equal(1)
    })

    it('should call _destroy', function () {
      sinon.stub(smtp, '_destroy')

      socketStub.readyState = ''
      smtp.close()
      expect(smtp._destroy.callCount).to.equal(1)
    })
  })

  describe('#useEnvelope', function () {
    it('should send MAIL FROM', function () {
      let envelope = {
        from: 'ft',
        to: ['tt']
      }
      let _sendCommandStub = sinon.stub(smtp, '_sendCommand')

      smtp.useEnvelope(envelope)

      expect(_sendCommandStub.withArgs('MAIL FROM:<ft>').callCount).to.equal(1)
      expect(smtp._envelope.from).to.deep.equal(envelope.from)
      expect(smtp._envelope.to).to.deep.equal(envelope.to)
    })
  })

  describe('#send', function () {
    it('should do nothing if not data mode', function () {
      smtp._dataMode = false
      smtp.send()

      expect(socketStub.send.callCount).to.equal(0)
    })

    it('should send data to socket', function () {
      let _sendStringStub = sinon.stub(smtp, '_sendString')

      smtp._dataMode = true
      smtp.send('abcde')

      expect(_sendStringStub.withArgs('abcde').callCount).to.equal(1)
    })
  })

  describe('#end', function () {
    it('should do nothing if not data mode', function () {
      smtp._dataMode = false
      smtp.send()

      expect(socketStub.send.callCount).to.equal(0)
    })

    it('should send a dot in a separate line', function () {
      smtp._dataMode = true
      smtp.end()

      expect(socketStub.send.callCount).to.equal(1)
      expect(socketStub.send.args[0][0]).to.deep.equal(
        new Uint8Array([13, 10, 46, 13, 10]).buffer) // \r\n.\r\n
    })
  })

  describe('#_parse', function () {
    it('should parse and emit a single line response', function () {
      sinon.stub(smtp, '_onCommand')

      smtp._parse('250 1.1.1 Ok\r\n')
      expect(smtp._onCommand.withArgs({
        statusCode: 250,
        enhancedStatus: '1.1.1',
        data: 'Ok',
        line: '250 1.1.1 Ok',
        success: true
      }).callCount).to.equal(1)
    })

    it('should parse and emit a multi line response', function () {
      sinon.stub(smtp, '_onCommand')

      smtp._parse('250-Ok 1\r\n')
      smtp._parse('250-Ok 2\r\n')
      smtp._parse('250 Ok 3\r\n')

      expect(smtp._onCommand.withArgs({
        statusCode: 250,
        enhancedStatus: null,
        data: 'Ok 1\nOk 2\nOk 3',
        line: '250-Ok 1\n250-Ok 2\n250 Ok 3',
        success: true
      }).callCount).to.equal(1)
    })
  })

  describe('#_onData', function () {
    it('should decode and send chunk to parser', function () {
      sinon.stub(smtp, '_parse')

      smtp._onData({
        data: new Uint8Array([97, 98, 99]).buffer // abc
      })

      expect(smtp._parse.withArgs('abc').callCount).to.equal(1)
    })
  })

  describe('#_onDrain', function () {
    it('should emit ondrain', function () {
      let _ondrainStub = sinon.stub(smtp, 'ondrain')

      smtp._onDrain()

      expect(_ondrainStub.callCount).to.equal(1)
    })
  })

  describe('#_onError', function () {
    it('should emit onerror and close connection', function () {
      let _onerrorStub = sinon.stub(smtp, 'onerror')
      let _closeStub = sinon.stub(smtp, 'close')
      let err = new Error('abc')

      smtp._onError({
        data: err
      })

      expect(_onerrorStub.withArgs(err).callCount).to.equal(1)
      expect(_closeStub.callCount).to.equal(1)
    })
  })

  describe('#_onClose', function () {
    it('should call _destroy', function () {
      let _destroyStub = sinon.stub(smtp, '_destroy')

      smtp._onClose()

      expect(_destroyStub.callCount).to.equal(1)
    })
  })

  describe('#_onCommand', function () {
    it('should run stored handler', function () {
      let _commandStub = sinon.stub()
      let cmd = 'abc'

      smtp._currentAction = _commandStub
      smtp._onCommand(cmd)

      expect(_commandStub.withArgs(cmd).callCount).to.equal(1)
    })
  })

  describe('#_destroy', function () {
    it('should do nothing if already destroyed', function () {
      let _oncloseStub = sinon.stub(smtp, 'onclose')

      smtp.destroyed = true
      smtp._destroy()

      expect(_oncloseStub.callCount).to.equal(0)
    })

    it('should emit onclose if not destroyed yet', function () {
      let _oncloseStub = sinon.stub(smtp, 'onclose')

      smtp.destroyed = false
      smtp._destroy()

      expect(_oncloseStub.callCount).to.equal(1)
    })
  })

  describe('#_sendCommand', function () {
    it('should convert string to ArrayBuffer and send to socket', function () {
      smtp._sendCommand('abc')

      expect(socketStub.send.args[0][0]).to.deep.equal(
        new Uint8Array([97, 98, 99, 13, 10]).buffer) // abc\r\n
    })
  })

  describe('_authenticateUser', function () {
    it('should emit onidle if no auth info', function () {
      let _onidleStub = sinon.stub(smtp, 'onidle')

      smtp.options.auth = false
      smtp._authenticateUser()

      expect(_onidleStub.callCount).to.equal(1)
      expect(smtp._currentAction).to.equal(smtp._actionIdle)
    })

    it('should use AUTH PLAIN by default', function () {
      let _sendCommandStub = sinon.stub(smtp, '_sendCommand')

      smtp.options.auth = {
        user: 'abc',
        pass: 'def'
      }
      smtp._supportedAuth = []
      smtp._authenticateUser()

      expect(_sendCommandStub.withArgs('AUTH PLAIN AGFiYwBkZWY=').callCount).to.equal(1)
      expect(smtp._currentAction).to.equal(smtp._actionAUTHComplete)
    })

    it('should use AUTH LOGIN if specified', function () {
      let _sendCommandStub = sinon.stub(smtp, '_sendCommand')

      smtp.options.auth = {
        user: 'abc',
        pass: 'def'
      }
      smtp._supportedAuth = []
      smtp.options.authMethod = 'LOGIN'
      smtp._authenticateUser()

      expect(_sendCommandStub.withArgs('AUTH LOGIN').callCount).to.equal(1)
      expect(smtp._currentAction).to.equal(smtp._actionAUTH_LOGIN_USER)
    })

    it('should use AUTH XOAUTH2 if specified', function () {
      let _sendCommandStub = sinon.stub(smtp, '_sendCommand')

      smtp.options.auth = {
        user: 'abc',
        xoauth2: 'def'
      }
      smtp._supportedAuth = ['XOAUTH2']
      smtp._authenticateUser()

      expect(_sendCommandStub.withArgs('AUTH XOAUTH2 dXNlcj1hYmMBYXV0aD1CZWFyZXIgZGVmAQE=').callCount).to.equal(1)
      expect(smtp._currentAction).to.equal(smtp._actionAUTH_XOAUTH2)
    })
  })

  describe('#_actionGreeting', function () {
    it('should fail if response is not 220', function () {
      let _onErrorStub = sinon.stub(smtp, '_onError')

      smtp._actionGreeting({
        statusCode: 500,
        data: 'test'
      })

      expect(_onErrorStub.calledOnce).to.be.true
      expect(_onErrorStub.args[0][0].message).to.deep.equal('Invalid greeting: test')
    })

    it('should send EHLO on greeting', function () {
      let _sendCommandStub = sinon.stub(smtp, '_sendCommand')

      smtp.options.name = 'abc'
      smtp._actionGreeting({
        statusCode: 220,
        data: 'test'
      })

      expect(_sendCommandStub.withArgs('EHLO abc').callCount).to.equal(1)
      expect(smtp._currentAction).to.equal(smtp._actionEHLO)
    })

    it('should send LHLO on greeting', function () {
      let _sendCommandStub = sinon.stub(smtp, '_sendCommand')

      smtp.options.name = 'abc'
      smtp.options.lmtp = true
      smtp._actionGreeting({
        statusCode: 220,
        data: 'test'
      })

      expect(_sendCommandStub.withArgs('LHLO abc').callCount).to.equal(1)
      expect(smtp._currentAction).to.equal(smtp._actionLHLO)
    })
  })

  describe('#_actionLHLO', function () {
    it('should proceed to EHLO', function () {
      let _actionEHLOStub = sinon.stub(smtp, '_actionEHLO')

      smtp.options.name = 'abc'
      smtp._actionLHLO({
        success: true,
        line: '250-AUTH PLAIN LOGIN'
      })

      expect(_actionEHLOStub.callCount).to.equal(1)
    })
  })

  describe('#_actionEHLO', function () {
    it('should fallback to HELO on error', function () {
      let _sendCommandStub = sinon.stub(smtp, '_sendCommand')

      smtp.options.name = 'abc'
      smtp._actionEHLO({
        success: false
      })

      expect(_sendCommandStub.withArgs('HELO abc').callCount).to.equal(1)
      expect(smtp._currentAction).to.equal(smtp._actionHELO)
    })

    it('should proceed to authentication', function () {
      let _authenticateUserStub = sinon.stub(smtp, '_authenticateUser')

      smtp._actionEHLO({
        success: true,
        line: '250-AUTH PLAIN LOGIN'
      })

      expect(_authenticateUserStub.callCount).to.equal(1)
      expect(smtp._supportedAuth).to.deep.equal(['PLAIN', 'LOGIN'])
    })

    it('should proceed to starttls', function () {
      let _sendCommandStub = sinon.stub(smtp, '_sendCommand')

      smtp._secureMode = false
      smtp._actionEHLO({
        success: true,
        line: '250-STARTTLS'
      })

      expect(_sendCommandStub.withArgs('STARTTLS').callCount).to.equal(1)

      expect(smtp._currentAction).to.equal(smtp._actionSTARTTLS)
    })
  })

  describe('#_actionHELO', function () {
    it('should proceed to authentication', function () {
      let _authenticateUserStub = sinon.stub(smtp, '_authenticateUser')

      smtp._actionHELO({
        success: true
      })

      expect(_authenticateUserStub.callCount).to.equal(1)
    })
  })

  describe('#_actionSTARTTLS', function () {
    it('should upgrade connection', function () {
      let _sendCommandStub = sinon.stub(smtp, '_sendCommand')

      smtp.options.name = 'abc'
      smtp._actionSTARTTLS({
        success: true,
        line: '220 Ready to start TLS'
      })

      expect(smtp.socket.upgradeToSecure.callCount).to.equal(1)
      expect(_sendCommandStub.withArgs('EHLO abc').callCount).to.equal(1)
      expect(smtp._currentAction).to.equal(smtp._actionEHLO)
    })
  })

  describe('#_actionAUTH_LOGIN_USER', function () {
    it('should emit error on invalid input', function () {
      let _onErrorStub = sinon.stub(smtp, '_onError')

      smtp._actionAUTH_LOGIN_USER({
        statusCode: 334, // valid status code
        data: 'test' // invalid value
      })

      expect(_onErrorStub.callCount).to.equal(1)
      expect(_onErrorStub.args[0][0] instanceof Error).to.be.true
    })

    it('should respond to server with base64 encoded username', function () {
      let _sendCommandStub = sinon.stub(smtp, '_sendCommand')

      smtp.options.auth = {
        user: 'abc',
        pass: 'def'
      }
      smtp._actionAUTH_LOGIN_USER({
        statusCode: 334,
        data: 'VXNlcm5hbWU6'
      })

      expect(_sendCommandStub.withArgs('YWJj').callCount).to.equal(1)
      expect(smtp._currentAction).to.equal(smtp._actionAUTH_LOGIN_PASS)
    })
  })

  describe('#_actionAUTH_LOGIN_PASS', function () {
    it('should emit error on invalid input', function () {
      let _onErrorStub = sinon.stub(smtp, '_onError')

      smtp._actionAUTH_LOGIN_PASS({
        statusCode: 334, // valid status code
        data: 'test' // invalid value
      })

      expect(_onErrorStub.callCount).to.equal(1)
      expect(_onErrorStub.args[0][0] instanceof Error).to.be.true
    })

    it('should respond to server with base64 encoded password', function () {
      let _sendCommandStub = sinon.stub(smtp, '_sendCommand')

      smtp.options.auth = {
        user: 'abc',
        pass: 'def'
      }
      smtp._actionAUTH_LOGIN_PASS({
        statusCode: 334,
        data: 'UGFzc3dvcmQ6'
      })

      expect(_sendCommandStub.withArgs('ZGVm').callCount).to.equal(1)
      expect(smtp._currentAction).to.equal(smtp._actionAUTHComplete)
    })
  })

  describe('#_actionAUTH_XOAUTH2', function () {
    it('should send empty response on error', function () {
      let _sendCommandStub = sinon.stub(smtp, '_sendCommand')

      smtp._actionAUTH_XOAUTH2({
        success: false
      })

      expect(_sendCommandStub.withArgs('').callCount).to.equal(1)
      expect(smtp._currentAction).to.equal(smtp._actionAUTHComplete)
    })

    it('should run _actionAUTHComplete on success', function () {
      let _actionAUTHCompleteStub = sinon.stub(smtp, '_actionAUTHComplete')

      let cmd = {
        success: true
      }
      smtp._actionAUTH_XOAUTH2(cmd)

      expect(_actionAUTHCompleteStub.withArgs(cmd).callCount).to.equal(1)
    })
  })

  describe('#_actionAUTHComplete', function () {
    it('should emit error on invalid auth', function () {
      let _onErrorStub = sinon.stub(smtp, '_onError')

      smtp._actionAUTHComplete({
        success: false,
        data: 'err'
      })

      expect(_onErrorStub.callCount).to.equal(1)
      expect(_onErrorStub.args[0][0] instanceof Error).to.be.true
    })

    it('should emit idle if auth succeeded', function () {
      let _onidleStub = sinon.stub(smtp, 'onidle')

      smtp.options.auth = {
        user: 'abc',
        pass: 'def'
      }
      smtp._actionAUTHComplete({
        success: true
      })

      expect(_onidleStub.callCount).to.equal(1)
      expect(smtp._currentAction).to.equal(smtp._actionIdle)
      expect(smtp._authenticatedAs).to.equal('abc')
    })
  })

  describe('#_actionMAIL', function () {
    it('should emit error on invalid input', function () {
      let _onErrorStub = sinon.stub(smtp, '_onError')

      smtp._actionMAIL({
        success: false,
        data: 'err'
      })

      expect(_onErrorStub.calledOnce).to.be.true
      expect(_onErrorStub.args[0][0].message).to.equal('err')
    })

    it('should emit error on empty recipient queue', function () {
      let _onErrorStub = sinon.stub(smtp, '_onError')

      smtp._envelope = {
        rcptQueue: []
      }
      smtp._actionMAIL({
        success: true
      })

      expect(_onErrorStub.callCount).to.equal(1)
      expect(_onErrorStub.args[0][0] instanceof Error).to.be.true
    })

    it('should send to the next recipient in queue', function () {
      let _sendCommandStub = sinon.stub(smtp, '_sendCommand')

      smtp._envelope = {
        rcptQueue: ['receiver']
      }
      smtp._actionMAIL({
        success: true
      })

      expect(_sendCommandStub.withArgs('RCPT TO:<receiver>').callCount).to.equal(1)
      expect(smtp._currentAction).to.equal(smtp._actionRCPT)
    })
  })

  describe('#_actionRCPT', function () {
    it('should send DATA if queue is processed', function () {
      let _sendCommandStub = sinon.stub(smtp, '_sendCommand')

      smtp._envelope = {
        to: ['abc'],
        rcptFailed: [],
        rcptQueue: [],
        responseQueue: []
      }
      smtp._actionRCPT({
        success: true
      })

      expect(_sendCommandStub.withArgs('DATA').callCount).to.equal(1)
      expect(smtp._currentAction).to.equal(smtp._actionDATA)
    })

    it('should send rerun RCPT if queue is not empty', function () {
      let _sendCommandStub = sinon.stub(smtp, '_sendCommand')

      smtp._envelope = {
        rcptQueue: ['receiver'],
        responseQueue: []
      }
      smtp._actionRCPT({
        success: true
      })

      expect(_sendCommandStub.withArgs('RCPT TO:<receiver>').callCount).to.equal(1)
      expect(smtp._currentAction).to.equal(smtp._actionRCPT)
    })

    it('should emit error if all recipients failed', function () {
      let _onErrorStub = sinon.stub(smtp, '_onError')

      smtp._envelope = {
        to: ['abc'],
        rcptFailed: ['abc'],
        rcptQueue: [],
        responseQueue: []
      }
      smtp._actionRCPT({
        success: true
      })

      expect(_onErrorStub.callCount).to.equal(1)
      expect(_onErrorStub.args[0][0] instanceof Error).to.be.true
    })
  })

  describe('#_actionDATA', function () {
    it('should emit error on invalid input', function () {
      let _onErrorStub = sinon.stub(smtp, '_onError')

      smtp._actionDATA({
        statusCode: 500,
        data: 'err'
      })

      expect(_onErrorStub.calledOnce).to.be.true
      expect(_onErrorStub.args[0][0].message).to.equal('err')
    })

    it('should emit onready on success', function () {
      let _onreadyStub = sinon.stub(smtp, 'onready')

      smtp._envelope = {
        to: ['abc'],
        rcptFailed: ['abc'],
        rcptQueue: []
      }
      smtp._actionDATA({
        statusCode: 250
      })

      expect(_onreadyStub.withArgs(['abc']).callCount).to.equal(1)
      expect(smtp._currentAction).to.equal(smtp._actionIdle)
      expect(smtp._dataMode).to.be.true
    })
  })

  describe('#_actionStream', function () {
    it('should emit ondone with argument false', function () {
      let _ondoneStub = sinon.stub(smtp, 'ondone')

      smtp._actionStream({
        success: false
      })

      expect(_ondoneStub.withArgs(false).callCount).to.equal(1)
    })

    it('should emit ondone with argument true', function () {
      let _ondoneStub = sinon.stub(smtp, 'ondone')

      smtp._actionStream({
        success: true
      })

      expect(_ondoneStub.withArgs(true).callCount).to.equal(1)
    })

    it('should emit onidle if required', function () {
      let _onidleStub = sinon.stub(smtp, 'onidle')

      smtp._currentAction = smtp._actionIdle
      smtp._actionStream({
        success: true
      })

      expect(_onidleStub.callCount).to.equal(1)
    })

    it('should cancel onidle', function () {
      let _onidleStub = sinon.stub(smtp, 'onidle')

      smtp.ondone = function () {
        this._currentAction = false
      }

      smtp._actionStream({
        success: true
      })

      expect(_onidleStub.callCount).to.equal(0)
    })

    describe('LMTP responses', function () {
      it('should receive single responses', function () {
        let _ondoneStub = sinon.stub(smtp, 'ondone')

        smtp.options.lmtp = true
        smtp._envelope = {
          responseQueue: ['abc'],
          rcptFailed: []
        }

        smtp._actionStream({
          success: false
        })

        expect(_ondoneStub.withArgs(true).callCount).to.equal(1)
        expect(smtp._envelope.rcptFailed).to.deep.equal(['abc'])
      })

      it('should wait for additional responses', function () {
        let _ondoneStub = sinon.stub(smtp, 'ondone')

        smtp.options.lmtp = true
        smtp._envelope = {
          responseQueue: ['abc', 'def', 'ghi'],
          rcptFailed: []
        }

        smtp._actionStream({
          success: false
        })

        smtp._actionStream({
          success: true
        })

        smtp._actionStream({
          success: false
        })

        expect(_ondoneStub.withArgs(true).callCount).to.equal(1)
        expect(smtp._envelope.rcptFailed).to.deep.equal(['abc', 'ghi'])
      })
    })
  })

  describe('#_buildXOAuth2Token', function () {
    it('should return base64 encoded XOAUTH2 token', function () {
      expect(smtp._buildXOAuth2Token('user@host', 'abcde')).to.equal('dXNlcj11c2VyQGhvc3QBYXV0aD1CZWFyZXIgYWJjZGUBAQ==')
    })
  })
})
