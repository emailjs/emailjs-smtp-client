'use strict';

(function(factory) {
    if (typeof define === 'function' && define.amd) {
        define(['chai', '../../src/emailjs-smtp-client-response-parser'], factory.bind(null, sinon));
    } else if (typeof exports === 'object') {
        module.exports = factory(require('sinon'), require('chai'), require('../../src/emailjs-smtp-client-response-parser'));
    }
}(function(sinon, chai, SmtpResponseParser) {
    var expect = chai.expect;
    chai.config.includeStack = true;

    describe('smtpclient response parser unit tests', function() {
        var parser;

        beforeEach(function() {
            parser = new SmtpResponseParser();
        });

        afterEach(function() {});

        describe('#send', function() {
            it('should emit error on closed parser', function() {
                sinon.stub(parser, 'onerror');

                parser.destroyed = true;
                parser.send('abc');

                expect(parser.onerror.callCount).to.equal(1);
                expect(parser.onerror.args[0][0] instanceof Error).to.be.true;

                parser.onerror.restore();
            });

            it('should process sent lines', function() {
                sinon.stub(parser, '_processLine');

                parser._remainder = 'a';
                parser.send('bc\r\ndef\nghi');

                expect(parser._processLine.callCount).to.equal(2);
                expect(parser._processLine.args[0][0]).to.equal('abc');
                expect(parser._processLine.args[1][0]).to.equal('def');
                expect(parser._remainder).to.equal('ghi');

                parser._processLine.restore();
            });
        });

        describe('#end', function() {
            it('should emit error on closed parser', function() {
                sinon.stub(parser, 'onerror');

                parser.destroyed = true;
                parser.end();

                expect(parser.onerror.callCount).to.equal(1);
                expect(parser.onerror.args[0][0] instanceof Error).to.be.true;

                parser.onerror.restore();
            });

            it('process the remainder and emit onend', function() {
                sinon.stub(parser, '_processLine');
                sinon.stub(parser, 'onend');

                parser._remainder = 'abc';
                parser.end();

                expect(parser._processLine.withArgs('abc').callCount).to.equal(1);
                expect(parser.onend.callCount).to.equal(1);

                parser._processLine.restore();
                parser.onend.restore();
            });
        });

        describe('#_processLine', function() {
            it('should parse and emit a single line response', function() {
                sinon.stub(parser, 'ondata');

                parser._processLine('250 1.1.1 Ok');
                expect(parser.ondata.withArgs({
                    statusCode: 250,
                    enhancedStatus: '1.1.1',
                    data: 'Ok',
                    line: '250 1.1.1 Ok',
                    success: true
                }).callCount).to.equal(1);

                parser.ondata.restore();
            });

            it('should parse and emit a multi line response', function() {
                sinon.stub(parser, 'ondata');

                parser._processLine('250-Ok 1');
                parser._processLine('250-Ok 2');
                parser._processLine('250 Ok 3');

                expect(parser.ondata.withArgs({
                    statusCode: 250,
                    enhancedStatus: null,
                    data: 'Ok 1\nOk 2\nOk 3',
                    line: '250-Ok 1\n250-Ok 2\n250 Ok 3',
                    success: true
                }).callCount).to.equal(1);

                parser.ondata.restore();
            });

            it('should emit an error on invalid input', function() {
                sinon.stub(parser, 'onerror');

                parser._processLine('zzzz');

                expect(parser.onerror.callCount).to.equal(1);
                expect(parser.onerror.args[0][0] instanceof Error).to.be.true;

                parser.onerror.restore();
            });
        });
    });
}));
