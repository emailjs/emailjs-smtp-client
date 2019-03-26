/* eslint-disable no-unused-expressions */

import SmtpClient from './client'
import { SMTPServer } from 'smtp-server'

describe('smtp-client data', function () {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  let smtp
  let port = 10001
  let server

  before(function (done) {
    server = new SMTPServer({
      port: port,
      authOptional: true
    })
    server.listen(port, done)
  })

  after(function (done) {
    server.close(done)
  })

  beforeEach(function (done) {
    smtp = new SmtpClient('127.0.0.1', port, {
      useSecureTransport: false
    })
    expect(smtp).to.exist

    smtp.connect()
    smtp.onidle = function () {
      done()
    }
  })

  it('should fail with invalid MAIL FROM', function (done) {
    smtp.onerror = function (err) {
      expect(err.message).to.include('Bad sender address syntax')
      smtp.onclose = done
    }

    smtp.useEnvelope({
      from: 'invalid',
      to: ['receiver@localhost']
    })
  })

  it('should fail with empty recipients', function (done) {
    smtp.onerror = function (err) {
      expect(err.message).to.include('Can\'t send mail - no recipients defined')
      smtp.onclose = done
    }

    smtp.useEnvelope({
      from: 'sender@example.com',
      to: []
    })
  })

  it('should fail with invalid recipients', function (done) {
    smtp.onerror = function (err) {
      expect(err.message).to.include('Can\'t send mail - all recipients were rejected')
      smtp.onclose = done
    }

    smtp.useEnvelope({
      from: 'sender@example.com',
      to: ['invalid']
    })
  })

  it('should pass RCPT TO', function (done) {
    smtp.onready = function (failed) {
      expect(failed).to.deep.equal([])
      smtp.onclose = done
      smtp.close()
    }

    smtp.useEnvelope({
      from: 'sender@example.com',
      to: ['receiver@example.com']
    })
  })

  it('should pass RCPT TO with some failures', function (done) {
    smtp.onready = function (failed) {
      expect(failed).to.deep.equal(['invalid'])
      smtp.onclose = done
      smtp.close()
    }

    smtp.useEnvelope({
      from: 'sender@example.com',
      to: ['invalid', 'receiver@example.com']
    })
  })

  it('should succeed with DATA', function (done) {
    smtp.onidle = function () {
      smtp.onclose = done
      smtp.quit()
    }

    smtp.onready = function (failedRecipients) {
      expect(failedRecipients).to.be.empty

      smtp.send('Subject: test\r\n\r\nMessage body')
      smtp.end()
    }

    smtp.ondone = function (success) {
      expect(success).to.be.true
    }

    smtp.useEnvelope({
      from: 'sender@localhost',
      to: ['receiver@localhost']
    })
  })

  it('should not idle', function (done) {
    smtp.onidle = function () {
      // should not run
      expect(true).to.be.false
    }

    smtp.onready = function (failedRecipients) {
      expect(failedRecipients).to.be.empty

      smtp.send('Subject: test\r\n\r\nMessage body')
      smtp.end()
    }

    smtp.ondone = function (success) {
      expect(success).to.be.true
      smtp.onclose = done
      smtp.quit()
    }

    smtp.useEnvelope({
      from: 'sender@localhost',
      to: ['receiver@localhost']
    })
  })

  it('should timeout', function (done) {
    let errored = false

    smtp.onerror = function () {
      errored = true
    }

    smtp.onclose = function () {
      expect(errored).to.be.true
      done()
    }

    smtp.onready = function (failedRecipients) {
      expect(failedRecipients).to.be.empty

      // remove the ondata event to simulate 100% packet loss and make the socket time out after 10ms
      smtp.timeoutSocketLowerBound = 10
      smtp.timeoutSocketMultiplier = 0
      smtp.socket.ondata = function () { }

      smtp.send('Subject: test\r\n\r\nMessage body') // trigger write
    }

    smtp.onidle = smtp.ondone = function () {
      // should not happen
      expect(true).to.be.false
    }

    smtp.useEnvelope({
      from: 'sender@localhost',
      to: ['receiver@localhost']
    })
  })
})

describe('smtp-client authentication', function () {
  let port = 10001
  let server

  before(function (done) {
    server = new SMTPServer({
      port: port,
      closeTimeout: 10,
      allowInsecureAuth: true,
      authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2'],
      onAuth (auth, session, callback) {
        if (auth.method === 'PLAIN' && auth.username === 'abc' && auth.password === 'def') {
          callback(null, { user: 123 })
        } else if (auth.method === 'LOGIN' && auth.username === 'abc' && auth.password === 'def') {
          callback(null, { user: 123 })
        } else if (auth.method === 'XOAUTH2' && auth.username === 'abc' && auth.accessToken === 'def') {
          callback(null, {
            data: {
              status: '401',
              schemes: 'bearer mac',
              scope: 'my_smtp_access_scope_name'
            }
          })
        }
        callback(new Error('wrong user'))
      }
    })
    server.listen(port, done)
  })

  after(function (done) {
    server.close(done)
  })

  it('should authenticate with default method', function (done) {
    let smtp = new SmtpClient('127.0.0.1', port, {
      useSecureTransport: false,
      auth: {
        user: 'abc',
        pass: 'def'
      }
    })
    expect(smtp).to.exist

    smtp.connect()
    smtp.onidle = function () {
      smtp.onclose = done
      setTimeout(() => { smtp.quit() }, 123)
    }
  })

  it('should authenticate with AUTH LOGIN', function (done) {
    let smtp = new SmtpClient('127.0.0.1', port, {
      useSecureTransport: false,
      auth: {
        user: 'abc',
        pass: 'def'
      },
      authMethod: 'LOGIN'
    })
    expect(smtp).to.exist

    smtp.connect()
    smtp.onidle = function () {
      smtp.onclose = done
      setTimeout(() => { smtp.quit() }, 123)
    }
  })

  it('should fail with invalid credentials', function (done) {
    let smtp = new SmtpClient('127.0.0.1', port, {
      useSecureTransport: false,
      auth: {
        user: 'abcd',
        pass: 'defe'
      },
      authMethod: 'LOGIN'
    })
    expect(smtp).to.exist

    smtp.connect()
    smtp.onerror = function () {
      smtp.onclose = done
    }
  })
})

describe('smtp-client STARTTLS encryption', function () {
  let port = 10001
  let server

  before(function (done) {
    server = new SMTPServer({
      port: port,
      authOptional: true
    })
    server.listen(port, done)
  })

  after(function (done) {
    server.close(done)
  })

  it('should connect insecurely', function (done) {
    let smtp = new SmtpClient('127.0.0.1', port, {
      useSecureTransport: false,
      ignoreTLS: true
    })
    expect(smtp).to.exist

    smtp.connect()
    smtp.onidle = function () {
      expect(smtp._secureMode).to.be.false
      smtp.onclose = done
      setTimeout(() => { smtp.quit() }, 123)
    }
  })

  it('should connect securely', function (done) {
    let smtp = new SmtpClient('127.0.0.1', port, {
      useSecureTransport: false
    })
    expect(smtp).to.exist

    smtp.connect()
    smtp.onidle = function () {
      expect(smtp._secureMode).to.be.true
      smtp.onclose = done
      setTimeout(() => { smtp.quit() }, 123)
    }
  })
})
