# SMTP Client

SMTP Client allows you to connect to and stream data to a SMTP server from FirefoxOS

## Quirks

  * `STARTTLS` is currently not supported
  * Only `PLAIN` and `USER` authentication mechanisms are supported

## Usage

### AMD

Require [smtpclient.js](smtpclient.js) as `smtpclient`

### Global context

Include files [smtpResponseParser.js](smtpResponseParser.js) and [smtpclient.js](smtpclient.js) on the page.

```html
<script src="smtpResponseParser.js"></script>
<script src="smtpclient.js"></script>
```

This exposes global variable `smtpclient`

### Ensure privileges

Opening TCP sockets to a SMTP server requires special privileges. You need to set the type of your application to "privileged" and add "tcp-socket" to the permissions list in the application manifest.

```
{
    "type" : "privileged",
    "permissions": {
        "tcp-socket": {
            "description" : "SMTP access"
        }
    },
    ...
}
```

## API

Create `smtpclient` object with:

```javascript
var client = smtpclient(host, port, options)
```

where

  * **host** is the hostname to connect to (defaults to "localhost")
  * **port** is the port to connect to
  * **options** is an optional options object (see below)

## Connection options

The following connection options can be used with `simplesmtp.connect`:

  * **useSSL** *Boolean* Set to true, to use encrypted connection
  * **name** *String* Client hostname for introducing itself to the server
  * **auth** *Object* Authentication options. Depends on the preferred authentication method. Usually `{user, pass}`
  * **authMethod** *String* Force specific authentication method (eg. `"PLAIN"` for using `AUTH PLAIN`)
  * **disableEscaping** *Boolean* If set to true, do not escape dots on the beginning of the lines
  * **logLength** *Number* How many messages between the client and the server to log. Set to false to disable logging. Defaults to 6

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
    if(alreadySending){
        return;
    }
    alreadySending = true;
    client.useEnvelope({
        from: "me@example.com",
        to: ["receiver1@example.com", "receiver2@example.com"]
    });
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
        console.log("The following addresses were rejected: ", failedRecipients);
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

```
client.ondone = function(success){
    if(success){
        console.log("The message was transmitted successfully with "+response);
    }
}
```

## Logging

At any time you can access the traffic log between the client and the server from the `client.log` array.

```javascript
client.ondone = function(success){
    // show the last message
    console.log(client.log.slice(-1));
}
```

## Closing the connection

Once you have done sending messages and do not want to keep the connection open, you can gracefully close the connection with `client.quit()` or non-gracefully (if you just want to shut down the connection and do not care for the server) with `client.close()`.

If you run `quit` or `close` in the `ondone` event, then the next `onidle` is never called.

## Tests

Unit tests for firemail reside in the [example app](https://github.com/Kreata/firemail-example).

## License

**MIT**
