define(['chai', 'sinon', 'smtpclient'], function(chai, sinon, SmtpClient) {
    'use strict';

    var expect = chai.expect;
    chai.Assertion.includeStack = true;

    describe('smtpclient unit tests', function() {
        var smtp;
        var host, port, options;
        var TCPSocket;

        TCPSocket = navigator.TCPSocket = function() {};
        TCPSocket.open = function() {};
        TCPSocket.prototype.close = function() {};
        TCPSocket.prototype.send = function() {};

        beforeEach(function() {
            host = '127.0.0.1',
            port = 10000,
            options = {
                useSSL: true,
                ca: 'WOW. SUCH CERT. MUCH TLS.'
            };

            smtp = new SmtpClient(host, port, options);
            expect(smtp).to.exist;
        });

        afterEach(function() {});

        describe('#connect', function() {
            var openStub, socketStub;

            beforeEach(function() {
                socketStub = sinon.createStubInstance(TCPSocket);
                openStub = sinon.stub(TCPSocket, 'open');
            });

            afterEach(function() {
                TCPSocket.open.restore();
            });

            it('should instantiate a socket', function() {
                openStub.withArgs(host, port).returns(socketStub);

                smtp.connect();

                expect(openStub.callCount).to.equal(1);
                expect(socketStub.onerror).to.exist;
                expect(socketStub.onopen).to.exist;
            });
        });
    });
});