'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var SmtpResponseParser = function () {
  /**
   * Generates a parser object for data coming from a SMTP server
   */
  function SmtpResponseParser() {
    _classCallCheck(this, SmtpResponseParser);

    this.destroyed = false; // If set to true, do not accept any more input

    // Event placeholders
    // NB! Errors do not block, the parsing and data emitting continues despite of the errors
    this.onerror = function () {};
    this.ondata = function () {};
    this.onend = function () {};

    this._block = { data: [], lines: [], statusCode: null // If the response is a list, contains previous not yet emitted lines
    };this._remainder = ''; // If the complete line is not received yet, contains the beginning of it
  }

  /**
   * Queue some data from the server for parsing. Only allowed, if 'end' has not been called yet
   *
   * @param {String} chunk Chunk of data received from the server
   */


  _createClass(SmtpResponseParser, [{
    key: 'send',
    value: function send(chunk) {
      if (this.destroyed) {
        return this.onerror(new Error('This parser has already been closed, "write" is prohibited'));
      }

      // Lines should always end with <CR><LF> but you never know, might be only <LF> as well
      var lines = (this._remainder + (chunk || '')).split(/\r?\n/);
      this._remainder = lines.pop(); // not sure if the line has completely arrived yet

      for (var i = 0, len = lines.length; i < len; i++) {
        this._processLine(lines[i]);
      }
    }

    /**
     * Indicate that all the data from the server has been received. Can be called only once.
     *
     * @param {String} [chunk] Chunk of data received from the server
     */

  }, {
    key: 'end',
    value: function end(chunk) {
      if (this.destroyed) {
        return this.onerror(new Error('This parser has already been closed, "end" is prohibited'));
      }

      if (chunk) {
        this.send(chunk);
      }

      if (this._remainder) {
        this._processLine(this._remainder);
      }

      this.destroyed = true;
      this.onend();
    }

    // Private API

    /**
     * Processes a single and complete line. If it is a continous one (slash after status code),
     * queue it to this._block
     *
     * @param {String} line Complete line of data from the server
     */

  }, {
    key: '_processLine',
    value: function _processLine(line) {
      var match, response;

      // possible input strings for the regex:
      // 250-MESSAGE
      // 250 MESSAGE
      // 250 1.2.3 MESSAGE

      if (!line.trim()) {
        // nothing to check, empty line
        return;
      }

      this._block.lines.push(line);

      if (match = line.match(/^(\d{3})([- ])(?:(\d+\.\d+\.\d+)(?: ))?(.*)/)) {
        this._block.data.push(match[4]);

        if (match[2] === '-') {
          if (this._block.statusCode && this._block.statusCode !== Number(match[1])) {
            this.onerror('Invalid status code ' + match[1] + ' for multi line response (' + this._block.statusCode + ' expected)');
          } else if (!this._block.statusCode) {
            this._block.statusCode = Number(match[1]);
          }
        } else {
          response = {
            statusCode: Number(match[1]) || 0,
            enhancedStatus: match[3] || null,
            data: this._block.data.join('\n'),
            line: this._block.lines.join('\n')
          };
          response.success = response.statusCode >= 200 && response.statusCode < 300;

          this.ondata(response);
          this._block = {
            data: [],
            lines: [],
            statusCode: null
          };
          this._block.statusCode = null;
        }
      } else {
        this.onerror(new Error('Invalid SMTP response "' + line + '"'));
        this.ondata({
          success: false,
          statusCode: this._block.statusCode || null,
          enhancedStatus: null,
          data: [line].join('\n'),
          line: this._block.lines.join('\n')
        });
        this._block = {
          data: [],
          lines: [],
          statusCode: null
        };
      }
    }
  }]);

  return SmtpResponseParser;
}();

