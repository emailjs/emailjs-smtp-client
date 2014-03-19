require.config({
    baseUrl: 'lib',
    paths: {
        'test': '..'
    },
    shim: {
        sinon: {
            exports: 'sinon',
        }
    }
});


mocha.setup('bdd');
require(['test/smtpclient-unit'], function() {
    'use strict';
    (window.mochaPhantomJS || window.mocha).run();
});