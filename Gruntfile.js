module.exports = function(grunt) {
    'use strict';

    // Project configuration.
    grunt.initConfig({
        jshint: {
            all: ['*.js', 'src/*.js', 'test/unit/*.js', 'test/integration/*.js', 'test/chrome/*.js'],
            options: {
                jshintrc: '.jshintrc'
            }
        },

        connect: {
            dev: {
                options: {
                    port: 12345,
                    base: '.',
                    keepalive: true
                }
            }
        },

        mochaTest: {
            test: {
                options: {
                    reporter: 'spec'
                },
                src: ['test/unit/*-test.js', 'test/integration/*-test.js']
            }
        },

        mocha_phantomjs: {
            all: {
                options: {
                    reporter: 'spec'
                },
                src: ['test/unit/unit.html']
            }
        },

        watch: {
            js: {
                files: ['src/*.js'],
                tasks: ['deps']
            }
        },

        copy: {
            npm: {
                expand: true,
                flatten: false,
                cwd: 'node_modules/',
                src: [
                    'arraybuffer-slice/index.js',
                    'emailjs-tcp-socket/src/*.js',
                    'node-forge/js/forge.min.js',
                    'emailjs-stringencoding/src/*.js',
                    'mocha/mocha.js',
                    'mocha/mocha.css',
                    'chai/chai.js',
                    'sinon/pkg/sinon.js',
                    'requirejs/require.js',
                    'emailjs-mime-codec/src/*.js',
                    'punycode/punycode.min.js'
                ],
                dest: 'test/lib/',
                rename: function(dest, src) {
                    if (src === 'arraybuffer-slice/index.js') {
                        // 'index.js' is obviously a good name for a polyfill. duh.
                        return dest + 'arraybuffer-slice.js';
                    }
                    return dest + '/' + src.split('/').pop();
                }
            },
            app: {
                expand: true,
                flatten: true,
                cwd: 'src/',
                src: [
                    '*.js',
                ],
                dest: 'test/lib/'
            },
            "chrome-npm": {
                expand: true,
                flatten: true,
                cwd: 'node_modules/',
                src: [
                    'emailjs-tcp-socket/src/*.js',
                    'node-forge/js/forge.min.js',
                    'emailjs-stringencoding/src/*.js',
                    'mocha/mocha.js',
                    'mocha/mocha.css',
                    'chai/chai.js',
                    'sinon/pkg/sinon.js',
                    'requirejs/require.js',
                    'emailjs-mime-codec/src/*.js',
                    'punycode/punycode.min.js'
                ],
                dest: 'test/chrome/lib/'
            },
            "chrome-app": {
                expand: true,
                flatten: true,
                cwd: 'src/',
                src: [
                    '*.js',
                ],
                dest: 'test/chrome/lib/'
            }
        },
        clean: ['test/lib/**/*', 'test/chrome/lib/**/*']
    });

    // Load the plugin(s)
    grunt.loadNpmTasks('grunt-contrib-jshint');
    grunt.loadNpmTasks('grunt-mocha-phantomjs');
    grunt.loadNpmTasks('grunt-contrib-connect');
    grunt.loadNpmTasks('grunt-contrib-watch');
    grunt.loadNpmTasks('grunt-contrib-copy');
    grunt.loadNpmTasks('grunt-contrib-clean');
    grunt.loadNpmTasks('grunt-mocha-test');

    // Tasks
    grunt.registerTask('simplesmtp', function() {
        var simplesmtp = require('simplesmtp');

        var secureOptions = {
            debug: false,
            disableDNSValidation: true,
            port: 10000,
            enableAuthentication: true,
            secureConnection: true,
            credentials: {
                key: '-----BEGIN RSA PRIVATE KEY-----\r\nMIICXQIBAAKBgQC9Em0BRVjucpRsqB8Y/GQizRpPwETz2aBXHyhNQAcNHtcbPphd\r\nx65atAMaDiPjYnVte1kwa6KsdizMB4A1O3f5gbH4Bp1zAmZrZKt1XBPy05kM+fjx\r\n64Sx7KJr86jzzBi9TzOYu1DgUcb2WyND+FjPGQUSEhyeCWlAbqb64V2nmQIDAQAB\r\nAoGAdBx3srsatTzKZ7wLdPWyrSiWCvoBnls8u6QXxPEYI3eYFFQpkBYLvgokiYC7\r\ni22wva5thG3lddIRCq9kjcxajWJcobY3WB9l/oSS+6THnBh2K09HXIJOpp53lu93\r\n0svtSesfxUepgwqkIs209TbaFvJW1cZk0qpna2dNze0QmLECQQDd998Qfs9obaMP\r\nAd8JhnVKYhHPpXghAwgLXn6faO5t97C580e1bcN5A61KhDoqfEzQ3/aiS+H5H3/q\r\nA7nM4yz9AkEA2g9k8pOPSXUAa3ufjAoPPzmkL5uJqCN0lSuyTr5EU+TnNGyG/bCD\r\n2E3BaSn9IOEsL8woeYzB2BWOofp4kl91zQJAHOI0VKErvBsILNvBeivU92jriGmv\r\nyBvs4A3bzEKLRCQHCyttGV6/IPApjJjION8T39pE7bmSHijLLFhvxQmKwQJBAIus\r\nNKLUNYF9ugkepDFU+DMtPqdn3yKdoz0xQgMCCE4cXqPLqCOy/qB8HZi41nRLBryO\r\n7pX8vOUl2biS8MwA7TkCQQCpjbncHpTUI+glp/wLcFDwnbIzXCEtEaRUmkg5ED5K\r\n//xLNE+jr8ZZTwoz4RrVkKZ3UwksxQPYypdZPmZFj9ac\r\n-----END RSA PRIVATE KEY-----',
                cert: '-----BEGIN CERTIFICATE-----\r\nMIICKTCCAZICCQDW2h5P+naMbjANBgkqhkiG9w0BAQUFADBZMQswCQYDVQQGEwJB\r\nVTETMBEGA1UECBMKU29tZS1TdGF0ZTEhMB8GA1UEChMYSW50ZXJuZXQgV2lkZ2l0\r\ncyBQdHkgTHRkMRIwEAYDVQQDEwkxMjcuMC4wLjEwHhcNMTQwNzI4MTIzMDAxWhcN\r\nMTUwNzI4MTIzMDAxWjBZMQswCQYDVQQGEwJBVTETMBEGA1UECBMKU29tZS1TdGF0\r\nZTEhMB8GA1UEChMYSW50ZXJuZXQgV2lkZ2l0cyBQdHkgTHRkMRIwEAYDVQQDEwkx\r\nMjcuMC4wLjEwgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJAoGBAL0SbQFFWO5ylGyo\r\nHxj8ZCLNGk/ARPPZoFcfKE1ABw0e1xs+mF3Hrlq0AxoOI+NidW17WTBroqx2LMwH\r\ngDU7d/mBsfgGnXMCZmtkq3VcE/LTmQz5+PHrhLHsomvzqPPMGL1PM5i7UOBRxvZb\r\nI0P4WM8ZBRISHJ4JaUBupvrhXaeZAgMBAAEwDQYJKoZIhvcNAQEFBQADgYEApduD\r\nnAGm+VIMkCfLxWNegd41xS6Z89F/szTXjqnT14UnDc9CayOqxhsoWirukmEr7W9d\r\ngOTjGvG5X2k012VT1WTWinMHmyRJ4mM+caGTAJCE6Z314duhzOXrHhJUSHU5F9vs\r\nk9+qfs5ewmYBE3J6adnRCszn2VuoSRuof1MWRsU=\r\n-----END CERTIFICATE-----'
            }
        };

        var starttlsOptions = {
            debug: false,
            disableDNSValidation: true,
            port: 10001,
            enableAuthentication: true,
            secureConnection: false,
            ignoreTLS: false,
            credentials: {
                key: '-----BEGIN RSA PRIVATE KEY-----\r\nMIICXQIBAAKBgQC9Em0BRVjucpRsqB8Y/GQizRpPwETz2aBXHyhNQAcNHtcbPphd\r\nx65atAMaDiPjYnVte1kwa6KsdizMB4A1O3f5gbH4Bp1zAmZrZKt1XBPy05kM+fjx\r\n64Sx7KJr86jzzBi9TzOYu1DgUcb2WyND+FjPGQUSEhyeCWlAbqb64V2nmQIDAQAB\r\nAoGAdBx3srsatTzKZ7wLdPWyrSiWCvoBnls8u6QXxPEYI3eYFFQpkBYLvgokiYC7\r\ni22wva5thG3lddIRCq9kjcxajWJcobY3WB9l/oSS+6THnBh2K09HXIJOpp53lu93\r\n0svtSesfxUepgwqkIs209TbaFvJW1cZk0qpna2dNze0QmLECQQDd998Qfs9obaMP\r\nAd8JhnVKYhHPpXghAwgLXn6faO5t97C580e1bcN5A61KhDoqfEzQ3/aiS+H5H3/q\r\nA7nM4yz9AkEA2g9k8pOPSXUAa3ufjAoPPzmkL5uJqCN0lSuyTr5EU+TnNGyG/bCD\r\n2E3BaSn9IOEsL8woeYzB2BWOofp4kl91zQJAHOI0VKErvBsILNvBeivU92jriGmv\r\nyBvs4A3bzEKLRCQHCyttGV6/IPApjJjION8T39pE7bmSHijLLFhvxQmKwQJBAIus\r\nNKLUNYF9ugkepDFU+DMtPqdn3yKdoz0xQgMCCE4cXqPLqCOy/qB8HZi41nRLBryO\r\n7pX8vOUl2biS8MwA7TkCQQCpjbncHpTUI+glp/wLcFDwnbIzXCEtEaRUmkg5ED5K\r\n//xLNE+jr8ZZTwoz4RrVkKZ3UwksxQPYypdZPmZFj9ac\r\n-----END RSA PRIVATE KEY-----',
                cert: '-----BEGIN CERTIFICATE-----\r\nMIICKTCCAZICCQDW2h5P+naMbjANBgkqhkiG9w0BAQUFADBZMQswCQYDVQQGEwJB\r\nVTETMBEGA1UECBMKU29tZS1TdGF0ZTEhMB8GA1UEChMYSW50ZXJuZXQgV2lkZ2l0\r\ncyBQdHkgTHRkMRIwEAYDVQQDEwkxMjcuMC4wLjEwHhcNMTQwNzI4MTIzMDAxWhcN\r\nMTUwNzI4MTIzMDAxWjBZMQswCQYDVQQGEwJBVTETMBEGA1UECBMKU29tZS1TdGF0\r\nZTEhMB8GA1UEChMYSW50ZXJuZXQgV2lkZ2l0cyBQdHkgTHRkMRIwEAYDVQQDEwkx\r\nMjcuMC4wLjEwgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJAoGBAL0SbQFFWO5ylGyo\r\nHxj8ZCLNGk/ARPPZoFcfKE1ABw0e1xs+mF3Hrlq0AxoOI+NidW17WTBroqx2LMwH\r\ngDU7d/mBsfgGnXMCZmtkq3VcE/LTmQz5+PHrhLHsomvzqPPMGL1PM5i7UOBRxvZb\r\nI0P4WM8ZBRISHJ4JaUBupvrhXaeZAgMBAAEwDQYJKoZIhvcNAQEFBQADgYEApduD\r\nnAGm+VIMkCfLxWNegd41xS6Z89F/szTXjqnT14UnDc9CayOqxhsoWirukmEr7W9d\r\ngOTjGvG5X2k012VT1WTWinMHmyRJ4mM+caGTAJCE6Z314duhzOXrHhJUSHU5F9vs\r\nk9+qfs5ewmYBE3J6adnRCszn2VuoSRuof1MWRsU=\r\n-----END CERTIFICATE-----'
            }
        };

        grunt.log.writeln('> Starting SMTP servers on port ' + secureOptions.port + ' (SSL) and port ' + starttlsOptions.port + ' (STARTTLS)');

        var secureServer = simplesmtp.createServer(secureOptions);
        secureServer.on('startData', function( /*connection*/ ) {});
        secureServer.on('data', function( /*connection, chunk*/ ) {});
        secureServer.on('dataReady', function(connection, callback) {
            callback(null, 'foo');
        });
        secureServer.on('authorizeUser', function(connection, username, password, callback) {
            callback(null, username === 'abc' && password === 'def');
        });

        var starttlsServer = simplesmtp.createServer(starttlsOptions);
        starttlsServer.on('startData', function( /*connection*/ ) {});
        starttlsServer.on('data', function( /*connection, chunk*/ ) {});
        starttlsServer.on('dataReady', function(connection, callback) {
            callback(null, 'foo');
        });
        starttlsServer.on('authorizeUser', function(connection, username, password, callback) {
            callback(null, username === 'abc' && password === 'def');
        });

        secureServer.listen(secureOptions.port, function(err) {
            if (err) {
                grunt.fatal(err);
            }
            grunt.log.write('> Listening on port ' + secureOptions.port + '...\n');

            starttlsServer.listen(starttlsOptions.port, function(err) {
                if (err) {
                    grunt.fatal(err);
                }
                grunt.log.write('> Listening on port ' + starttlsOptions.port + '...\n');
            });
        });

        this.async();
    });

    grunt.registerTask('smtp', ['deps', 'simplesmtp']);
    grunt.registerTask('dev', ['jshint', 'deps', 'connect']);
    grunt.registerTask('deps', ['clean', 'copy']);
    grunt.registerTask('test', ['jshint', 'mocha_phantomjs', 'mochaTest']);
    grunt.registerTask('default', ['deps', 'test']);
};
