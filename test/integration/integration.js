require.config({
    baseUrl: '../lib',
    paths: {
        'test': '..',
        'punycode': 'punycode.min',
        'forge': 'forge.min',
        'stringencoding': 'stringencoding.min'
    },
    shim: {
        forge: {
            exports: 'forge'
        }
    }
});

mocha.setup('bdd');
require(['../integration/smtpclient-test'], function() {
    'use strict';

    window.mocha.run();
});