# SMTP Client

[![Greenkeeper badge](https://badges.greenkeeper.io/emailjs/emailjs-smtp-client.svg)](https://greenkeeper.io/) [![Build Status](https://travis-ci.org/emailjs/emailjs-smtp-client.png?branch=master)](https://travis-ci.org/emailjs/emailjs-smtp-client) [![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)  [![ES6+](https://camo.githubusercontent.com/567e52200713e0f0c05a5238d91e1d096292b338/68747470733a2f2f696d672e736869656c64732e696f2f62616467652f65732d362b2d627269676874677265656e2e737667)](https://kangax.github.io/compat-table/es6/)

SMTP Client allows you to connect to and stream data to a SMTP server in the browser.

## API

Installation: `npm install emailjs-smtp-client`

Create `SmtpClient` object with:

```javascript
import SmtpClient from 'emailjs-smtp-client'
var client = new SmtpClient(host, port, options)
```

where

* **host** is the hostname to connect to (defaults to "localhost")
* **port** is the port to connect to
* **options** is an optional options object (see below)

## Connection options

The following connection options can be used with `simplesmtp.connect`:

* **useSecureTransport** *Boolean* Set to true, to use encrypted connection
* **name** *String* Client hostname for introducing itself to the server
* **auth** *Object* Authentication options. Depends on the preferred authentication method
  * **user** is the username for the user (also applies to OAuth2)
  * **pass** is the password for the user if plain auth is used
  * **xoauth2** is the OAuth2 access token to be used instead of password. If both password and xoauth2 token are set, the token is preferred.
  * **authMethod** *String* Force specific authentication method (eg. `"PLAIN"` for using `AUTH PLAIN` or `"XOAUTH2"` for `AUTH XOAUTH2`)
* **ca** (optional) (only in conjunction with this [TCPSocket shim](https://github.com/emailjs/emailjs-tcp-socket)) if you use TLS with forge, pin a PEM-encoded certificate as a string. Please refer to the [tcp-socket documentation](https://github.com/emailjs/emailjs-tcp-socket) for more information!
* **disableEscaping** *Boolean* If set to true, do not escape dots on the beginning of the lines
* **ignoreTLS** – if set to true, do not issue STARTTLS even if the server supports it
* **requireTLS** – if set to true, always use STARTTLS before authentication even if the host does not advertise it. If STARTTLS fails, do not try to authenticate the user
* **lmtp** - if set to true use LMTP commands instead of SMTP commands

Default STARTTLS support is opportunistic – if the server advertises STARTTLS in EHLO response, the client tries to use it. If STARTTLS is not advertised, the clients sends passwords in the plain. You can use `ignoreTLS` and `requireTLS` to change this behavior by explicitly enabling or disabling STARTTLS usage.

### XOAUTH2

To authenticate using XOAUTH2, use the following authentication config

```javascript
var config = {
  auth: {
    user: 'username',
    xoauth2: 'access_token'
  }
}
```

See [XOAUTH2 docs](https://developers.google.com/gmail/xoauth2_protocol#smtp_protocol_exchange) for more info.

## Connection events

Once a connection is set up the following events can be listened to:

* **onidle** - the connection to the SMTP server has been successfully set up and the client is waiting for an envelope. **NB!** this event is emitted multiple times - if an e-mail has been sent and the client has nothing to do, `onidle` is emitted again.
* **onready** `(failedRecipients)` - the envelope is passed successfully to the server and a message stream can be started. The argument is an array of e-mail addresses not accepted as recipients by the server. If none of the recipient addresses is accepted, `onerror` is emitted instead.
* **ondone** `(success)` - the message was sent
* **onerror** `(err)` - An error occurred. The connection will be closed shortly afterwards, so expect an `onclose` event as well
* **onclose** `(isError)` - connection to the client is closed. If `isError` is true, the connection is closed because of an error

Example:

```javascript
client.onidle = function(){
  console.log("Connection has been established");
  // this event will be called again once a message has been sent
  // so do not just initiate a new message here, as infinite loops might occur
}
```

## Sending an envelope

When an `onidle` event is emitted, an envelope object can be sent to the server.
This includes a string `from` and a single string or an array of strings for `to` property.

Envelope can be sent with `client.useEnvelope(envelope)`

```javascript
// run only once as 'idle' is emitted again after message delivery
var alreadySending = false;

client.onidle = function(){
  if(alreadySending) return

  alreadySending = true
  client.useEnvelope({
    from: "me@example.com",
    to: ["receiver1@example.com", "receiver2@example.com"]
  })
}
```

The `to` part of the envelope must include **all** recipients from `To:`, `Cc:` and `Bcc:` fields.

If envelope setup up fails, an error is emitted. If only some (not all)
recipients are not accepted, the mail can still be sent. An `onready` event
is emitted when the server has accepted the `from` and at least one `to`
address.

```javascript
client.onready = function(failedRecipients){
  if(failedRecipients.length){
    console.log("The following addresses were rejected: ", failedRecipients)
  }
  // start transfering the e-mail
}
```

## Sending a message

When `onready` event is emitted, it is possible to start sending mail. To do this
you can send the message with `client.send` calls (you also need to call `client.end()` once
the message is completed).

`send` method returns the state of the downstream buffer - if it returns `true`, it is safe to send more data, otherwise you should (but don't have to) wait for the `ondrain` event before you send more data.

**NB!** you do not have to escape the dots in the beginning of the lines by yourself (unless you specificly define so with `disableEscaping` option).

```javascript
client.onready = function(){
  client.send("Subject: test\r\n");
  client.send("\r\n");
  client.send("Message body");
  client.end();
}
```

Once the message is delivered an `ondone` event is emitted. The event has an
parameter which indicates if the message was accepted by the server (`true`) or not (`false`).

```javascript
client.ondone = function(success){
  if(success){
    console.log("The message was transmitted successfully");
  }
}
```

## Closing the connection

Once you have done sending messages and do not want to keep the connection open, you can gracefully close the connection with `client.quit()` or non-gracefully (if you just want to shut down the connection and do not care for the server) with `client.close()`.

If you run `quit` or `close` in the `ondone` event, then the next `onidle` is never called.

## Quirks

* `STARTTLS` is currently not supported
* Only `PLAIN`, `USER` and `XOAUTH2` authentication mechanisms are supported. `XOAUTH2` expects a ready to use access token, no tokens are generated automatically.

## License

Copyright (c) 2013 Andris Reinman

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