exports.default = SmtpResponseParser;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9wYXJzZXIuanMiXSwibmFtZXMiOlsiU210cFJlc3BvbnNlUGFyc2VyIiwiZGVzdHJveWVkIiwib25lcnJvciIsIm9uZGF0YSIsIm9uZW5kIiwiX2Jsb2NrIiwiZGF0YSIsImxpbmVzIiwic3RhdHVzQ29kZSIsIl9yZW1haW5kZXIiLCJjaHVuayIsIkVycm9yIiwic3BsaXQiLCJwb3AiLCJpIiwibGVuIiwibGVuZ3RoIiwiX3Byb2Nlc3NMaW5lIiwic2VuZCIsImxpbmUiLCJtYXRjaCIsInJlc3BvbnNlIiwidHJpbSIsInB1c2giLCJOdW1iZXIiLCJlbmhhbmNlZFN0YXR1cyIsImpvaW4iLCJzdWNjZXNzIl0sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7O0lBQU1BLGtCO0FBQ0o7OztBQUdBLGdDQUFlO0FBQUE7O0FBQ2IsU0FBS0MsU0FBTCxHQUFpQixLQUFqQixDQURhLENBQ1U7O0FBRXZCO0FBQ0E7QUFDQSxTQUFLQyxPQUFMLEdBQWUsWUFBTSxDQUFHLENBQXhCO0FBQ0EsU0FBS0MsTUFBTCxHQUFjLFlBQU0sQ0FBRyxDQUF2QjtBQUNBLFNBQUtDLEtBQUwsR0FBYSxZQUFNLENBQUcsQ0FBdEI7O0FBRUEsU0FBS0MsTUFBTCxHQUFjLEVBQUVDLE1BQU0sRUFBUixFQUFZQyxPQUFPLEVBQW5CLEVBQXVCQyxZQUFZLElBQW5DLENBQTBDO0FBQTFDLEtBQWQsQ0FDQSxLQUFLQyxVQUFMLEdBQWtCLEVBQWxCLENBVmEsQ0FVUTtBQUN0Qjs7QUFFRDs7Ozs7Ozs7O3lCQUtNQyxLLEVBQU87QUFDWCxVQUFJLEtBQUtULFNBQVQsRUFBb0I7QUFDbEIsZUFBTyxLQUFLQyxPQUFMLENBQWEsSUFBSVMsS0FBSixDQUFVLDREQUFWLENBQWIsQ0FBUDtBQUNEOztBQUVEO0FBQ0EsVUFBSUosUUFBUSxDQUFDLEtBQUtFLFVBQUwsSUFBbUJDLFNBQVMsRUFBNUIsQ0FBRCxFQUFrQ0UsS0FBbEMsQ0FBd0MsT0FBeEMsQ0FBWjtBQUNBLFdBQUtILFVBQUwsR0FBa0JG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QUlWbkIsZ0JBQU0sQ0FBQ2EsSUFBRCxFQUFPTyxJQUFQLENBQVksSUFBWixDQUpJO0FBS1ZQLGdCQUFNLEtBQUtkLE1BQUwsQ0FBWUUsS0FBWixDQUFrQm1CLElBQWxCLENBQXVCLElBQXZCO0FBTEksU0FBWjtBQU9BLGFBQUtyQixNQUFMLEdBQWM7QUFDWkMsZ0JBQU0sRUFETTtBQUVaQyxpQkFBTyxFQUZLO0FBR1pDLHNCQUFZO0FBSEEsU0FBZDtBQUtEO0FBQ0Y7Ozs7OztrQkFHWVIsa0IiLCJmaWxlIjoicGFyc2VyLmpzIiwic291cmNlc0NvbnRlbnQiOlsiY2xhc3MgU210cFJlc3BvbnNlUGFyc2VyIHtcbiAgLyoqXG4gICAqIEdlbmVyYXRlcyBhIHBhcnNlciBvYmplY3QgZm9yIGRhdGEgY29taW5nIGZyb20gYSBTTVRQIHNlcnZlclxuICAgKi9cbiAgY29uc3RydWN0b3IgKCkge1xuICAgIHRoaXMuZGVzdHJveWVkID0gZmFsc2UgLy8gSWYgc2V0IHRvIHRydWUsIGRvIG5vdCBhY2NlcHQgYW55IG1vcmUgaW5wdXRcblxuICAgIC8vIEV2ZW50IHBsYWNlaG9sZGVyc1xuICAgIC8vIE5CISBFcnJvcnMgZG8gbm90IGJsb2NrLCB0aGUgcGFyc2luZyBhbmQgZGF0YSBlbWl0dGluZyBjb250aW51ZXMgZGVzcGl0ZSBvZiB0aGUgZXJyb3JzXG4gICAgdGhpcy5vbmVycm9yID0gKCkgPT4geyB9XG4gICAgdGhpcy5vbmRhdGEgPSAoKSA9PiB7IH1cbiAgICB0aGlzLm9uZW5kID0gKCkgPT4geyB9XG5cbiAgICB0aGlzLl9ibG9jayA9IHsgZGF0YTogW10sIGxpbmVzOiBbXSwgc3RhdHVzQ29kZTogbnVsbCB9IC8vIElmIHRoZSByZXNwb25zZSBpcyBhIGxpc3QsIGNvbnRhaW5zIHByZXZpb3VzIG5vdCB5ZXQgZW1pdHRlZCBsaW5lc1xuICAgIHRoaXMuX3JlbWFpbmRlciA9ICcnIC8vIElmIHRoZSBjb21wbGV0ZSBsaW5lIGlzIG5vdCByZWNlaXZlZCB5ZXQsIGNvbnRhaW5zIHRoZSBiZWdpbm5pbmcgb2YgaXRcbiAgfVxuXG4gIC8qKlxuICAgKiBRdWV1ZSBzb21lIGRhdGEgZnJvbSB0aGUgc2VydmVyIGZvciBwYXJzaW5nLiBPbmx5IGFsbG93ZWQsIGlmICdlbmQnIGhhcyBub3QgYmVlbiBjYWxsZWQgeWV0XG4gICAqXG4gICAqIEBwYXJhbSB7U3RyaW5nfSBjaHVuayBDaHVuayBvZiBkYXRhIHJlY2VpdmVkIGZyb20gdGhlIHNlcnZlclxuICAgKi9cbiAgc2VuZCAoY2h1bmspIHtcbiAgICBpZiAodGhpcy5kZXN0cm95ZWQpIHtcbiAgICAgIHJldHVybiB0aGlzLm9uZXJyb3IobmV3IEVycm9yKCdUaGlzIHBhcnNlciBoYXMgYWxyZWFkeSBiZWVuIGNsb3NlZCwgXCJ3cml0ZVwiIGlzIHByb2hpYml0ZWQnKSlcbiAgICB9XG5cbiAgICAvLyBMaW5lcyBzaG91bGQgYWx3YXlzIGVuZCB3aXRoIDxDUj48TEY+IGJ1dCB5b3UgbmV2ZXIga25vdywgbWlnaHQgYmUgb25seSA8TEY+IGFzIHdlbGxcbiAgICB2YXIgbGluZXMgPSAodGhpcy5fcmVtYWluZGVyICsgKGNodW5rIHx8ICcnKSkuc3BsaXQoL1xccj9cXG4vKVxuICAgIHRoaXMuX3JlbWFpbmRlciA9IGxpbmVzLnBvcCgpIC8vIG5vdCBzdXJlIGlmIHRoZSBsaW5lIGhhcyBjb21wbGV0ZWx5IGFycml2ZWQgeWV0XG5cbiAgICBmb3IgKHZhciBpID0gMCwgbGVuID0gbGluZXMubGVuZ3RoOyBpIDwgbGVuOyBpKyspIHtcbiAgICAgIHRoaXMuX3Byb2Nlc3NMaW5lKGxpbmVzW2ldKVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBJbmRpY2F0ZSB0aGF0IGFsbCB0aGUgZGF0YSBmcm9tIHRoZSBzZXJ2ZXIgaGFzIGJlZW4gcmVjZWl2ZWQuIENhbiBiZSBjYWxsZWQgb25seSBvbmNlLlxuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gW2NodW5rXSBDaHVuayBvZiBkYXRhIHJlY2VpdmVkIGZyb20gdGhlIHNlcnZlclxuICAgKi9cbiAgZW5kIChjaHVuaykge1xuICAgIGlmICh0aGlzLmRlc3Ryb3llZCkge1xuICAgICAgcmV0dXJuIHRoaXMub25lcnJvcihuZXcgRXJyb3IoJ1RoaXMgcGFyc2VyIGhhcyBhbHJlYWR5IGJlZW4gY2xvc2VkLCBcImVuZFwiIGlzIHByb2hpYml0ZWQnKSlcbiAgICB9XG5cbiAgICBpZiAoY2h1bmspIHtcbiAgICAgIHRoaXMuc2VuZChjaHVuaylcbiAgICB9XG5cbiAgICBpZiAodGhpcy5fcmVtYWluZGVyKSB7XG4gICAgICB0aGlzLl9wcm9jZXNzTGluZSh0aGlzLl9yZW1haW5kZXIpXG4gICAgfVxuXG4gICAgdGhpcy5kZXN0cm95ZWQgPSB0cnVlXG4gICAgdGhpcy5vbmVuZCgpXG4gIH1cblxuICAvLyBQcml2YXRlIEFQSVxuXG4gIC8qKlxuICAgKiBQcm9jZXNzZXMgYSBzaW5nbGUgYW5kIGNvbXBsZXRlIGxpbmUuIElmIGl0IGlzIGEgY29udGlub3VzIG9uZSAoc2xhc2ggYWZ0ZXIgc3RhdHVzIGNvZGUpLFxuICAgKiBxdWV1ZSBpdCB0byB0aGlzLl9ibG9ja1xuICAgKlxuICAgKiBAcGFyYW0ge1N0cmluZ30gbGluZSBDb21wbGV0ZSBsaW5lIG9mIGRhdGEgZnJvbSB0aGUgc2VydmVyXG4gICAqL1xuICBfcHJvY2Vzc0xpbmUgKGxpbmUpIHtcbiAgICB2YXIgbWF0Y2gsIHJlc3BvbnNlXG5cbiAgICAvLyBwb3NzaWJsZSBpbnB1dCBzdHJpbmdzIGZvciB0aGUgcmVnZXg6XG4gICAgLy8gMjUwLU1FU1NBR0VcbiAgICAvLyAyNTAgTUVTU0FHRVxuICAgIC8vIDI1MCAxLjIuMyBNRVNTQUdFXG5cbiAgICBpZiAoIWxpbmUudHJpbSgpKSB7XG4gICAgICAvLyBub3RoaW5nIHRvIGNoZWNrLCBlbXB0eSBsaW5lXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICB0aGlzLl9ibG9jay5saW5lcy5wdXNoKGxpbmUpXG5cbiAgICBpZiAoKG1hdGNoID0gbGluZS5tYXRjaCgvXihcXGR7M30pKFstIF0pKD86KFxcZCtcXC5cXGQrXFwuXFxkKykoPzogKSk/KC4qKS8pKSkge1xuICAgICAgdGhpcy5fYmxvY2suZGF0YS5wdXNoKG1hdGNoWzRdKVxuXG4gICAgICBpZiAobWF0Y2hbMl0gPT09ICctJykge1xuICAgICAgICBpZiAodGhpcy5fYmxvY2suc3RhdHVzQ29kZSAmJiB0aGlzLl9ibG9jay5zdGF0dXNDb2RlICE9PSBOdW1iZXIobWF0Y2hbMV0pKSB7XG4gICAgICAgICAgdGhpcy5vbmVycm9yKCdJbnZhbGlkIHN0YXR1cyBjb2RlICcgKyBtYXRjaFsxXSArXG4gICAgICAgICAgICAnIGZvciBtdWx0aSBsaW5lIHJlc3BvbnNlICgnICsgdGhpcy5fYmxvY2suc3RhdHVzQ29kZSArICcgZXhwZWN0ZWQpJylcbiAgICAgICAgfSBlbHNlIGlmICghdGhpcy5fYmxvY2suc3RhdHVzQ29kZSkge1xuICAgICAgICAgIHRoaXMuX2Jsb2NrLnN0YXR1c0NvZGUgPSBOdW1iZXIobWF0Y2hbMV0pXG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlc3BvbnNlID0ge1xuICAgICAgICAgIHN0YXR1c0NvZGU6IE51bWJlcihtYXRjaFsxXSkgfHwgMCxcbiAgICAgICAgICBlbmhhbmNlZFN0YXR1czogbWF0Y2hbM10gfHwgbnVsbCxcbiAgICAgICAgICBkYXRhOiB0aGlzLl9ibG9jay5kYXRhLmpvaW4oJ1xcbicpLFxuICAgICAgICAgIGxpbmU6IHRoaXMuX2Jsb2NrLmxpbmVzLmpvaW4oJ1xcbicpXG4gICAgICAgIH1cbiAgICAgICAgcmVzcG9uc2Uuc3VjY2VzcyA9IHJlc3BvbnNlLnN0YXR1c0NvZGUgPj0gMjAwICYmIHJlc3BvbnNlLnN0YXR1c0NvZGUgPCAzMDBcblxuICAgICAgICB0aGlzLm9uZGF0YShyZXNwb25zZSlcbiAgICAgICAgdGhpcy5fYmxvY2sgPSB7XG4gICAgICAgICAgZGF0YTogW10sXG4gICAgICAgICAgbGluZXM6IFtdLFxuICAgICAgICAgIHN0YXR1c0NvZGU6IG51bGxcbiAgICAgICAgfVxuICAgICAgICB0aGlzLl9ibG9jay5zdGF0dXNDb2RlID0gbnVsbFxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLm9uZXJyb3IobmV3IEVycm9yKCdJbnZhbGlkIFNNVFAgcmVzcG9uc2UgXCInICsgbGluZSArICdcIicpKVxuICAgICAgdGhpcy5vbmRhdGEoe1xuICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgc3RhdHVzQ29kZTogdGhpcy5fYmxvY2suc3RhdHVzQ29kZSB8fCBudWxsLFxuICAgICAgICBlbmhhbmNlZFN0YXR1czogbnVsbCxcbiAgICAgICAgZGF0YTogW2xpbmVdLmpvaW4oJ1xcbicpLFxuICAgICAgICBsaW5lOiB0aGlzLl9ibG9jay5saW5lcy5qb2luKCdcXG4nKVxuICAgICAgfSlcbiAgICAgIHRoaXMuX2Jsb2NrID0ge1xuICAgICAgICBkYXRhOiBbXSxcbiAgICAgICAgbGluZXM6IFtdLFxuICAgICAgICBzdGF0dXNDb2RlOiBudWxsXG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IFNtdHBSZXNwb25zZVBhcnNlclxuIl19