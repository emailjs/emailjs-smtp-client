define(['chai', 'smtpclient'], function(chai, SmtpClient) {
    'use strict';

    var expect = chai.expect;
    chai.Assertion.includeStack = true;

    describe('smtpclient chrome integration tests', function() {
        var smtp;

        beforeEach(function(done) {
            // smtp = new SmtpClient('127.0.0.1', 10000);
            smtp = new SmtpClient('127.0.0.1', 10000, {
                useSecureTransport: true,
                ca: '-----BEGIN CERTIFICATE-----\r\nMIICKTCCAZICCQDW2h5P+naMbjANBgkqhkiG9w0BAQUFADBZMQswCQYDVQQGEwJB\r\nVTETMBEGA1UECBMKU29tZS1TdGF0ZTEhMB8GA1UEChMYSW50ZXJuZXQgV2lkZ2l0\r\ncyBQdHkgTHRkMRIwEAYDVQQDEwkxMjcuMC4wLjEwHhcNMTQwNzI4MTIzMDAxWhcN\r\nMTUwNzI4MTIzMDAxWjBZMQswCQYDVQQGEwJBVTETMBEGA1UECBMKU29tZS1TdGF0\r\nZTEhMB8GA1UEChMYSW50ZXJuZXQgV2lkZ2l0cyBQdHkgTHRkMRIwEAYDVQQDEwkx\r\nMjcuMC4wLjEwgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJAoGBAL0SbQFFWO5ylGyo\r\nHxj8ZCLNGk/ARPPZoFcfKE1ABw0e1xs+mF3Hrlq0AxoOI+NidW17WTBroqx2LMwH\r\ngDU7d/mBsfgGnXMCZmtkq3VcE/LTmQz5+PHrhLHsomvzqPPMGL1PM5i7UOBRxvZb\r\nI0P4WM8ZBRISHJ4JaUBupvrhXaeZAgMBAAEwDQYJKoZIhvcNAQEFBQADgYEApduD\r\nnAGm+VIMkCfLxWNegd41xS6Z89F/szTXjqnT14UnDc9CayOqxhsoWirukmEr7W9d\r\ngOTjGvG5X2k012VT1WTWinMHmyRJ4mM+caGTAJCE6Z314duhzOXrHhJUSHU5F9vs\r\nk9+qfs5ewmYBE3J6adnRCszn2VuoSRuof1MWRsU=\r\n-----END CERTIFICATE-----',
                tlsWorkerPath: 'lib/tcp-socket-tls-worker.js'
            });
            expect(smtp).to.exist;

            smtp.oncert = function() {};
            smtp.connect();
            smtp.onidle = done;
        });

        it('should fail with invalid MAIL FROM', function(done) {
            smtp.onerror = function(err) {
                expect(err.message).to.equal('Bad sender address syntax');
                smtp.onclose = done;
            };

            smtp.useEnvelope({
                from: 'invalid',
                to: ['receiver@localhost']
            });
        });

        it('should fail with empty recipients', function(done) {
            smtp.onerror = function(err) {
                expect(err.message).to.equal('Can\'t send mail - no recipients defined');
                smtp.onclose = done;
            };

            smtp.useEnvelope({
                from: 'sender@example.com',
                to: []
            });
        });

        it('should fail with invalid recipients', function(done) {
            smtp.onerror = function(err) {
                expect(err.message).to.equal('Can\'t send mail - all recipients were rejected');
                smtp.onclose = done;
            };

            smtp.useEnvelope({
                from: 'sender@example.com',
                to: ['invalid']
            });
        });

        it('should pass RCPT TO', function(done) {
            smtp.onready = function(failed) {
                expect(failed).to.deep.equal([]);
                smtp.onclose = done;
                smtp.close();
            };

            smtp.useEnvelope({
                from: 'sender@example.com',
                to: ['receiver@example.com']
            });
        });

        it('should pass RCPT TO with some failures', function(done) {
            smtp.onready = function(failed) {
                expect(failed).to.deep.equal(['invalid']);
                smtp.onclose = done;
                smtp.close();
            };

            smtp.useEnvelope({
                from: 'sender@example.com',
                to: ['invalid', 'receiver@example.com']
            });
        });

        it('should succeed with DATA', function(done) {
            smtp.onidle = function() {
                smtp.onclose = done;
                smtp.quit();
            };

            smtp.onready = function(failedRecipients) {
                expect(failedRecipients).to.be.empty;

                smtp.send('Subject: test\r\n\r\nMessage body');
                smtp.end();
            };

            smtp.ondone = function(success) {
                expect(success).to.be.true;
            };

            smtp.useEnvelope({
                from: 'sender@localhost',
                to: ['receiver@localhost']
            });
        });

        it('should not idle', function(done) {
            smtp.onidle = function() {
                // should not run
                expect(true).to.be.false;
            };

            smtp.onready = function(failedRecipients) {
                expect(failedRecipients).to.be.empty;

                smtp.send('Subject: test\r\n\r\nMessage body');
                smtp.end();
            };

            smtp.ondone = function(success) {
                expect(success).to.be.true;
                smtp.onclose = done;
                smtp.quit();
            };

            smtp.useEnvelope({
                from: 'sender@localhost',
                to: ['receiver@localhost']
            });
        });
    });

    describe('smtpclient authentication tests', function() {
        it('should authenticate with default method', function(done) {
            var smtp = new SmtpClient('127.0.0.1', 10000, {
                useSecureTransport: true,
                ca: '-----BEGIN CERTIFICATE-----\r\nMIICKTCCAZICCQDW2h5P+naMbjANBgkqhkiG9w0BAQUFADBZMQswCQYDVQQGEwJB\r\nVTETMBEGA1UECBMKU29tZS1TdGF0ZTEhMB8GA1UEChMYSW50ZXJuZXQgV2lkZ2l0\r\ncyBQdHkgTHRkMRIwEAYDVQQDEwkxMjcuMC4wLjEwHhcNMTQwNzI4MTIzMDAxWhcN\r\nMTUwNzI4MTIzMDAxWjBZMQswCQYDVQQGEwJBVTETMBEGA1UECBMKU29tZS1TdGF0\r\nZTEhMB8GA1UEChMYSW50ZXJuZXQgV2lkZ2l0cyBQdHkgTHRkMRIwEAYDVQQDEwkx\r\nMjcuMC4wLjEwgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJAoGBAL0SbQFFWO5ylGyo\r\nHxj8ZCLNGk/ARPPZoFcfKE1ABw0e1xs+mF3Hrlq0AxoOI+NidW17WTBroqx2LMwH\r\ngDU7d/mBsfgGnXMCZmtkq3VcE/LTmQz5+PHrhLHsomvzqPPMGL1PM5i7UOBRxvZb\r\nI0P4WM8ZBRISHJ4JaUBupvrhXaeZAgMBAAEwDQYJKoZIhvcNAQEFBQADgYEApduD\r\nnAGm+VIMkCfLxWNegd41xS6Z89F/szTXjqnT14UnDc9CayOqxhsoWirukmEr7W9d\r\ngOTjGvG5X2k012VT1WTWinMHmyRJ4mM+caGTAJCE6Z314duhzOXrHhJUSHU5F9vs\r\nk9+qfs5ewmYBE3J6adnRCszn2VuoSRuof1MWRsU=\r\n-----END CERTIFICATE-----',
                auth: {
                    user: 'abc',
                    pass: 'def'
                },
                tlsWorkerPath: 'lib/tcp-socket-tls-worker.js'
            });
            expect(smtp).to.exist;

            smtp.connect();
            smtp.onidle = function() {
                smtp.onclose = done;
                smtp.quit();
            };
        });

        it('should authenticate with AUTH LOGIN', function(done) {
            var smtp = new SmtpClient('127.0.0.1', 10000, {
                useSecureTransport: true,
                ca: '-----BEGIN CERTIFICATE-----\r\nMIICKTCCAZICCQDW2h5P+naMbjANBgkqhkiG9w0BAQUFADBZMQswCQYDVQQGEwJB\r\nVTETMBEGA1UECBMKU29tZS1TdGF0ZTEhMB8GA1UEChMYSW50ZXJuZXQgV2lkZ2l0\r\ncyBQdHkgTHRkMRIwEAYDVQQDEwkxMjcuMC4wLjEwHhcNMTQwNzI4MTIzMDAxWhcN\r\nMTUwNzI4MTIzMDAxWjBZMQswCQYDVQQGEwJBVTETMBEGA1UECBMKU29tZS1TdGF0\r\nZTEhMB8GA1UEChMYSW50ZXJuZXQgV2lkZ2l0cyBQdHkgTHRkMRIwEAYDVQQDEwkx\r\nMjcuMC4wLjEwgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJAoGBAL0SbQFFWO5ylGyo\r\nHxj8ZCLNGk/ARPPZoFcfKE1ABw0e1xs+mF3Hrlq0AxoOI+NidW17WTBroqx2LMwH\r\ngDU7d/mBsfgGnXMCZmtkq3VcE/LTmQz5+PHrhLHsomvzqPPMGL1PM5i7UOBRxvZb\r\nI0P4WM8ZBRISHJ4JaUBupvrhXaeZAgMBAAEwDQYJKoZIhvcNAQEFBQADgYEApduD\r\nnAGm+VIMkCfLxWNegd41xS6Z89F/szTXjqnT14UnDc9CayOqxhsoWirukmEr7W9d\r\ngOTjGvG5X2k012VT1WTWinMHmyRJ4mM+caGTAJCE6Z314duhzOXrHhJUSHU5F9vs\r\nk9+qfs5ewmYBE3J6adnRCszn2VuoSRuof1MWRsU=\r\n-----END CERTIFICATE-----',
                auth: {
                    user: 'abc',
                    pass: 'def'
                },
                authMethod: 'LOGIN',
                tlsWorkerPath: 'lib/tcp-socket-tls-worker.js'
            });
            expect(smtp).to.exist;

            smtp.connect();
            smtp.onidle = function() {
                smtp.onclose = done;
                smtp.quit();
            };
        });

        it('should fail with invalid credentials', function(done) {
            var smtp = new SmtpClient('127.0.0.1', 10000, {
                useSecureTransport: true,
                ca: '-----BEGIN CERTIFICATE-----\r\nMIICKTCCAZICCQDW2h5P+naMbjANBgkqhkiG9w0BAQUFADBZMQswCQYDVQQGEwJB\r\nVTETMBEGA1UECBMKU29tZS1TdGF0ZTEhMB8GA1UEChMYSW50ZXJuZXQgV2lkZ2l0\r\ncyBQdHkgTHRkMRIwEAYDVQQDEwkxMjcuMC4wLjEwHhcNMTQwNzI4MTIzMDAxWhcN\r\nMTUwNzI4MTIzMDAxWjBZMQswCQYDVQQGEwJBVTETMBEGA1UECBMKU29tZS1TdGF0\r\nZTEhMB8GA1UEChMYSW50ZXJuZXQgV2lkZ2l0cyBQdHkgTHRkMRIwEAYDVQQDEwkx\r\nMjcuMC4wLjEwgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJAoGBAL0SbQFFWO5ylGyo\r\nHxj8ZCLNGk/ARPPZoFcfKE1ABw0e1xs+mF3Hrlq0AxoOI+NidW17WTBroqx2LMwH\r\ngDU7d/mBsfgGnXMCZmtkq3VcE/LTmQz5+PHrhLHsomvzqPPMGL1PM5i7UOBRxvZb\r\nI0P4WM8ZBRISHJ4JaUBupvrhXaeZAgMBAAEwDQYJKoZIhvcNAQEFBQADgYEApduD\r\nnAGm+VIMkCfLxWNegd41xS6Z89F/szTXjqnT14UnDc9CayOqxhsoWirukmEr7W9d\r\ngOTjGvG5X2k012VT1WTWinMHmyRJ4mM+caGTAJCE6Z314duhzOXrHhJUSHU5F9vs\r\nk9+qfs5ewmYBE3J6adnRCszn2VuoSRuof1MWRsU=\r\n-----END CERTIFICATE-----',
                auth: {
                    user: 'abcd',
                    pass: 'defe'
                },
                authMethod: 'LOGIN',
                tlsWorkerPath: 'lib/tcp-socket-tls-worker.js'
            });
            expect(smtp).to.exist;

            smtp.connect();
            smtp.onerror = function() {
                smtp.onclose = done;
            };
        });

        it('should authenticate with default method using STARTTLS', function(done) {
            var smtp = new SmtpClient('127.0.0.1', 10001, {
                useSecureTransport: false,
                //ca: '-----BEGIN CERTIFICATE-----\r\nMIICKTCCAZICCQDW2h5P+naMbjANBgkqhkiG9w0BAQUFADBZMQswCQYDVQQGEwJB\r\nVTETMBEGA1UECBMKU29tZS1TdGF0ZTEhMB8GA1UEChMYSW50ZXJuZXQgV2lkZ2l0\r\ncyBQdHkgTHRkMRIwEAYDVQQDEwkxMjcuMC4wLjEwHhcNMTQwNzI4MTIzMDAxWhcN\r\nMTUwNzI4MTIzMDAxWjBZMQswCQYDVQQGEwJBVTETMBEGA1UECBMKU29tZS1TdGF0\r\nZTEhMB8GA1UEChMYSW50ZXJuZXQgV2lkZ2l0cyBQdHkgTHRkMRIwEAYDVQQDEwkx\r\nMjcuMC4wLjEwgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJAoGBAL0SbQFFWO5ylGyo\r\nHxj8ZCLNGk/ARPPZoFcfKE1ABw0e1xs+mF3Hrlq0AxoOI+NidW17WTBroqx2LMwH\r\ngDU7d/mBsfgGnXMCZmtkq3VcE/LTmQz5+PHrhLHsomvzqPPMGL1PM5i7UOBRxvZb\r\nI0P4WM8ZBRISHJ4JaUBupvrhXaeZAgMBAAEwDQYJKoZIhvcNAQEFBQADgYEApduD\r\nnAGm+VIMkCfLxWNegd41xS6Z89F/szTXjqnT14UnDc9CayOqxhsoWirukmEr7W9d\r\ngOTjGvG5X2k012VT1WTWinMHmyRJ4mM+caGTAJCE6Z314duhzOXrHhJUSHU5F9vs\r\nk9+qfs5ewmYBE3J6adnRCszn2VuoSRuof1MWRsU=\r\n-----END CERTIFICATE-----',
                auth: {
                    user: 'abc',
                    pass: 'def'
                }
            });
            expect(smtp).to.exist;

            smtp.oncert = function() {};
            smtp.connect();
            smtp.onidle = function() {
                smtp.onclose = done;
                smtp.quit();
            };
        });
    });
});