'use strict';

var _ = require('..');

var _2 = _interopRequireDefault(_);

var _simplesmtp = require('simplesmtp');

var _simplesmtp2 = _interopRequireDefault(_simplesmtp);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

/* eslint-disable no-unused-expressions */

describe('smtpclient node integration tests', function () {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  var smtp;
  var port = 10001;
  var server;

  before(function (done) {
    // start smtp test server
    var options = {
      debug: false,
      disableDNSValidation: true,
      port: port,
      enableAuthentication: true,
      secureConnection: false
    };

    server = _simplesmtp2.default.createServer(options);
    server.on('startData', function () /* connection */{});
    server.on('data', function () /* connection, chunk */{});
    server.on('dataReady', function (connection, callback) {
      callback(null, 'foo');
    });
    server.on('authorizeUser', function (connection, username, password, callback) {
      callback(null, username === 'abc' && password === 'def');
    });
    server.listen(options.port, done);
  });

  after(function (done) {
    // close smtp test server
    server.end(done);
  });

  beforeEach(function (done) {
    smtp = new _2.default('127.0.0.1', port, {
      useSecureTransport: false
    });
    smtp.logLevel = smtp.LOG_LEVEL_NONE;
    expect(smtp).to.exist;

    smtp.connect();
    smtp.onidle = function () {
      done();
    };
  });

  it('should fail with invalid MAIL FROM', function (done) {
    smtp.onerror = function (err) {
      expect(err.message).to.equal('Bad sender address syntax');
      smtp.onclose = done;
    };

    smtp.useEnvelope({
      from: 'invalid',
      to: ['receiver@localhost']
    });
  });

  it('should fail with empty recipients', function (done) {
    smtp.onerror = function (err) {
      expect(err.message).to.equal('Can\'t send mail - no recipients defined');
      smtp.onclose = done;
    };

    smtp.useEnvelope({
      from: 'sender@example.com',
      to: []
    });
  });

  it('should fail with invalid recipients', function (done) {
    smtp.onerror = function (err) {
      expect(err.message).to.equal('Can\'t send mail - all recipients were rejected');
      smtp.onclose = done;
    };

    smtp.useEnvelope({
      from: 'sender@example.com',
      to: ['invalid']
    });
  });

  it('should pass RCPT TO', function (done) {
    smtp.onready = function (failed) {
      expect(failed).to.deep.equal([]);
      smtp.onclose = done;
      smtp.close();
    };

    smtp.useEnvelope({
      from: 'sender@example.com',
      to: ['receiver@example.com']
    });
  });

  it('should pass RCPT TO with some failures', function (done) {
    smtp.onready = function (failed) {
      expect(failed).to.deep.equal(['invalid']);
      smtp.onclose = done;
      smtp.close();
    };

    smtp.useEnvelope({
      from: 'sender@example.com',
      to: ['invalid', 'receiver@example.com']
    });
  });

  it('should succeed with DATA', function (done) {
    smtp.onidle = function () {
      smtp.onclose = done;
      smtp.quit();
    };

    smtp.onready = function (failedRecipients) {
      expect(failedRecipients).to.be.empty;

      smtp.send('Subject: test\r\n\r\nMessage body');
      smtp.end();
    };

    smtp.ondone = function (success) {
      expect(success).to.be.true;
    };

    smtp.useEnvelope({
      from: 'sender@localhost',
      to: ['receiver@localhost']
    });
  });

  it('should not idle', function (done) {
    smtp.onidle = function () {
      // should not run
      expect(true).to.be.false;
    };

    smtp.onready = function (failedRecipients) {
      expect(failedRecipients).to.be.empty;

      smtp.send('Subject: test\r\n\r\nMessage body');
      smtp.end();
    };

    smtp.ondone = function (success) {
      expect(success).to.be.true;
      smtp.onclose = done;
      smtp.quit();
    };

    smtp.useEnvelope({
      from: 'sender@localhost',
      to: ['receiver@localhost']
    });
  });

  it('shoud timeout', function (done) {
    var errored = false;

    smtp.onerror = function () {
      errored = true;
    };

    smtp.onclose = function () {
      expect(errored).to.be.true;
      done();
    };

    smtp.onready = function (failedRecipients) {
      expect(failedRecipients).to.be.empty;

      // remove the ondata event to simulate 100% packet loss and make the socket time out after 10ms
      smtp.TIMEOUT_SOCKET_LOWER_BOUND = 10;
      smtp.TIMEOUT_SOCKET_MULTIPLIER = 0;
      smtp.socket.ondata = function () {};

      smtp.send('Subject: test\r\n\r\nMessage body'); // trigger write
    };

    smtp.onidle = smtp.ondone = function () {
      // should not happen
      expect(true).to.be.false;
    };

    smtp.useEnvelope({
      from: 'sender@localhost',
      to: ['receiver@localhost']
    });
  });
});

describe('smtpclient authentication tests', function () {
  var port = 10001;
  var server;

  before(function (done) {
    // start smtp test server
    var options = {
      debug: false,
      disableDNSValidation: true,
      port: port,
      enableAuthentication: true,
      secureConnection: false,
      ignoreTLS: false,
      authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2']
    };

    server = _simplesmtp2.default.createServer(options);
    server.on('startData', function () /* connection */{});
    server.on('data', function () /* connection, chunk */{});
    server.on('dataReady', function (connection, callback) {
      callback(null, 'foo');
    });
    server.on('authorizeUser', function (connection, username, password, callback) {
      callback(null, username === 'abc' && password === 'def');
    });
    server.listen(options.port, done);
  });

  after(function (done) {
    // close smtp test server
    server.end(done);
  });

  it('should authenticate with default method', function (done) {
    var smtp = new _2.default('127.0.0.1', port, {
      useSecureTransport: false,
      auth: {
        user: 'abc',
        pass: 'def'
      }
    });
    smtp.logLevel = smtp.LOG_LEVEL_NONE;
    expect(smtp).to.exist;

    smtp.connect();
    smtp.onidle = function () {
      smtp.onclose = done;
      smtp.quit();
    };
  });

  it('should authenticate with AUTH LOGIN', function (done) {
    var smtp = new _2.default('127.0.0.1', port, {
      useSecureTransport: false,
      auth: {
        user: 'abc',
        pass: 'def'
      },
      authMethod: 'LOGIN'
    });
    smtp.logLevel = smtp.LOG_LEVEL_NONE;
    expect(smtp).to.exist;

    smtp.connect();
    smtp.onidle = function () {
      smtp.onclose = done;
      smtp.quit();
    };
  });

  it('should fail with invalid credentials', function (done) {
    var smtp = new _2.default('127.0.0.1', port, {
      useSecureTransport: false,
      auth: {
        user: 'abcd',
        pass: 'defe'
      },
      authMethod: 'LOGIN'
    });
    smtp.logLevel = smtp.LOG_LEVEL_NONE;
    expect(smtp).to.exist;

    smtp.connect();
    smtp.onerror = function () {
      smtp.onclose = done;
    };
  });

  it('should authenticate with AUTH XOAUTH2 and send a message', function (done) {
    var smtp = new _2.default('127.0.0.1', port, {
      useSecureTransport: false,
      auth: {
        user: 'abc',
        xoauth2: 'def'
      }
    });
    smtp.logLevel = smtp.LOG_LEVEL_NONE;
    expect(smtp).to.exist;

    smtp.connect();
    smtp.onidle = function () {
      smtp.onidle = function () {
        smtp.onclose = done;
        smtp.quit();
      };

      smtp.onready = function (failedRecipients) {
        expect(failedRecipients).to.be.empty;

        smtp.send('Subject: test\r\n\r\nMessage body');
        smtp.end();
      };

      smtp.ondone = function (success) {
        expect(success).to.be.true;
      };

      smtp.useEnvelope({
        from: 'sender@localhost',
        to: ['receiver@localhost']
      });
    };
  });

  it('should fail with AUTH XOAUTH2', function (done) {
    var smtp = new _2.default('127.0.0.1', port, {
      useSecureTransport: false,
      auth: {
        user: 'abc',
        xoauth2: 'ghi'
      }
    });
    smtp.logLevel = smtp.LOG_LEVEL_NONE;
    expect(smtp).to.exist;

    smtp.connect();
    smtp.onerror = function () {
      smtp.onclose = done;
    };
  });
});

