class SmtpResponseParser {
  /**
   * Generates a parser object for data coming from a SMTP server
   */
  constructor () {
    this.destroyed = false // If set to true, do not accept any more input

    // Event placeholders
    // NB! Errors do not block, the parsing and data emitting continues despite of the errors
    this.onerror = () => { }
    this.ondata = () => { }
    this.onend = () => { }

    this._block = { data: [], lines: [], statusCode: null } // If the response is a list, contains previous not yet emitted lines
    this._remainder = '' // If the complete line is not received yet, contains the beginning of it
  }

  /**
   * Queue some data from the server for parsing. Only allowed, if 'end' has not been called yet
   *
   * @param {String} chunk Chunk of data received from the server
   */
  send (chunk) {
    if (this.destroyed) {
      return this.onerror(new Error('This parser has already been closed, "write" is prohibited'))
    }

    // Lines should always end with <CR><LF> but you never know, might be only <LF> as well
    var lines = (this._remainder + (chunk || '')).split(/\r?\n/)
    this._remainder = lines.pop() // not sure if the line has completely arrived yet

    for (var i = 0, len = lines.length; i < len; i++) {
      this._processLine(lines[i])
    }
  }

  /**
   * Indicate that all the data from the server has been received. Can be called only once.
   *
   * @param {String} [chunk] Chunk of data received from the server
   */
  end (chunk) {
    if (this.destroyed) {
      return this.onerror(new Error('This parser has already been closed, "end" is prohibited'))
    }

    if (chunk) {
      this.send(chunk)
    }

    if (this._remainder) {
      this._processLine(this._remainder)
    }

    this.destroyed = true
    this.onend()
  }

  // Private API

  /**
   * Processes a single and complete line. If it is a continous one (slash after status code),
   * queue it to this._block
   *
   * @param {String} line Complete line of data from the server
   */
  _processLine (line) {
    var match, response

    // possible input strings for the regex:
    // 250-MESSAGE
    // 250 MESSAGE
    // 250 1.2.3 MESSAGE

    if (!line.trim()) {
      // nothing to check, empty line
      return
    }

    this._block.lines.push(line)

    if ((match = line.match(/^(\d{3})([- ])(?:(\d+\.\d+\.\d+)(?: ))?(.*)/))) {
      this._block.data.push(match[4])

      if (match[2] === '-') {
        if (this._block.statusCode && this._block.statusCode !== Number(match[1])) {
          this.onerror('Invalid status code ' + match[1] +
            ' for multi line response (' + this._block.statusCode + ' expected)')
        } else if (!this._block.statusCode) {
          this._block.statusCode = Number(match[1])
        }
      } else {
        response = {
          statusCode: Number(match[1]) || 0,
          enhancedStatus: match[3] || null,
          data: this._block.data.join('\n'),
          line: this._block.lines.join('\n')
        }
        response.success = response.statusCode >= 200 && response.statusCode < 300

        this.ondata(response)
        this._block = {
          data: [],
          lines: [],
          statusCode: null
        }
        this._block.statusCode = null
      }
    } else {
      this.onerror(new Error('Invalid SMTP response "' + line + '"'))
      this.ondata({
        success: false,
        statusCode: this._block.statusCode || null,
        enhancedStatus: null,
        data: [line].join('\n'),
        line: this._block.lines.join('\n')
      })
      this._block = {
        data: [],
        lines: [],
        statusCode: null
      }
    }
  }
}

export default SmtpResponseParser