describe('smtpclient STARTTLS tests', function () {
  var port = 10001;
  var server;

  describe('STARTTLS is supported', function () {
    before(function (done) {
      // start smtp test server
      var options = {
        debug: false,
        disableDNSValidation: true,
        port: port,
        enableAuthentication: true,
        secureConnection: false,
        ignoreTLS: true,
        authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2']
      };

      server = _simplesmtp2.default.createServer(options);
      server.on('startData', function () /* connection */{});
      server.on('data', function () /* connection, chunk */{});
      server.on('dataReady', function (connection, callback) {
        callback(null, 'foo');
      });
      server.on('authorizeUser', function (connection, username, password, callback) {
        callback(null, username === 'abc' && password === 'def');
      });
      server.listen(options.port, done);
    });

    after(function (done) {
      // close smtp test server
      server.end(done);
    });

    it('should connect insecurely', function (done) {
      var smtp = new _2.default('127.0.0.1', port, {
        useSecureTransport: false,
        auth: {
          user: 'abc',
          pass: 'def'
        },
        ignoreTLS: true
      });
      smtp.logLevel = smtp.LOG_LEVEL_NONE;
      expect(smtp).to.exist;

      smtp.connect();
      smtp.onidle = function () {
        expect(smtp._secureMode).to.be.false;
        smtp.onclose = done;
        smtp.quit();
      };
    });

    it('should connect securely', function (done) {
      var smtp = new _2.default('127.0.0.1', port, {
        useSecureTransport: false,
        auth: {
          user: 'abc',
          pass: 'def'
        }
      });
      smtp.logLevel = smtp.LOG_LEVEL_NONE;
      expect(smtp).to.exist;

      smtp.connect();
      smtp.onidle = function () {
        expect(smtp._secureMode).to.be.true;
        smtp.onclose = done;
        smtp.quit();
      };
    });
  });

  describe('STARTTLS is disabled', function () {
    before(function (done) {
      // start smtp test server
      var options = {
        debug: false,
        disableDNSValidation: true,
        port: port,
        enableAuthentication: true,
        secureConnection: false,
        ignoreTLS: true,
        authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2'],
        disableSTARTTLS: true
      };

      server = _simplesmtp2.default.createServer(options);
      server.on('startData', function () /* connection */{});
      server.on('data', function () /* connection, chunk */{});
      server.on('dataReady', function (connection, callback) {
        callback(null, 'foo');
      });
      server.on('authorizeUser', function (connection, username, password, callback) {
        callback(null, username === 'abc' && password === 'def');
      });
      server.listen(options.port, done);
    });

    after(function (done) {
      // close smtp test server
      server.end(done);
    });

    it('should connect insecurely', function (done) {
      var smtp = new _2.default('127.0.0.1', port, {
        useSecureTransport: false,
        auth: {
          user: 'abc',
          pass: 'def'
        }
      });
      smtp.logLevel = smtp.LOG_LEVEL_NONE;
      expect(smtp).to.exist;

      smtp.connect();
      smtp.onidle = function () {
        expect(smtp._secureMode).to.be.false;
        smtp.onclose = done;
        smtp.quit();
      };
    });

    it('should fail connecting to insecure server', function (done) {
      var smtp = new _2.default('127.0.0.1', port, {
        useSecureTransport: false,
        auth: {
          user: 'abc',
          pass: 'def'
        },
        requireTLS: true
      });
      smtp.logLevel = smtp.LOG_LEVEL_NONE;
      expect(smtp).to.exist;

      smtp.connect();

      smtp.onerror = function (err) {
        expect(err).to.exist;
        expect(smtp._secureMode).to.be.false;
        smtp.onclose = done;
        smtp.quit();
      };
    });
  });

  describe('no STARTTLS because no EHLO, only HELO', function () {
    before(function (done) {
      // start smtp test server
      var options = {
        debug: false,
        disableDNSValidation: true,
        port: port,
        enableAuthentication: true,
        secureConnection: false,
        disableEHLO: true,
        ignoreTLS: true,
        authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2'],
        disableSTARTTLS: true
      };

      server = _simplesmtp2.default.createServer(options);
      server.on('startData', function () /* connection */{});
      server.on('data', function () /* connection, chunk */{});
      server.on('dataReady', function (connection, callback) {
        callback(null, 'foo');
      });
      server.on('authorizeUser', function (connection, username, password, callback) {
        callback(null, username === 'abc' && password === 'def');
      });
      server.listen(options.port, done);
    });

    after(function (done) {
      // close smtp test server
      server.end(done);
    });

    it('should fail connecting to insecure server', function (done) {
      var smtp = new _2.default('127.0.0.1', port, {
        useSecureTransport: false,
        auth: {
          user: 'abc',
          pass: 'def'
        },
        requireTLS: true
      });
      smtp.logLevel = smtp.LOG_LEVEL_NONE;
      expect(smtp).to.exist;

      smtp.connect();

      smtp.onerror = function (err) {
        expect(err).to.exist;
        expect(err.message).to.equal('STARTTLS not supported without EHLO');
        expect(smtp._secureMode).to.be.false;
        smtp.onclose = done;
        smtp.quit();
      };
    });
  });
});
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9jbGllbnQtaW50ZWdyYXRpb24uanMiXSwibmFtZXMiOlsiZGVzY3JpYmUiLCJwcm9jZXNzIiwiZW52IiwiTk9ERV9UTFNfUkVKRUNUX1VOQVVUSE9SSVpFRCIsInNtdHAiLCJwb3J0Iiwic2VydmVyIiwiYmVmb3JlIiwiZG9uZSIsIm9wdGlvbnMiLCJkZWJ1ZyIsImRpc2FibGVETlNWYWxpZGF0aW9uIiwiZW5hYmxlQXV0aGVudGljYXRpb24iLCJzZWN1cmVDb25uZWN0aW9uIiwiY3JlYXRlU2VydmVyIiwib24iLCJjb25uZWN0aW9uIiwiY2FsbGJhY2siLCJ1c2VybmFtZSIsInBhc3N3b3JkIiwibGlzdGVuIiwiYWZ0ZXIiLCJlbmQiLCJiZWZvcmVFYWNoIiwidXNlU2VjdXJlVHJhbnNwb3J0IiwibG9nTGV2ZWwiLCJMT0dfTEVWRUxfTk9ORSIsImV4cGVjdCIsInRvIiwiZXhpc3QiLCJjb25uZWN0Iiwib25pZGxlIiwiaXQiLCJvbmVycm9yIiwiZXJyIiwibWVzc2FnZSIsImVxdWFsIiwib25jbG9zZSIsInVzZUVudmVsb3BlIiwiZnJvbSIsIm9ucmVhZHkiLCJmYWlsZWQiLCJkZWVwIiwiY2xvc2UiLCJxdWl0IiwiZmFpbGVkUmVjaXBpZW50cyIsImJlIiwiZW1wdHkiLCJzZW5kIiwib25kb25lIiwic3VjY2VzcyIsInRydWUiLCJmYWxzZSIsImVycm9yZWQiLCJUSU1FT1VUX1NPQ0tFVF9MT1dFUl9CT1VORCIsIlRJTUVPVVRfU09DS0VUX01VTFRJUExJRVIiLCJzb2NrZXQiLCJvbmRhdGEiLCJpZ25vcmVUTFMiLCJhdXRoTWV0aG9kcyIsImF1dGgiLCJ1c2VyIiwicGFzcyIsImF1dGhNZXRob2QiLCJ4b2F1dGgyIiwiX3NlY3VyZU1vZGUiLCJkaXNhYmxlU1RBUlRUTFMiLCJyZXF1aXJlVExTIiwiZGlzYWJsZUVITE8iXSwibWFwcGluZ3MiOiI7O0FBRUE7Ozs7QUFDQTs7Ozs7O0FBSEE7O0FBS0FBLFNBQVMsbUNBQVQsRUFBOEMsWUFBWTtBQUN4REMsVUFBUUMsR0FBUixDQUFZQyw0QkFBWixHQUEyQyxHQUEzQzs7QUFFQSxNQUFJQyxJQUFKO0FBQ0EsTUFBSUMsT0FBTyxLQUFYO0FBQ0EsTUFBSUMsTUFBSjs7QUFFQUMsU0FBTyxVQUFVQyxJQUFWLEVBQWdCO0FBQ2pCO0FBQ0osUUFBSUMsVUFBVTtBQUNaQyxhQUFPLEtBREs7QUFFWkMsNEJBQXNCLElBRlY7QUFHWk4sWUFBTUEsSUFITTtBQUlaTyw0QkFBc0IsSUFKVjtBQUtaQyx3QkFBa0I7QUFMTixLQUFkOztBQVFBUCxhQUFTLHFCQUFXUSxZQUFYLENBQXdCTCxPQUF4QixDQUFUO0FBQ0FILFdBQU9TLEVBQVAsQ0FBVSxXQUFWLEVBQXVCLFlBQVUsZ0JBQWtCLENBQUUsQ0FBckQ7QUFDQVQsV0FBT1MsRUFBUCxDQUFVLE1BQVYsRUFBa0IsWUFBVSx1QkFBeUIsQ0FBRSxDQUF2RDtBQUNBVCxXQUFPUyxFQUFQLENBQVUsV0FBVixFQUF1QixVQUFVQyxVQUFWLEVBQXNCQyxRQUF0QixFQUFnQztBQUNyREEsZUFBUyxJQUFULEVBQWUsS0FBZjtBQUNELEtBRkQ7QUFHQVgsV0FBT1MsRUFBUCxDQUFVLGVBQVYsRUFBMkIsVUFBVUMsVUFBVixFQUFzQkUsUUFBdEIsRUFBZ0NDLFFBQWhDLEVBQTBDRixRQUExQyxFQUFvRDtBQUM3RUEsZUFBUyxJQUFULEVBQWVDLGFBQWEsS0FBYixJQUFzQkMsYUFBYSxLQUFsRDtBQUNELEtBRkQ7QUFHQWIsV0FBT2MsTUFBUCxDQUFjWCxRQUFRSixJQUF0QixFQUE0QkcsSUFBNUI7QUFDRCxHQXBCRDs7QUFzQkFhLFFBQU0sVUFBVWIsSUFBVixFQUFnQjtBQUNoQjtBQUNKRixXQUFPZ0IsR0FBUCxDQUFXZCxJQUFYO0FBQ0QsR0FIRDs7QUFLQWUsYUFBVyxVQUFVZixJQUFWLEVBQWdCO0FBQ3pCSixXQUFPLGVBQWUsV0FBZixFQUE0QkMsSUFBNUIsRUFBa0M7QUFDdkNtQiwwQkFBb0I7QUFEbUIsS0FBbEMsQ0FBUDtBQUdBcEIsU0FBS3FCLFFBQUwsR0FBZ0JyQixLQUFLc0IsY0FBckI7QUFDQUMsV0FBT3ZCLElBQVAsRUFBYXdCLEVBQWIsQ0FBZ0JDLEtBQWhCOztBQUVBekIsU0FBSzBCLE9BQUw7QUFDQTFCLFNBQUsyQixNQUFMLEdBQWMsWUFBWTtBQUN4QnZCO0FBQ0QsS0FGRDtBQUdELEdBWEQ7O0FBYUF3QixLQUFHLG9DQUFILEVBQXlDLFVBQVV4QixJQUFWLEVBQWdCO0FBQ3ZESixTQUFLNkIsT0FBTCxHQUFlLFVBQVVDLEdBQVYsRUFBZTtBQUM1QlAsYUFBT08sSUFBSUMsT0FBWCxFQUFvQlAsRUFBcEIsQ0FBdUJRLEtBQXZCLENBQTZCLDJCQUE3QjtBQUNBaEMsV0FBS2lDLE9BQUwsR0FBZTdCLElBQWY7QUFDRCxLQUhEOztBQUtBSixTQUFLa0MsV0FBTCxDQUFpQjtBQUNmQyxZQUFNLFNBRFM7QUFFZlgsVUFBSSxDQUFDLG9CQUFEO0FBRlcsS0FBakI7QUFJRCxHQVZEOztBQVlBSSxLQUFHLG1DQUFILEVBQXdDLFVBQVV4QixJQUFWLEVBQWdCO0FBQ3RESixTQUFLNkIsT0FBTCxHQUFlLFVBQVVDLEdBQVYsRUFBZTtBQUM1QlAsYUFBT08sSUFBSUMsT0FBWCxFQUFvQlAsRUFBcEIsQ0FBdUJRLEtBQXZCLENBQTZCLDBDQUE3QjtBQUNBaEMsV0FBS2lDLE9BQUwsR0FBZTdCLElBQWY7QUFDRCxLQUhEOztBQUtBSixTQUFLa0MsV0FBTCxDQUFpQjtBQUNmQyxZQUFNLG9CQURTO0FBRWZYLFVBQUk7QUFGVyxLQUFqQjtBQUlELEdBVkQ7O0FBWUFJLEtBQUcscUNBQUgsRUFBMEMsVUFBVXhCLElBQVYsRUFBZ0I7QUFDeERKLFNBQUs2QixPQUFMLEdBQWUsVUFBVUMsR0FBVixFQUFlO0FBQzVCUCxhQUFPTyxJQUFJQyxPQUFYLEVBQW9CUCxFQUFwQixDQUF1QlEsS0FBdkIsQ0FBNkIsaURBQTdCO0FBQ0FoQyxXQUFLaUMsT0FBTCxHQUFlN0IsSUFBZjtBQUNELEtBSEQ7O0FBS0FKLFNBQUtrQyxXQUFMLENBQWlCO0FBQ2ZDLFlBQU0sb0JBRFM7QUFFZlgsVUFBSSxDQUFDLFNBQUQ7QUFGVyxLQUFqQjtBQUlELEdBVkQ7O0FBWUFJLEtBQUcscUJBQUgsRUFBMEIsVUFBVXhCLElBQVYsRUFBZ0I7QUFDeENKLFNBQUtvQyxPQUFMLEdBQWUsVUFBVUMsTUFBVixFQUFrQjtBQUMvQmQsYUFBT2MsTUFBUCxFQUFlYixFQUFmLENBQWtCYyxJQUFsQixDQUF1Qk4sS0FBdkIsQ0FBNkIsRUFBN0I7QUFDQWhDLFdBQUtpQyxPQUFMLEdBQWU3QixJQUFmO0FBQ0FKLFdBQUt1QyxLQUFMO0FBQ0QsS0FKRDs7QUFNQXZDLFNBQUtrQyxXQUFMLENBQWlCO0FBQ2ZDLFlBQU0sb0JBRFM7QUFFZlgsVUFBSSxDQUFDLHNCQUFEO0FBRlcsS0FBakI7QUFJRCxHQVhEOztBQWFBSSxLQUFHLHdDQUFILEVBQTZDLFVBQVV4QixJQUFWLEVBQWdCO0FBQzNESixTQUFLb0MsT0FBTCxHQUFlLFVBQVVDLE1BQVYsRUFBa0I7QUFDL0JkLGFBQU9jLE1BQVAsRUFBZWIsRUFBZixDQUFrQmMsSUFBbEIsQ0FBdUJOLEtBQXZCLENBQTZCLENBQUMsU0FBRCxDQUE3QjtBQUNBaEMsV0FBS2lDLE9BQUwsR0FBZTdCLElBQWY7QUFDQUosV0FBS3VDLEtBQUw7QUFDRCxLQUpEOztBQU1BdkMsU0FBS2tDLFdBQUwsQ0FBaUI7QUFDZkMsWUFBTSxvQkFEUztBQUVmWCxVQUFJLENBQUMsU0FBRCxFQUFZLHNCQUFaO0FBRlcsS0FBakI7QUFJRCxHQVhEOztBQWFBSSxLQUFHLDBCQUFILEVBQStCLFVBQVV4QixJQUFWLEVBQWdCO0FBQzdDSixTQUFLMkIsTUFBTCxHQUFjLFlBQVk7QUFDeEIzQixXQUFLaUMsT0FBTCxHQUFlN0IsSUFBZjtBQUNBSixXQUFLd0MsSUFBTDtBQUNELEtBSEQ7O0FBS0F4QyxTQUFLb0MsT0FBTCxHQUFlLFVBQVVLLGdCQUFWLEVBQTRCO0FBQ3pDbEIsYUFBT2tCLGdCQUFQLEVBQXlCakIsRUFBekIsQ0FBNEJrQixFQUE1QixDQUErQkMsS0FBL0I7O0FBRUEzQyxXQUFLNEMsSUFBTCxDQUFVLG1DQUFWO0FBQ0E1QyxXQUFLa0IsR0FBTDtBQUNELEtBTEQ7O0FBT0FsQixTQUFLNkMsTUFBTCxHQUFjLFVBQVVDLE9BQVYsRUFBbUI7QUFDL0J2QixhQUFPdUIsT0FBUCxFQUFnQnRCLEVBQWhCLENBQW1Ca0IsRUFBbkIsQ0FBc0JLLElBQXRCO0FBQ0QsS0FGRDs7QUFJQS9DLFNBQUtrQyxXQUFMLENBQWlCO0FBQ2ZDLFlBQU0sa0JBRFM7QUFFZlgsVUFBSSxDQUFDLG9CQUFEO0FBRlcsS0FBakI7QUFJRCxHQXJCRDs7QUF1QkFJLEtBQUcsaUJBQUgsRUFBc0IsVUFBVXhCLElBQVYsRUFBZ0I7QUFDcENKLFNBQUsyQixNQUFMLEdBQWMsWUFBWTtBQUNsQjtBQUNOSixhQUFPLElBQVAsRUFBYUMsRUFBYixDQUFnQmtCLEVBQWhCLENBQW1CTSxLQUFuQjtBQUNELEtBSEQ7O0FBS0FoRCxTQUFLb0MsT0FBTCxHQUFlLFVBQVVLLGdCQUFWLEVBQTRCO0FBQ3pDbEIsYUFBT2tCLGdCQUFQLEVBQXlCakIsRUFBekIsQ0FBNEJrQixFQUE1QixDQUErQkMsS0FBL0I7O0FBRUEzQyxXQUFLNEMsSUFBTCxDQUFVLG1DQUFWO0FBQ0E1QyxXQUFLa0IsR0FBTDtBQUNELEtBTEQ7O0FBT0FsQixTQUFLNkMsTUFBTCxHQUFjLFVBQVVDLE9BQVYsRUFBbUI7QUFDL0J2QixhQUFPdUIsT0FBUCxFQUFnQnRCLEVBQWhCLENBQW1Ca0IsRUFBbkIsQ0FBc0JLLElBQXRCO0FBQ0EvQyxXQUFLaUMsT0FBTCxHQUFlN0IsSUFBZjtBQUNBSixXQUFLd0MsSUFBTDtBQUNELEtBSkQ7O0FBTUF4QyxTQUFLa0MsV0FBTCxDQUFpQjtBQUNmQyxZQUFNLGtCQURTO0FBRWZYLFVBQUksQ0FBQyxvQkFBRDtBQUZXLEtBQWpCO0FBSUQsR0F2QkQ7O0FBeUJBSSxLQUFHLGVBQUgsRUFBb0IsVUFBVXhCLElBQVYsRUFBZ0I7QUFDbEMsUUFBSTZDLFVBQVUsS0FBZDs7QUFFQWpELFNBQUs2QixPQUFMLEdBQWUsWUFBWTtBQUN6Qm9CLGdCQUFVLElBQVY7QUFDRCxLQUZEOztBQUlBakQsU0FBS2lDLE9BQUwsR0FBZSxZQUFZO0FBQ3pCVixhQUFPMEIsT0FBUCxFQUFnQnpCLEVBQWhCLENBQW1Ca0IsRUFBbkIsQ0FBc0JLLElBQXRCO0FBQ0EzQztBQUNELEtBSEQ7O0FBS0FKLFNBQUtvQyxPQUFMLEdBQWUsVUFBVUssZ0JBQVYsRUFBNEI7QUFDekNsQixhQUFPa0IsZ0JBQVAsRUFBeUJqQixFQUF6QixDQUE0QmtCLEVBQTVCLENBQStCQyxLQUEvQjs7QUFFTTtBQUNOM0MsV0FBS2tELDBCQUFMLEdBQWtDLEVBQWxDO0FBQ0FsRCxXQUFLbUQseUJBQUwsR0FBaUMsQ0FBakM7QUFDQW5ELFdBQUtvRCxNQUFMLENBQVlDLE1BQVosR0FBcUIsWUFBWSxDQUFFLENBQW5DOztBQUVBckQsV0FBSzRDLElBQUwsQ0FBVSxtQ0FBVixFQVJ5QyxDQVFNO0FBQ2hELEtBVEQ7O0FBV0E1QyxTQUFLMkIsTUFBTCxHQUFjM0IsS0FBSzZDLE1BQUwsR0FBYyxZQUFZO0FBQ2hDO0FBQ050QixhQUFPLElBQVAsRUFBYUMsRUFBYixDQUFnQmtCLEVBQWhCLENBQW1CTSxLQUFuQjtBQUNELEtBSEQ7O0FBS0FoRCxTQUFLa0MsV0FBTCxDQUFpQjtBQUNmQyxZQUFNLGtCQURTO0FBRWZYLFVBQUksQ0FBQyxvQkFBRDtBQUZXLEtBQWpCO0FBSUQsR0FoQ0Q7QUFpQ0QsQ0E5TEQ7O0FBZ01BNUIsU0FBUyxpQ0FBVCxFQUE0QyxZQUFZO0FBQ3RELE1BQUlLLE9BQU8sS0FBWDtBQUNBLE1BQUlDLE1BQUo7O0FBRUFDLFNBQU8sVUFBVUMsSUFBVixFQUFnQjtBQUNqQjtBQUNKLFFBQUlDLFVBQVU7QUFDWkMsYUFBTyxLQURLO0FBRVpDLDRCQUFzQixJQUZWO0FBR1pOLFlBQU1BLElBSE07QUFJWk8sNEJBQXNCLElBSlY7QUFLWkMsd0JBQWtCLEtBTE47QUFNWjZDLGlCQUFXLEtBTkM7QUFPWkMsbUJBQWEsQ0FBQyxPQUFELEVBQVUsT0FBVixFQUFtQixTQUFuQjtBQVBELEtBQWQ7O0FBVUFyRCxhQUFTLHFCQUFXUSxZQUFYLENBQXdCTCxPQUF4QixDQUFUO0FBQ0FILFdBQU9TLEVBQVAsQ0FBVSxXQUFWLEVBQXVCLFlBQVUsZ0JBQWtCLENBQUUsQ0FBckQ7QUFDQVQsV0FBT1MsRUFBUCxDQUFVLE1BQVYsRUFBa0IsWUFBVSx1QkFBeUIsQ0FBRSxDQUF2RDtBQUNBVCxXQUFPUyxFQUFQLENBQVUsV0FBVixFQUF1QixVQUFVQyxVQUFWLEVBQXNCQyxRQUF0QixFQUFnQztBQUNyREEsZUFBUyxJQUFULEVBQWUsS0FBZjtBQUNELEtBRkQ7QUFHQVgsV0FBT1MsRUFBUCxDQUFVLGVBQVYsRUFBMkIsVUFBVUMsVUFBVixFQUFzQkUsUUFBdEIsRUFBZ0NDLFFBQWhDLEVBQTBDRixRQUExQyxFQUFvRDtBQUM3RUEsZUFBUyxJQUFULEVBQWVDLGFBQWEsS0FBYixJQUFzQkMsYUFBYSxLQUFsRDtBQUNELEtBRkQ7QUFHQWIsV0FBT2MsTUFBUCxDQUFjWCxRQUFRSixJQUF0QixFQUE0QkcsSUFBNUI7QUFDRCxHQXRCRDs7QUF3QkFhLFFBQU0sVUFBVWIsSUFBVixFQUFnQjtBQUNoQjtBQUNKRixXQUFPZ0IsR0FBUCxDQUFXZCxJQUFYO0FBQ0QsR0FIRDs7QUFLQXdCLEtBQUcseUNBQUgsRUFBOEMsVUFBVXhCLElBQVYsRUFBZ0I7QUFDNUQsUUFBSUosT0FBTyxlQUFlLFdBQWYsRUFBNEJDLElBQTVCLEVBQWtDO0FBQzNDbUIsMEJBQW9CLEtBRHVCO0FBRTNDb0MsWUFBTTtBQUNKQyxjQUFNLEtBREY7QUFFSkMsY0FBTTtBQUZGO0FBRnFDLEtBQWxDLENBQVg7QUFPQTFELFNBQUtxQixRQUFMLEdBQWdCckIsS0FBS3NCLGNBQXJCO0FBQ0FDLFdBQU92QixJQUFQLEVBQWF3QixFQUFiLENBQWdCQyxLQUFoQjs7QUFFQXpCLFNBQUswQixPQUFMO0FBQ0ExQixTQUFLMkIsTUFBTCxHQUFjLFlBQVk7QUFDeEIzQixXQUFLaUMsT0FBTCxHQUFlN0IsSUFBZjtBQUNBSixXQUFLd0MsSUFBTDtBQUNELEtBSEQ7QUFJRCxHQWhCRDs7QUFrQkFaLEtBQUcscUNBQUgsRUFBMEMsVUFBVXhCLElBQVYsRUFBZ0I7QUFDeEQsUUFBSUosT0FBTyxlQUFlLFdBQWYsRUFBNEJDLElBQTVCLEVBQWtDO0FBQzNDbUIsMEJBQW9CLEtBRHVCO0FBRTNDb0MsWUFBTTtBQUNKQyxjQUFNLEtBREY7QUFFSkMsY0FBTTtBQUZGLE9BRnFDO0FBTTNDQyxrQkFBWTtBQU4rQixLQUFsQyxDQUFYO0FBUUEzRCxTQUFLcUIsUUFBTCxHQUFnQnJCLEtBQUtzQixjQUFyQjtBQUNBQyxXQUFPdkIsSUFBUCxFQUFhd0IsRUFBYixDQUFnQkMsS0FBaEI7O0FBRUF6QixTQUFLMEIsT0FBTDtBQUNBMUIsU0FBSzJCLE1BQUwsR0FBYyxZQUFZO0FBQ3hCM0IsV0FBS2lDLE9BQUwsR0FBZTdCLElBQWY7QUFDQUosV0FBS3dDLElBQUw7QUFDRCxLQUhEO0FBSUQsR0FqQkQ7O0FBbUJBWixLQUFHLHNDQUFILEVBQTJDLFVBQVV4QixJQUFWLEVBQWdCO0FBQ3pELFFBQUlKLE9BQU8sZUFBZSxXQUFmLEVBQTRCQyxJQUE1QixFQUFrQztBQUMzQ21CLDBCQUFvQixLQUR1QjtBQUUzQ29DLFlBQU07QUFDSkMsY0FBTSxNQURGO0FBRUpDLGNBQU07QUFGRixPQUZxQztBQU0zQ0Msa0JBQVk7QUFOK0IsS0FBbEMsQ0FBWDtBQVFBM0QsU0FBS3FCLFFBQUwsR0FBZ0JyQixLQUFLc0IsY0FBckI7QUFDQUMsV0FBT3ZCLElBQVAsRUFBYXdCLEVBQWIsQ0FBZ0JDLEtBQWhCOztBQUVBekIsU0FBSzBCLE9BQUw7QUFDQTFCLFNBQUs2QixPQUFMLEdBQWUsWUFBWTtBQUN6QjdCLFdBQUtpQyxPQUFMLEdBQWU3QixJQUFmO0FBQ0QsS0FGRDtBQUdELEdBaEJEOztBQWtCQXdCLEtBQUcsMERBQUgsRUFBK0QsVUFBVXhCLElBQVYsRUFBZ0I7QUFDN0UsUUFBSUosT0FBTyxlQUFlLFdBQWYsRUFBNEJDLElBQTVCLEVBQWtDO0FBQzNDbUIsMEJBQW9CLEtBRHVCO0FBRTNDb0MsWUFBTTtBQUNKQyxjQUFNLEtBREY7QUFFSkcsaUJBQVM7QUFGTDtBQUZxQyxLQUFsQyxDQUFYO0FBT0E1RCxTQUFLcUIsUUFBTCxHQUFnQnJCLEtBQUtzQixjQUFyQjtBQUNBQyxXQUFPdkIsSUFBUCxFQUFhd0IsRUFBYixDQUFnQkMsS0FBaEI7O0FBRUF6QixTQUFLMEIsT0FBTDtBQUNBMUIsU0FBSzJCLE1BQUwsR0FBYyxZQUFZO0FBQ3hCM0IsV0FBSzJCLE1BQUwsR0FBYyxZQUFZO0FBQ3hCM0IsYUFBS2lDLE9BQUwsR0FBZTdCLElBQWY7QUFDQUosYUFBS3dDLElBQUw7QUFDRCxPQUhEOztBQUtBeEMsV0FBS29DLE9BQUwsR0FBZSxVQUFVSyxnQkFBVixFQUE0QjtBQUN6Q2xCLGVBQU9rQixnQkFBUCxFQUF5QmpCLEVBQXpCLENBQTRCa0IsRUFBNUIsQ0FBK0JDLEtBQS9COztBQUVBM0MsYUFBSzRDLElBQUwsQ0FBVSxtQ0FBVjtBQUNBNUMsYUFBS2tCLEdBQUw7QUFDRCxPQUxEOztBQU9BbEIsV0FBSzZDLE1BQUwsR0FBYyxVQUFVQyxPQUFWLEVBQW1CO0FBQy9CdkIsZUFBT3VCLE9BQVAsRUFBZ0J0QixFQUFoQixDQUFtQmtCLEVBQW5CLENBQXNCSyxJQUF0QjtBQUNELE9BRkQ7O0FBSUEvQyxXQUFLa0MsV0FBTCxDQUFpQjtBQUNmQyxjQUFNLGtCQURTO0FBRWZYLFlBQUksQ0FBQyxvQkFBRDtBQUZXLE9BQWpCO0FBSUQsS0FyQkQ7QUFzQkQsR0FsQ0Q7O0FBb0NBSSxLQUFHLCtCQUFILEVBQW9DLFVBQVV4QixJQUFWLEVBQWdCO0FBQ2xELFFBQUlKLE9BQU8sZUFBZSxXQUFmLEVBQTRCQyxJQUE1QixFQUFrQztBQUMzQ21CLDBCQUFvQixLQUR1QjtBQUUzQ29DLFlBQU07QUFDSkMsY0FBTSxLQURGO0FBRUpHLGlCQUFTO0FBRkw7QUFGcUMsS0FBbEMsQ0FBWDtBQU9BNUQsU0FBS3FCLFFBQUwsR0FBZ0JyQixLQUFLc0IsY0FBckI7QUFDQUMsV0FBT3ZCLElBQVAsRUFBYXdCLEVBQWIsQ0FBZ0JDLEtBQWhCOztBQUVBekIsU0FBSzBCLE9BQUw7QUFDQTFCLFNBQUs2QixPQUFMLEdBQWUsWUFBWTtBQUN6QjdCLFdBQUtpQyxPQUFMLEdBQWU3QixJQUFmO0FBQ0QsS0FGRDtBQUdELEdBZkQ7QUFnQkQsQ0E1SUQ7O0FBOElBUixTQUFTLDJCQUFULEVBQXNDLFlBQVk7QUFDaEQsTUFBSUssT0FBTyxLQUFYO0FBQ0EsTUFBSUMsTUFBSjs7QUFFQU4sV0FBUyx1QkFBVCxFQUFrQyxZQUFZO0FBQzVDTyxXQUFPLFVBQVVDLElBQVYsRUFBZ0I7QUFDZjtBQUNOLFVBQUlDLFVBQVU7QUFDWkMsZUFBTyxLQURLO0FBRVpDLDhCQUFzQixJQUZWO0FBR1pOLGNBQU1BLElBSE07QUFJWk8sOEJBQXNCLElBSlY7QUFLWkMsMEJBQWtCLEtBTE47QUFNWjZDLG1CQUFXLElBTkM7QUFPWkMscUJBQWEsQ0FBQyxPQUFELEVBQVUsT0FBVixFQUFtQixTQUFuQjtBQVBELE9BQWQ7O0FBVUFyRCxlQUFTLHFCQUFXUSxZQUFYLENBQXdCTCxPQUF4QixDQUFUO0FBQ0FILGFBQU9TLEVBQVAsQ0FBVSxXQUFWLEVBQXVCLFlBQVUsZ0JBQWtCLENBQUUsQ0FBckQ7QUFDQVQsYUFBT1MsRUFBUCxDQUFVLE1BQVYsRUFBa0IsWUFBVSx1QkFBeUIsQ0FBRSxDQUF2RDtBQUNBVCxhQUFPUyxFQUFQLENBQVUsV0FBVixFQUF1QixVQUFVQyxVQUFWLEVBQXNCQyxRQUF0QixFQUFnQztBQUNyREEsaUJBQVMsSUFBVCxFQUFlLEtBQWY7QUFDRCxPQUZEO0FBR0FYLGFBQU9TLEVBQVAsQ0FBVSxlQUFWLEVBQTJCLFVBQVVDLFVBQVYsRUFBc0JFLFFBQXRCLEVBQWdDQyxRQUFoQyxFQUEwQ0YsUUFBMUMsRUFBb0Q7QUFDN0VBLGlCQUFTLElBQVQsRUFBZUMsYUFBYSxLQUFiLElBQXNCQyxhQUFhLEtBQWxEO0FBQ0QsT0FGRDtBQUdBYixhQUFPYyxNQUFQLENBQWNYLFFBQVFKLElBQXRCLEVBQTRCRyxJQUE1QjtBQUNELEtBdEJEOztBQXdCQWEsVUFBTSxVQUFVYixJQUFWLEVBQWdCO0FBQ2Q7QUFDTkYsYUFBT2dCLEdBQVAsQ0FBV2QsSUFBWDtBQUNELEtBSEQ7O0FBS0F3QixPQUFHLDJCQUFILEVBQWdDLFVBQVV4QixJQUFWLEVBQWdCO0FBQzlDLFVBQUlKLE9BQU8sZUFBZSxXQUFmLEVBQTRCQyxJQUE1QixFQUFrQztBQUMzQ21CLDRCQUFvQixLQUR1QjtBQUUzQ29DLGNBQU07QUFDSkMsZ0JBQU0sS0FERjtBQUVKQyxnQkFBTTtBQUZGLFNBRnFDO0FBTTNDSixtQkFBVztBQU5nQyxPQUFsQyxDQUFYO0FBUUF0RCxXQUFLcUIsUUFBTCxHQUFnQnJCLEtBQUtzQixjQUFyQjtBQUNBQyxhQUFPdkIsSUFBUCxFQUFhd0IsRUFBYixDQUFnQkMsS0FBaEI7O0FBRUF6QixXQUFLMEIsT0FBTDtBQUNBMUIsV0FBSzJCLE1BQUwsR0FBYyxZQUFZO0FBQ3hCSixlQUFPdkIsS0FBSzZELFdBQVosRUFBeUJyQyxFQUF6QixDQUE0QmtCLEVBQTVCLENBQStCTSxLQUEvQjtBQUNBaEQsYUFBS2lDLE9BQUwsR0FBZTdCLElBQWY7QUFDQUosYUFBS3dDLElBQUw7QUFDRCxPQUpEO0FBS0QsS0FsQkQ7O0FBb0JBWixPQUFHLHlCQUFILEVBQThCLFVBQVV4QixJQUFWLEVBQWdCO0FBQzVDLFVBQUlKLE9BQU8sZUFBZSxXQUFmLEVBQTRCQyxJQUE1QixFQUFrQztBQUMzQ21CLDRCQUFvQixLQUR1QjtBQUUzQ29DLGNBQU07QUFDSkMsZ0JBQU0sS0FERjtBQUVKQyxnQkFBTTtBQUZGO0FBRnFDLE9BQWxDLENBQVg7QUFPQTFELFdBQUtxQixRQUFMLEdBQWdCckIsS0FBS3NCLGNBQXJCO0FBQ0FDLGFBQU92QixJQUFQLEVBQWF3QixFQUFiLENBQWdCQyxLQUFoQjs7QUFFQXpCLFdBQUswQixPQUFMO0FBQ0ExQixXQUFLMkIsTUFBTCxHQUFjLFlBQVk7QUFDeEJKLGVBQU92QixLQUFLNkQsV0FBWixFQUF5QnJDLEVBQXpCLENBQTRCa0IsRUFBNUIsQ0FBK0JLLElBQS9CO0FBQ0EvQyxhQUFLaUMsT0FBTCxHQUFlN0IsSUFBZjtBQUNBSixhQUFLd0MsSUFBTDtBQUNELE9BSkQ7QUFLRCxLQWpCRDtBQWtCRCxHQXBFRDs7QUFzRUE1QyxXQUFTLHNCQUFULEVBQWlDLFlBQVk7QUFDM0NPLFdBQU8sVUFBVUMsSUFBVixFQUFnQjtBQUNmO0FBQ04sVUFBSUMsVUFBVTtBQUNaQyxlQUFPLEtBREs7QUFFWkMsOEJBQXNCLElBRlY7QUFHWk4sY0FBTUEsSUFITTtBQUlaTyw4QkFBc0IsSUFKVjtBQUtaQywwQkFBa0IsS0FMTjtBQU1aNkMsbUJBQVcsSUFOQztBQU9aQyxxQkFBYSxDQUFDLE9BQUQsRUFBVSxPQUFWLEVBQW1CLFNBQW5CLENBUEQ7QUFRWk8seUJBQWlCO0FBUkwsT0FBZDs7QUFXQTVELGVBQVMscUJBQVdRLFlBQVgsQ0FBd0JMLE9BQXhCLENBQVQ7QUFDQUgsYUFBT1MsRUFBUCxDQUFVLFdBQVYsRUFBdUIsWUFBVSxnQkFBa0IsQ0FBRSxDQUFyRDtBQUNBVCxhQUFPUyxFQUFQLENBQVUsTUFBVixFQUFrQixZQUFVLHVCQUF5QixDQUFFLENBQXZEO0FBQ0FULGFBQU9TLEVBQVAsQ0FBVSxXQUFWLEVBQXVCLFVBQVVDLFVBQVYsRUFBc0JDLFFBQXRCLEVBQWdDO0FBQ3JEQSxpQkFBUyxJQUFULEVBQWUsS0FBZjtBQUNELE9BRkQ7QUFHQVgsYUFBT1MsRUFBUCxDQUFVLGVBQVYsRUFBMkIsVUFBVUMsVUFBVixFQUFzQkUsUUFBdEIsRUFBZ0NDLFFBQWhDLEVBQTBDRixRQUExQyxFQUFvRDtBQUM3RUEsaUJBQVMsSUFBVCxFQUFlQyxhQUFhLEtBQWIsSUFBc0JDLGFBQWEsS0FBbEQ7QUFDRCxPQUZEO0FBR0FiLGFBQU9jLE1BQVAsQ0FBY1gsUUFBUUosSUFBdEIsRUFBNEJHLElBQTVCO0FBQ0QsS0F2QkQ7O0FBeUJBYSxVQUFNLFVBQVViLElBQVYsRUFBZ0I7QUFDZDtBQUNORixhQUFPZ0IsR0FBUCxDQUFXZCxJQUFYO0FBQ0QsS0FIRDs7QUFLQXdCLE9BQUcsMkJBQUgsRUFBZ0MsVUFBVXhCLElBQVYsRUFBZ0I7QUFDOUMsVUFBSUosT0FBTyxlQUFlLFdBQWYsRUFBNEJDLElBQTVCLEVBQWtDO0FBQzNDbUIsNEJBQW9CLEtBRHVCO0FBRTNDb0MsY0FBTTtBQUNKQyxnQkFBTSxLQURGO0FBRUpDLGdCQUFNO0FBRkY7QUFGcUMsT0FBbEMsQ0FBWDtBQU9BMUQsV0FBS3FCLFFBQUwsR0FBZ0JyQixLQUFLc0IsY0FBckI7QUFDQUMsYUFBT3ZCLElBQVAsRUFBYXdCLEVBQWIsQ0FBZ0JDLEtBQWhCOztBQUVBekIsV0FBSzBCLE9BQUw7QUFDQTFCLFdBQUsyQixNQUFMLEdBQWMsWUFBWTtBQUN4QkosZUFBT3ZCLEtBQUs2RCxXQUFaLEVBQXlCckMsRUFBekIsQ0FBNEJrQixFQUE1QixDQUErQk0sS0FBL0I7QUFDQWhELGFBQUtpQyxPQUFMLEdBQWU3QixJQUFmO0FBQ0FKLGFBQUt3QyxJQUFMO0FBQ0QsT0FKRDtBQUtELEtBakJEOztBQW1CQVosT0FBRywyQ0FBSCxFQUFnRCxVQUFVeEIsSUFBVixFQUFnQjtBQUM5RCxVQUFJSixPQUFPLGVBQWUsV0FBZixFQUE0QkMsSUFBNUIsRUFBa0M7QUFDM0NtQiw0QkFBb0IsS0FEdUI7QUFFM0NvQyxjQUFNO0FBQ0pDLGdCQUFNLEtBREY7QUFFSkMsZ0JBQU07QUFGRixTQUZxQztBQU0zQ0ssb0JBQVk7QUFOK0IsT0FBbEMsQ0FBWDtBQVFBL0QsV0FBS3FCLFFBQUwsR0FBZ0JyQixLQUFLc0IsY0FBckI7QUFDQUMsYUFBT3ZCLElBQVAsRUFBYXdCLEVBQWIsQ0FBZ0JDLEtBQWhCOztBQUVBekIsV0FBSzBCLE9BQUw7O0FBRUExQixXQUFLNkIsT0FBTCxHQUFlLFVBQVVDLEdBQVYsRUFBZTtBQUM1QlAsZUFBT08sR0FBUCxFQUFZTixFQUFaLENBQWVDLEtBQWY7QUFDQUYsZUFBT3ZCLEtBQUs2RCxXQUFaLEVBQXlCckMsRUFBekIsQ0FBNEJrQixFQUE1QixDQUErQk0sS0FBL0I7QUFDQWhELGFBQUtpQyxPQUFMLEdBQWU3QixJQUFmO0FBQ0FKLGFBQUt3QyxJQUFMO0FBQ0QsT0FMRDtBQU1ELEtBcEJEO0FBcUJELEdBdkVEOztBQXlFQTVDLFdBQVMsd0NBQVQsRUFBbUQsWUFBWTtBQUM3RE8sV0FBTyxVQUFVQyxJQUFWLEVBQWdCO0FBQ2Y7QUFDTixVQUFJQyxVQUFVO0FBQ1pDLGVBQU8sS0FESztBQUVaQyw4QkFBc0IsSUFGVjtBQUdaTixjQUFNQSxJQUhNO0FBSVpPLDhCQUFzQixJQUpWO0FBS1pDLDBCQUFrQixLQUxOO0FBTVp1RCxxQkFBYSxJQU5EO0FBT1pWLG1CQUFXLElBUEM7QUFRWkMscUJBQWEsQ0FBQyxPQUFELEVBQVUsT0FBVixFQUFtQixTQUFuQixDQVJEO0FBU1pPLHlCQUFpQjtBQVRMLE9BQWQ7O0FBWUE1RCxlQUFTLHFCQUFXUSxZQUFYLENBQXdCTCxPQUF4QixDQUFUO0FBQ0FILGFBQU9TLEVBQVAsQ0FBVSxXQUFWLEVBQXVCLFlBQVUsZ0JBQWtCLENBQUUsQ0FBckQ7QUFDQVQsYUFBT1MsRUFBUCxDQUFVLE1BQVYsRUFBa0IsWUFBVSx1QkFBeUIsQ0FBRSxDQUF2RDtBQUNBVCxhQUFPUyxFQUFQLENBQVUsV0FBVixFQUF1QixVQUFVQyxVQUFWLEVBQXNCQyxRQUF0QixFQUFnQztBQUNyREEsaUJBQVMsSUFBVCxFQUFlLEtBQWY7QUFDRCxPQUZEO0FBR0FYLGFBQU9TLEVBQVAsQ0FBVSxlQUFWLEVBQTJCLFVBQVVDLFVBQVYsRUFBc0JFLFFBQXRCLEVBQWdDQyxRQUFoQyxFQUEwQ0YsUUFBMUMsRUFBb0Q7QUFDN0VBLGlCQUFTLElBQVQsRUFBZUMsYUFBYSxLQUFiLElBQXNCQyxhQUFhLEtBQWxEO0FBQ0QsT0FGRDtBQUdBYixhQUFPYyxNQUFQLENBQWNYLFFBQVFKLElBQXRCLEVBQTRCRyxJQUE1QjtBQUNELEtBeEJEOztBQTBCQWEsVUFBTSxVQUFVYixJQUFWLEVBQWdCO0FBQ2Q7QUFDTkYsYUFBT2dCLEdBQVAsQ0FBV2QsSUFBWDtBQUNELEtBSEQ7O0FBS0F3QixPQUFHLDJDQUFILEVBQWdELFVBQVV4QixJQUFWLEVBQWdCO0FBQzlELFVBQUlKLE9BQU8sZUFBZSxXQUFmLEVBQTRCQyxJQUE1QixFQUFrQztBQUMzQ21CLDRCQUFvQixLQUR1QjtBQUUzQ29DLGNBQU07QUFDSkMsZ0JBQU0sS0FERjtBQUVKQyxnQkFBTTtBQUZGLFNBRnFDO0FBTTNDSyxvQkFBWTtBQU4rQixPQUFsQyxDQUFYO0FBUUEvRCxXQUFLcUIsUUFBTCxHQUFnQnJCLEtBQUtzQixjQUFyQjtBQUNBQyxhQUFPdkIsSUFBUCxFQUFhd0IsRUFBYixDQUFnQkMsS0FBaEI7O0FBRUF6QixXQUFLMEIsT0FBTDs7QUFFQTFCLFdBQUs2QixPQUFMLEdBQWUsVUFBVUMsR0FBVixFQUFlO0FBQzVCUCxlQUFPTyxHQUFQLEVBQVlOLEVBQVosQ0FBZUMsS0FBZjtBQUNBRixlQUFPTyxJQUFJQyxPQUFYLEVBQW9CUCxFQUFwQixDQUF1QlEsS0FBdkIsQ0FBNkIscUNBQTdCO0FBQ0FULGVBQU92QixLQUFLNkQsV0FBWixFQUF5QnJDLEVBQXpCLENBQTRCa0IsRUFBNUIsQ0FBK0JNLEtBQS9CO0FBQ0FoRCxhQUFLaUMsT0FBTCxHQUFlN0IsSUFBZjtBQUNBSixhQUFLd0MsSUFBTDtBQUNELE9BTkQ7QUFPRCxLQXJCRDtBQXNCRCxHQXRERDtBQXVERCxDQTFNRCIsImZpbGUiOiJjbGllbnQtaW50ZWdyYXRpb24uanMiLCJzb3VyY2VzQ29udGVudCI6WyIvKiBlc2xpbnQtZGlzYWJsZSBuby11bnVzZWQtZXhwcmVzc2lvbnMgKi9cblxuaW1wb3J0IFNtdHBDbGllbnQgZnJvbSAnLi4nXG5pbXBvcnQgc2ltcGxlc210cCBmcm9tICdzaW1wbGVzbXRwJ1xuXG5kZXNjcmliZSgnc210cGNsaWVudCBub2RlIGludGVncmF0aW9uIHRlc3RzJywgZnVuY3Rpb24gKCkge1xuICBwcm9jZXNzLmVudi5OT0RFX1RMU19SRUpFQ1RfVU5BVVRIT1JJWkVEID0gJzAnXG5cbiAgdmFyIHNtdHBcbiAgdmFyIHBvcnQgPSAxMDAwMVxuICB2YXIgc2VydmVyXG5cbiAgYmVmb3JlKGZ1bmN0aW9uIChkb25lKSB7XG4gICAgICAgIC8vIHN0YXJ0IHNtdHAgdGVzdCBzZXJ2ZXJcbiAgICB2YXIgb3B0aW9ucyA9IHtcbiAgICAgIGRlYnVnOiBmYWxzZSxcbiAgICAgIGRpc2FibGVETlNWYWxpZGF0aW9uOiB0cnVlLFxuICAgICAgcG9ydDogcG9ydCxcbiAgICAgIGVuYWJsZUF1dGhlbnRpY2F0aW9uOiB0cnVlLFxuICAgICAgc2VjdXJlQ29ubmVjdGlvbjogZmFsc2VcbiAgICB9XG5cbiAgICBzZXJ2ZXIgPSBzaW1wbGVzbXRwLmNyZWF0ZVNlcnZlcihvcHRpb25zKVxuICAgIHNlcnZlci5vbignc3RhcnREYXRhJywgZnVuY3Rpb24gKC8qIGNvbm5lY3Rpb24gKi8pIHt9KVxuICAgIHNlcnZlci5vbignZGF0YScsIGZ1bmN0aW9uICgvKiBjb25uZWN0aW9uLCBjaHVuayAqLykge30pXG4gICAgc2VydmVyLm9uKCdkYXRhUmVhZHknLCBmdW5jdGlvbiAoY29ubmVjdGlvbiwgY2FsbGJhY2spIHtcbiAgICAgIGNhbGxiYWNrKG51bGwsICdmb28nKVxuICAgIH0pXG4gICAgc2VydmVyLm9uKCdhdXRob3JpemVVc2VyJywgZnVuY3Rpb24gKGNvbm5lY3Rpb24sIHVzZXJuYW1lLCBwYXNzd29yZCwgY2FsbGJhY2spIHtcbiAgICAgIGNhbGxiYWNrKG51bGwsIHVzZXJuYW1lID09PSAnYWJjJyAmJiBwYXNzd29yZCA9PT0gJ2RlZicpXG4gICAgfSlcbiAgICBzZXJ2ZXIubGlzdGVuKG9wdGlvbnMucG9ydCwgZG9uZSlcbiAgfSlcblxuICBhZnRlcihmdW5jdGlvbiAoZG9uZSkge1xuICAgICAgICAvLyBjbG9zZSBzbXRwIHRlc3Qgc2VydmVyXG4gICAgc2VydmVyLmVuZChkb25lKVxuICB9KVxuXG4gIGJlZm9yZUVhY2goZnVuY3Rpb24gKGRvbmUpIHtcbiAgICBzbXRwID0gbmV3IFNtdHBDbGllbnQoJzEyNy4wLjAuMScsIHBvcnQsIHtcbiAgICAgIHVzZVNlY3VyZVRyYW5zcG9ydDogZmFsc2VcbiAgICB9KVxuICAgIHNtdHAubG9nTGV2ZWwgPSBzbXRwLkxPR19MRVZFTF9OT05FXG4gICAgZXhwZWN0KHNtdHApLnRvLmV4aXN0XG5cbiAgICBzbXRwLmNvbm5lY3QoKVxuICAgIHNtdHAub25pZGxlID0gZnVuY3Rpb24gKCkge1xuICAgICAgZG9uZSgpXG4gICAgfVxuICB9KVxuXG4gIGl0KCdzaG91bGQgZmFpbCB3aXRoIGludmFsaWQgTUFJTCBGUk9NJywgZnVuY3Rpb24gKGRvbmUpIHtcbiAgICBzbXRwLm9uZXJyb3IgPSBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICBleHBlY3QoZXJyLm1lc3NhZ2UpLnRvLmVxdWFsKCdCYWQgc2VuZGVyIGFkZHJlc3Mgc3ludGF4JylcbiAgICAgIHNtdHAub25jbG9zZSA9IGRvbmVcbiAgICB9XG5cbiAgICBzbXRwLnVzZUVudmVsb3BlKHtcbiAgICAgIGZyb206ICdpbnZhbGlkJyxcbiAgICAgIHRvOiBbJ3JlY2VpdmVyQGxvY2FsaG9zdCddXG4gICAgfSlcbiAgfSlcblxuICBpdCgnc2hvdWxkIGZhaWwgd2l0aCBlbXB0eSByZWNpcGllbnRzJywgZnVuY3Rpb24gKGRvbmUpIHtcbiAgICBzbXRwLm9uZXJyb3IgPSBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICBleHBlY3QoZXJyLm1lc3NhZ2UpLnRvLmVxdWFsKCdDYW5cXCd0IHNlbmQgbWFpbCAtIG5vIHJlY2lwaWVudHMgZGVmaW5lZCcpXG4gICAgICBzbXRwLm9uY2xvc2UgPSBkb25lXG4gICAgfVxuXG4gICAgc210cC51c2VFbnZlbG9wZSh7XG4gICAgICBmcm9tOiAnc2VuZGVyQGV4YW1wbGUuY29tJyxcbiAgICAgIHRvOiBbXVxuICAgIH0pXG4gIH0pXG5cbiAgaXQoJ3Nob3VsZCBmYWlsIHdpdGggaW52YWxpZCByZWNpcGllbnRzJywgZnVuY3Rpb24gKGRvbmUpIHtcbiAgICBzbXRwLm9uZXJyb3IgPSBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICBleHBlY3QoZXJyLm1lc3NhZ2UpLnRvLmVxdWFsKCdDYW5cXCd0IHNlbmQgbWFpbCAtIGFsbCByZWNpcGllbnRzIHdlcmUgcmVqZWN0ZWQnKVxuICAgICAgc210cC5vbmNsb3NlID0gZG9uZVxuICAgIH1cblxuICAgIHNtdHAudXNlRW52ZWxvcGUoe1xuICAgICAgZnJvbTogJ3NlbmRlckBleGFtcGxlLmNvbScsXG4gICAgICB0bzogWydpbnZhbGlkJ11cbiAgICB9KVxuICB9KVxuXG4gIGl0KCdzaG91bGQgcGFzcyBSQ1BUIFRPJywgZnVuY3Rpb24gKGRvbmUpIHtcbiAgICBzbXRwLm9ucmVhZHkgPSBmdW5jdGlvbiAoZmFpbGVkKSB7XG4gICAgICBleHBlY3QoZmFpbGVkKS50by5kZWVwLmVxdWFsKFtdKVxuICAgICAgc210cC5vbmNsb3NlID0gZG9uZVxuICAgICAgc210cC5jbG9zZSgpXG4gICAgfVxuXG4gICAgc210cC51c2VFbnZlbG9wZSh7XG4gICAgICBmcm9tOiAnc2VuZGVyQGV4YW1wbGUuY29tJyxcbiAgICAgIHRvOiBbJ3JlY2VpdmVyQGV4YW1wbGUuY29tJ11cbiAgICB9KVxuICB9KVxuXG4gIGl0KCdzaG91bGQgcGFzcyBSQ1BUIFRPIHdpdGggc29tZSBmYWlsdXJlcycsIGZ1bmN0aW9uIChkb25lKSB7XG4gICAgc210cC5vbnJlYWR5ID0gZnVuY3Rpb24gKGZhaWxlZCkge1xuICAgICAgZXhwZWN0KGZhaWxlZCkudG8uZGVlcC5lcXVhbChbJ2ludmFsaWQnXSlcbiAgICAgIHNtdHAub25jbG9zZSA9IGRvbmVcbiAgICAgIHNtdHAuY2xvc2UoKVxuICAgIH1cblxuICAgIHNtdHAudXNlRW52ZWxvcGUoe1xuICAgICAgZnJvbTogJ3NlbmRlckBleGFtcGxlLmNvbScsXG4gICAgICB0bzogWydpbnZhbGlkJywgJ3JlY2VpdmVyQGV4YW1wbGUuY29tJ11cbiAgICB9KVxuICB9KVxuXG4gIGl0KCdzaG91bGQgc3VjY2VlZCB3aXRoIERBVEEnLCBmdW5jdGlvbiAoZG9uZSkge1xuICAgIHNtdHAub25pZGxlID0gZnVuY3Rpb24gKCkge1xuICAgICAgc210cC5vbmNsb3NlID0gZG9uZVxuICAgICAgc210cC5xdWl0KClcbiAgICB9XG5cbiAgICBzbXRwLm9ucmVhZHkgPSBmdW5jdGlvbiAoZmFpbGVkUmVjaXBpZW50cykge1xuICAgICAgZXhwZWN0KGZhaWxlZFJlY2lwaWVudHMpLnRvLmJlLmVtcHR5XG5cbiAgICAgIHNtdHAuc2VuZCgnU3ViamVjdDogdGVzdFxcclxcblxcclxcbk1lc3NhZ2UgYm9keScpXG4gICAgICBzbXRwLmVuZCgpXG4gICAgfVxuXG4gICAgc210cC5vbmRvbmUgPSBmdW5jdGlvbiAoc3VjY2Vzcykge1xuICAgICAgZXhwZWN0KHN1Y2Nlc3MpLnRvLmJlLnRydWVcbiAgICB9XG5cbiAgICBzbXRwLnVzZUVudmVsb3BlKHtcbiAgICAgIGZyb206ICdzZW5kZXJAbG9jYWxob3N0JyxcbiAgICAgIHRvOiBbJ3JlY2VpdmVyQGxvY2FsaG9zdCddXG4gICAgfSlcbiAgfSlcblxuICBpdCgnc2hvdWxkIG5vdCBpZGxlJywgZnVuY3Rpb24gKGRvbmUpIHtcbiAgICBzbXRwLm9uaWRsZSA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIC8vIHNob3VsZCBub3QgcnVuXG4gICAgICBleHBlY3QodHJ1ZSkudG8uYmUuZmFsc2VcbiAgICB9XG5cbiAgICBzbXRwLm9ucmVhZHkgPSBmdW5jdGlvbiAoZmFpbGVkUmVjaXBpZW50cykge1xuICAgICAgZXhwZWN0KGZhaWxlZFJlY2lwaWVudHMpLnRvLmJlLmVtcHR5XG5cbiAgICAgIHNtdHAuc2VuZCgnU3ViamVjdDogdGVzdFxcclxcblxcclxcbk1lc3NhZ2UgYm9keScpXG4gICAgICBzbXRwLmVuZCgpXG4gICAgfVxuXG4gICAgc210cC5vbmRvbmUgPSBmdW5jdGlvbiAoc3VjY2Vzcykge1xuICAgICAgZXhwZWN0KHN1Y2Nlc3MpLnRvLmJlLnRydWVcbiAgICAgIHNtdHAub25jbG9zZSA9IGRvbmVcbiAgICAgIHNtdHAucXVpdCgpXG4gICAgfVxuXG4gICAgc210cC51c2VFbnZlbG9wZSh7XG4gICAgICBmcm9tOiAnc2VuZGVyQGxvY2FsaG9zdCcsXG4gICAgICB0bzogWydyZWNlaXZlckBsb2NhbGhvc3QnXVxuICAgIH0pXG4gIH0pXG5cbiAgaXQoJ3Nob3VkIHRpbWVvdXQnLCBmdW5jdGlvbiAoZG9uZSkge1xuICAgIHZhciBlcnJvcmVkID0gZmFsc2VcblxuICAgIHNtdHAub25lcnJvciA9IGZ1bmN0aW9uICgpIHtcbiAgICAgIGVycm9yZWQgPSB0cnVlXG4gICAgfVxuXG4gICAgc210cC5vbmNsb3NlID0gZnVuY3Rpb24gKCkge1xuICAgICAgZXhwZWN0KGVycm9yZWQpLnRvLmJlLnRydWVcbiAgICAgIGRvbmUoKVxuICAgIH1cblxuICAgIHNtdHAub25yZWFkeSA9IGZ1bmN0aW9uIChmYWlsZWRSZWNpcGllbnRzKSB7XG4gICAgICBleHBlY3QoZmFpbGVkUmVjaXBpZW50cykudG8uYmUuZW1wdHlcblxuICAgICAgICAgICAgLy8gcmVtb3ZlIHRoZSBvbmRhdGEgZXZlbnQgdG8gc2ltdWxhdGUgMTAwJSBwYWNrZXQgbG9zcyBhbmQgbWFrZSB0aGUgc29ja2V0IHRpbWUgb3V0IGFmdGVyIDEwbXNcbiAgICAgIHNtdHAuVElNRU9VVF9TT0NLRVRfTE9XRVJfQk9VTkQgPSAxMFxuICAgICAgc210cC5USU1FT1VUX1NPQ0tFVF9NVUxUSVBMSUVSID0gMFxuICAgICAgc210cC5zb2NrZXQub25kYXRhID0gZnVuY3Rpb24gKCkge31cblxuICAgICAgc210cC5zZW5kKCdTdWJqZWN0OiB0ZXN0XFxyXFxuXFxyXFxuTWVzc2FnZSBib2R5JykgLy8gdHJpZ2dlciB3cml0ZVxuICAgIH1cblxuICAgIHNtdHAub25pZGxlID0gc210cC5vbmRvbmUgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAvLyBzaG91bGQgbm90IGhhcHBlblxuICAgICAgZXhwZWN0KHRydWUpLnRvLmJlLmZhbHNlXG4gICAgfVxuXG4gICAgc210cC51c2VFbnZlbG9wZSh7XG4gICAgICBmcm9tOiAnc2VuZGVyQGxvY2FsaG9zdCcsXG4gICAgICB0bzogWydyZWNlaXZlckBsb2NhbGhvc3QnXVxuICAgIH0pXG4gIH0pXG59KVxuXG5kZXNjcmliZSgnc210cGNsaWVudCBhdXRoZW50aWNhdGlvbiB0ZXN0cycsIGZ1bmN0aW9uICgpIHtcbiAgdmFyIHBvcnQgPSAxMDAwMVxuICB2YXIgc2VydmVyXG5cbiAgYmVmb3JlKGZ1bmN0aW9uIChkb25lKSB7XG4gICAgICAgIC8vIHN0YXJ0IHNtdHAgdGVzdCBzZXJ2ZXJcbiAgICB2YXIgb3B0aW9ucyA9IHtcbiAgICAgIGRlYnVnOiBmYWxzZSxcbiAgICAgIGRpc2FibGVETlNWYWxpZGF0aW9uOiB0cnVlLFxuICAgICAgcG9ydDogcG9ydCxcbiAgICAgIGVuYWJsZUF1dGhlbnRpY2F0aW9uOiB0cnVlLFxuICAgICAgc2VjdXJlQ29ubmVjdGlvbjogZmFsc2UsXG4gICAgICBpZ25vcmVUTFM6IGZhbHNlLFxuICAgICAgYXV0aE1ldGhvZHM6IFsnUExBSU4nLCAnTE9HSU4nLCAnWE9BVVRIMiddXG4gICAgfVxuXG4gICAgc2VydmVyID0gc2ltcGxlc210cC5jcmVhdGVTZXJ2ZXIob3B0aW9ucylcbiAgICBzZXJ2ZXIub24oJ3N0YXJ0RGF0YScsIGZ1bmN0aW9uICgvKiBjb25uZWN0aW9uICovKSB7fSlcbiAgICBzZXJ2ZXIub24oJ2RhdGEnLCBmdW5jdGlvbiAoLyogY29ubmVjdGlvbiwgY2h1bmsgKi8pIHt9KVxuICAgIHNlcnZlci5vbignZGF0YVJlYWR5JywgZnVuY3Rpb24gKGNvbm5lY3Rpb24sIGNhbGxiYWNrKSB7XG4gICAgICBjYWxsYmFjayhudWxsLCAnZm9vJylcbiAgICB9KVxuICAgIHNlcnZlci5vbignYXV0aG9yaXplVXNlcicsIGZ1bmN0aW9uIChjb25uZWN0aW9uLCB1c2VybmFtZSwgcGFzc3dvcmQsIGNhbGxiYWNrKSB7XG4gICAgICBjYWxsYmFjayhudWxsLCB1c2VybmFtZSA9PT0gJ2FiYycgJiYgcGFzc3dvcmQgPT09ICdkZWYnKVxuICAgIH0pXG4gICAgc2VydmVyLmxpc3RlbihvcHRpb25zLnBvcnQsIGRvbmUpXG4gIH0pXG5cbiAgYWZ0ZXIoZnVuY3Rpb24gKGRvbmUpIHtcbiAgICAgICAgLy8gY2xvc2Ugc210cCB0ZXN0IHNlcnZlclxuICAgIHNlcnZlci5lbmQoZG9uZSlcbiAgfSlcblxuICBpdCgnc2hvdWxkIGF1dGhlbnRpY2F0ZSB3aXRoIGRlZmF1bHQgbWV0aG9kJywgZnVuY3Rpb24gKGRvbmUpIHtcbiAgICB2YXIgc210cCA9IG5ldyBTbXRwQ2xpZW50KCcxMjcuMC4wLjEnLCBwb3J0LCB7XG4gICAgICB1c2VTZWN1cmVUcmFuc3BvcnQ6IGZhbHNlLFxuICAgICAgYXV0aDoge1xuICAgICAgICB1c2VyOiAnYWJjJyxcbiAgICAgICAgcGFzczogJ2RlZidcbiAgICAgIH1cbiAgICB9KVxuICAgIHNtdHAubG9nTGV2ZWwgPSBzbXRwLkxPR19MRVZFTF9OT05FXG4gICAgZXhwZWN0KHNtdHApLnRvLmV4aXN0XG5cbiAgICBzbXRwLmNvbm5lY3QoKVxuICAgIHNtdHAub25pZGxlID0gZnVuY3Rpb24gKCkge1xuICAgICAgc210cC5vbmNsb3NlID0gZG9uZVxuICAgICAgc210cC5xdWl0KClcbiAgICB9XG4gIH0pXG5cbiAgaXQoJ3Nob3VsZCBhdXRoZW50aWNhdGUgd2l0aCBBVVRIIExPR0lOJywgZnVuY3Rpb24gKGRvbmUpIHtcbiAgICB2YXIgc210cCA9IG5ldyBTbXRwQ2xpZW50KCcxMjcuMC4wLjEnLCBwb3J0LCB7XG4gICAgICB1c2VTZWN1cmVUcmFuc3BvcnQ6IGZhbHNlLFxuICAgICAgYXV0aDoge1xuICAgICAgICB1c2VyOiAnYWJjJyxcbiAgICAgICAgcGFzczogJ2RlZidcbiAgICAgIH0sXG4gICAgICBhdXRoTWV0aG9kOiAnTE9HSU4nXG4gICAgfSlcbiAgICBzbXRwLmxvZ0xldmVsID0gc210cC5MT0dfTEVWRUxfTk9ORVxuICAgIGV4cGVjdChzbXRwKS50by5leGlzdFxuXG4gICAgc210cC5jb25uZWN0KClcbiAgICBzbXRwLm9uaWRsZSA9IGZ1bmN0aW9uICgpIHtcbiAgICAgIHNtdHAub25jbG9zZSA9IGRvbmVcbiAgICAgIHNtdHAucXVpdCgpXG4gICAgfVxuICB9KVxuXG4gIGl0KCdzaG91bGQgZmFpbCB3aXRoIGludmFsaWQgY3JlZGVudGlhbHMnLCBmdW5jdGlvbiAoZG9uZSkge1xuICAgIHZhciBzbXRwID0gbmV3IFNtdHBDbGllbnQoJzEyNy4wLjAuMScsIHBvcnQsIHtcbiAgICAgIHVzZVNlY3VyZVRyYW5zcG9ydDogZmFsc2UsXG4gICAgICBhdXRoOiB7XG4gICAgICAgIHVzZXI6ICdhYmNkJyxcbiAgICAgICAgcGFzczogJ2RlZmUnXG4gICAgICB9LFxuICAgICAgYXV0aE1ldGhvZDogJ0xPR0lOJ1xuICAgIH0pXG4gICAgc210cC5sb2dMZXZlbCA9IHNtdHAuTE9HX0xFVkVMX05PTkVcbiAgICBleHBlY3Qoc210cCkudG8uZXhpc3RcblxuICAgIHNtdHAuY29ubmVjdCgpXG4gICAgc210cC5vbmVycm9yID0gZnVuY3Rpb24gKCkge1xuICAgICAgc210cC5vbmNsb3NlID0gZG9uZVxuICAgIH1cbiAgfSlcblxuICBpdCgnc2hvdWxkIGF1dGhlbnRpY2F0ZSB3aXRoIEFVVEggWE9BVVRIMiBhbmQgc2VuZCBhIG1lc3NhZ2UnLCBmdW5jdGlvbiAoZG9uZSkge1xuICAgIHZhciBzbXRwID0gbmV3IFNtdHBDbGllbnQoJzEyNy4wLjAuMScsIHBvcnQsIHtcbiAgICAgIHVzZVNlY3VyZVRyYW5zcG9ydDogZmFsc2UsXG4gICAgICBhdXRoOiB7XG4gICAgICAgIHVzZXI6ICdhYmMnLFxuICAgICAgICB4b2F1dGgyOiAnZGVmJ1xuICAgICAgfVxuICAgIH0pXG4gICAgc210cC5sb2dMZXZlbCA9IHNtdHAuTE9HX0xFVkVMX05PTkVcbiAgICBleHBlY3Qoc210cCkudG8uZXhpc3RcblxuICAgIHNtdHAuY29ubmVjdCgpXG4gICAgc210cC5vbmlkbGUgPSBmdW5jdGlvbiAoKSB7XG4gICAgICBzbXRwLm9uaWRsZSA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgc210cC5vbmNsb3NlID0gZG9uZVxuICAgICAgICBzbXRwLnF1aXQoKVxuICAgICAgfVxuXG4gICAgICBzbXRwLm9ucmVhZHkgPSBmdW5jdGlvbiAoZmFpbGVkUmVjaXBpZW50cykge1xuICAgICAgICBleHBlY3QoZmFpbGVkUmVjaXBpZW50cykudG8uYmUuZW1wdHlcblxuICAgICAgICBzbXRwLnNlbmQoJ1N1YmplY3Q6IHRlc3RcXHJcXG5cXHJcXG5NZXNzYWdlIGJvZHknKVxuICAgICAgICBzbXRwLmVuZCgpXG4gICAgICB9XG5cbiAgICAgIHNtdHAub25kb25lID0gZnVuY3Rpb24gKHN1Y2Nlc3MpIHtcbiAgICAgICAgZXhwZWN0KHN1Y2Nlc3MpLnRvLmJlLnRydWVcbiAgICAgIH1cblxuICAgICAgc210cC51c2VFbnZlbG9wZSh7XG4gICAgICAgIGZyb206ICdzZW5kZXJAbG9jYWxob3N0JyxcbiAgICAgICAgdG86IFsncmVjZWl2ZXJAbG9jYWxob3N0J11cbiAgICAgIH0pXG4gICAgfVxuICB9KVxuXG4gIGl0KCdzaG91bGQgZmFpbCB3aXRoIEFVVEggWE9BVVRIMicsIGZ1bmN0aW9uIChkb25lKSB7XG4gICAgdmFyIHNtdHAgPSBuZXcgU210cENsaWVudCgnMTI3LjAuMC4xJywgcG9ydCwge1xuICAgICAgdXNlU2VjdXJlVHJhbnNwb3J0OiBmYWxzZSxcbiAgICAgIGF1dGg6IHtcbiAgICAgICAgdXNlcjogJ2FiYycsXG4gICAgICAgIHhvYXV0aDI6ICdnaGknXG4gICAgICB9XG4gICAgfSlcbiAgICBzbXRwLmxvZ0xldmVsID0gc210cC5MT0dfTEVWRUxfTk9ORVxuICAgIGV4cGVjdChzbXRwKS50by5leGlzdFxuXG4gICAgc210cC5jb25uZWN0KClcbiAgICBzbXRwLm9uZXJyb3IgPSBmdW5jdGlvbiAoKSB7XG4gICAgICBzbXRwLm9uY2xvc2UgPSBkb25lXG4gICAgfVxuICB9KVxufSlcblxuZGVzY3JpYmUoJ3NtdHBjbGllbnQgU1RBUlRUTFMgdGVzdHMnLCBmdW5jdGlvbiAoKSB7XG4gIHZhciBwb3J0ID0gMTAwMDFcbiAgdmFyIHNlcnZlclxuXG4gIGRlc2NyaWJlKCdTVEFSVFRMUyBpcyBzdXBwb3J0ZWQnLCBmdW5jdGlvbiAoKSB7XG4gICAgYmVmb3JlKGZ1bmN0aW9uIChkb25lKSB7XG4gICAgICAgICAgICAvLyBzdGFydCBzbXRwIHRlc3Qgc2VydmVyXG4gICAgICB2YXIgb3B0aW9ucyA9IHtcbiAgICAgICAgZGVidWc6IGZhbHNlLFxuICAgICAgICBkaXNhYmxlRE5TVmFsaWRhdGlvbjogdHJ1ZSxcbiAgICAgICAgcG9ydDogcG9ydCxcbiAgICAgICAgZW5hYmxlQXV0aGVudGljYXRpb246IHRydWUsXG4gICAgICAgIHNlY3VyZUNvbm5lY3Rpb246IGZhbHNlLFxuICAgICAgICBpZ25vcmVUTFM6IHRydWUsXG4gICAgICAgIGF1dGhNZXRob2RzOiBbJ1BMQUlOJywgJ0xPR0lOJywgJ1hPQVVUSDInXVxuICAgICAgfVxuXG4gICAgICBzZXJ2ZXIgPSBzaW1wbGVzbXRwLmNyZWF0ZVNlcnZlcihvcHRpb25zKVxuICAgICAgc2VydmVyLm9uKCdzdGFydERhdGEnLCBmdW5jdGlvbiAoLyogY29ubmVjdGlvbiAqLykge30pXG4gICAgICBzZXJ2ZXIub24oJ2RhdGEnLCBmdW5jdGlvbiAoLyogY29ubmVjdGlvbiwgY2h1bmsgKi8pIHt9KVxuICAgICAgc2VydmVyLm9uKCdkYXRhUmVhZHknLCBmdW5jdGlvbiAoY29ubmVjdGlvbiwgY2FsbGJhY2spIHtcbiAgICAgICAgY2FsbGJhY2sobnVsbCwgJ2ZvbycpXG4gICAgICB9KVxuICAgICAgc2VydmVyLm9uKCdhdXRob3JpemVVc2VyJywgZnVuY3Rpb24gKGNvbm5lY3Rpb24sIHVzZXJuYW1lLCBwYXNzd29yZCwgY2FsbGJhY2spIHtcbiAgICAgICAgY2FsbGJhY2sobnVsbCwgdXNlcm5hbWUgPT09ICdhYmMnICYmIHBhc3N3b3JkID09PSAnZGVmJylcbiAgICAgIH0pXG4gICAgICBzZXJ2ZXIubGlzdGVuKG9wdGlvbnMucG9ydCwgZG9uZSlcbiAgICB9KVxuXG4gICAgYWZ0ZXIoZnVuY3Rpb24gKGRvbmUpIHtcbiAgICAgICAgICAgIC8vIGNsb3NlIHNtdHAgdGVzdCBzZXJ2ZXJcbiAgICAgIHNlcnZlci5lbmQoZG9uZSlcbiAgICB9KVxuXG4gICAgaXQoJ3Nob3VsZCBjb25uZWN0IGluc2VjdXJlbHknLCBmdW5jdGlvbiAoZG9uZSkge1xuICAgICAgdmFyIHNtdHAgPSBuZXcgU210cENsaWVudCgnMTI3LjAuMC4xJywgcG9ydCwge1xuICAgICAgICB1c2VTZWN1cmVUcmFuc3BvcnQ6IGZhbHNlLFxuICAgICAgICBhdXRoOiB7XG4gICAgICAgICAgdXNlcjogJ2FiYycsXG4gICAgICAgICAgcGFzczogJ2RlZidcbiAgICAgICAgfSxcbiAgICAgICAgaWdub3JlVExTOiB0cnVlXG4gICAgICB9KVxuICAgICAgc210cC5sb2dMZXZlbCA9IHNtdHAuTE9HX0xFVkVMX05PTkVcbiAgICAgIGV4cGVjdChzbXRwKS50by5leGlzdFxuXG4gICAgICBzbXRwLmNvbm5lY3QoKVxuICAgICAgc210cC5vbmlkbGUgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgIGV4cGVjdChzbXRwLl9zZWN1cmVNb2RlKS50by5iZS5mYWxzZVxuICAgICAgICBzbXRwLm9uY2xvc2UgPSBkb25lXG4gICAgICAgIHNtdHAucXVpdCgpXG4gICAgICB9XG4gICAgfSlcblxuICAgIGl0KCdzaG91bGQgY29ubmVjdCBzZWN1cmVseScsIGZ1bmN0aW9uIChkb25lKSB7XG4gICAgICB2YXIgc210cCA9IG5ldyBTbXRwQ2xpZW50KCcxMjcuMC4wLjEnLCBwb3J0LCB7XG4gICAgICAgIHVzZVNlY3VyZVRyYW5zcG9ydDogZmFsc2UsXG4gICAgICAgIGF1dGg6IHtcbiAgICAgICAgICB1c2VyOiAnYWJjJyxcbiAgICAgICAgICBwYXNzOiAnZGVmJ1xuICAgICAgICB9XG4gICAgICB9KVxuICAgICAgc210cC5sb2dMZXZlbCA9IHNtdHAuTE9HX0xFVkVMX05PTkVcbiAgICAgIGV4cGVjdChzbXRwKS50by5leGlzdFxuXG4gICAgICBzbXRwLmNvbm5lY3QoKVxuICAgICAgc210cC5vbmlkbGUgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgIGV4cGVjdChzbXRwLl9zZWN1cmVNb2RlKS50by5iZS50cnVlXG4gICAgICAgIHNtdHAub25jbG9zZSA9IGRvbmVcbiAgICAgICAgc210cC5xdWl0KClcbiAgICAgIH1cbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKCdTVEFSVFRMUyBpcyBkaXNhYmxlZCcsIGZ1bmN0aW9uICgpIHtcbiAgICBiZWZvcmUoZnVuY3Rpb24gKGRvbmUpIHtcbiAgICAgICAgICAgIC8vIHN0YXJ0IHNtdHAgdGVzdCBzZXJ2ZXJcbiAgICAgIHZhciBvcHRpb25zID0ge1xuICAgICAgICBkZWJ1ZzogZmFsc2UsXG4gICAgICAgIGRpc2FibGVETlNWYWxpZGF0aW9uOiB0cnVlLFxuICAgICAgICBwb3J0OiBwb3J0LFxuICAgICAgICBlbmFibGVBdXRoZW50aWNhdGlvbjogdHJ1ZSxcbiAgICAgICAgc2VjdXJlQ29ubmVjdGlvbjogZmFsc2UsXG4gICAgICAgIGlnbm9yZVRMUzogdHJ1ZSxcbiAgICAgICAgYXV0aE1ldGhvZHM6IFsnUExBSU4nLCAnTE9HSU4nLCAnWE9BVVRIMiddLFxuICAgICAgICBkaXNhYmxlU1RBUlRUTFM6IHRydWVcbiAgICAgIH1cblxuICAgICAgc2VydmVyID0gc2ltcGxlc210cC5jcmVhdGVTZXJ2ZXIob3B0aW9ucylcbiAgICAgIHNlcnZlci5vbignc3RhcnREYXRhJywgZnVuY3Rpb24gKC8qIGNvbm5lY3Rpb24gKi8pIHt9KVxuICAgICAgc2VydmVyLm9uKCdkYXRhJywgZnVuY3Rpb24gKC8qIGNvbm5lY3Rpb24sIGNodW5rICovKSB7fSlcbiAgICAgIHNlcnZlci5vbignZGF0YVJlYWR5JywgZnVuY3Rpb24gKGNvbm5lY3Rpb24sIGNhbGxiYWNrKSB7XG4gICAgICAgIGNhbGxiYWNrKG51bGwsICdmb28nKVxuICAgICAgfSlcbiAgICAgIHNlcnZlci5vbignYXV0aG9yaXplVXNlcicsIGZ1bmN0aW9uIChjb25uZWN0aW9uLCB1c2VybmFtZSwgcGFzc3dvcmQsIGNhbGxiYWNrKSB7XG4gICAgICAgIGNhbGxiYWNrKG51bGwsIHVzZXJuYW1lID09PSAnYWJjJyAmJiBwYXNzd29yZCA9PT0gJ2RlZicpXG4gICAgICB9KVxuICAgICAgc2VydmVyLmxpc3RlbihvcHRpb25zLnBvcnQsIGRvbmUpXG4gICAgfSlcblxuICAgIGFmdGVyKGZ1bmN0aW9uIChkb25lKSB7XG4gICAgICAgICAgICAvLyBjbG9zZSBzbXRwIHRlc3Qgc2VydmVyXG4gICAgICBzZXJ2ZXIuZW5kKGRvbmUpXG4gICAgfSlcblxuICAgIGl0KCdzaG91bGQgY29ubmVjdCBpbnNlY3VyZWx5JywgZnVuY3Rpb24gKGRvbmUpIHtcbiAgICAgIHZhciBzbXRwID0gbmV3IFNtdHBDbGllbnQoJzEyNy4wLjAuMScsIHBvcnQsIHtcbiAgICAgICAgdXNlU2VjdXJlVHJhbnNwb3J0OiBmYWxzZSxcbiAgICAgICAgYXV0aDoge1xuICAgICAgICAgIHVzZXI6ICdhYmMnLFxuICAgICAgICAgIHBhc3M6ICdkZWYnXG4gICAgICAgIH1cbiAgICAgIH0pXG4gICAgICBzbXRwLmxvZ0xldmVsID0gc210cC5MT0dfTEVWRUxfTk9ORVxuICAgICAgZXhwZWN0KHNtdHApLnRvLmV4aXN0XG5cbiAgICAgIHNtdHAuY29ubmVjdCgpXG4gICAgICBzbXRwLm9uaWRsZSA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgZXhwZWN0KHNtdHAuX3NlY3VyZU1vZGUpLnRvLmJlLmZhbHNlXG4gICAgICAgIHNtdHAub25jbG9zZSA9IGRvbmVcbiAgICAgICAgc210cC5xdWl0KClcbiAgICAgIH1cbiAgICB9KVxuXG4gICAgaXQoJ3Nob3VsZCBmYWlsIGNvbm5lY3RpbmcgdG8gaW5zZWN1cmUgc2VydmVyJywgZnVuY3Rpb24gKGRvbmUpIHtcbiAgICAgIHZhciBzbXRwID0gbmV3IFNtdHBDbGllbnQoJzEyNy4wLjAuMScsIHBvcnQsIHtcbiAgICAgICAgdXNlU2VjdXJlVHJhbnNwb3J0OiBmYWxzZSxcbiAgICAgICAgYXV0aDoge1xuICAgICAgICAgIHVzZXI6ICdhYmMnLFxuICAgICAgICAgIHBhc3M6ICdkZWYnXG4gICAgICAgIH0sXG4gICAgICAgIHJlcXVpcmVUTFM6IHRydWVcbiAgICAgIH0pXG4gICAgICBzbXRwLmxvZ0xldmVsID0gc210cC5MT0dfTEVWRUxfTk9ORVxuICAgICAgZXhwZWN0KHNtdHApLnRvLmV4aXN0XG5cbiAgICAgIHNtdHAuY29ubmVjdCgpXG5cbiAgICAgIHNtdHAub25lcnJvciA9IGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgZXhwZWN0KGVycikudG8uZXhpc3RcbiAgICAgICAgZXhwZWN0KHNtdHAuX3NlY3VyZU1vZGUpLnRvLmJlLmZhbHNlXG4gICAgICAgIHNtdHAub25jbG9zZSA9IGRvbmVcbiAgICAgICAgc210cC5xdWl0KClcbiAgICAgIH1cbiAgICB9KVxuICB9KVxuXG4gIGRlc2NyaWJlKCdubyBTVEFSVFRMUyBiZWNhdXNlIG5vIEVITE8sIG9ubHkgSEVMTycsIGZ1bmN0aW9uICgpIHtcbiAgICBiZWZvcmUoZnVuY3Rpb24gKGRvbmUpIHtcbiAgICAgICAgICAgIC8vIHN0YXJ0IHNtdHAgdGVzdCBzZXJ2ZXJcbiAgICAgIHZhciBvcHRpb25zID0ge1xuICAgICAgICBkZWJ1ZzogZmFsc2UsXG4gICAgICAgIGRpc2FibGVETlNWYWxpZGF0aW9uOiB0cnVlLFxuICAgICAgICBwb3J0OiBwb3J0LFxuICAgICAgICBlbmFibGVBdXRoZW50aWNhdGlvbjogdHJ1ZSxcbiAgICAgICAgc2VjdXJlQ29ubmVjdGlvbjogZmFsc2UsXG4gICAgICAgIGRpc2FibGVFSExPOiB0cnVlLFxuICAgICAgICBpZ25vcmVUTFM6IHRydWUsXG4gICAgICAgIGF1dGhNZXRob2RzOiBbJ1BMQUlOJywgJ0xPR0lOJywgJ1hPQVVUSDInXSxcbiAgICAgICAgZGlzYWJsZVNUQVJUVExTOiB0cnVlXG4gICAgICB9XG5cbiAgICAgIHNlcnZlciA9IHNpbXBsZXNtdHAuY3JlYXRlU2VydmVyKG9wdGlvbnMpXG4gICAgICBzZXJ2ZXIub24oJ3N0YXJ0RGF0YScsIGZ1bmN0aW9uICgvKiBjb25uZWN0aW9uICovKSB7fSlcbiAgICAgIHNlcnZlci5vbignZGF0YScsIGZ1bmN0aW9uICgvKiBjb25uZWN0aW9uLCBjaHVuayAqLykge30pXG4gICAgICBzZXJ2ZXIub24oJ2RhdGFSZWFkeScsIGZ1bmN0aW9uIChjb25uZWN0aW9uLCBjYWxsYmFjaykge1xuICAgICAgICBjYWxsYmFjayhudWxsLCAnZm9vJylcbiAgICAgIH0pXG4gICAgICBzZXJ2ZXIub24oJ2F1dGhvcml6ZVVzZXInLCBmdW5jdGlvbiAoY29ubmVjdGlvbiwgdXNlcm5hbWUsIHBhc3N3b3JkLCBjYWxsYmFjaykge1xuICAgICAgICBjYWxsYmFjayhudWxsLCB1c2VybmFtZSA9PT0gJ2FiYycgJiYgcGFzc3dvcmQgPT09ICdkZWYnKVxuICAgICAgfSlcbiAgICAgIHNlcnZlci5saXN0ZW4ob3B0aW9ucy5wb3J0LCBkb25lKVxuICAgIH0pXG5cbiAgICBhZnRlcihmdW5jdGlvbiAoZG9uZSkge1xuICAgICAgICAgICAgLy8gY2xvc2Ugc210cCB0ZXN0IHNlcnZlclxuICAgICAgc2VydmVyLmVuZChkb25lKVxuICAgIH0pXG5cbiAgICBpdCgnc2hvdWxkIGZhaWwgY29ubmVjdGluZyB0byBpbnNlY3VyZSBzZXJ2ZXInLCBmdW5jdGlvbiAoZG9uZSkge1xuICAgICAgdmFyIHNtdHAgPSBuZXcgU210cENsaWVudCgnMTI3LjAuMC4xJywgcG9ydCwge1xuICAgICAgICB1c2VTZWN1cmVUcmFuc3BvcnQ6IGZhbHNlLFxuICAgICAgICBhdXRoOiB7XG4gICAgICAgICAgdXNlcjogJ2FiYycsXG4gICAgICAgICAgcGFzczogJ2RlZidcbiAgICAgICAgfSxcbiAgICAgICAgcmVxdWlyZVRMUzogdHJ1ZVxuICAgICAgfSlcbiAgICAgIHNtdHAubG9nTGV2ZWwgPSBzbXRwLkxPR19MRVZFTF9OT05FXG4gICAgICBleHBlY3Qoc210cCkudG8uZXhpc3RcblxuICAgICAgc210cC5jb25uZWN0KClcblxuICAgICAgc210cC5vbmVycm9yID0gZnVuY3Rpb24gKGVycikge1xuICAgICAgICBleHBlY3QoZXJyKS50by5leGlzdFxuICAgICAgICBleHBlY3QoZXJyLm1lc3NhZ2UpLnRvLmVxdWFsKCdTVEFSVFRMUyBub3Qgc3VwcG9ydGVkIHdpdGhvdXQgRUhMTycpXG4gICAgICAgIGV4cGVjdChzbXRwLl9zZWN1cmVNb2RlKS50by5iZS5mYWxzZVxuICAgICAgICBzbXRwLm9uY2xvc2UgPSBkb25lXG4gICAgICAgIHNtdHAucXVpdCgpXG4gICAgICB9XG4gICAgfSlcbiAgfSlcbn0pXG4iXX0=